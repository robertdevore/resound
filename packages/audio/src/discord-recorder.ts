import fs from "node:fs";
import path from "node:path";
import { sessionPaths } from "@resound/core";
import type {
  AudioChunk,
  Recorder,
  RecorderCapabilities,
  RecorderPreflightResult,
  RecorderStartOptions,
  RecordingContext,
  RecordingHealth,
} from "./types.js";
import { pcmDurationSeconds, pcmToWav } from "./wav.js";

/**
 * Live Discord voice-receive recorder.
 *
 * ⚠️ DAVE STATUS (as of June 2026): Discord enforces DAVE end-to-end encryption
 * on all voice channels, and `@discordjs/voice` audio *receive* is currently
 * broken under DAVE (DecryptionFailed / no `speaking` events). This class
 * implements the correct receive pipeline so Resound works the moment upstream
 * receive support lands — but live capture will not produce audio until then.
 * See docs/providers.md. Until then use `resound transcribe <file>` on a
 * recording, which is fully functional.
 *
 * Heavy/native deps (`@discordjs/voice`, `prism-media`, an Opus decoder) are
 * declared as OPTIONAL and imported lazily, so installing/building Resound and
 * running the bot in mock mode never requires them.
 */

// Structural type for the bits of a VoiceConnection we use, so this module
// compiles without @discordjs/voice types installed.
export interface VoiceConnectionLike {
  receiver: {
    speaking: {
      on(event: "start", listener: (userId: string) => void): void;
      off?(event: "start", listener: (userId: string) => void): void;
    };
    subscribe(userId: string, options: unknown): NodeJS.ReadableStream;
  };
}

export interface DiscordRecorderOptions {
  connection: VoiceConnectionLike;
  /** Map a Discord user id to a display name for transcript speaker labels. */
  resolveUsername?: (userId: string) => string;
  /** Milliseconds of silence that ends an utterance chunk. Default 1000. */
  silenceMs?: number;
  /** Injectable optional voice dependencies for offline integration tests. */
  loadDependencies?: () => Promise<VoiceDeps>;
}

const FORMAT = { sampleRate: 48000, channels: 2, bitDepth: 16 } as const;

export class DiscordRecorder implements Recorder {
  readonly id = "discord-recorder";
  readonly mode = "discord-native" as const;
  readonly capabilities: RecorderCapabilities = {
    mixedAudio: false,
    separateSpeakerTracks: true,
    reliableSpeakerIdentity: true,
    liveParticipantEvents: true,
    pauseResume: true,
    localOnly: false,
    reconnectSupport: false,
    healthMetrics: true,
    strictConsentCompatible: true,
    supportedPlatforms: ["darwin", "linux", "win32"],
    requiredCommands: [],
    requiredPermissions: [
      "Discord Connect/Speak/Use Voice Activity permissions",
    ],
    warnings: [
      "Live Discord receive still requires live verification against the installed @discordjs/voice stack.",
    ],
  };
  private readonly connection: VoiceConnectionLike;
  private readonly resolveUsername: (userId: string) => string;
  private readonly silenceMs: number;
  private readonly loadDependencies: () => Promise<VoiceDeps>;
  private chunks: AudioChunk[] = [];
  private chunkDir = "";
  private startedAt = 0;
  private active = new Map<string, { flush(): void; dispose(): void }>();
  private speakingListener?: (userId: string) => void;
  private failure?: Error;
  private counters = new Map<string, number>();
  private status: RecordingHealth["status"] = "idle";

  constructor(opts: DiscordRecorderOptions) {
    this.connection = opts.connection;
    this.resolveUsername = opts.resolveUsername ?? ((id) => id);
    this.silenceMs = opts.silenceMs ?? 1000;
    this.loadDependencies = opts.loadDependencies ?? loadVoiceDeps;
  }

  async preflight(
    _context: RecordingContext,
  ): Promise<RecorderPreflightResult> {
    const warnings = [
      "Discord-native capture requires optional voice receive dependencies and live DAVE verification.",
    ];
    const errors: string[] = [];
    try {
      await this.loadDependencies();
    } catch (err) {
      errors.push((err as Error).message);
    }
    return {
      status: errors.length > 0 ? "fail" : "warning",
      recorderId: this.id,
      mode: this.mode,
      summary:
        errors.length > 0
          ? "Discord-native preflight failed."
          : "Discord-native dependencies are present, but live DAVE receive still requires verification.",
      dependencies: [
        {
          name: "discord-voice-deps",
          ok: errors.length === 0,
          detail: errors[0] ?? "Optional voice receive dependencies loaded.",
        },
      ],
      warnings,
      errors,
      remediation:
        errors.length > 0
          ? [
              "Install @discordjs/voice, prism-media, and an Opus decoder, or use local-capture mode.",
            ]
          : [
              "Run the live Discord verification checklist before treating this mode as production ready.",
            ],
    };
  }

