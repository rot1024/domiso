import { keepAwake, openAudio } from "../audio";
import { solfege } from "../graph";
import type { PitchTracker } from "../pitch";
import { midiName } from "../theory";
import { $, checkbox, choices, errorText, prefs, prefsListeners, savePrefs } from "../ui";
import { HOP } from "./analyze";
import { ANALYSIS_RATE, analyzeInWorker, decodeForAnalysis, type AnalysisJob } from "./load";
import { soundRange } from "./trim";
import { encodeWav, renderMelody } from "./melody";
import { melodyToMidi } from "./midi";
import { KaraokePlayer, MAX_SPEED, MIN_SPEED } from "./player";
import { initLesson, openLesson } from "./lesson";
import { parsePlan, serializePlan, type Plan } from "./plan";
import { initReplay, openReplay } from "./replay";
import { parseSong, serializeSong, type Song } from "./song";
import { parseTakeFile, serializeTake, songKey, type Take, type TakePoint } from "./take";
import { deletePlan, deleteTake, plansFor, savePlan, saveTake, takesFor } from "./takes-db";
import { KaraokeView } from "./view";

/** Audio files the user picked, by file name. */
let audioFiles = new Map<string, ArrayBuffer>();
/** Object URLs of the picked audio files, by file name, for playback through audio elements. */
const urls = new Map<string, string>();

function forgetAudio() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
}

/**
 * A fresh audio element for one of the picked files (an element can feed Web Audio only once).
 * iOS lets media start only from a tap, so it is started muted right away, inside the tap, and stopped.
 */
function mediaFor(name: string | undefined): { el: HTMLAudioElement; unlocked: Promise<unknown> } | null {
  if (!name || !audioFiles.has(name)) return null;
  if (!urls.has(name)) urls.set(name, URL.createObjectURL(new Blob([audioFiles.get(name)!])));
  const el = new Audio(urls.get(name));
  el.preload = "auto";
  el.muted = true;
  const unlocked = el
    .play()
    .then(() => el.pause())
    .catch(() => {})
    .finally(() => (el.muted = false));
  return { el, unlocked };
}
let song: Song | null = null;
let job: AnalysisJob | null = null;
let player: KaraokePlayer | null = null;
let view: KaraokeView | null = null;
let tracker: PitchTracker | null = null;

/** The take being recorded in the current karaoke session. */
let recording: {
  recorder: MediaRecorder;
  chunks: Blob[];
  /** AudioContext time at which the recording started. */
  start: number;
  points: TakePoint[];
  done: boolean;
} | null = null;
let lastTake: Take | null = null;

export function initKaraoke() {
  checkbox("playInst");
  checkbox("playVoice");
  checkbox("playMelody");
  checkbox("playOriginal");
  choices($("octave"), "octave", [
    { value: -1, label: "1つ下" },
    { value: 0, label: "そのまま" },
    { value: 1, label: "1つ上" },
  ]);
  choices($("kTolerance"), "tolerance", [
    { value: 50, label: "甘め ±50¢" },
    { value: 30, label: "ふつう ±30¢" },
    { value: 15, label: "厳しめ ±15¢" },
  ]);
  checkbox("showContour");
  checkbox("recordTakes");
  initReplay({
    song: () => song,
    media: mediaFor,
    back: () => {
      show("karaokeSetup");
      void renderTakes();
    },
  });
  $("kReplay").onclick = () => lastTake && void openReplay(lastTake);
  initLesson({
    media: mediaFor,
    back: () => {
      show("karaokeSetup");
      void renderTakes();
    },
  });
  checkbox("octaveFree", $<HTMLInputElement>("kOctaveFree"));

  const latency = $<HTMLInputElement>("latency");
  const syncLatency = () => {
    latency.value = String(prefs.latencyMs);
    $("latencyLabel").textContent = `${prefs.latencyMs > 0 ? "+" : ""}${prefs.latencyMs}ms`;
  };
  latency.oninput = () => {
    prefs.latencyMs = Number(latency.value);
    savePrefs();
  };
  prefsListeners.push(syncLatency);
  syncLatency();

  $("openKaraoke").onclick = () => show("karaokeSetup");
  $("kBack").onclick = () => show("setup");
  $<HTMLInputElement>("kFiles").onchange = (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = ""; // Allow picking the same files again.
    if (files.length) void openFiles(files);
  };
  $("kSave").onclick = save;
  $("kMidi").onclick = saveMidi;
  $("kGuideAudio").onclick = saveGuideAudio;
  $("kSing").onclick = () => void sing();
  $("kPlay").onclick = togglePlay;
  $("kRewind").onclick = () => player?.seek(player.position - 5);
  $("kStop").onclick = endSinging;
  $("kSlower").onclick = () => changeSpeed(-SPEED_STEP);
  $("kFaster").onclick = () => changeSpeed(SPEED_STEP);
  $("kSpeed").onclick = () => changeSpeed(1 - prefs.speed); // back to normal
  showSpeed();
}

