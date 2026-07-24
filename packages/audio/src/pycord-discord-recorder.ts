import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  AudioChunk,
  Recorder,
  RecorderCapabilities,
  RecorderPreflightResult,
  RecorderStartOptions,
  RecordingContext,
  RecordingHealth
} from "./types.js";

export interface PycordDiscordRecorderOptions {
  token: string;
  guildId: string;
  channelId: string;
  pythonPath?: string;
  pythonPathEntries?: string[];
  startupTimeoutMs?: number;
}

interface SidecarReadyEvent {
  event: "ready";
  dave: boolean;
}

interface SidecarStoppedEvent {
  event: "stopped";
  tracks: AudioChunk[];
  warnings?: string[];
}

interface SidecarErrorEvent {
  event: "error";
  message: string;
}

type SidecarEvent = SidecarReadyEvent | SidecarStoppedEvent | SidecarErrorEvent;

function scriptPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../python/discord_native_sidecar.py");
}

function pythonEnv(entries: string[] | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const configured = process.env.RESOUND_DISCORD_PYTHONPATH?.split(path.delimiter).filter(Boolean) ?? [];
  const merged = [...(entries ?? []), ...configured];
  if (merged.length > 0) {
    env.PYTHONPATH = [env.PYTHONPATH, ...merged].filter(Boolean).join(path.delimiter);
  }
  return env;
}

function safeJsonParse(line: string): SidecarEvent | undefined {
  try {
    return JSON.parse(line) as SidecarEvent;
  } catch {
    return undefined;
  }
}

export class PycordDiscordRecorder implements Recorder {
  readonly id = "pycord-discord-recorder";
  readonly mode = "discord-native" as const;
  readonly capabilities: RecorderCapabilities = {
    mixedAudio: true,
    separateSpeakerTracks: true,
    reliableSpeakerIdentity: true,
    liveParticipantEvents: true,
    pauseResume: false,
    localOnly: false,
    reconnectSupport: false,
    healthMetrics: true,
    strictConsentCompatible: true,
    supportedPlatforms: ["darwin", "linux", "win32"],
    requiredCommands: ["python3"],
    requiredPermissions: ["Discord Connect permission", "Pycord + davey + PyNaCl + libopus runtime"],
    warnings: [
      "Discord-native sidecar still requires live Discord acceptance testing before being treated as production-ready."
    ]
  };

  private child?: ChildProcess;
  private lines?: readline.Interface;
  private status: RecordingHealth["status"] = "idle";
  private stopped?: SidecarStoppedEvent;
  private stderrTail = "";
  private pending:
    Array<{
      predicate: (event: SidecarEvent) => boolean;
      resolve: (event: SidecarEvent) => void;
      reject: (error: Error) => void;
    }> = [];

  constructor(private readonly options: PycordDiscordRecorderOptions) {}

  async preflight(context: RecordingContext): Promise<RecorderPreflightResult> {
    const python = this.options.pythonPath ?? process.env.RESOUND_DISCORD_PYTHON ?? "python3";
    const probe = spawnSync(python, [scriptPath(), "--probe"], {
      encoding: "utf8",
      env: pythonEnv(this.options.pythonPathEntries)
    });

    const dependencies = [
      {
        name: python,
        ok: !probe.error,
        detail: probe.error ? probe.error.message : `Detected ${python}`
      }
    ];
    const warnings: string[] = [];
    const errors: string[] = [];
    const remediation: string[] = [];

    if (probe.error) {
      errors.push(`Python runtime unavailable: ${probe.error.message}`);
      remediation.push("Install Python 3.10+ and set RESOUND_DISCORD_PYTHON if it is not on PATH.");
    } else {
      const parsed = (probe.stdout ?? "")
        .split(/\r?\n/u)
        .map((line) => safeJsonParse(line.trim()))
        .find((event): event is SidecarEvent => event !== undefined);
      if (parsed?.event === "error") {
        errors.push(parsed.message);
      } else if (parsed?.event === "ready") {
        dependencies.push({
          name: "pycord-sidecar",
          ok: true,
          detail: "Pycord Discord-native sidecar dependencies loaded."
        });
      } else {
        errors.push(`Sidecar probe did not return valid JSON. stderr: ${(probe.stderr ?? "").trim().slice(0, 300)}`);
      }
    }

    if (!this.options.token) errors.push("DISCORD_TOKEN is required for the Pycord sidecar recorder.");
    if (!this.options.guildId || !this.options.channelId) {
      errors.push("Guild ID and channel ID are required for Discord-native capture.");
    }

    warnings.push(...(this.capabilities.warnings ?? []));
    if (context.strictConsent === true) {
      warnings.push("Strict consent policy still requires live verification of participant mapping and track exclusion behavior.");
    }

    return {
      status: errors.length > 0 ? "fail" : "warning",
      recorderId: this.id,
      mode: this.mode,
      summary:
        errors.length > 0
          ? "Pycord Discord-native preflight failed."
          : "Pycord Discord-native preflight passed, but live acceptance testing is still required.",
      dependencies,
      warnings,
      errors,
      remediation:
        remediation.length > 0
          ? remediation
          : ["Run a live Discord smoke test in a real voice channel before relying on this path in production."]
    };
  }

