import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { deadlineMs, diagnosticPreview } from "@resound/core";
import { fileURLToPath } from "node:url";
import type {
  AudioChunk,
  Recorder,
  RecorderCapabilities,
  RecorderPreflightResult,
  RecorderStartOptions,
  RecordingContext,
  RecordingHealth,
} from "./types.js";

export interface PycordDiscordRecorderOptions {
  token: string;
  guildId: string;
  channelId: string;
  pythonPath?: string;
  pythonPathEntries?: string[];
  startupTimeoutMs?: number;
  /** Idle finalization deadline; actual byte progress refreshes it. */
  stopTimeoutMs?: number;
}

interface SidecarReadyEvent {
  event: "ready";
  dave: boolean;
  dave_receive: boolean;
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

type SidecarEvent =
  | SidecarReadyEvent
  | SidecarStoppedEvent
  | SidecarErrorEvent
  | { event: "progress"; bytesProcessed: number };

function scriptPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../python/discord_native_sidecar.py",
  );
}

function pythonEnv(entries: string[] | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  const configured =
    process.env.RESOUND_DISCORD_PYTHONPATH?.split(path.delimiter).filter(
      Boolean,
    ) ?? [];
  const merged = [...(entries ?? []), ...configured];
  if (merged.length > 0) {
    env.PYTHONPATH = [env.PYTHONPATH, ...merged]
      .filter(Boolean)
      .join(path.delimiter);
  }
  return env;
}

