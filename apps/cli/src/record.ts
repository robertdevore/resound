import { spawn, spawnSync } from "node:child_process";

/**
 * macOS system-audio capture via ffmpeg + avfoundation.
 *
 * This is the "for real" capture path: it records the audio that is actually
 * playing on/through the Mac (the already-decrypted Discord call) plus your
 * microphone, so it is completely unaffected by Discord's DAVE/E2EE (which only
 * blocks bot-side voice receive). The result is a single mixed track — good for
 * a meeting transcript, though without per-speaker separation.
 */

export interface RecordOptions {
  outFile: string;
  /** avfoundation audio device for the call output (e.g. BlackHole index "1"). */
  systemDevice?: string;
  /** avfoundation audio device for your microphone (e.g. "2"). */
  micDevice?: string;
  /** Single-device capture instead of system+mic mix. */
  device?: string;
  /** Stop automatically after N seconds. 0/undefined = run until stop(). */
  durationSec?: number;
  ffmpegPath?: string;
  sampleRate?: number;
  /** Escape hatch for tests: replace the avfoundation inputs entirely. */
  rawInputArgs?: string[];
}

/** Build the ffmpeg argument vector (pure — no spawning, so it is testable). */
export function buildFfmpegArgs(opts: RecordOptions): string[] {
  const rate = opts.sampleRate ?? 16000;
  const args: string[] = ["-hide_banner", "-loglevel", "error"];

  const inputs: string[][] = [];
  if (opts.rawInputArgs) {
    inputs.push(opts.rawInputArgs);
  } else if (opts.device) {
    inputs.push(["-f", "avfoundation", "-i", `:${opts.device}`]);
  } else {
    if (opts.systemDevice) inputs.push(["-f", "avfoundation", "-i", `:${opts.systemDevice}`]);
    if (opts.micDevice) inputs.push(["-f", "avfoundation", "-i", `:${opts.micDevice}`]);
  }
  if (inputs.length === 0) {
    throw new Error("No capture device specified. Use --device, or --system and/or --mic.");
  }
  for (const inp of inputs) args.push(...inp);

  if (inputs.length > 1) {
    const labels = inputs.map((_, i) => `[${i}:a]`).join("");
    args.push("-filter_complex", `${labels}amix=inputs=${inputs.length}:duration=longest[a]`, "-map", "[a]");
  }

  args.push("-ac", "1", "-ar", String(rate));
  if (opts.durationSec && opts.durationSec > 0) args.push("-t", String(opts.durationSec));
  args.push("-y", opts.outFile);
  return args;
}

export interface Recording {
  /** Resolves with the output path when ffmpeg has finalized the file. */
  done: Promise<string>;
  /** Ask ffmpeg to finish writing and close the file cleanly. */
  stop(): void;
}

/** Start an ffmpeg capture. Call stop() (or rely on durationSec) to finish. */
export function recordAudio(opts: RecordOptions): Recording {
  const ffmpeg = opts.ffmpegPath ?? "ffmpeg";
  const args = buildFfmpegArgs(opts);
  const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });

  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));

  const done = new Promise<string>((resolve, reject) => {
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(new Error(`ffmpeg not found. Install it: brew install ffmpeg`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      // ffmpeg returns 255 when stopped via 'q'/SIGINT after writing a valid file.
      if (code === 0 || code === 255) resolve(opts.outFile);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });

  const stop = () => {
    try {
      child.stdin?.write("q");
      child.stdin?.end();
    } catch {
      child.kill("SIGINT");
    }
  };

  return { done, stop };
}

export interface AudioDevice {
  index: string;
  name: string;
}

/** List avfoundation audio input devices (macOS) by parsing ffmpeg's banner. */
export function listAudioDevices(ffmpegPath = "ffmpeg"): AudioDevice[] {
  const res = spawnSync(
    ffmpegPath,
    ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
    { encoding: "utf8" }
  );
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const devices: AudioDevice[] = [];
  let inAudio = false;
  for (const line of text.split("\n")) {
    if (/AVFoundation audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (inAudio) {
      const m = line.match(/\[(\d+)\]\s+(.*\S)\s*$/);
      if (m) devices.push({ index: m[1]!, name: m[2]! });
    }
  }
  return devices;
}
