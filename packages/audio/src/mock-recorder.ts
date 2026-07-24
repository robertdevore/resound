import fs from "node:fs";
import path from "node:path";
import { sessionPaths } from "@resound/core";
import type {
  AudioChunk,
  Recorder,
  RecorderCapabilities,
  RecorderPreflightResult,
  RecorderStartOptions
} from "./types.js";

export interface MockRecorderOptions {
  participants?: { id: string; username: string }[];
}

/**
 * Writes placeholder chunk files so the full record -> transcribe -> export
 * pipeline can run end-to-end with no real audio. Each "chunk" is a small text
 * file standing in for an Opus/WAV segment.
 */
export class MockRecorder implements Recorder {
  readonly id = "mock-recorder";
  readonly mode = "mock" as const;
  readonly capabilities: RecorderCapabilities = {
    mixedAudio: true,
    separateSpeakerTracks: true,
    reliableSpeakerIdentity: true,
    liveParticipantEvents: true,
    pauseResume: false,
    localOnly: true,
    reconnectSupport: true,
    healthMetrics: false,
    strictConsentCompatible: true,
    supportedPlatforms: ["darwin", "linux", "win32"]
  };
  private chunks: AudioChunk[] = [];

  constructor(private readonly options: MockRecorderOptions = {}) {}

  async preflight(): Promise<RecorderPreflightResult> {
    return {
      status: "pass",
      recorderId: this.id,
      mode: this.mode,
      summary: "Mock recorder is ready.",
      dependencies: [],
      warnings: [],
      errors: [],
      remediation: []
    };
  }

  async start(options: RecorderStartOptions): Promise<void> {
    const paths = sessionPaths(options.sessionDir);
    fs.mkdirSync(paths.audioRaw, { recursive: true });
    fs.mkdirSync(paths.audioChunks, { recursive: true });

    const participants =
      this.options.participants && this.options.participants.length > 0
        ? this.options.participants
        : [
            { id: "1", username: "Robert" },
            { id: "2", username: "Ashley" }
          ];

    this.chunks = participants.map((p, i) => {
      const file = path.join(paths.audioChunks, `${p.id}-000.chunk.txt`);
      fs.writeFileSync(
        file,
        `mock audio chunk for ${p.username} (${p.id})\n`,
        "utf8"
      );
      return {
        userId: p.id,
        username: p.username,
        path: file,
        startSeconds: i * 5,
        durationSeconds: 4
      };
    });
  }

  async stop(): Promise<AudioChunk[]> {
    return this.chunks;
  }
}
