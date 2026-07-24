import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionPaths } from "@resound/core";
import type {
  AudioChunk,
  Recorder,
  RecorderCapabilities,
  RecorderPreflightResult,
  RecorderStartOptions,
  RecordingContext,
  RecordingHealth
} from "./types.js";

export interface SystemRecorderOptions {
  /** avfoundation audio device for call/system output, e.g. BlackHole index "1". */
  systemDevice?: string;
  /** avfoundation audio device for local microphone. */
  micDevice?: string;
  /** Single capture device instead of system+mic. */
  device?: string;
  ffmpegPath?: string;
  sampleRate?: number;
  /** How long to watch ffmpeg for immediate device/permission failures. */
  startupProbeMs?: number;
}

function canWriteDir(dir: string): { ok: boolean; detail: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true, detail: `Writable: ${dir}` };
  } catch (err) {
    return { ok: false, detail: `Cannot write to ${dir}: ${(err as Error).message}` };
  }
}

function commandExists(command: string): { ok: boolean; detail: string } {
  const result = spawnSync(command, ["-version"], { encoding: "utf8" });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, detail: `Command not found: ${command}` };
    return { ok: false, detail: `Failed to execute ${command}: ${result.error.message}` };
  }
  return { ok: true, detail: `Detected ${command}` };
}

export function buildSystemFfmpegArgs(
  opts: SystemRecorderOptions & { outFile: string; systemOutFile?: string; micOutFile?: string }
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
    const prepared = inputs.map((_, i) => `[${i}:a]aresample=${rate}:async=1:first_pts=0[in${i}]`);
    const labels = inputs.map((_, i) => `[in${i}]`).join("");
    args.push(
      "-filter_complex",
      `${prepared.join(";")};${labels}amix=inputs=${inputs.length}:duration=longest:normalize=0,alimiter=limit=0.95[mix]`,
      "-map",
      "[mix]"
    );
  }

  args.push("-c:a", "pcm_s16le", "-ac", "1", "-ar", String(rate), "-y", opts.outFile);

  // Preserve each side of a two-device capture. These tracks make it possible
  // to prove that both the call output and local microphone actually contained
  // audio instead of silently producing a partial transcript.
  if (inputs.length > 1 && opts.systemOutFile && opts.micOutFile) {
    args.push(
      "-map",
      "0:a",
      "-c:a",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      String(rate),
      "-y",
      opts.systemOutFile,
      "-map",
      "1:a",
      "-c:a",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      String(rate),
      "-y",
      opts.micOutFile
    );
  }
  return args;
}

export function isCleanSystemRecorderClose(
  code: number | null,
  signal: NodeJS.Signals | null
): boolean {
  return code === 0 || code === 255 || signal === "SIGINT" || signal === "SIGTERM";
}

export class SystemRecorder implements Recorder {
  readonly id = "system-recorder";
  readonly mode = "local-capture" as const;
  readonly capabilities: RecorderCapabilities = {
    mixedAudio: true,
    separateSpeakerTracks: true,
    reliableSpeakerIdentity: false,
    liveParticipantEvents: false,
    pauseResume: true,
    localOnly: true,
    reconnectSupport: false,
    healthMetrics: true,
    strictConsentCompatible: false,
    supportedPlatforms: ["darwin"],
    requiredCommands: ["ffmpeg"],
    requiredPermissions: ["Microphone access in macOS"],
    warnings: [
      "Local capture cannot selectively exclude one remote participant from a mixed system track."
    ]
  };
  private child?: ChildProcess;
  private done?: Promise<string>;
  private outFile?: string;
  private systemOutFile?: string;
  private micOutFile?: string;
  private startedAt = 0;
  private paused = false;
  private status: RecordingHealth["status"] = "idle";

  constructor(private readonly options: SystemRecorderOptions = {}) {}

  async preflight(context: RecordingContext): Promise<RecorderPreflightResult> {
    const ffmpeg = this.options.ffmpegPath ?? "ffmpeg";
    const ffmpegStatus = commandExists(ffmpeg);
    const writable = canWriteDir(context.outputDir ?? context.sessionDir);
    const dependencies = [
      { name: ffmpeg, ok: ffmpegStatus.ok, detail: ffmpegStatus.detail },
      { name: "output-directory", ok: writable.ok, detail: writable.detail }
    ];
    const warnings: string[] = [];
    const errors: string[] = [];
    const remediation: string[] = [];
    const selectedDevices: Array<{ role: string; value: string }> = [];

    if (os.platform() !== "darwin") {
      errors.push("Local capture is only implemented for macOS AVFoundation.");
      remediation.push("Use mock or discord-native mode on non-macOS hosts.");
    }

    if (this.options.device) {
      selectedDevices.push({ role: "device", value: this.options.device });
    } else {
      if (this.options.systemDevice) selectedDevices.push({ role: "system", value: this.options.systemDevice });
      if (this.options.micDevice) selectedDevices.push({ role: "mic", value: this.options.micDevice });
    }

    if (selectedDevices.length === 0) {
      errors.push(
        "No capture device configured. Set RESOUND_AUDIO_SYSTEM_DEVICE / RESOUND_AUDIO_MIC_DEVICE or RESOUND_AUDIO_DEVICE."
      );
      remediation.push("Run `resound audio devices` and configure the intended devices before recording.");
    }

    if (context.strictConsent) {
      warnings.push(
        "Strict per-participant consent is not compatible with local mixed system capture."
      );
      remediation.push("Use discord-native mode when selective speaker exclusion is required.");
    }

    for (const dependency of dependencies) {
      if (!dependency.ok) errors.push(dependency.detail);
    }

    return {
      status: errors.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass",
      recorderId: this.id,
      mode: this.mode,
      summary:
        errors.length > 0
          ? "Local capture preflight failed."
          : warnings.length > 0
            ? "Local capture preflight passed with warnings."
            : "Local capture preflight passed.",
      dependencies,
      warnings,
      errors,
      remediation,
      selectedDevices
    };
  }