  async start(options: RecorderStartOptions): Promise<void> {
    if (this.status !== "idle")
      throw new Error("Discord recorder is already running.");
    const { EndBehaviorType, opusDecoderStream } =
      await this.loadDependencies();
    const paths = sessionPaths(options.sessionDir);
    fs.mkdirSync(paths.audioChunks, { recursive: true, mode: 0o700 });
    this.chunkDir = paths.audioChunks;
    this.startedAt = Date.now();
    this.chunks = [];
    this.counters.clear();
    this.failure = undefined;
    this.status = "recording";

    const listener = (userId: string) => {
      if (this.speakingListener !== listener || this.status !== "recording")
        return;
      if (this.active.has(userId)) return;
      try {
        const opusStream = this.connection.receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: this.silenceMs,
          },
        });
        const decoder = opusDecoderStream();
        // 30 seconds of stereo s16le; continuous speech never grows this buffer.
        const limit = FORMAT.sampleRate * FORMAT.channels * 2 * 30;
        let pcm: Buffer[] = [];
        let bytes = 0;
        let startOffset = 0;
        let disposed = false;
        const flush = () => {
          if (!bytes) return;
          const buffer = Buffer.concat(pcm, bytes);
          pcm = [];
          bytes = 0;
          this.writeChunk(userId, buffer, startOffset);
          startOffset += pcmDurationSeconds(buffer, FORMAT);
        };
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          this.active.delete(userId);
          opusStream.unpipe(decoder);
          (
            opusStream as NodeJS.ReadableStream & { destroy?(): void }
          ).destroy?.();
          (
            decoder as NodeJS.ReadWriteStream & { destroy?(): void }
          ).destroy?.();
          flush();
        };
        const fail = (error: Error) => {
          this.failure ??= error;
          this.status = "failed";
          try {
            dispose();
          } catch (error) {
            this.failure ??= error as Error;
          }
        };
        this.active.set(userId, { flush, dispose });
        decoder.on("data", (data: Buffer) => {
          if (disposed || this.status !== "recording") return;
          try {
            if (!bytes) startOffset = (Date.now() - this.startedAt) / 1000;
            for (let offset = 0; offset < data.length;) {
              const length = Math.min(limit - bytes, data.length - offset);
              // Copy slices so a small remainder cannot retain a large input allocation.
              pcm.push(Buffer.from(data.subarray(offset, offset + length)));
              bytes += length;
              offset += length;
              if (bytes === limit) flush();
            }
          } catch (error) {
            fail(error as Error);
          }
        });
        decoder.on("end", () => {
          try {
            dispose();
          } catch (error) {
            fail(error as Error);
          }
        });
        decoder.on("error", fail);
        opusStream.on("error", fail);
        opusStream.pipe(decoder);
      } catch (error) {
        this.failure = error as Error;
        this.status = "failed";
      }
    };
    this.speakingListener = listener;
    this.connection.receiver.speaking.on("start", listener);
  }

  pause(): void {
    if (this.status !== "recording")
      throw new Error("Discord recorder is not recording.");
    this.status = "paused";
    for (const stream of this.active.values()) stream.flush();
  }

  resume(): void {
    if (this.status !== "paused")
      throw new Error("Discord recorder is not paused.");
    this.status = "recording";
  }

  private writeChunk(userId: string, pcm: Buffer, startOffset: number): void {
    const n = this.counters.get(userId) ?? 0;
    this.counters.set(userId, n + 1);
    const username = this.resolveUsername(userId);
    const file = path.join(
      this.chunkDir,
      `${userId}-${String(n).padStart(3, "0")}.wav`,
    );
    fs.writeFileSync(file, pcmToWav(pcm, FORMAT), { mode: 0o600 });
    this.chunks.push({
      userId,
      username,
      path: file,
      startSeconds: startOffset,
      durationSeconds: pcmDurationSeconds(pcm, FORMAT),
    });
  }

  async stop(): Promise<AudioChunk[]> {
    this.status = "stopping";
    if (this.speakingListener) {
      this.connection.receiver.speaking.off?.("start", this.speakingListener);
      this.speakingListener = undefined;
    }
    for (const stream of this.active.values()) {
      try {
        stream.dispose();
      } catch (error) {
        this.failure ??= error as Error;
      }
    }
    this.status = this.failure ? "failed" : "idle";
    if (this.failure) throw this.failure;
    return [...this.chunks].sort((a, b) => a.startSeconds - b.startSeconds);
  }

  async abort(): Promise<AudioChunk[]> {
    return this.stop();
  }

  getHealth(): RecordingHealth {
    return {
      status: this.status,
      summary:
        this.status === "paused"
          ? "Discord-native capture paused."
          : this.status === "recording"
            ? "Discord-native capture running."
            : this.status === "stopping"
              ? "Discord-native capture finalizing buffered chunks."
              : "Discord-native capture idle.",
      warnings: this.capabilities.warnings ?? [],
      metrics: {
        activeSpeakers: this.active.size,
        chunksWritten: this.chunks.length,
      },
    };
  }
}

export interface VoiceDeps {
  EndBehaviorType: { AfterSilence: unknown };
  opusDecoderStream: () => NodeJS.ReadWriteStream & NodeJS.EventEmitter;
}

/** Lazily import the optional native voice deps with a clear error if absent. */
async function loadVoiceDeps(): Promise<VoiceDeps> {
  // Variable specifiers keep these optional deps out of the type graph so the
  // package builds and runs in mock mode without them installed.
  const voiceMod = "@discordjs/voice";
  const prismMod = "prism-media";
  try {
    const voice = (await import(voiceMod)) as unknown as {
      EndBehaviorType: { AfterSilence: unknown };
    };
    const prism = (await import(prismMod)) as unknown as {
      opus: {
        Decoder: new (o: {
          rate: number;
          channels: number;
          frameSize: number;
        }) => NodeJS.ReadWriteStream & NodeJS.EventEmitter;
      };
    };
    return {
      EndBehaviorType: voice.EndBehaviorType,
      opusDecoderStream: () =>
        new prism.opus.Decoder({
          rate: FORMAT.sampleRate,
          channels: FORMAT.channels,
          frameSize: 960,
        }),
    };
  } catch (err) {
    throw new Error(
      "Live Discord capture needs the optional deps @discordjs/voice, prism-media and an Opus decoder " +
        "(@discordjs/opus or opusscript). Install them, or use `resound transcribe <file>` instead. " +
        "Note: Discord voice receive is currently blocked by DAVE/E2EE — see docs/providers.md. " +
        `(${(err as Error).message})`,
    );
  }
}
