import type { TranscriptSegment } from "@resound/core";
import type { Transcriber, TranscriptionInput } from "./types.js";

/**
 * Stand-in for providers that are designed for but not yet implemented
 * (deepgram, assemblyai, local-whisper). Keeps the abstraction honest: the
 * provider name resolves, but calling it fails loudly with guidance rather than
 * silently doing the wrong thing.
 */
export class NotImplementedTranscriber implements Transcriber {
  readonly model = "unconfigured";
  constructor(readonly provider: string) {}

  async transcribe(_input: TranscriptionInput): Promise<TranscriptSegment[]> {
    throw new Error(
      `Transcriber "${this.provider}" is scaffolded but not implemented yet. ` +
        `Set RESOUND_TRANSCRIBER=mock for local development, or RESOUND_TRANSCRIBER=openai with OPENAI_API_KEY.`
    );
  }
}