function show(id: "setup" | "karaokeSetup" | "karaoke") {
  for (const s of ["setup", "karaokeSetup", "karaoke", "replay", "lesson"]) $(s).hidden = s !== id;
  window.scrollTo(0, 0);
}

function status(text: string) {
  $("kStatus").textContent = text;
}

function updateButtons() {
  $<HTMLButtonElement>("kSing").disabled = !song;
  $<HTMLButtonElement>("kSave").disabled = !song;
  $<HTMLButtonElement>("kMidi").disabled = !song;
  $<HTMLButtonElement>("kGuideAudio").disabled = !song;
}

const isSongFile = (f: File) => /\.json$/i.test(f.name);

/**
 * Accepts either one plain audio file (analyzed here), or analysis data (.domiso.json, e.g. from the CLI)
 * together with the audio files it names.
 */
async function openFiles(files: File[]) {
  $("kError").textContent = "";
  let jsons = files.filter(isSongFile);
  let audios = files.filter((f) => !isSongFile(f));
  try {
    // A practice plan carries its song: opening one opens the song too.
    for (const j of [...jsons]) {
      const plan = parsePlan(await j.text());
      if (!plan) continue;
      if (!song || songKey(song) !== songKey(plan.song)) {
        job?.cancel();
        job = null;
        song = plan.song;
        audioFiles = new Map();
        forgetAudio();
      }
      await savePlan(plan);
      jsons = jsons.filter((x) => x !== j);
    }
    // Downloaded takes come back as their .domiso-take.json plus audio.
    for (const j of [...jsons]) {
      const t = parseTakeFile(await j.text());
      if (!t) continue;
      if (!song || t.songKey !== songKey(song)) throw new Error(`テイク「${j.name}」の曲の解析データを先に開いてください`);
      const audio = audios.find((f) => f.name === t.audioFile);
      if (!audio) throw new Error(`テイクの音声「${t.audioFile}」も一緒に選んでください`);
      await saveTake({
        id: crypto.randomUUID(),
        songKey: t.songKey,
        title: t.title,
        created: t.created,
        mime: t.mime,
        audio,
        points: t.points,
        score: t.score,
      });
      jsons = jsons.filter((x) => x !== j);
      audios = audios.filter((x) => x !== audio);
    }
    if (!jsons.length) {
      // Audio picked with a plan or take belongs to the song now loaded.
      const known = song ? trackNames(song) : [];
      for (const f of audios.filter((f) => known.includes(f.name))) audioFiles.set(f.name, await f.arrayBuffer());
      audios = audios.filter((f) => !known.includes(f.name));
      if (song) status(describe(song));
      if (!audios.length) {
        updateButtons();
        await renderTakes();
        return;
      }
    }
    if (jsons.length > 1) throw new Error("解析データは1つだけ選んでください");
    if (jsons.length) {
      const opened = parseSong(await jsons[0].text());
      job?.cancel();
      job = null;
      song = opened;
      audioFiles = new Map();
      forgetAudio();
    }
    const known = song ? trackNames(song) : [];
    if (song && audios.every((f) => known.includes(f.name))) {
      for (const f of audios) audioFiles.set(f.name, await f.arrayBuffer());
      status(describe(song));
    } else if (audios.length === 1 && !jsons.length) {
      await analyzeAudio(audios[0]);
    } else {
      throw new Error("複数の音声は、解析データ (.domiso.json) と一緒に選んでください");
    }
  } catch (e) {
    $("kError").textContent = e instanceof Error ? e.message : String(e);
  }
  updateButtons();
  await renderTakes();
}

/** File names a song can play: the reference voice and the backing track. */
function trackNames(s: Song): string[] {
  return [s.vocalsFile ?? s.audioName, ...[s.instFile, s.originalFile].filter((n) => n !== undefined)];
}