  async start(options: RecorderStartOptions): Promise<void> {
    const python = this.options.pythonPath ?? process.env.RESOUND_DISCORD_PYTHON ?? "python3";
    const child = spawn(
      python,
      [
        scriptPath(),
        "--token",
        this.options.token,
        "--guild-id",
        this.options.guildId,
        "--channel-id",
        this.options.channelId,
        "--session-dir",
        options.sessionDir
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: pythonEnv(this.options.pythonPathEntries)
      }
    );
    this.child = child;
    this.lines = readline.createInterface({ input: child.stdout! });
    this.pending = [];
    this.status = "recording";
    this.stopped = undefined;
    this.stderrTail = "";

    child.stderr?.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000);
    });
    this.lines.on("line", (line) => this.handleLine(line));
    child.on("error", (err) => this.failPending(err));
    child.on("exit", (code, signal) => {
      if (this.status !== "idle" && this.status !== "failed") {
        this.failPending(
          new Error(`Pycord sidecar exited unexpectedly (${code ?? signal}). ${this.stderrTail.slice(0, 500)}`)
        );
      }
      this.child = undefined;
      this.lines?.close();
      this.lines = undefined;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Pycord sidecar did not become ready before timeout."));
      }, this.options.startupTimeoutMs ?? 20_000);
      this.waitForEvent((event): event is SidecarReadyEvent => event.event === "ready")
        .then(() => {
          clearTimeout(timeout);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  async stop(): Promise<AudioChunk[]> {
    if (!this.child) throw new Error("Pycord sidecar recorder has not been started.");
    this.status = "stopping";
    const stoppedPromise = this.waitForEvent((event): event is SidecarStoppedEvent => event.event === "stopped");
    this.child.stdin?.write("stop\n");
    this.child.stdin?.end();
    const stopped = await stoppedPromise;
    this.stopped = stopped;
    this.status = stopped.warnings?.length ? "warning" : "idle";
    return [...stopped.tracks].sort((a, b) => a.startSeconds - b.startSeconds);
  }

  getHealth(): RecordingHealth {
    return {
      status: this.status,
      summary:
        this.status === "recording"
          ? "Pycord Discord-native sidecar is recording."
          : this.status === "stopping"
            ? "Pycord Discord-native sidecar is finalizing audio."
            : this.status === "warning"
              ? "Pycord Discord-native sidecar completed with warnings."
              : "Pycord Discord-native sidecar is idle.",
      warnings: this.stopped?.warnings ?? (this.capabilities.warnings ?? [])
    };
  }

  captureSummary(): string[] {
    return this.stopped?.warnings ?? [];
  }

  private handleLine(line: string): void {
    const event = safeJsonParse(line.trim());
    if (!event) return;
    if (event.event === "error") {
      this.status = "failed";
      this.failPending(new Error(event.message));
      return;
    }
    const match = this.pending.find((entry) => entry.predicate(event));
    if (!match) return;
    this.pending = this.pending.filter((entry) => entry !== match);
    match.resolve(event);
  }

  private failPending(error: Error): void {
    const pending = [...this.pending];
    this.pending = [];
    for (const entry of pending) entry.reject(error);
  }

  private waitForEvent<T extends SidecarEvent>(
    predicate: (event: SidecarEvent) => event is T
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        predicate,
        resolve: (event) => resolve(event as T),
        reject
      });
    });
  }
}
