import type { Participant, TranscriptSegment } from "@resound/core";

/** Input handed to a transcription provider. */
export interface TranscriptionInput {
  /** Path to an audio file or chunk directory, if real audio is available. */
  audioPath?: string;
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
}

export interface Transcriber {
  readonly provider: string;
  readonly model: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptSegment[]>;
}

export type TranscriberName =
  | "mock"
  | "local-whisper"
  | "openai"
  | "openai-compatible"
  | "deepgram"
  | "assemblyai";
