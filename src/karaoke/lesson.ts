import { keepAwake, openAudio } from "../audio";
import { $, errorText, prefs } from "../ui";
import { progressOf, type Plan } from "./plan";
import { KaraokePlayer } from "./player";
import { PracticeSession, type PracticeState } from "./practice";
import { savePlan } from "./takes-db";
import { KaraokeView } from "./view";

/** What the practice screen needs from the karaoke screen. */
export interface LessonHost {
  media: (name: string | undefined) => { el: HTMLAudioElement; unlocked: Promise<unknown> } | null;
  back: () => void;
}

let host: LessonHost;
let session: PracticeSession | null = null;
let view: KaraokeView | null = null;
let player: KaraokePlayer | null = null;
let plan: Plan | null = null;

export function initLesson(h: LessonHost) {
  host = h;
  $("lPause").onclick = () => session?.togglePause();
  $("lSkip").onclick = () => session?.skip();
  $("lStop").onclick = close;
}

/** Starts practising a plan. Called from a tap, so audio and the microphone can start. */
export async function openLesson(p: Plan) {
  plan = p;
  const song = p.song;
  // Created before anything is awaited, so they are still inside the tap.
  const voice = host.media(song.vocalsFile ?? song.audioName);
  const inst = host.media(song.instFile);
  for (const s of ["setup", "karaokeSetup", "karaoke", "replay", "lesson"]) $(s).hidden = s !== "lesson";
  $("lTitle").textContent = song.title;
  $("lMessage").textContent = "準備中…";
  try {
    const a = await openAudio();
    await Promise.all([voice?.unlocked, inst?.unlocked]);
    $("lMessage").textContent = "ピアノを読み込み中…";
    const midis = song.notes.map((n) => Math.round(n.midi + 12 * p.octave));
    const lo = Math.min(...midis);
    const hi = Math.max(...midis);
    await a.sound.loadPiano(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
    a.sound.speech = prefs.speech;
    player = new KaraokePlayer(
      a.ctx,
      song,
      {
        voice: voice?.el ?? null,
        voiceOffset: song.vocalsFile ? 0 : (song.audioStart ?? 0),
        inst: inst?.el ?? null,
        original: null,
      },
      {
        // Every track the stages may want; each stage turns them on or off.
        play: { inst: true, voice: true, melody: false, original: false },
        octave: p.octave,
        tolerance: p.tolerance,
        octaveFree: prefs.octaveFree,
        extraLatency: prefs.latencyMs / 1000,
        speed: 1,
      },
    );
    view = new KaraokeView($<HTMLCanvasElement>("lGraph"), player, { tolerance: p.tolerance, showContour: prefs.showContour });
    session = new PracticeSession(p, player, a.sound, a.tracker);
    session.onState = render;
    let saving: number | undefined;
    session.onProgress = (pl) => {
      // Progress changes after every attempt; saving a little later batches them.
      clearTimeout(saving);
      saving = window.setTimeout(() => void savePlan(pl), 500);
      renderPhrases();
    };
    if (!inst) $("lMessage").textContent = "伴奏の音声がないので、伴奏なしで練習します";
    keepAwake(true);
    renderPhrases();
    requestAnimationFrame(frame);
    await session.run();
    await savePlan(p);
  } catch (e) {
    $("lMessage").textContent = errorText(e);
  }
}

function render(s: PracticeState) {
  $("lLabel").textContent = s.label;
  $("lStage").textContent = s.stage ? `${s.stage}・${s.speed.toFixed(2)}倍` : "";
  $("lCount").textContent = s.needed ? `${s.attempt}回目・合格 ${s.passes}/${s.needed}` : s.attempt ? `${s.attempt}回目` : "";
  $("lScore").textContent = s.lastScore === null ? "" : `${s.lastScore}点`;
  $("lMessage").textContent = s.message;
  $("lPause").textContent = s.paused ? "再開" : "一時停止";
  if (s.done) $("lPause").hidden = $("lSkip").hidden = true;
}

/** The phrases in focus, with where each stands. */
function renderPhrases() {
  if (!plan) return;
  const p = plan;
  $("lPhrases").replaceChildren(
    ...p.focus.map((id) => {
      const ph = p.phrases.find((x) => x.id === id)!;
      const prog = progressOf(p, id);
      const row = document.createElement("div");
      row.className = "phrase-row";
      const status = prog.cleared ? "✓ クリア" : `${p.stages[prog.stage]?.name ?? ""}`;
      row.textContent = `${id}  ${status}  最高${prog.best}点${ph.score === null ? "" : `（最初${ph.score}点）`}${ph.issues[0] ? `・${ph.issues[0]}` : ""}`;
      if (prog.cleared) row.classList.add("cleared");
      return row;
    }),
  );
}

function frame() {
  if (!player || !view) return;
  view.draw();
  requestAnimationFrame(frame);
}

function close() {
  session?.stop();
  session = null;
  if (plan) void savePlan(plan);
  player = null;
  view = null;
  keepAwake(false);
  $("lPause").hidden = $("lSkip").hidden = false;
  host.back();
}
