import { PitchTracker } from "./pitch";
import { Sound } from "./sound";

let ctx: AudioContext | null = null;
let sound: Sound | null = null;
let tracker: PitchTracker | null = null;

/** Must run inside a tap: iOS only allows audio and speech started from a user gesture. */
export async function openAudio(): Promise<{ ctx: AudioContext; sound: Sound; tracker: PitchTracker }> {
  ctx ??= new AudioContext();
  await ctx.resume();
  sound ??= new Sound(ctx);
  sound.unlockSpeech();
  tracker ??= await PitchTracker.open(ctx);
  return { ctx, sound, tracker };
}

let wakeLock: WakeLockSentinel | null = null;
let wantWakeLock = false;

/** Keeps the screen on while practicing; the mic and audio stop when the phone locks. */
export function keepAwake(on: boolean) {
  wantWakeLock = on;
  if (on) void acquire();
  else {
    void wakeLock?.release();
    wakeLock = null;
  }
}

async function acquire() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    // Not supported or denied; practice still works while the screen stays on.
  }
}

document.addEventListener("visibilitychange", () => {
  // The lock is released whenever the page is hidden; take it again on return.
  if (document.visibilityState === "visible" && wantWakeLock) void acquire();
});
