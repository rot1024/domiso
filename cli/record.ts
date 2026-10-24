// pnpm cli record: records what the computer is playing (loopback), stops by itself once the sound has
// been followed by a stretch of silence, and saves a WAV with the silence around it cut.
//
// Backends:
//   wasapi  Windows (including WSL), the default there: WASAPI loopback of an output device, like
//           Audacity's loopback devices. Runs cli/wasapi-loopback.ps1 with Windows PowerShell.
//   dshow   Windows: DirectShow via Windows' ffmpeg.exe. Needs a device that carries the playback
//           ("Stereo Mix", VB-Cable's "CABLE Output", a Voicemeeter output).
//   pulse   Linux, the default there: the monitor of PulseAudio/PipeWire's default output. Under WSL it
//           records what Linux apps play.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BLOCK_SEC = 0.1;
const PAD_BEFORE = 0.2;
const PAD_AFTER = 0.5;
const CONFIG = join(homedir(), ".config", "domiso", "record.json");
/** What ffmpeg-based backends are asked to produce. */
const FFMPEG_FORMAT = { rate: 44100, channels: 2 };

const USAGE = `使い方: pnpm cli record [オプション]

PC で再生している音を録音し、音が鳴り終わって無音が続いたら自動で止めて WAV に保存します。
前後の無音はカットします。Ctrl+C でもその時点までを保存して終了します。

  -o, --out <file>      保存先（既定: ./recording-<日時>.wav）
  --silence <sec>       この秒数だけ無音が続いたら終了（既定: 5）
  --threshold <dB>      この dBFS より小さい音を無音とみなす（既定: 50 → -50 dBFS。符号はどちらでもよい）
  --max <sec>           最長の録音時間（既定: 1800）
  --device <name>       録音デバイス。wasapi: 出力デバイス名の一部（既定は既定の出力デバイス）、
                        dshow: DirectShow のデバイス名、pulse: PulseAudio のソース名
  --backend <name>      wasapi / dshow / pulse（既定: Windows と WSL は wasapi、Linux は pulse）
  --list                デバイスの一覧（* は保存済みの選択）
  --probe               音を流しながら実行すると、一番大きく鳴っているデバイスを選んで覚える
  --process             録音後、そのまま分離・解析までする（曲名は --title、既定はファイル名）
  --title <title>       --process のときの曲名
  -h, --help            このヘルプ

--process のときは --model、--model-dir、--separator も指定できます。`;

type Backend = "wasapi" | "dshow" | "pulse";

function isWsl(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function pickBackend(name?: string): Backend {
  if (name === "wasapi" || name === "dshow" || name === "pulse") return name;
  if (name) fail(`--backend は wasapi、dshow、pulse のどれかです: ${name}`);
  return process.platform === "win32" || isWsl() ? "wasapi" : "pulse";
}

/** Windows programs are called with .exe from WSL. */
const winExe = (name: string) => (process.platform === "win32" ? name : `${name}.exe`);

/**
 * Windows PowerShell can't run a script from the WSL file system, so it is copied to Windows' temp folder.
 * Returns the Windows path to pass to -File.
 */
function wasapiScript(): string {
  const src = join(dirname(fileURLToPath(import.meta.url)), "wasapi-loopback.ps1");
  if (process.platform === "win32") return src;
  const win = spawnSync("cmd.exe", ["/c", "echo %TEMP%"], { encoding: "utf8", cwd: "/mnt/c" }).stdout?.trim();
  if (!win) fail("Windows の一時フォルダが分かりません");
  const dest = `${win}\\domiso-wasapi-loopback.ps1`;
  const linux = spawnSync("wslpath", ["-u", dest], { encoding: "utf8" }).stdout.trim();
  writeFileSync(linux, readFileSync(src));
  return dest;
}

function powershell(args: string[]) {
  return [winExe("powershell"), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wasapiScript(), ...args]] as const;
}