  async start(options: RecorderStartOptions): Promise<void> {
    const paths = sessionPaths(options.sessionDir);
    fs.mkdirSync(paths.audioRaw, { recursive: true });
    this.outFile = path.join(paths.audioRaw, "recording.wav");
    this.systemOutFile = this.options.systemDevice && this.options.micDevice
      ? path.join(paths.audioRaw, "system.wav")
      : undefined;
    this.micOutFile = this.options.systemDevice && this.options.micDevice
      ? path.join(paths.audioRaw, "microphone.wav")
      : undefined;
    this.startedAt = Date.now();
    this.paused = false;
    this.status = "recording";

    const ffmpeg = this.options.ffmpegPath ?? "ffmpeg";
    const args = buildSystemFfmpegArgs({
      ...this.options,
      outFile: this.outFile,
      systemOutFile: this.systemOutFile,
      micOutFile: this.micOutFile
    });
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

    // `spawn()` succeeding only proves ffmpeg exists. Invalid device indices
    // and macOS permission failures arrive just after spawn, so do not announce
    // a recording until it has survived that startup window.
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, this.options.startupProbeMs ?? 750)),
      this.done.then(
        () => Promise.reject(new Error("ffmpeg stopped before audio capture became ready.")),
        (err) => Promise.reject(err)
      )
    ]);
  }

  pause(): void {
    if (!this.child || this.child.exitCode !== null) throw new Error("System recorder is not running.");
    if (!this.paused) {
      this.child.kill("SIGSTOP");
      this.paused = true;
      this.status = "paused";
    }
  }

  resume(): void {
    if (!this.child || this.child.exitCode !== null) throw new Error("System recorder is not running.");
    if (this.paused) {
      this.child.kill("SIGCONT");
      this.paused = false;
      this.status = "recording";
    }
  }

  async stop(): Promise<AudioChunk[]> {
    if (!this.child || !this.done || !this.outFile) {
      throw new Error("System recorder has not been started.");
    }

    if (this.paused) this.resume();

    this.status = "stopping";
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
    this.paused = false;
    this.status = "idle";

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

  async captureSummary(): Promise<string[]> {
    const ffmpeg = this.options.ffmpegPath ?? "ffmpeg";
    const reports: string[] = [];
    const inputs: Array<[string, string | undefined]> = [
      ["meeting/system audio", this.systemOutFile],
      ["local microphone", this.micOutFile]
    ];
    for (const [label, file] of inputs) {
      if (!file || !fs.existsSync(file)) continue;
      reports.push(await probeLevel(ffmpeg, file, label));
    }
    return reports;
  }

  getHealth(): RecordingHealth {
    return {
      status: this.status,
      summary:
        this.status === "paused"
          ? "Local capture paused."
          : this.status === "recording"
            ? "Local capture running."
            : this.status === "stopping"
              ? "Local capture finalizing audio."
              : "Local capture idle.",
      warnings: this.capabilities.warnings ?? [],
      metrics: {
        elapsedSeconds: this.startedAt > 0 ? Math.max(0, Math.round((Date.now() - this.startedAt) / 1000)) : 0
      }
    };
  }
}

async function probeLevel(ffmpeg: string, file: string, label: string): Promise<string> {
  return await new Promise((resolve) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (data) => (stderr += String(data)));
    child.on("error", (err) => resolve(`⚠️ ${label}: could not inspect audio (${err.message})`));
    child.on("close", () => {
      const max = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/i)?.[1];
      const mean = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/i)?.[1];
      const maxDb = max === undefined ? Number.NEGATIVE_INFINITY : Number(max);
      if (!Number.isFinite(maxDb) || maxDb <= -60) {
        resolve(`❌ ${label}: silent — check the configured device and macOS audio routing`);
      } else {
        resolve(`✅ ${label}: audio detected (peak ${max} dB, average ${mean ?? "unknown"} dB)`);
      }
    });
  });
}
