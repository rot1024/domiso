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

/** Audio files the user picked, by file name. */
let audioFiles = new Map<string, ArrayBuffer>();
/** Decoded playback buffers, by file name. */
const decoded = new Map<string, AudioBuffer>();
let song: Song | null = null;
let job: AnalysisJob | null = null;
let player: KaraokePlayer | null = null;
let view: KaraokeView | null = null;
let tracker: PitchTracker | null = null;

export function initKaraoke() {
  choices($("guide"), "guide", [
    { value: "both", label: "伴奏+声" },
    { value: "inst", label: "伴奏" },
    { value: "voice", label: "声" },
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
  $<HTMLInputElement>("kFiles").onchange = (e) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = ""; // Allow picking the same files again.
    if (files.length) void openFiles(files);
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

const isSongFile = (f: File) => /\.json$/i.test(f.name);

/**
 * Accepts either one plain audio file (analyzed here), or analysis data (.domiso.json, e.g. from the CLI)
 * together with the audio files it names.
 */
async function openFiles(files: File[]) {
  $("kError").textContent = "";
  const jsons = files.filter(isSongFile);
  const audios = files.filter((f) => !isSongFile(f));
  try {
    if (jsons.length > 1) throw new Error("解析データは1つだけ選んでください");
    if (jsons.length) {
      const opened = parseSong(await jsons[0].text());
      job?.cancel();
      job = null;
      song = opened;
      audioFiles = new Map();
      decoded.clear();
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
}

/** File names a song can play: the reference voice and the backing track. */
function trackNames(s: Song): string[] {
  return [s.vocalsFile ?? s.audioName, ...(s.instFile ? [s.instFile] : [])];
}

async function analyzeAudio(file: File) {
  job?.cancel();
  song = null;
  audioFiles = new Map([[file.name, await file.arrayBuffer()]]);
  decoded.clear();
  updateButtons();
  try {
    status("読み込み中…");
    const { samples, duration } = await decodeForAnalysis(audioFiles.get(file.name)!);
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
      duration,
      hop: HOP,
      offsetCents: result.offsetCents,
      notes: result.notes,
      contour: result.contour,
    };
    status(describe(song));
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
  lines.push(`声: ${mark(voiceName)}` + (s.instFile ? `　伴奏: ${mark(s.instFile)}` : ""));
  const missing = trackNames(s).filter((n) => !audioFiles.has(n));
  if (missing.length) lines.push("足りない音声はガイド音で代わりに鳴らします。まとめて選び直すと読み込めます。");
  return lines.join("\n");
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
    const load = async (name: string | undefined) => {
      if (!name || !audioFiles.has(name)) return null;
      if (!decoded.has(name)) decoded.set(name, await a.ctx.decodeAudioData(audioFiles.get(name)!.slice(0)));
      return decoded.get(name)!;
    };
    const tracks = { voice: await load(song.vocalsFile ?? song.audioName), inst: await load(song.instFile) };
    player = new KaraokePlayer(a.ctx, song, tracks, {
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
