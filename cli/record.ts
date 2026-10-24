// pnpm cli record: records what the computer is playing (loopback) with ffmpeg, stops by itself once the
// sound has been followed by a stretch of silence, and saves a WAV with the silence around it cut.
//
// Windows (including WSL): DirectShow via Windows' ffmpeg.exe. Needs a device that carries the playback,
//   such as "Stereo Mix", VB-Cable's "CABLE Output" or a Voicemeeter output; --probe finds it.
// Linux: PulseAudio/PipeWire, recording the monitor of the default output. Under WSL, --backend pulse
//   records what Linux apps play instead of Windows.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";

const RATE = 44100;
const CHANNELS = 2;
const BLOCK_SEC = 0.1;
const PAD_BEFORE = 0.2;
const PAD_AFTER = 0.5;
const CONFIG = join(homedir(), ".config", "domiso", "record.json");

const USAGE = `使い方: pnpm cli record [オプション]

PC で再生している音を録音し、音が鳴り終わって無音が続いたら自動で止めて WAV に保存します。
前後の無音はカットします。Ctrl+C でもその時点までを保存して終了します。

  -o, --out <file>      保存先（既定: ./recording-<日時>.wav）
  --silence <sec>       この秒数だけ無音が続いたら終了（既定: 5）
  --threshold <dB>      この dBFS より小さい音を無音とみなす（既定: 50 → -50 dBFS。符号はどちらでもよい）
  --max <sec>           最長の録音時間（既定: 1800）
  --device <name>       録音デバイス（Windows: DirectShow のデバイス名、Linux: PulseAudio のソース名）
  --backend <name>      dshow（Windows）か pulse（Linux）。既定は自動（WSL では dshow）
  --list                録音デバイスの一覧
  --probe               音を流しながら実行すると、一番大きく鳴っているデバイスを選んで覚える
  --process             録音後、そのまま分離・解析までする（曲名は --title、既定はファイル名）
  --title <title>       --process のときの曲名
  -h, --help            このヘルプ

--process のときは --model、--model-dir、--separator も指定できます。`;

type Platform = "windows" | "linux";

function platform(backend?: string): Platform {
  if (backend === "dshow") return "windows";
  if (backend === "pulse") return "linux";
  if (backend) fail(`--backend は dshow か pulse です: ${backend}`);
  if (process.platform === "win32") return "windows";
  // Under WSL, sound plays on Windows, so record with Windows' own ffmpeg.
  try {
    if (/microsoft/i.test(readFileSync("/proc/version", "utf8"))) return "windows";
  } catch {
    // not Linux
  }
  return "linux";
}

function ffmpegBin(p: Platform): string {
  return p === "windows" && process.platform !== "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/** Audio capture devices: DirectShow names on Windows, PulseAudio sources on Linux. */
function listDevices(p: Platform): string[] {
  if (p === "windows") {
    const r = spawnSync(ffmpegBin(p), ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
      encoding: "utf8",
    });
    if (r.error) fail("Windows の ffmpeg.exe が見つかりません。Windows 側に ffmpeg をインストールしてください");
    return [...r.stderr.matchAll(/"([^"]+)" \(audio\)/g)].map((m) => m[1]);
  }
  const r = spawnSync("pactl", ["list", "short", "sources"], { encoding: "utf8" });
  if (r.error) fail("pactl が見つかりません（PulseAudio または PipeWire の pulse 互換が必要です）");
  return r.stdout
    .split("\n")
    .map((l) => l.split("\t")[1])
    .filter((n): n is string => !!n);
}

function defaultDevice(p: Platform): string {
  const saved = loadConfig().device;
  if (saved) return saved;
  // PulseAudio's name for the monitor of whatever the default output is.
  if (p === "linux") return "@DEFAULT_MONITOR@";
  {
    const loopback = listDevices(p).find((d) => /stereo mix|ステレオ ミキサー|what u hear|virtual-audio-capturer/i.test(d));
    if (loopback) return loopback;
  }
  fail(`録音デバイスが決まっていません。音を流しながら --probe を実行するか、--device で指定してください（--list で一覧）\n${ROUTING_HELP}`);
}