async function analyzeAudio(file: File) {
  job?.cancel();
  song = null;
  audioFiles = new Map([[file.name, await file.arrayBuffer()]]);
  forgetAudio();
  updateButtons();
  try {
    status("読み込み中…");
    const decodedAudio = await decodeForAnalysis(audioFiles.get(file.name)!);
    // Skip silence at either end; playback then starts the file at `audioStart`.
    const { start, end } = soundRange(decodedAudio.samples, ANALYSIS_RATE);
    const samples = decodedAudio.samples.slice(Math.round(start * ANALYSIS_RATE), Math.round(end * ANALYSIS_RATE));
    job = analyzeInWorker(samples, (r) => status(`解析中… ${Math.round(r * 100)}%`));
    const result = await job.promise;
    job = null;
    if (!result.notes.length) {
      status("声が見つかりませんでした。声だけの音声か確認してください。");
      return;
    }
    song = {
      format: "domiso-karaoke",
      version: 1,
      title: file.name.replace(/\.[^.]+$/, ""),
      audioName: file.name,
      ...(start > 0 ? { audioStart: Math.round(start * 1000) / 1000 } : {}),
      duration: end - start,
      hop: HOP,
      offsetCents: result.offsetCents,
      notes: result.notes,
      contour: result.contour,
    };
    const cut = [start > 0.05 && `前 ${start.toFixed(1)}秒`, decodedAudio.duration - end > 0.05 && `後ろ ${(decodedAudio.duration - end).toFixed(1)}秒`].filter(Boolean);
    status(describe(song) + (cut.length ? `\n無音をカットしました（${cut.join("・")}）` : ""));
  } catch (e) {
    if (e instanceof Error && e.message === "cancelled") return;
    status("");
    $("kError").textContent = `解析できませんでした: ${e instanceof Error ? e.message : e}`;
  }
}

/** Summary plus which tracks are loaded, and the names of the ones still missing. */
function describe(s: Song): string {
  const voiceName = s.vocalsFile ?? s.audioName;
  const lines = [summary(s)];
  const mark = (name: string) => (audioFiles.has(name) ? "○" : `× (${name})`);
  lines.push(
    `声: ${mark(voiceName)}` +
      (s.instFile ? `　伴奏: ${mark(s.instFile)}` : "") +
      (s.originalFile ? `　原曲: ${audioFiles.has(s.originalFile) ? "○" : "×"}` : ""),
  );
  // The original is optional; only missing voice or backing is worth a note.
  const missing = trackNames(s).filter((n) => n !== s.originalFile && !audioFiles.has(n));
  if (missing.length) lines.push("お手本の声がない間は、代わりにガイドメロディを鳴らします。まとめて選び直すと読み込めます。");
  return lines.join("\n");
}

function summary(s: Song): string {
  const off = s.offsetCents ? `・全体のずれ ${s.offsetCents > 0 ? "+" : ""}${s.offsetCents}¢` : "";
  return `「${s.title}」 音符 ${s.notes.length} 個・${formatTime(s.duration)}${off}`;
}

function save() {
  if (!song) return;
  download(new Blob([serializeSong(song)], { type: "application/json" }), `${song.title}.domiso.json`);
}

function saveMidi() {
  if (!song) return;
  // Shift by the chosen octave, so the file matches what you sing along with.
  const notes = song.notes.map((n) => ({ ...n, midi: n.midi + 12 * prefs.octave }));
  download(new Blob([melodyToMidi(notes, song.title)], { type: "audio/midi" }), `${song.title}.guide.mid`);
}

