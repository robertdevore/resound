import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sessionPaths } from "@resound/core";
import type { AudioChunk, Recorder, RecorderStartOptions } from "./types.js";

export interface SystemRecorderOptions {
  /** avfoundation audio device for call/system output, e.g. BlackHole index "1". */
  systemDevice?: string;
  /** avfoundation audio device for local microphone. */
  micDevice?: string;
  /** Single capture device instead of system+mic. */
  device?: string;
  ffmpegPath?: string;
  sampleRate?: number;
}

export function buildSystemFfmpegArgs(
  opts: SystemRecorderOptions & { outFile: string }
): string[] {
  const rate = opts.sampleRate ?? 16000;
  const args: string[] = ["-hide_banner", "-loglevel", "error"];
  const inputs: string[][] = [];

  if (opts.device) {
    inputs.push(["-f", "avfoundation", "-i", `:${opts.device}`]);
  } else {
    if (opts.systemDevice) inputs.push(["-f", "avfoundation", "-i", `:${opts.systemDevice}`]);
    if (opts.micDevice) inputs.push(["-f", "avfoundation", "-i", `:${opts.micDevice}`]);
  }

  if (inputs.length === 0) {
    throw new Error(
      "No capture device specified. Set RESOUND_AUDIO_SYSTEM_DEVICE/RESOUND_AUDIO_MIC_DEVICE or RESOUND_AUDIO_DEVICE."
    );
  }

  for (const input of inputs) args.push(...input);

  if (inputs.length > 1) {
    const labels = inputs.map((_, i) => `[${i}:a]`).join("");
    args.push("-filter_complex", `${labels}amix=inputs=${inputs.length}:duration=longest[a]`, "-map", "[a]");
  }

  args.push("-ac", "1", "-ar", String(rate), "-y", opts.outFile);
  return args;
}

export function isCleanSystemRecorderClose(
  code: number | null,
  signal: NodeJS.Signals | null
): boolean {
  return code === 0 || code === 255 || signal === "SIGINT" || signal === "SIGTERM";
}

export class SystemRecorder implements Recorder {
  readonly mode = "system" as const;
  private child?: ChildProcess;
  private done?: Promise<string>;
  private outFile?: string;
  private startedAt = 0;

  constructor(private readonly options: SystemRecorderOptions = {}) {}

  async start(options: RecorderStartOptions): Promise<void> {
    const paths = sessionPaths(options.sessionDir);
    fs.mkdirSync(paths.audioRaw, { recursive: true });
    this.outFile = path.join(paths.audioRaw, "recording.wav");
    this.startedAt = Date.now();

    const ffmpeg = this.options.ffmpegPath ?? "ffmpeg";
    const args = buildSystemFfmpegArgs({ ...this.options, outFile: this.outFile });
    const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
    this.child = child;

    let stderr = "";
    child.stderr.on("data", (data) => (stderr += String(data)));

    this.done = new Promise((resolve, reject) => {
      child.on("error", (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") reject(new Error("ffmpeg not found. Install it: brew install ffmpeg"));
        else reject(err);
      });
      child.on("close", (code, signal) => {
        if (isCleanSystemRecorderClose(code, signal)) resolve(this.outFile!);
        else reject(new Error(`ffmpeg exited ${code ?? signal}: ${stderr.slice(0, 500)}`));
      });
    });
  }

  async stop(): Promise<AudioChunk[]> {
    if (!this.child || !this.done || !this.outFile) {
      throw new Error("System recorder has not been started.");
    }

    try {
      if (!this.child.stdin) throw new Error("ffmpeg stdin unavailable");
      this.child.stdin.write("q");
      this.child.stdin.end();
    } catch {
      this.child.kill("SIGINT");
    }

    const file = await this.done;
    const durationSeconds = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
    this.child = undefined;
    this.done = undefined;

    return [
      {
        userId: "local",
        username: "Local Capture",
        path: file,
        startSeconds: 0,
        durationSeconds
      }
    ];
  }
}
