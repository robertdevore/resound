/**
 * Audio capture abstraction.
 *
 * IMPORTANT: Discord voice receive now sits behind the DAVE end-to-end
 * encryption protocol (see docs/providers.md). Real receive support depends on
 * the chosen Discord voice library finalizing DAVE. The Recorder interface is
 * deliberately decoupled from Discord so the rest of Resound (sessions,
 * transcription, exporters, sinks) is ready the moment a working voice adapter
 * lands. Until then, MockRecorder drives the whole pipeline.
 */

export interface AudioChunk {
  /** The participant this chunk belongs to (for per-speaker diarization). */
  userId: string;
  username: string;
  /** Path to the written chunk file. */
  path: string;
  /** Start offset from session start, in seconds. */
  startSeconds: number;
  /** Duration in seconds. */
  durationSeconds: number;
}

export interface RecorderStartOptions {
  /** Directory where audio (raw + chunks) should be written. */
  sessionDir: string;
}

export interface Recorder {
  readonly mode: "mock" | "discord" | "system";
  start(options: RecorderStartOptions): Promise<void>;
  /** Pause capture when the recorder supports it. */
  pause?(): Promise<void> | void;
  /** Resume a previously paused capture. */
  resume?(): Promise<void> | void;
  /** Returns the chunks captured between start() and stop(). */
  stop(): Promise<AudioChunk[]>;
  /** Human-readable health report for the most recently completed capture. */
  captureSummary?(): Promise<string[]> | string[];
}
