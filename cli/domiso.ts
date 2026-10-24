// domiso CLI: turns a song into karaoke data for the domiso app.
//
//   pnpm cli <song> [--inst <instrumental>] [-o <dir>] [--title <title>] [--model <file>]
//   pnpm cli record [--process]   (records what the computer plays; see cli/record.ts)
//
// 0. Cuts silence at the start and end of the song
// 1. Separates the vocals with an AI model (audio-separator), and the instrumental too unless --inst is given
// 2. With --inst, aligns the official instrumental to the song and uses it as the backing track
// 3. Analyzes the vocals into semitone bars with the same code the app uses
// 4. Writes <title>.domiso.json; vocals, instrumental and the trimmed original as AAC (.m4a); the guide melody as MIDI
import { spawnSync } from "node:child_process";
import { recordCommand } from "./record";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyze, HOP } from "../src/karaoke/analyze";
import { melodyToMidi } from "../src/karaoke/midi";
import { soundRange } from "../src/karaoke/trim";
import { serializeSong, type Song } from "../src/karaoke/song";
import { alignmentLag } from "./align";

const ANALYSIS_RATE = 22050;
const ALIGN_RATE = 11025;
const DEFAULT_MODEL = "vocals_mel_band_roformer.ckpt";

const USAGE = `使い方: pnpm cli <曲の音声> [オプション]
       pnpm cli record [オプション]   PC で再生している音を録音（詳しくは pnpm cli record --help）

  --inst <file>        公式のインスト音源。指定すると AI 分離のインストの代わりに伴奏として使う
  -o, --out <dir>      出力先（既定: ./<タイトル>）
  --title <title>      曲名（既定: 入力ファイル名）
  --model <file>       audio-separator のモデル（既定: ${DEFAULT_MODEL}）
  --model-dir <dir>    モデルの保存先（既定: ~/.cache/domiso/models）
  --separator <cmd>    audio-separator コマンド（既定: audio-separator）
  --bitrate <rate>     AAC のビットレート（既定: 192k）
  --no-trim            前後の無音をカットしない
  -h, --help           このヘルプ`;

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      inst: { type: "string" },
      out: { type: "string", short: "o" },
      title: { type: "string" },
      model: { type: "string", default: DEFAULT_MODEL },
      "model-dir": { type: "string", default: join(homedir(), ".cache", "domiso", "models") },
      separator: { type: "string", default: "audio-separator" },
      bitrate: { type: "string", default: "192k" },
      "no-trim": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const input = userPath(positionals[0]);
  if (!existsSync(input)) fail(`ファイルがありません: ${input}`);
  if (values.inst && !existsSync(userPath(values.inst))) fail(`ファイルがありません: ${values.inst}`);
  requireCommand("ffmpeg", ["-version"]);
  requireCommand(values.separator, ["--version"]);

  const title = values.title ?? basename(input, extname(input));
  const outDir = userPath(values.out ?? title);
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "domiso-"));
  const started = Date.now();

  try {
    // 0. Silence. Everything after works on the trimmed song, so all outputs share one timeline.
    let source = input;
    let audioStart = 0;
    if (!values["no-trim"]) {
      const mono = decodeMono(input, ALIGN_RATE, work);
      const total = mono.length / ALIGN_RATE;
      const { start, end } = soundRange(mono, ALIGN_RATE);
      if (start > 0.05 || total - end > 0.05) {
        step(`前後の無音をカット（前 ${start.toFixed(1)}秒・後ろ ${(total - end).toFixed(1)}秒）`);
        source = join(work, "trimmed.wav");
        run("ffmpeg", ["-y", "-v", "error", "-i", input, "-af", `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`, "-c:a", "pcm_f32le", source]);
        audioStart = start;
      }
    }

    // 1. Separation. Model stems are named differently ("Instrumental" or "Other"); map both to inst.
    step(`ボーカルを分離中（${values.model}）`);
    const sepArgs = [
      source,
      "-m", values.model,
      "--model_file_dir", values["model-dir"],
      "--output_dir", work,
      "--output_format", "WAV",
      "--custom_output_names", JSON.stringify({ Vocals: "vocals", Instrumental: "inst", Other: "inst" }),
    ];
    if (values.inst) sepArgs.push("--single_stem", "Vocals");
    run(values.separator, sepArgs);
    const vocalsWav = join(work, "vocals.wav");
    if (!existsSync(vocalsWav)) fail("分離結果のボーカルが見つかりません");

    // 2. Backing track.
    let instWav = join(work, "inst.wav");
    if (values.inst) {
      step("インストの位置を合わせています");
      instWav = alignInstrumental(userPath(values.inst), source, work);
    } else if (!existsSync(instWav)) {
      fail("分離結果のインストが見つかりません。--inst でインスト音源を指定してください");
    }

    // 3. Analysis, with the exact code the app runs.
    step("音程を解析中");
    const samples = decodeMono(vocalsWav, ANALYSIS_RATE, work);
    const result = analyze(samples, ANALYSIS_RATE);
    if (!result.notes.length) fail("声が見つかりませんでした");

    // 4. Output.
    step("書き出し中");
    const vocalsFile = `${title}.vocals.m4a`;
    const instFile = `${title}.inst.m4a`;
    const originalFile = `${title}.original.m4a`;
    encodeAac(vocalsWav, join(outDir, vocalsFile), values.bitrate);
    encodeAac(instWav, join(outDir, instFile), values.bitrate);
    encodeAac(source, join(outDir, originalFile), values.bitrate);
    const song: Song = {
      format: "domiso-karaoke",
      version: 1,
      title,
      audioName: basename(input),
      ...(audioStart ? { audioStart: Math.round(audioStart * 1000) / 1000 } : {}),
      vocalsFile,
      instFile,
      originalFile,
      duration: samples.length / ANALYSIS_RATE,
      hop: HOP,
      offsetCents: result.offsetCents,
      notes: result.notes,
      contour: result.contour,
    };
    const jsonFile = `${title}.domiso.json`;
    writeFileSync(join(outDir, jsonFile), serializeSong(song));
    const midiFile = `${title}.guide.mid`;
    writeFileSync(join(outDir, midiFile), melodyToMidi(result.notes, title));

    const voiced = result.contour.filter((m) => m !== null).length * HOP;
    console.log(`
完了（${((Date.now() - started) / 1000).toFixed(0)}秒）: ${outDir}
  ${jsonFile}  音符 ${result.notes.length} 個・声 ${voiced.toFixed(0)}秒 / ${song.duration.toFixed(0)}秒・全体のずれ ${result.offsetCents}¢
  ${vocalsFile}
  ${instFile}${values.inst ? "（公式インスト）" : "（AI 分離）"}
  ${originalFile}（原曲。前後の無音だけカット）
  ${midiFile}（ガイドメロディ。DAW などで使えます）
.domiso.json と .m4a を、domiso のカラオケの「ファイルを開く」からまとめて選んでください（原曲は省いても構いません）。`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Shifts the official instrumental so it lines up with the song, and trims/pads it to the same length. */
function alignInstrumental(inst: string, song: string, work: string): string {
  const a = decodeMono(song, ALIGN_RATE, work);
  const b = decodeMono(inst, ALIGN_RATE, work);
  const { lag, correlation } = alignmentLag(a, b);
  const sec = lag / ALIGN_RATE;
  console.log(`  ずれ ${(sec * 1000).toFixed(1)}ms・相関 ${correlation.toFixed(2)}`);
  if (correlation < 0.5) console.warn("  警告: 相関が低いので、別の音源かもしれません");
  const duration = a.length / ALIGN_RATE;
  // lag > 0: the instrumental starts later in the song, so delay it; lag < 0: cut its head.
  const shift = sec >= 0 ? `adelay=${Math.round(sec * 1000)}:all=1` : `atrim=start=${-sec}`;
  const out = join(work, "inst_aligned.wav");
  run("ffmpeg", ["-y", "-v", "error", "-i", inst, "-af", `${shift},asetpts=PTS-STARTPTS,apad,atrim=end=${duration}`, out]);
  return out;
}

/**
 * Resolves a path the user typed. `pnpm cli` runs in the package directory, so relative paths are taken
 * from where the command was started (INIT_CWD) instead.
 */
export function userPath(p: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

function decodeMono(file: string, rate: number, work: string): Float32Array {
  const raw = join(work, "pcm.f32");
  run("ffmpeg", ["-y", "-v", "error", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", raw]);
  const buf = readFileSync(raw);
  rmSync(raw, { force: true });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function encodeAac(input: string, output: string, bitrate: string) {
  run("ffmpeg", ["-y", "-v", "error", "-i", input, "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart", output]);
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`${cmd} を実行できません: ${r.error.message}`);
  if (r.status !== 0) {
    process.stderr.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    fail(`${cmd} が失敗しました（終了コード ${r.status}）`);
  }
}

function requireCommand(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) {
    const hint =
      cmd === "ffmpeg"
        ? "ffmpeg をインストールしてください"
        : "audio-separator をインストールしてください（README の「CLI」を参照）";
    fail(`${cmd} が見つかりません。${hint}`);
  }
}

function step(text: string) {
  console.log(`▶ ${text}`);
}

function fail(message: string): never {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

if (process.argv[2] === "record") {
  void recordCommand(process.argv.slice(3), userPath, (file, extra) => {
    // Run the regular pipeline in a fresh process, exactly as `pnpm cli <file>` would.
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], file, ...extra], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  });
} else {
  main();
}
