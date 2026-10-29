import { openAudio, keepAwake } from "./audio";
import { initKaraoke } from "./karaoke/screen";
import type { PitchSample, PitchTracker } from "./pitch";
import type { Sound } from "./sound";
import { Tuner } from "./tuner";
import { centsOff, freqToMidi, midiName, midiToFreq, VOICE_PRESETS } from "./theory";
import { AID_LABELS, MODES, Trainer, type Mode, type Settings, type TrainerState } from "./trainer";
import { $, checkbox, choices, errorText, prefs, prefsListeners, savePrefs, showScreen } from "./ui";

function updateHint() {
  const hint =
    !prefs.headphones && prefs.slide
      ? "イヤホンなしのスライドでは、ピアノは和音だけ鳴らし、次の音へは合図音で進みます。"
      : !prefs.headphones && prefs.mode === "unison"
      ? "イヤホンなしではピアノの音をマイクが拾うため、ピアノの後に歌う方式になります。"
      : !prefs.headphones
        ? "イヤホンなしの場合、ピアノが鳴っている間は判定しません。"
        : "";
  $("hint").textContent = hint;
}

choices(
  $("voice"),
  "voice",
  VOICE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
);
// Home: picking a mode opens its settings.
$("mode").replaceChildren(
  ...(Object.keys(MODES) as Mode[]).map((m) => {
    const b = document.createElement("button");
    b.textContent = MODES[m].label;
    const sub = document.createElement("small");
    sub.textContent = MODES[m].description;
    b.append(sub);
    b.onclick = () => {
      prefs.mode = m;
      savePrefs();
      $("setupTitle").textContent = MODES[m].label;
      $("setupDescription").textContent = MODES[m].description;
      $("error").textContent = "";
      showScreen("setup");
    };
    return b;
  }),
);
$("backHome").onclick = () => showScreen("home");
choices($("pattern"), "pattern", [
  { value: "triad", label: "ドミソ" },
  { value: "five", label: "ドレミファソ" },
]);
choices($("tolerance"), "tolerance", [
  { value: 50, label: "甘め ±50¢" },
  { value: 30, label: "ふつう ±30¢" },
  { value: 15, label: "厳しめ ±15¢" },
]);
choices($("holdMs"), "holdMs", [
  { value: 500, label: "0.5秒" },
  { value: 1000, label: "1秒" },
  { value: 1500, label: "1.5秒" },
  { value: 2000, label: "2秒" },
]);
choices($("rounds"), "rounds", [
  { value: 5, label: "5" },
  { value: 10, label: "10" },
  { value: 20, label: "20" },
  { value: 0, label: "エンドレス" },
]);
checkbox("headphones");
checkbox("speech");
checkbox("octaveFree");
checkbox("slide");
prefsListeners.push(updateHint);
updateHint();
initKaraoke();

// --- Session ---

let ctx: AudioContext | null = null;
let tracker: PitchTracker | null = null;
let sound: Sound | null = null;
let trainer: Trainer | null = null;
let settings: Settings | null = null;
const history: { time: number; midi: number | null }[] = [];

$("start").onclick = async () => {
  const startBtn = $<HTMLButtonElement>("start");
  $("error").textContent = "";
  startBtn.disabled = true;
  try {
    ({ ctx, sound, tracker } = await openAudio());

    const home = VOICE_PRESETS.find((p) => p.id === prefs.voice)!.home;
    startBtn.textContent = "ピアノ読み込み中…";
    const notes = Array.from({ length: 20 }, (_, i) => home - 6 + i);
    await sound!.loadPiano(notes, (loaded, total) => {
      startBtn.textContent = `ピアノ読み込み中… ${loaded}/${total}`;
    });

    settings = { home, ...prefs };
    begin(settings);
  } catch (e) {
    $("error").textContent = errorText(e);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "スタート";
  }
};

// --- Tuner ---

let tuner: Tuner | null = null;

$("openTuner").onclick = async () => {
  $("homeError").textContent = "";
  try {
    ({ ctx, sound, tracker } = await openAudio());
  } catch (e) {
    $("homeError").textContent = errorText(e);
    return;
  }
  tuner = new Tuner(
    {
      note: $("tunerNote"),
      cents: $("tunerCents"),
      needle: $("tunerNeedle"),
      zone: $("tunerZone"),
      canvas: $<HTMLCanvasElement>("tunerGraph"),
    },
    prefs.tolerance,
  );
  showScreen("tuner");
  tuner.start();
  tracker!.onSample = (s) => tuner?.push(s);
  tracker!.start();
  keepAwake(true);
};