/** Devices for the backend: output devices for wasapi, capture devices for dshow, sources for pulse. */
function listDevices(b: Backend): string[] {
  if (b === "wasapi") {
    const [cmd, args] = powershell(["-List"]);
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    if (r.error || r.status !== 0) fail(`出力デバイスを取得できませんでした: ${r.error?.message ?? r.stderr}`);
    return r.stdout.split(/\r?\n/).filter(Boolean);
  }
  if (b === "dshow") {
    const r = spawnSync(winExe("ffmpeg"), ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
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

function defaultDevice(b: Backend): string {
  const saved = loadConfig();
  if (saved.device && saved.backend === b) return saved.device;
  // Empty means the default output device to the WASAPI helper.
  if (b === "wasapi") return "";
  // PulseAudio's name for the monitor of whatever the default output is.
  if (b === "pulse") return "@DEFAULT_MONITOR@";
  const loopback = listDevices(b).find((d) => /stereo mix|ステレオ ミキサー|what u hear|virtual-audio-capturer/i.test(d));
  if (loopback) return loopback;
  fail(`録音デバイスが決まっていません。音を流しながら --probe を実行するか、--device で指定してください（--list で一覧）\n${ROUTING_HELP}`);
}

interface Capture {
  proc: ChildProcessWithoutNullStreams;
  /** Resolves once the sample format is known (the WASAPI helper reports the device's own format). */
  format: Promise<{ rate: number; channels: number; name: string }>;
}

/** Starts capturing; the process writes interleaved float32 PCM to stdout and stops on "q" on stdin. */
function capture(b: Backend, device: string): Capture {
  if (b === "wasapi") {
    const [cmd, args] = powershell(device ? ["-Device", device] : []);
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const format = new Promise<{ rate: number; channels: number; name: string }>((resolve, reject) => {
      let err = "";
      proc.stderr.on("data", (d) => {
        err += d;
        const m = err.match(/FORMAT (\d+) (\d+) (.*)\r?\n/);
        if (m) resolve({ rate: Number(m[1]), channels: Number(m[2]), name: m[3] });
      });
      proc.on("close", () => reject(new Error(err.trim() || "WASAPI の録音を開始できませんでした")));
    });
    return { proc, format };
  }
  const input = b === "dshow" ? ["-f", "dshow", "-i", `audio=${device}`] : ["-f", "pulse", "-i", device];
  const { rate, channels } = FFMPEG_FORMAT;
  const proc = spawn(
    b === "dshow" ? winExe("ffmpeg") : "ffmpeg",
    ["-hide_banner", "-loglevel", "error", ...input, "-ac", String(channels), "-ar", String(rate), "-f", "f32le", "-"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  return { proc, format: Promise.resolve({ rate, channels, name: device }) };
}

/** Splits a byte stream into whole blocks of float32 frames, keeping leftovers between chunks. */
function blockReader(rate: number, channels: number, onBlock: (samples: Float32Array) => void) {
  const blockBytes = Math.round(rate * BLOCK_SEC) * channels * 4;
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

const ROUTING_HELP = `dshow 方式で Windows の再生音を録音するには、再生音が流れ込む録音デバイスが必要です
（既定の wasapi 方式なら設定は要りません）。
  - Voicemeeter: Windows の既定の再生デバイスを「Voicemeeter Input」にし、Voicemeeter で A1（スピーカー）と B1 をオン
    → 「Voicemeeter Out B1」に再生音が来ます
  - VB-Cable: 既定の再生デバイスを「CABLE Input」にする（このままでは自分には聞こえないので、
    サウンド設定の「CABLE Output」→「このデバイスを聴く」で普段のスピーカーを選ぶ）
  - サウンド設定の録音デバイスに「ステレオ ミキサー」があれば有効にする
設定したら、音を流しながら pnpm cli record --probe を実行してください。`;

/** Records each device for a moment and keeps the loudest; run it while something is playing. */
async function probe(b: Backend) {
  const devices = listDevices(b);
  if (!devices.length) fail("録音デバイスが見つかりません");
  console.log("各デバイスの音量を測っています（音を流したままにしてください）");
  let best: { device: string; db: number } | null = null;
  for (const device of devices) {
    const db = await new Promise<number>((done) => {
      const { proc, format } = capture(b, device);
      const levels: number[] = [];
      const chunks: Buffer[] = [];
      proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      proc.on("close", () => {
        format
          .then(({ rate, channels }) => {
            const read = blockReader(rate, channels, (x) => levels.push(levelDb(x)));
            chunks.forEach(read);
            done(levels.length > 3 ? Math.max(...levels.slice(3)) : -Infinity);
          })
          .catch(() => done(-Infinity));
      });
      // The WASAPI helper takes a moment to start; give every backend a couple of seconds of audio.
      format.then(() => setTimeout(() => proc.stdin.end("q"), 2000)).catch(() => {});
      setTimeout(() => proc.kill(), 8000);
    });
    // Capture devices can be microphones; wasapi lists outputs, where a headset is a fine choice.
    const mic = b !== "wasapi" && MIC.test(device);
    console.log(`  ${Number.isFinite(db) ? db.toFixed(1).padStart(6) : "  ――"} dB  ${device}${mic ? "（マイクなので対象外）" : ""}`);
    if (!mic && Number.isFinite(db) && (!best || db > best.db)) best = { device, db };
  }
  if (!best || best.db < -60) {
    fail(`再生音が来ているデバイスがありません。${b === "dshow" ? `\n${ROUTING_HELP}` : "音を流しながら実行してください"}`);
  }
  saveConfig({ backend: b, device: best.device });
  console.log(`\n「${best.device}」を録音デバイスにしました（${CONFIG} に保存）`);
}

async function record(b: Backend, device: string, out: string, opts: { silence: number; threshold: number; max: number }) {
  const raw = join(tmpdir(), `domiso-rec-${process.pid}.f32`);
  const fd = openSync(raw, "w");
  const { proc, format } = capture(b, device);
  let blocks = 0;
  let firstSound = -1;
  let lastSound = -1;
  let stopping = false;
  let errors = "";

  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Ask the recorder to finish cleanly; force it if it doesn't.
    proc.stdin.end("q");
    setTimeout(() => proc.kill(), 3000);
  };

  proc.stderr.on("data", (d) => (errors += d));
  const fmt = await format.catch((e: Error) => fail(`録音を開始できませんでした: ${e.message}`));
  console.log(`録音デバイス: ${fmt.name || device}（${b}、${fmt.rate} Hz・${fmt.channels}ch）`);
  console.log(`音が鳴り始めるのを待っています…（無音が ${opts.silence}秒続いたら終了、Ctrl+C で中断して保存）`);
  proc.stdout.on(
    "data",
    blockReader(fmt.rate, fmt.channels, (b) => {
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
    if (!stopping && code !== 0) fail(`録音できませんでした: ${errors.trim() || `終了コード ${code}`}`);
    fail("音が鳴らないまま終了しました");
  }

  const start = Math.max(0, firstSound - PAD_BEFORE);
  const end = Math.min(blocks * BLOCK_SEC, lastSound + PAD_AFTER);
  mkdirSync(dirname(out), { recursive: true });
  const r = spawnSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "f32le", "-ar", String(fmt.rate), "-ac", String(fmt.channels), "-i", raw,
    "-af", `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`,
    // Surround outputs are folded down to stereo.
    "-ac", String(Math.min(2, fmt.channels)),
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
  const b = pickBackend(values.backend ?? loadConfig().backend);
  if (values.list) {
    const saved = loadConfig();
    const devices = listDevices(b);
    devices.forEach((d, i) => {
      const mark = saved.backend === b && d === saved.device ? "*" : " ";
      console.log(`${mark} ${d}${b === "wasapi" && i === 0 ? "（既定の出力）" : ""}`);
    });
    return;
  }
  if (values.probe) {
    await probe(b);
    return;
  }

  const device = values.device ?? defaultDevice(b);
  const out = userPath(values.out ?? `recording-${timestamp()}.wav`);
  await record(b, device, out, {
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

function loadConfig(): { backend?: Backend; device?: string } {
  try {
    return existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
  } catch {
    return {};
  }
}

function saveConfig(c: { backend?: Backend; device?: string }) {
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
