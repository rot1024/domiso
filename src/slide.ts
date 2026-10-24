import { median } from "./pitch";
import { centsOff } from "./theory";

/** A window this long whose pitch spread is within SETTLE_SPREAD counts as "landed". */
const SETTLE_SEC = 0.12;
const SETTLE_SPREAD = 25;
/** A silence longer than this during a slide means the voice was cut. */
const BREAK_SEC = 0.3;

export interface Landing {
  time: number;
  /** Deviation from the target where the voice first came to rest, in cents. */
  cents: number;
  freq: number;
}

/**
 * Follows one continuous move from `prev` to `target` and finds where the voice first comes to rest.
 * Landing within tolerance on that first rest is what counts as hitting the note "in one go".
 */
export class SlideAnalyzer {
  leftAt: number | null = null;
  landing: Landing | null = null;
  broke = false;
  private lastVoiced: number;
  private win: { t: number; c: number; f: number }[] = [];

  constructor(
    private prev: number,
    private target: number,
    private tolerance: number,
    private octaveFree: boolean,
    /** When the move was cued; the voice is assumed to be sounding on the previous note then. */
    startTime: number,
  ) {
    this.lastVoiced = startTime;
  }

  /** Feeds one sample; returns the landing at the moment it is detected. */
  push(time: number, freq: number | null): Landing | null {
    if (freq === null) {
      if (!this.landing && time - this.lastVoiced > BREAK_SEC) this.broke = true;
      this.win = [];
      return null;
    }
    this.lastVoiced = time;
    if (this.landing) return null;

    if (this.leftAt === null) {
      if (Math.abs(centsOff(freq, this.prev, this.octaveFree)) <= this.tolerance) return null;
      this.leftAt = time;
    }

    this.win.push({ t: time, c: centsOff(freq, this.target, this.octaveFree), f: freq });
    while (time - this.win[0].t > SETTLE_SEC) this.win.shift();
    if (time - this.win[0].t < SETTLE_SEC * 0.75) return null;
    const cs = this.win.map((w) => w.c);
    if (Math.max(...cs) - Math.min(...cs) > SETTLE_SPREAD) return null;

    this.landing = { time, cents: median(cs), freq: median(this.win.map((w) => w.f)) };
    return this.landing;
  }

  get oneShot(): boolean {
    return !!this.landing && !this.broke && Math.abs(this.landing.cents) <= this.tolerance;
  }
}