$("closeTuner").onclick = () => {
  tuner?.stop();
  tuner = null;
  tracker?.stop();
  keepAwake(false);
  showScreen("home");
};

$("stop").onclick = () => end();

function begin(s: Settings) {
  showScreen("practice");
  $("modeLabel").textContent = MODES[s.mode].label + (s.slide ? "・スライド" : "");
  $("zone").style.width = `${(s.tolerance / 100) * 50}%`;
  history.length = 0;

  trainer = new Trainer(sound!, s);
  trainer.onState = renderState;
  renderState(trainer.state);
  tracker!.onSample = onSample;
  tracker!.start();
  keepAwake(true);
  requestAnimationFrame(draw);
  void trainer.run().then(() => {
    if (trainer?.state.phase === "done") $<HTMLButtonElement>("stop").textContent = "もどる";
  });
}

function end() {
  trainer?.stop();
  trainer = null;
  tracker?.stop();
  keepAwake(false);
  showScreen("setup");
  $("stop").textContent = "やめる";
}

function onSample(s: PitchSample) {
  trainer?.handleSample(s);
  history.push({ time: s.time, midi: s.freq === null ? null : freqToMidi(s.freq) });
  while (history.length && s.time - history[0].time > GRAPH_SECONDS) history.shift();

  const needle = $("needle");
  const target = trainer?.state.target;
  if (s.freq === null || target == null || trainer?.state.phase !== "listen") {
    needle.style.opacity = "0";
    return;
  }
  const cents = Math.max(-100, Math.min(100, centsOff(s.freq, target, settings!.octaveFree)));
  needle.style.opacity = "1";
  needle.style.left = `${50 + cents / 2}%`;
  needle.style.background = Math.abs(cents) <= settings!.tolerance ? "var(--good)" : "var(--text)";
}

function renderState(s: TrainerState) {
  $("chord").textContent = s.chord;
  $("message").textContent = s.message;
  $("aidLabel").textContent = `補助: ${AID_LABELS[s.aid]}`;
  $("score").textContent = `${s.round}${settings?.rounds ? `/${settings.rounds}` : ""}  ✓${s.passed}/${s.attempted}`;
  $("steps").classList.toggle("many", s.order.length > 5);
  $("steps").replaceChildren(
    ...s.order.map((degree, i) => {
      const el = document.createElement("span");
      el.textContent = s.labels[degree];
      el.classList.toggle("done", i < s.step);
      el.classList.toggle("current", i === s.step && s.phase !== "done");
      el.classList.toggle("in-tune", i === s.step && s.inTune);
      return el;
    }),
  );
}

// --- Pitch graph ---

const GRAPH_SECONDS = 6;

function draw() {
  if (!trainer || !ctx) return;
  const canvas = $<HTMLCanvasElement>("graph");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext("2d")!;
  g.clearRect(0, 0, w, h);

  const { tones, target, labels } = trainer.state;
  if (tones.length) {
    const lo = Math.min(...tones) - 3;
    const hi = Math.max(...tones) + 3;
    const y = (midi: number) => h - ((midi - lo) / (hi - lo)) * h;
    const tolSemis = settings!.tolerance / 100;

    tones.forEach((m, i) => {
      const active = m === target;
      g.fillStyle = active ? "rgba(62,207,142,0.22)" : "rgba(255,255,255,0.06)";
      g.fillRect(0, y(m + tolSemis), w, y(m - tolSemis) - y(m + tolSemis));
      g.strokeStyle = active ? "#3ecf8e" : "rgba(255,255,255,0.25)";
      g.lineWidth = dpr;
      g.beginPath();
      g.moveTo(0, y(m));
      g.lineTo(w, y(m));
      g.stroke();
      g.fillStyle = active ? "#3ecf8e" : "#8b90a0";
      g.font = `${12 * dpr}px system-ui`;
      g.fillText(`${labels[i]} ${midiName(m)}`, 6 * dpr, y(m) - 4 * dpr);
    });

    const now = ctx.currentTime;
    g.strokeStyle = "#e8e9ee";
    g.lineWidth = 2.5 * dpr;
    g.beginPath();
    let drawing = false;
    for (const p of history) {
      if (p.midi === null) {
        drawing = false;
        continue;
      }
      let m = p.midi;
      // With octave-free judging, show the voice folded into the chord's octave.
      if (settings!.octaveFree && target != null) m = target + centsOff(midiToFreq(m), target, true) / 100;
      const x = w - ((now - p.time) / GRAPH_SECONDS) * w;
      if (drawing) g.lineTo(x, y(m));
      else g.moveTo(x, y(m));
      drawing = true;
    }
    g.stroke();
  }
  requestAnimationFrame(draw);
}
