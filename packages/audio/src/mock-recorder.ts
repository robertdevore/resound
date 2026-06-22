import fs from "node:fs";
import path from "node:path";
import { sessionPaths } from "@resound/core";
import type { AudioChunk, Recorder, RecorderStartOptions } from "./types.js";

export interface MockRecorderOptions {
  participants?: { id: string; username: string }[];
}

/**
 * Writes placeholder chunk files so the full record -> transcribe -> export
 * pipeline can run end-to-end with no real audio. Each "chunk" is a small text
 * file standing in for an Opus/WAV segment.
 */
export class MockRecorder implements Recorder {
  readonly mode = "mock" as const;
  private chunks: AudioChunk[] = [];

  constructor(private readonly options: MockRecorderOptions = {}) {}

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