function inputArgs(p: Platform, device: string): string[] {
  return p === "windows" ? ["-f", "dshow", "-i", `audio=${device}`] : ["-f", "pulse", "-i", device];
}

/** Starts ffmpeg writing raw float32 stereo PCM to stdout. */
function capture(p: Platform, device: string) {
  return spawn(
    ffmpegBin(p),
    ["-hide_banner", "-loglevel", "error", ...inputArgs(p, device), "-ac", String(CHANNELS), "-ar", String(RATE), "-f", "f32le", "-"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

/** Splits a byte stream into whole blocks of float32 frames, keeping leftovers between chunks. */
function blockReader(onBlock: (samples: Float32Array) => void) {
  const blockBytes = Math.round(RATE * BLOCK_SEC) * CHANNELS * 4;
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= blockBytes) {
      const block = pending.subarray(0, blockBytes);
      pending = pending.subarray(blockBytes);
      const copy = new Float32Array(block.length / 4);
      Buffer.from(copy.buffer).set(block);
      onBlock(copy);
    }
  };
}

function levelDb(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return 10 * Math.log10(sum / samples.length + 1e-20);
}

/** Microphones hear the speakers through the room; they are not a loopback. */
const MIC = /マイク|microphone|\bmic\b|ヘッドセット|headset|webcam|カメラ/i;

const ROUTING_HELP = `Windows の再生音を録音するには、再生音が流れ込む録音デバイスが必要です（ffmpeg 単体では録れません）。
  - Voicemeeter: Windows の既定の再生デバイスを「Voicemeeter Input」にし、Voicemeeter で A1（スピーカー）と B1 をオン
    → 「Voicemeeter Out B1」に再生音が来ます
  - VB-Cable: 既定の再生デバイスを「CABLE Input」にする（このままでは自分には聞こえないので、
    サウンド設定の「CABLE Output」→「このデバイスを聴く」で普段のスピーカーを選ぶ）
  - サウンド設定の録音デバイスに「ステレオ ミキサー」があれば有効にする
設定したら、音を流しながら pnpm cli record --probe を実行してください。`;

/** Records each device for a moment and keeps the loudest; run it while something is playing. */
async function probe(p: Platform) {
  const devices = listDevices(p);
  if (!devices.length) fail("録音デバイスが見つかりません");
  console.log("各デバイスの音量を測っています（音を流したままにしてください）");
  let best: { device: string; db: number } | null = null;
  for (const device of devices) {
    const db = await new Promise<number>((done) => {
      const proc = capture(p, device);
      const levels: number[] = [];
      proc.stdout.on("data", blockReader((b) => levels.push(levelDb(b))));
      const finish = () => done(levels.length ? Math.max(...levels.slice(3)) : -Infinity);
      proc.on("close", finish);
      setTimeout(() => proc.kill(), 2000);
    });
    const mic = MIC.test(device);
    console.log(`  ${Number.isFinite(db) ? db.toFixed(1).padStart(6) : "  ――"} dB  ${device}${mic ? "（マイクなので対象外）" : ""}`);
    if (!mic && Number.isFinite(db) && (!best || db > best.db)) best = { device, db };
  }
  if (!best || best.db < -60) {
    fail(`再生音が来ているデバイスがありません。${p === "windows" ? `\n${ROUTING_HELP}` : "音を流しながら実行してください"}`);
  }
  saveConfig({ device: best.device });
  console.log(`\n「${best.device}」を録音デバイスにしました（${CONFIG} に保存）`);
}

async function record(p: Platform, device: string, out: string, opts: { silence: number; threshold: number; max: number }) {
  const raw = join(tmpdir(), `domiso-rec-${process.pid}.f32`);
  const fd = openSync(raw, "w");
  const proc = capture(p, device);
  let blocks = 0;
  let firstSound = -1;
  let lastSound = -1;
  let stopping = false;
  let errors = "";

  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Ask ffmpeg to finish cleanly; force it if it doesn't.
    proc.stdin.write("q");
    setTimeout(() => proc.kill(), 1500);
  };

  console.log(`録音デバイス: ${device}`);
  console.log(`音が鳴り始めるのを待っています…（無音が ${opts.silence}秒続いたら終了、Ctrl+C で中断して保存）`);
  proc.stderr.on("data", (d) => (errors += d));
  proc.stdout.on(
    "data",
    blockReader((b) => {
      if (stopping) return;
      writeSync(fd, Buffer.from(b.buffer));
      const t = blocks * BLOCK_SEC;
      blocks++;
      const db = levelDb(b);
      if (db > opts.threshold) {
        if (firstSound < 0) {
          firstSound = t;
          console.log("録音中");
        }
        lastSound = t + BLOCK_SEC;
      }
      if (firstSound >= 0) {
        const quiet = t + BLOCK_SEC - lastSound;
        const bar = db > opts.threshold ? "●" : "○";
        process.stdout.write(`\r  ${bar} ${clock(t - firstSound)}  ${db.toFixed(0).padStart(4)} dB  無音 ${quiet.toFixed(1)}/${opts.silence}秒   `);
        if (quiet >= opts.silence) stop();
      }
      if (t >= opts.max) stop();
    }),
  );
  process.once("SIGINT", stop);

  const code = await new Promise<number | null>((done) => proc.on("close", done));
  closeSync(fd);
  process.stdout.write("\n");
  if (firstSound < 0) {
    rmSync(raw, { force: true });
    if (!stopping && code !== 0) fail(`録音できませんでした: ${errors.trim() || `ffmpeg 終了コード ${code}`}`);
    fail("音が鳴らないまま終了しました");
  }

  const start = Math.max(0, firstSound - PAD_BEFORE);
  const end = Math.min(blocks * BLOCK_SEC, lastSound + PAD_AFTER);
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "f32le", "-ar", String(RATE), "-ac", String(CHANNELS), "-i", raw,
    "-af", `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`,
    "-c:a", "pcm_s16le", out,
  ]);
  rmSync(raw, { force: true });
  if (r.status !== 0) fail(`保存できませんでした: ${r.stderr}`);
  console.log(`保存しました: ${out}（${clock(end - start)}）`);
}

