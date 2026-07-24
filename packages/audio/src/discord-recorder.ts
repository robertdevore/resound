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
  RecordingHealth
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
    speaking: { on(event: "start", listener: (userId: string) => void): void };
    subscribe(userId: string, options: unknown): NodeJS.ReadableStream;
  };
}

export interface DiscordRecorderOptions {
  connection: VoiceConnectionLike;
  /** Map a Discord user id to a display name for transcript speaker labels. */
  resolveUsername?: (userId: string) => string;
  /** Milliseconds of silence that ends an utterance chunk. Default 1000. */
  silenceMs?: number;
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
    requiredPermissions: ["Discord Connect/Speak/Use Voice Activity permissions"],
    warnings: [
      "Live Discord receive still requires live verification against the installed @discordjs/voice stack."
    ]
  };
  private readonly connection: VoiceConnectionLike;
  private readonly resolveUsername: (userId: string) => string;
  private readonly silenceMs: number;
  private chunks: AudioChunk[] = [];
  private chunkDir = "";
  private startedAt = 0;
  private active = new Set<string>();
  private counters = new Map<string, number>();
  private paused = false;
  private status: RecordingHealth["status"] = "idle";

  constructor(opts: DiscordRecorderOptions) {
    this.connection = opts.connection;
    this.resolveUsername = opts.resolveUsername ?? ((id) => id);
    this.silenceMs = opts.silenceMs ?? 1000;
  }

  async preflight(_context: RecordingContext): Promise<RecorderPreflightResult> {
    const warnings = [
      "Discord-native capture requires optional voice receive dependencies and live DAVE verification."
    ];
    const errors: string[] = [];
    try {
      await loadVoiceDeps();
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
          detail: errors[0] ?? "Optional voice receive dependencies loaded."
        }
      ],
      warnings,
      errors,
      remediation: errors.length > 0
        ? ["Install @discordjs/voice, prism-media, and an Opus decoder, or use local-capture mode."]
        : ["Run the live Discord verification checklist before treating this mode as production ready."]
    };
  }

  async start(options: RecorderStartOptions): Promise<void> {
    const paths = sessionPaths(options.sessionDir);
    fs.mkdirSync(paths.audioRaw, { recursive: true });
    fs.mkdirSync(paths.audioChunks, { recursive: true });
    this.chunkDir = paths.audioChunks;
    this.startedAt = Date.now();
    this.paused = false;
    this.status = "recording";

    const { EndBehaviorType, opusDecoderStream } = await loadVoiceDeps();

    this.connection.receiver.speaking.on("start", (userId: string) => {
      if (this.paused) return;
      if (this.active.has(userId)) return;
      this.active.add(userId);

      const opusStream = this.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceMs }
      });
      const startOffset = (Date.now() - this.startedAt) / 1000;
      const pcm: Buffer[] = [];
      const decoder = opusDecoderStream();

      (opusStream as NodeJS.ReadableStream).pipe(decoder);
      decoder.on("data", (d: Buffer) => pcm.push(d));
      decoder.on("end", () => {
        this.active.delete(userId);
        const buffer = Buffer.concat(pcm);
        if (buffer.length === 0) return;
        this.writeChunk(userId, buffer, startOffset);
      });
      decoder.on("error", () => this.active.delete(userId));
    });
  }

  pause(): void {
    this.paused = true;
    this.status = "paused";
  }

  resume(): void {
    this.paused = false;
    this.status = "recording";
  }

  private writeChunk(userId: string, pcm: Buffer, startOffset: number): void {
    const n = this.counters.get(userId) ?? 0;
    this.counters.set(userId, n + 1);
    const username = this.resolveUsername(userId);
    const file = path.join(this.chunkDir, `${userId}-${String(n).padStart(3, "0")}.wav`);
    fs.writeFileSync(file, pcmToWav(pcm, FORMAT));
    this.chunks.push({
      userId,
      username,
      path: file,
      startSeconds: startOffset,
      durationSeconds: pcmDurationSeconds(pcm, FORMAT)
    });
  }

  async stop(): Promise<AudioChunk[]> {
    // Let any in-flight silence timers flush.
    this.status = "stopping";
    await new Promise((r) => setTimeout(r, this.silenceMs + 200));
    this.status = "idle";
    return [...this.chunks].sort((a, b) => a.startSeconds - b.startSeconds);
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
        chunksWritten: this.chunks.length
      }
    };
  }
}

interface VoiceDeps {
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
      opus: { Decoder: new (o: { rate: number; channels: number; frameSize: number }) => NodeJS.ReadWriteStream & NodeJS.EventEmitter };
    };
    return {
      EndBehaviorType: voice.EndBehaviorType,
      opusDecoderStream: () =>
        new prism.opus.Decoder({ rate: FORMAT.sampleRate, channels: FORMAT.channels, frameSize: 960 })
    };
  } catch (err) {
    throw new Error(
      "Live Discord capture needs the optional deps @discordjs/voice, prism-media and an Opus decoder " +
        "(@discordjs/opus or opusscript). Install them, or use `resound transcribe <file>` instead. " +
        "Note: Discord voice receive is currently blocked by DAVE/E2EE — see docs/providers.md. " +
        `(${(err as Error).message})`
    );
  }
}