function saveGuideAudio() {
  if (!song) return;
  const notes = song.notes.map((n) => ({ ...n, midi: n.midi + 12 * prefs.octave }));
  const rate = 44100;
  const wav = encodeWav(renderMelody(notes, rate, song.duration, song.offsetCents), rate);
  download(new Blob([wav], { type: "audio/wav" }), `${song.title}.guide.wav`);
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

let sessionCtx: AudioContext;

async function sing() {
  if (!song) return;
  $("kError").textContent = "";
  // Created before anything is awaited, so they are still inside the tap (see mediaFor).
  const voice = mediaFor(song.vocalsFile ?? song.audioName);
  const inst = mediaFor(song.instFile);
  const original = mediaFor(song.originalFile);
  try {
    const a = await openAudio();
    tracker = a.tracker;
    sessionCtx = a.ctx;
    await Promise.all([voice, inst, original].map((m) => m?.unlocked));
    const tracks = {
      voice: voice?.el ?? null,
      // Only the original file may have skipped silence; CLI tracks are already trimmed.
      voiceOffset: song.vocalsFile ? 0 : (song.audioStart ?? 0),
      inst: inst?.el ?? null,
      original: original?.el ?? null,
    };
    player = new KaraokePlayer(a.ctx, song, tracks, {
      play: { inst: prefs.playInst, voice: prefs.playVoice, melody: prefs.playMelody, original: prefs.playOriginal },
      octave: prefs.octave,
      tolerance: prefs.tolerance,
      octaveFree: prefs.octaveFree,
      extraLatency: prefs.latencyMs / 1000,
      speed: prefs.speed,
    });
    view = new KaraokeView($<HTMLCanvasElement>("kGraph"), player, {
      tolerance: prefs.tolerance,
      showContour: prefs.showContour,
    });
  } catch (e) {
    $("kError").textContent = errorText(e);
    return;
  }

  $("kTitle").textContent = song.title;
  $("kResult").textContent = "";
  show("karaoke");
  player.onEnd = showResult;
  startRecording(sessionCtx);
  tracker.onSample = (s) => {
    player?.handleSample(s);
    readout(s.freq);
  };
  tracker.start();
  keepAwake(true);
  player.play();
  updatePlayButton();
  requestAnimationFrame(frame);
}

function frame() {
  if (!player || !view) return;
  view.draw();
  $("kTime").textContent = `${formatTime(player.position)} / ${formatTime(player.duration)}`;
  requestAnimationFrame(frame);
}

/** Big target note, plus how far off you are from it. */
function readout(freq: number | null) {
  if (!player) return;
  const note = $("kNote");
  const cents = $("kCents");
  const d = freq === null ? null : player.deviationAt(freq, player.position);
  const target = d?.note ?? null;
  if (!player.isPlaying) return;
  if (!target) {
    note.classList.add("idle");
    cents.textContent = "";
    return;
  }
  note.textContent = solfege(target.midi);
  note.classList.remove("idle");
  const c = Math.round(d!.cents);
  cents.textContent = `${midiName(Math.round(target.midi))}  ${c === 0 ? "±" : c > 0 ? "+" : "−"}${Math.abs(c)}¢`;
  cents.style.color = Math.abs(c) <= prefs.tolerance ? "var(--good)" : "";
}

const SPEED_STEP = 0.05;

function changeSpeed(delta: number) {
  prefs.speed = Math.round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, prefs.speed + delta)) * 100) / 100;
  savePrefs();
  if (player) player.speed = prefs.speed;
  showSpeed();
}

function showSpeed() {
  $("kSpeed").textContent = `${prefs.speed.toFixed(2)}倍`;
}

function togglePlay() {
  if (!player) return;
  if (player.isPlaying) {
    player.pause();
  } else {
    if (player.position >= player.duration) {
      player.seek(0);
      $("kResult").textContent = "";
    }
    player.play();
  }
  updatePlayButton();
}

function updatePlayButton() {
  if (!player) return;
  const ended = player.position >= player.duration;
  $("kPlay").textContent = player.isPlaying ? "一時停止" : ended ? "もう一度" : "再生";
}

function showResult() {
  if (!player) return;
  void finishTake();
  const r = player.result();
  let text = `スコア ${r.score}点・音符 ${r.notesHit}/${r.notesTotal}`;
  if (r.bias !== null && Math.abs(r.bias) >= 8) {
    text += `・全体に${Math.abs(r.bias) >= 20 ? "" : "やや"}${r.bias < 0 ? "低め" : "高め"} (${r.bias > 0 ? "+" : ""}${Math.round(r.bias)}¢)`;
  }
  $("kResult").textContent = text;
  updatePlayButton();
}

function endSinging() {
  void finishTake();
  player?.stop();
  player = null;
  view = null;
  tracker?.stop();
  keepAwake(false);
  show("karaokeSetup");
}

/** Records your voice alongside the pitch, so the take can be replayed against the song. */
function startRecording(ctx: AudioContext) {
  recording = null;
  $("kReplay").hidden = true;
  if (!prefs.recordTakes || !tracker || !player || typeof MediaRecorder === "undefined") return;
  const recorder = new MediaRecorder(tracker.stream);
  const rec = { recorder, chunks: [] as Blob[], start: ctx.currentTime, points: [] as TakePoint[], done: false };
  recorder.ondataavailable = (e) => {
    if (e.data.size) rec.chunks.push(e.data);
  };
  recorder.onstart = () => (rec.start = ctx.currentTime);
  recorder.start(1000);
  // The detector reports a frame about 20 ms after its middle; the recording has it at the real time.
  player.onPoint = (p) => rec.points.push({ t: p.t, m: p.midi, r: p.ctxTime - 0.02 - rec.start });
  recording = rec;
}