export async function recordCommand(
  argv: string[],
  userPath: (p: string) => string,
  processSong: (file: string, extra: string[]) => void,
) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string", short: "o" },
      silence: { type: "string", default: "5" },
      threshold: { type: "string", default: "50" },
      max: { type: "string", default: "1800" },
      device: { type: "string" },
      backend: { type: "string" },
      list: { type: "boolean" },
      probe: { type: "boolean" },
      process: { type: "boolean" },
      title: { type: "string" },
      model: { type: "string" },
      "model-dir": { type: "string" },
      separator: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const p = platform(values.backend);
  if (values.list) {
    const saved = loadConfig().device;
    for (const d of listDevices(p)) console.log(`${d === saved ? "*" : " "} ${d}`);
    return;
  }
  if (values.probe) {
    await probe(p);
    return;
  }

  const device = values.device ?? defaultDevice(p);
  const out = userPath(values.out ?? `recording-${timestamp()}.wav`);
  await record(p, device, out, {
    silence: Number(values.silence),
    // Accept "50" as well as "--threshold=-50"; a leading minus is awkward to pass on the command line.
    threshold: -Math.abs(Number(values.threshold)),
    max: Number(values.max),
  });

  if (values.process) {
    // Results go next to the recording, in a folder named after the song.
    const title = values.title ?? basename(out, extname(out));
    const extra: string[] = ["--title", title, "-o", join(dirname(out), title)];
    for (const k of ["model", "model-dir", "separator"] as const) {
      if (values[k]) extra.push(`--${k}`, values[k]!);
    }
    processSong(out, extra);
  }
}

function loadConfig(): { device?: string } {
  try {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
  } catch {
    return {};
  }
}

function saveConfig(c: { device?: string }) {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ ...loadConfig(), ...c }, null, 2) + "\n");
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function timestamp(): string {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function fail(message: string): never {
  console.error(`エラー: ${message}`);
  process.exit(1);
}