function sidecarEnv(
  token: string,
  entries: string[] | undefined,
): NodeJS.ProcessEnv {
  const env = pythonEnv(entries);
  return { ...env, RESOUND_SIDECAR_TOKEN: token };
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
    strictConsentCompatible: false,
    supportedPlatforms: ["darwin", "linux", "win32"],
    requiredCommands: ["python3"],
    requiredPermissions: [
      "Discord Connect permission",
      "Pycord + davey + PyNaCl + libopus runtime",
    ],
    warnings: [],
  };

  private child?: ChildProcess;
  private closed?: Promise<void>;
  private starting = false;
  private stopping = false;
  private stopPromise?: Promise<AudioChunk[]>;
  private lines?: readline.Interface;
  private status: RecordingHealth["status"] = "idle";
  private stopped?: SidecarStoppedEvent;
  private stderrLogPath?: string;
  private terminalError?: Error;
  private progressTimer?: NodeJS.Timeout;
  private progressBytes = 0;
  private stopTimeoutMs = 15_000;
  private pending: Array<{
    predicate: (event: SidecarEvent) => boolean;
    resolve: (event: SidecarEvent) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly options: PycordDiscordRecorderOptions) {}

  async preflight(context: RecordingContext): Promise<RecorderPreflightResult> {
    const python =
      this.options.pythonPath ??
      process.env.RESOUND_DISCORD_PYTHON ??
      "python3";
    const probe = spawnSync(python, [scriptPath(), "--probe"], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      env: pythonEnv(this.options.pythonPathEntries),
    });

    const dependencies = [
      {
        name: python,
        ok: !probe.error,
        detail: probe.error ? probe.error.message : `Detected ${python}`,
      },
    ];
    const warnings: string[] = [];
    const errors: string[] = [];
    const remediation: string[] = [];

    if (probe.error) {
      errors.push(`Python runtime unavailable: ${probe.error.message}`);
      remediation.push(
        "Install Python 3.10+ and set RESOUND_DISCORD_PYTHON if it is not on PATH.",
      );
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
          detail: "Pycord Discord-native sidecar dependencies loaded.",
        });
      } else {
        errors.push(
          `Sidecar probe did not return valid JSON. stderr: ${(probe.stderr ?? "").trim().slice(0, 300)}`,
        );
      }
    }

    if (!this.options.token)
      errors.push("DISCORD_TOKEN is required for the Pycord sidecar recorder.");
    if (!this.options.guildId || !this.options.channelId) {
      errors.push(
        "Guild ID and channel ID are required for Discord-native capture.",
      );
    }

    warnings.push(...(this.capabilities.warnings ?? []));
    if (context.strictConsent === true) {
      warnings.push(
        "Strict opt-in consent is not enforced during capture; use the recorded announcement policy or do not start the session.",
      );
      remediation.push(
        "Do not enable strict opt-in mode until capture-time participant exclusion is implemented.",
      );
    }

    return {
      status:
        errors.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass",
      recorderId: this.id,
      mode: this.mode,
      summary:
        errors.length > 0
          ? "Pycord Discord-native preflight failed."
          : warnings.length > 0
            ? "Pycord Discord-native preflight passed with warnings."
            : "Pycord Discord-native preflight passed.",
      dependencies,
      warnings,
      errors,
      remediation: remediation,
    };
  }

  async start(options: RecorderStartOptions): Promise<void> {
    if (this.child || this.starting || this.stopping)
      throw new Error("Pycord recorder is already started.");
    const startupTimeoutMs = deadlineMs(this.options.startupTimeoutMs, 20_000);
    this.stopTimeoutMs = deadlineMs(
      this.options.stopTimeoutMs ?? process.env.RESOUND_SIDECAR_STOP_TIMEOUT_MS,
      15_000,
    );
    // Prepare diagnostics before spawning: a filesystem failure must not orphan capture.
    this.stderrLogPath = path.join(
      options.sessionDir,
      "audio",
      "raw",
      "pycord-sidecar.stderr.log",
    );
    fs.mkdirSync(path.dirname(this.stderrLogPath), {
      recursive: true,
      mode: 0o700,
    });
    const python =
      this.options.pythonPath ??
      process.env.RESOUND_DISCORD_PYTHON ??
      "python3";
    const stderrFd = fs.openSync(this.stderrLogPath, "w", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(
        python,
        [
          scriptPath(),
          "--guild-id",
          this.options.guildId,
          "--channel-id",
          this.options.channelId,
          "--session-dir",
          options.sessionDir,
        ],
        {
          stdio: ["pipe", "pipe", stderrFd],
          env: sidecarEnv(this.options.token, this.options.pythonPathEntries),
        },
      );
    } finally {
      fs.closeSync(stderrFd);
    }
    this.child = child;
    this.closed = new Promise((resolve) =>
      child.once("close", () => resolve()),
    );
    this.stopPromise = undefined;
    this.lines = readline.createInterface({ input: child.stdout! });
    this.pending = [];
    this.status = "recording";
    this.stopped = undefined;
    this.terminalError = undefined;
    child.stdin?.on("error", (error) => {
      this.terminalError = new Error(
        `Pycord sidecar command pipe failed: ${error.message}`,
      );
      this.status = "failed";
      this.failPending(this.terminalError);
    });

    this.lines.on("line", (line) => this.handleLine(line));
    child.on("error", (err) => {
      this.terminalError = err;
      this.status = "failed";
      this.failPending(err);
    });
    // close follows stdout drainage; exit can precede the final stopped event.
    child.on("close", (code, signal) => {
      if (this.status !== "idle" && this.status !== "failed") {
        let detail: string;
        try {
          detail = diagnosticPreview(this.stderrLogPath!).slice(-500);
        } catch (error) {
          detail = `Cannot read sidecar diagnostics: ${(error as Error).message}`;
        }
        const error = new Error(
          `Pycord sidecar exited unexpectedly (${code ?? signal}). ${detail} See ${this.stderrLogPath}.`,
        );
        this.terminalError = error;
        this.status = this.stopped ? "warning" : "failed";
        this.failPending(error);
      }
      this.failPending(
        new Error(
          "Pycord sidecar closed before a pending operation completed.",
        ),
      );
      this.child = undefined;
      this.lines?.close();
      this.lines = undefined;
    });

    this.starting = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error("Pycord sidecar did not become ready before timeout."),
          );
        }, startupTimeoutMs);
        this.waitForEvent(
          (event): event is SidecarReadyEvent => event.event === "ready",
        )
          .then(() => {
            clearTimeout(timeout);
            resolve();
          })
          .catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
      });
    } catch (error) {
      await this.terminateSidecar();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  stop(): Promise<AudioChunk[]> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.finishStop().finally(() => {
      this.stopping = false;
    });
    return this.stopPromise;
  }

  private async finishStop(): Promise<AudioChunk[]> {
    if (this.stopped && !this.child) {
      this.status = this.stopped.warnings?.length ? "warning" : "idle";
      return [...this.stopped.tracks].sort(
        (a, b) => a.startSeconds - b.startSeconds,
      );
    }
    if (this.terminalError) {
      await this.terminateSidecar();
      throw this.terminalError;
    }
    if (!this.child) {
      throw (
        this.terminalError ??
        new Error("Pycord sidecar recorder is not running.")
      );
    }
    this.progressBytes = 0;
    const stoppedPromise = this.stopped
      ? Promise.resolve(this.stopped)
      : this.waitForEvent(
          (event): event is SidecarStoppedEvent => event.event === "stopped",
        );
    const closed = this.closed;
    const finalized = stoppedPromise.then(async (event) => {
      await closed;
      return event;
    });
    if (!this.stopped) {
      this.status = "stopping";
      this.child.stdin?.write("stop\n");
      this.child.stdin?.end();
    }
    const timeoutMs = this.stopTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const stopped = await Promise.race([
        finalized,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`Pycord sidecar did not stop within ${timeoutMs}ms.`),
              ),
            timeoutMs,
          );
          this.progressTimer = timer;
        }),
      ]);
      this.stopped = stopped;
      this.status = stopped.warnings?.length ? "warning" : "idle";
      return [...stopped.tracks].sort(
        (a, b) => a.startSeconds - b.startSeconds,
      );
    } catch (error) {
      await this.terminateSidecar();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.progressTimer = undefined;
    }
  }

  async abort(): Promise<AudioChunk[]> {
    await this.terminateSidecar();
    return [];
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
              : this.status === "failed"
                ? "Pycord Discord-native sidecar failed."
                : "Pycord Discord-native sidecar is idle.",
      warnings: this.stopped?.warnings ?? this.capabilities.warnings ?? [],
    };
  }

  captureSummary(): string[] {
    return this.stopped?.warnings ?? [];
  }

  private handleLine(line: string): void {
    const event = safeJsonParse(line.trim());
    if (!event) return;
    if (event.event === "progress") {
      if (
        Number.isSafeInteger(event.bytesProcessed) &&
        event.bytesProcessed > this.progressBytes
      ) {
        this.progressBytes = event.bytesProcessed;
        this.progressTimer?.refresh();
      }
      return;
    }
    if (event.event === "error") {
      this.status = "failed";
      this.terminalError = new Error(event.message);
      this.failPending(this.terminalError);
      return;
    }
    if (event.event === "stopped") {
      this.stopped = event;
      this.status = event.warnings?.length ? "warning" : "idle";
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

  private async terminateSidecar(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.status = "failed";
    this.failPending(new Error("Pycord sidecar was terminated."));
    child.stdin?.destroy();
    const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try {
      child.kill("SIGTERM");
      // exit precedes stdout drainage and close; retain ownership through both.
      await this.closed;
    } finally {
      clearTimeout(force);
    }
  }

  private waitForEvent<T extends SidecarEvent>(
    predicate: (event: SidecarEvent) => event is T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        predicate,
        resolve: (event) => resolve(event as T),
        reject,
      });
    });
  }
}
