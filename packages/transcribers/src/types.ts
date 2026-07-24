import type { Participant, TranscriptSegment } from "@resound/core";

export interface TranscriptionTrack {
  path: string;
  userId: string;
  username: string;
  startSeconds: number;
  durationSeconds: number;
}

/** Input handed to a transcription provider. */
export interface TranscriptionInput {
  /** Path to an audio file or chunk directory, if real audio is available. */
  audioPath?: string;
  /** Optional speaker or source-specific audio tracks for timestamp-aware merging. */
  audioTracks?: TranscriptionTrack[];
  /** The session directory (providers may read audio/chunks from here). */
  sessionDir?: string;
  /** Known participants, used to map speakers when diarization is unavailable. */
  participants?: Participant[];
  /** Optional language hint, e.g. "en". */
  language?: string;
  /**
   * If true, the provider should synthesize deterministic output instead of
   * calling any external service. The mock provider always behaves this way.
   */
  mock?: boolean;
  /** Optional progress hook for long-running local transcription jobs. */
  onProgress?: (progress: TranscriptionProgress) => void;
}

export interface TranscriptionProgress {
  phase: "track-started" | "track-completed";
  trackIndex: number;
  trackCount: number;
  trackLabel: string;
  completedTracks: number;
  completedDurationSeconds: number;
  totalDurationSeconds: number;
  elapsedMs: number;
}

export interface TranscriberCapabilities {
  local: boolean;
  remote: boolean;
  segmentTimestamps: boolean;
  speakerAware: boolean;
  wordTimestamps: boolean;
  contextualPrompting: boolean;
  confidence: boolean;
  retrySafe: boolean;
  maxInputSize?: string;
  privacy: "local-only" | "remote-optional" | "remote-required";
}

export interface TranscriberPreflightResult {
  status: "pass" | "warning" | "fail";
  provider: string;
  model: string;
  summary: string;
  warnings: string[];
  errors: string[];
  remediation: string[];
}

export interface Transcriber {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: TranscriberCapabilities;
  preflight?(input?: TranscriptionInput): Promise<TranscriberPreflightResult>;
  transcribe(input: TranscriptionInput): Promise<TranscriptSegment[]>;
}

export type TranscriberName =
  | "mock"
  | "local-whisper"
  | "openai"
  | "openai-compatible"
  | "deepgram"
  | "assemblyai";