/** Stops the recording and keeps it as a take if anything was sung. */
async function finishTake() {
  const rec = recording;
  if (!rec || rec.done || !song) return;
  rec.done = true;
  // Scored now, over what was actually sung: the player may be gone once the recorder has stopped.
  const last = rec.points.at(-1);
  const score = (last && player?.rangeScore(0, last.t)) ?? 0;
  const stopped = new Promise<void>((r) => (rec.recorder.onstop = () => r()));
  if (rec.recorder.state !== "inactive") rec.recorder.stop();
  await stopped;
  const voiced = rec.points.filter((p) => p.m !== null).length * 0.025;
  if (voiced < 2 || !rec.chunks.length) return;
  const mime = rec.recorder.mimeType || rec.chunks[0].type;
  const take: Take = {
    id: crypto.randomUUID(),
    songKey: songKey(song),
    title: song.title,
    created: new Date().toISOString(),
    mime,
    audio: new Blob(rec.chunks, { type: mime }),
    points: rec.points,
    score,
  };
  try {
    await saveTake(take);
    lastTake = take;
    $("kReplay").hidden = false;
  } catch (e) {
    $("kResult").textContent += `（テイクを保存できませんでした: ${e}）`;
  }
  await renderTakes();
}

/** Lists this song's practice plans with their progress. */
async function renderPlans() {
  const plans = song ? await plansFor(songKey(song)).catch(() => [] as Plan[]) : [];
  $("kPlansSection").hidden = !plans.length;
  $("kPlans").replaceChildren(
    ...plans.map((p) => {
      const row = document.createElement("div");
      row.className = "take";
      const cleared = p.focus.filter((id) => p.progress[id]?.cleared).length;
      const label = document.createElement("span");
      label.textContent = `${new Date(p.created).toLocaleString()}・苦手フレーズ ${p.focus.length}個（クリア ${cleared}）${p.finished ? "・完了" : ""}`;
      const button = (text: string, f: () => void) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.onclick = f;
        return b;
      };
      row.append(
        label,
        button("練習する", () => void openLesson(p)),
        button("保存", () => download(new Blob([serializePlan(p)], { type: "application/json" }), `${p.song.title}.domiso-plan.json`)),
        button("削除", () => {
          if (confirm("この練習プランを削除しますか？（元に戻せません）")) void deletePlan(p.id).then(renderPlans);
        }),
      );
      return row;
    }),
  );
}

/** Lists this song's takes, newest first, with replay / download / remove. */
async function renderTakes() {
  void renderPlans();
  const list = $("kTakes");
  const takes = song ? await takesFor(songKey(song)).catch(() => [] as Take[]) : [];
  $("kTakesSection").hidden = !takes.length;
  list.replaceChildren(
    ...takes.map((t) => {
      const row = document.createElement("div");
      row.className = "take";
      const label = document.createElement("span");
      label.textContent = `${new Date(t.created).toLocaleString()}・${t.score}点・${(t.audio.size / 1e6).toFixed(1)}MB`;
      const button = (text: string, f: () => void) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.onclick = f;
        return b;
      };
      row.append(
        label,
        button("リプレイ", () => void openReplay(t)),
        button("保存", () => downloadTake(t)),
        button("保存して削除", () => {
          downloadTake(t);
          // Give the downloads a moment to start before the data goes.
          setTimeout(() => void deleteTake(t.id).then(renderTakes), 1500);
        }),
        button("削除", () => {
          if (confirm("このテイクを削除しますか？（元に戻せません）")) void deleteTake(t.id).then(renderTakes);
        }),
      );
      return row;
    }),
  );
}

/** Downloads a take as its audio plus a .domiso-take.json that can be opened again later. */
function downloadTake(t: Take) {
  const { json, audioFile } = serializeTake(t);
  download(t.audio, audioFile);
  const jsonName = audioFile.replace(/\.[^.]+$/, ".domiso-take.json");
  setTimeout(() => download(new Blob([json], { type: "application/json" }), jsonName), 300);
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
