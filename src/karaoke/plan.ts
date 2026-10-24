import { assess, pickWeak, segment, type Block, type Phrase } from "./phrases";
import { parseSong, type Song } from "./song";

/** What plays during a stage. */
export interface StagePlay {
  voice: boolean;
  inst: boolean;
  melody: boolean;
}

/**
 * One step of practising a phrase, as a teacher would: listen, pick out the notes on the piano, sing
 * along slowly with help, then take the help away and bring the speed back up.
 */
export interface Stage {
  name: string;
  /** listen: just play it; notes: piano note by note, sung back; sing: sing the phrase and get scored. */
  kind: "listen" | "notes" | "sing";
  speed: number;
  play: StagePlay;
  /** To clear the stage: this score (0-100) this many times in a row. */
  pass?: { score: number; times: number };
}

export const DEFAULT_STAGES: Stage[] = [
  { name: "聴く", kind: "listen", speed: 0.7, play: { voice: true, inst: true, melody: true } },
  { name: "音取り", kind: "notes", speed: 1, play: { voice: false, inst: false, melody: false } },
  { name: "一緒に", kind: "sing", speed: 0.75, play: { voice: true, inst: true, melody: true }, pass: { score: 70, times: 2 } },
  { name: "メロディだけ", kind: "sing", speed: 0.75, play: { voice: false, inst: true, melody: true }, pass: { score: 70, times: 2 } },
  { name: "伴奏だけ", kind: "sing", speed: 0.85, play: { voice: false, inst: true, melody: false }, pass: { score: 70, times: 2 } },
  { name: "あと少し", kind: "sing", speed: 0.95, play: { voice: false, inst: true, melody: false }, pass: { score: 75, times: 2 } },
  { name: "本番の速さ", kind: "sing", speed: 1, play: { voice: false, inst: true, melody: false }, pass: { score: 75, times: 2 } },
];

/** Joining phrases and whole blocks are sung once at full speed with the backing only. */
export const JOIN_STAGE: Stage = {
  name: "つなげて",
  kind: "sing",
  speed: 1,
  play: { voice: false, inst: true, melody: false },
  pass: { score: 70, times: 1 },
};

export interface PlanPhrase extends Phrase {
  /** Score in the take the plan was made from; null if the take didn't reach this phrase. */
  score: number | null;
  issues: string[];
  /** Index of the note sung worst. */
  worst: number;
}

export interface PhraseProgress {
  /** Index into stages of the stage being practised. */
  stage: number;
  cleared: boolean;
  best: number;
  history: { date: string; stage: number; score: number | null }[];
}

export interface Plan {
  format: "domiso-plan";
  version: 1;
  id: string;
  created: string;
  /** The song's analysis, so the plan opens on its own (with the song's audio files). */
  song: Song;
  octave: number;
  tolerance: number;
  phrases: PlanPhrase[];
  blocks: Block[];
  /** Phrases to practise, in song order. */
  focus: string[];
  stages: Stage[];
  progress: Record<string, PhraseProgress>;
  /** Joined runs and blocks already sung through: keys like "p3+p4" or "b2". */
  joined: string[];
  /** Whether the whole song has been sung through after the phrases were cleared. */
  finished: boolean;
}

/** Builds a plan from a take: splits the song into phrases and picks the weak ones to practise. */
export function makePlan(
  song: Song,
  notes: Song["notes"],
  points: { t: number; m: number | null }[],
  opts: { octave: number; tolerance: number },
): Plan {
  const { phrases, blocks } = segment(notes);
  const assessed = assess(notes, phrases, points, opts.tolerance);
  // Only phrases the take actually covered can be judged; a take stopped halfway says nothing about the rest.
  const times = points.map((p) => p.t);
  const from = Math.min(...times);
  const to = Math.max(...times);
  const covered = (i: number) => phrases[i].start >= from - 0.5 && phrases[i].end <= to + 0.5;
  const weak = new Set(pickWeak(assessed.filter((_, i) => covered(i))).map((a) => a.id));
  const planPhrases = phrases.map((ph, i) => ({
    ...ph,
    score: covered(i) ? assessed[i].score : null,
    issues: covered(i) ? assessed[i].issues : [],
    worst: assessed[i].worst,
  }));
  return {
    format: "domiso-plan",
    version: 1,
    id: crypto.randomUUID(),
    created: new Date().toISOString(),
    song,
    octave: opts.octave,
    tolerance: opts.tolerance,
    phrases: planPhrases,
    blocks,
    focus: phrases.filter((p) => weak.has(p.id)).map((p) => p.id),
    stages: DEFAULT_STAGES,
    progress: {},
    joined: [],
    finished: false,
  };
}

export function serializePlan(plan: Plan): string {
  return JSON.stringify(plan);
}

export function parsePlan(text: string): Plan | null {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  const p = d as Plan;
  if (p?.format !== "domiso-plan") return null;
  if (p.version !== 1 || !Array.isArray(p.phrases) || !Array.isArray(p.focus)) throw new Error("練習プランが壊れています");
  // Validates the embedded song the same way as a standalone analysis file.
  p.song = parseSong(JSON.stringify(p.song));
  p.stages ??= DEFAULT_STAGES;
  p.progress ??= {};
  p.joined ??= [];
  return p;
}

export function progressOf(plan: Plan, id: string): PhraseProgress {
  return (plan.progress[id] ??= { stage: 0, cleared: false, best: 0, history: [] });
}
