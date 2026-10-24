import { keepAwake, openPlayback } from "../audio";
import type { Sound } from "../sound";
import { midiToFreq } from "../theory";
import { $, checkbox, prefs, prefsListeners, savePrefs } from "../ui";
import { median } from "../pitch";
import { KaraokePlayer, MAX_SPEED, MIN_SPEED } from "./player";
import type { Song } from "./song";
import { noteAt } from "./song";
import { takeOnTimeline, type Take } from "./take";
import { KaraokeView } from "./view";

/** What the replay needs from the karaoke screen. */
export interface ReplayHost {
  song: () => Song | null;
  media: (name: string | undefined) => { el: HTMLAudioElement; unlocked: Promise<unknown> } | null;
  back: () => void;
}

let host: ReplayHost;
let take: Take | null = null;
let mineUrl: string | null = null;
/** The speed the take was sung at; replay starts there so your voice plays naturally. */
let mineSpeed = 1;
let player: KaraokePlayer | null = null;
let view: KaraokeView | null = null;
let sound: Sound | null = null;
let loop: { a: number | null; b: number | null } = { a: null, b: null };

export function initReplay(h: ReplayHost) {
  host = h;
  for (const k of ["rMine", "rVoice", "rInst", "rMelody", "rSplit"] as const) {
    checkbox(k);
    $<HTMLInputElement>(k).addEventListener("change", () => void rebuild());
  }
  const offset = $<HTMLInputElement>("rOffset");
  const syncOffset = () => {
    offset.value = String(prefs.rOffsetMs);
    $("rOffsetLabel").textContent = `${prefs.rOffsetMs > 0 ? "+" : ""}${prefs.rOffsetMs}ms`;
  };
  offset.oninput = () => {
    prefs.rOffsetMs = Number(offset.value);
    savePrefs();
  };
  offset.onchange = () => void rebuild();
  prefsListeners.push(syncOffset);
  syncOffset();

  $("rPlay").onclick = () => {
    if (!player) return;
    if (player.isPlaying) player.pause();
    else {
      if (player.position >= player.duration) player.seek(0);
      play();
    }
    updatePlay();
  };
  $("rRewind").onclick = () => player?.seek(player.position - 5);
  $("rSlower").onclick = () => setSpeed(prefs.rSpeed - 0.05);
  $("rFaster").onclick = () => setSpeed(prefs.rSpeed + 0.05);
  $("rSpeed").onclick = () => setSpeed(1);
  $("rA").onclick = () => setLoop("a");
  $("rB").onclick = () => setLoop("b");
  $("rClear").onclick = () => {
    loop = { a: null, b: null };
    showLoop();
  };
  $("rBack").onclick = close;
  $<HTMLCanvasElement>("rGraph").onclick = (e) => void compareAt(e);
}

/** Opens a take for replay. Called from a tap, so audio can start. */
export async function openReplay(t: Take) {
  take = t;
  loop = { a: null, b: null };
  showLoop();
  $("rTitle").textContent = `${t.title}（${new Date(t.created).toLocaleString()}・${t.score}点）`;
  $("rMessage").textContent = "読み込み中…";
  for (const s of ["setup", "karaokeSetup", "karaoke", "replay"]) $(s).hidden = s !== "replay";
  const a = await openPlayback();
  sound = a.sound;
  if (mineUrl) URL.revokeObjectURL(mineUrl);
  const laid = await takeOnTimeline(t, a.ctx, host.song()!.duration);
  mineUrl = URL.createObjectURL(laid.wav);
  mineSpeed = laid.speed;
  prefs.rSpeed = laid.speed;
  savePrefs();
  $("rMessage").textContent = "線をタップすると、その音の「自分の声 → 正しい音」を聞き比べられます";
  keepAwake(true);
  await rebuild(0);
  requestAnimationFrame(frame);
}

