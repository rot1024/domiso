import { keepAwake, openAudio } from "../audio";
import { solfege } from "../graph";
import type { PitchTracker } from "../pitch";
import { midiName } from "../theory";
import { $, checkbox, choices, errorText, prefs, prefsListeners, savePrefs } from "../ui";
import { HOP } from "./analyze";
import { analyzeInWorker, decodeForAnalysis, type AnalysisJob } from "./load";
import { KaraokePlayer } from "./player";
import { parseSong, serializeSong, type Song } from "./song";
import { KaraokeView } from "./view";

let audio: { name: string; data: ArrayBuffer } | null = null;
let playbackBuffer: AudioBuffer | null = null;
let song: Song | null = null;
let job: AnalysisJob | null = null;
let player: KaraokePlayer | null = null;
let view: KaraokeView | null = null;
let tracker: PitchTracker | null = null;

export function initKaraoke() {
  choices($("guide"), "guide", [
    { value: "voice", label: "お手本の声" },
    { value: "tone", label: "ガイド音" },
    { value: "none", label: "なし" },
  ]);
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
  $<HTMLInputElement>("audioFile").onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void loadAudio(file);
  };
  $<HTMLInputElement>("songFile").onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void loadSong(file);
  };
  $("kSave").onclick = save;
  $("kSing").onclick = () => void sing();
  $("kPlay").onclick = togglePlay;
  $("kRewind").onclick = () => player?.seek(player.position - 5);
  $("kStop").onclick = endSinging;
}

function show(id: "setup" | "karaokeSetup" | "karaoke") {
  for (const s of ["setup", "karaokeSetup", "karaoke"]) $(s).hidden = s !== id;
  window.scrollTo(0, 0);
}

function status(text: string) {
  $("kStatus").textContent = text;
}

function updateButtons() {
  $<HTMLButtonElement>("kSing").disabled = !song;
  $<HTMLButtonElement>("kSave").disabled = !song;
}

async function loadAudio(file: File) {
  $("kError").textContent = "";
  job?.cancel();
  audio = { name: file.name, data: await file.arrayBuffer() };
  playbackBuffer = null;

  // Opened analysis data for this same file: no need to analyze again.
  if (song && song.audioName === file.name) {
    status(summary(song));
    updateButtons();
    return;
  }
  song = null;
  updateButtons();
  try {
    status("読み込み中…");
    const { samples, duration } = await decodeForAnalysis(audio.data);
    job = analyzeInWorker(samples, (r) => status(`解析中… ${Math.round(r * 100)}%`));
    const result = await job.promise;
    job = null;
    song = {
      format: "domiso-karaoke",
      version: 1,
      title: file.name.replace(/\.[^.]+$/, ""),
      audioName: file.name,
      duration,
      hop: HOP,
      offsetCents: result.offsetCents,
      notes: result.notes,
      contour: result.contour,
    };
    status(result.notes.length ? summary(song) : "声が見つかりませんでした。声だけの音声か確認してください。");
    if (!result.notes.length) song = null;
  } catch (e) {
    if (e instanceof Error && e.message === "cancelled") return;
    status("");
    $("kError").textContent = `解析できませんでした: ${e instanceof Error ? e.message : e}`;
  }
  updateButtons();
}

async function loadSong(file: File) {
  $("kError").textContent = "";
  try {
    const opened = parseSong(await file.text());
    job?.cancel();
    job = null;
    song = opened;
    let text = summary(song);
    if (!audio) text += "\n音声なし: 「お手本の声」の代わりにガイド音が鳴ります。同じ音声ファイルを選ぶと声で歌えます。";
    else if (audio.name !== song.audioName) text += `\n注意: 解析元の音声は「${song.audioName}」です。`;
    status(text);
  } catch (e) {
    $("kError").textContent = e instanceof Error ? e.message : String(e);
  }
  updateButtons();
}

function summary(s: Song): string {
  const off = s.offsetCents ? `・全体のずれ ${s.offsetCents > 0 ? "+" : ""}${s.offsetCents}¢` : "";
  return `「${s.title}」 音符 ${s.notes.length} 個・${formatTime(s.duration)}${off}`;
}

function save() {
  if (!song) return;
  const blob = new Blob([serializeSong(song)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${song.title}.domiso.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function sing() {
  if (!song) return;
  $("kError").textContent = "";
  try {
    const a = await openAudio();
    tracker = a.tracker;
    if (audio && !playbackBuffer && audio.name === song.audioName) {
      playbackBuffer = await a.ctx.decodeAudioData(audio.data.slice(0));
    }
    player = new KaraokePlayer(a.ctx, song, playbackBuffer, {
      guide: prefs.guide,
      octave: prefs.octave,
      tolerance: prefs.tolerance,
      octaveFree: prefs.octaveFree,
      extraLatency: prefs.latencyMs / 1000,
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
  const r = player.result();
  let text = `スコア ${r.score}点・音符 ${r.notesHit}/${r.notesTotal}`;
  if (r.bias !== null && Math.abs(r.bias) >= 8) {
    text += `・全体に${Math.abs(r.bias) >= 20 ? "" : "やや"}${r.bias < 0 ? "低め" : "高め"} (${r.bias > 0 ? "+" : ""}${Math.round(r.bias)}¢)`;
  }
  $("kResult").textContent = text;
  updatePlayButton();
}

function endSinging() {
  player?.stop();
  player = null;
  view = null;
  tracker?.stop();
  keepAwake(false);
  show("karaokeSetup");
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