/** Recreates the player with the current mixer settings (an audio element feeds Web Audio only once). */
async function rebuild(at?: number) {
  const song = host.song();
  if (!take || !song) return;
  const pos = at ?? player?.position ?? 0;
  const wasPlaying = at === undefined && !!player?.isPlaying;
  player?.stop();
  const voice = host.media(song.vocalsFile ?? song.audioName);
  const inst = host.media(song.instFile);
  const mine = new Audio(mineUrl!);
  mine.preload = "auto";
  await Promise.all([voice?.unlocked, inst?.unlocked]);
  const { ctx } = await openPlayback();
  player = new KaraokePlayer(
    ctx,
    song,
    {
      voice: voice?.el ?? null,
      voiceOffset: song.vocalsFile ? 0 : (song.audioStart ?? 0),
      inst: inst?.el ?? null,
      original: null,
      mine,
      mineOffset: prefs.rOffsetMs / 1000,
      mineSpeed,
    },
    {
      play: {
        inst: prefs.rInst,
        voice: prefs.rVoice,
        melody: prefs.rMelody,
        original: false,
        mine: prefs.rMine,
        split: prefs.rSplit,
      },
      octave: prefs.octave,
      tolerance: prefs.tolerance,
      octaveFree: prefs.octaveFree,
      extraLatency: 0,
      speed: prefs.rSpeed,
    },
  );
  player.loadTrace(take.points.map((p) => ({ t: p.t, midi: p.m })));
  player.onEnd = updatePlay;
  view = new KaraokeView($<HTMLCanvasElement>("rGraph"), player, {
    tolerance: prefs.tolerance,
    showContour: prefs.showContour,
  });
  player.seek(pos);
  if (wasPlaying) play();
  showSpeed();
  updatePlay();
}

/** Plays, looping between A and B when both are set. */
function play() {
  if (!player) return;
  const { a, b } = loop;
  if (a !== null && b !== null && b > a) {
    const from = player.position >= a && player.position < b ? player.position : a;
    // Range playback clears scores in the range; replay keeps the take's, so reload them each pass.
    const pass = (start: number) => {
      player?.playRange(start, b, () => pass(a));
      player?.loadTrace(take!.points.map((p) => ({ t: p.t, midi: p.m })));
    };
    pass(from);
  } else {
    player.play();
  }
}

function setLoop(which: "a" | "b") {
  if (!player) return;
  loop[which] = player.position;
  if (loop.a !== null && loop.b !== null && loop.b < loop.a) loop = { a: loop.b, b: loop.a };
  showLoop();
  if (player.isPlaying && loop.a !== null && loop.b !== null) play();
}

function showLoop() {
  const f = (t: number | null) => (t === null ? "--:--" : clock(t));
  $("rLoop").textContent = `A ${f(loop.a)} – B ${f(loop.b)}`;
}

function setSpeed(v: number) {
  prefs.rSpeed = Math.round(Math.max(MIN_SPEED, Math.min(MAX_SPEED, v)) * 100) / 100;
  savePrefs();
  if (player) player.speed = prefs.rSpeed;
  showSpeed();
}

function showSpeed() {
  $("rSpeed").textContent = `${prefs.rSpeed.toFixed(2)}倍`;
}

function updatePlay() {
  if (!player) return;
  $("rPlay").textContent = player.isPlaying ? "一時停止" : "再生";
}

/** Tap on the graph: plays what you sang on that note, then the right pitch. */
async function compareAt(e: MouseEvent) {
  if (!player || !view || !take || !sound) return;
  const canvas = e.currentTarget as HTMLCanvasElement;
  const t = view.timeAtX((e.clientX - canvas.getBoundingClientRect().left) / canvas.clientWidth);
  const i = noteAt(player.notes, t);
  if (i < 0) return;
  const n = player.notes[i];
  const sung = take.points.filter((p) => p.t >= n.start && p.t < n.end && p.m !== null).map((p) => p.m!);
  if (!sung.length) {
    $("rMessage").textContent = "この音は声が拾えていません";
    return;
  }
  const mine = median(sung);
  const cents = Math.round((mine - n.midi) * 100);
  $("rMessage").textContent = `この音: ${cents > 0 ? "+" : ""}${cents}¢（自分の声 → 正しい音）`;
  sound.compare(midiToFreq(mine), n.midi);
}

function frame() {
  if (!player || !view) return;
  view.draw();
  $("rTime").textContent = `${clock(player.position)} / ${clock(player.duration)}`;
  requestAnimationFrame(frame);
}

function close() {
  player?.stop();
  player = null;
  view = null;
  keepAwake(false);
  host.back();
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
