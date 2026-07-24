import type { TranscriptSegment } from "@resound/core";
import type {
  Transcriber,
  TranscriptionInput,
  TranscriberCapabilities,
  TranscriberPreflightResult
} from "./types.js";

/**
 * Stand-in for providers that are designed for but not yet implemented
 * (deepgram, assemblyai, local-whisper). Keeps the abstraction honest: the
 * provider name resolves, but calling it fails loudly with guidance rather than
 * silently doing the wrong thing.
 */
export class NotImplementedTranscriber implements Transcriber {
  readonly model = "unconfigured";
  readonly capabilities: TranscriberCapabilities = {
    local: false,
    remote: false,
    segmentTimestamps: false,
    speakerAware: false,
    wordTimestamps: false,
    contextualPrompting: false,
    confidence: false,
    retrySafe: false,
    privacy: "remote-optional"
  };
  constructor(readonly provider: string) {}

  async preflight(): Promise<TranscriberPreflightResult> {
    return {
      status: "fail",
      provider: this.provider,
      model: this.model,
      summary: `Transcriber "${this.provider}" is not implemented.`,
      warnings: [],
      errors: [`Provider "${this.provider}" is scaffolded but not implemented.`],
      remediation: [
        "Use mock, local-whisper, openai, or openai-compatible until this adapter is completed."
      ]
    };
  }

  async transcribe(_input: TranscriptionInput): Promise<TranscriptSegment[]> {
    throw new Error(
      `Transcriber "${this.provider}" is scaffolded but not implemented yet. ` +
        `Set RESOUND_TRANSCRIBER=mock for local development, or RESOUND_TRANSCRIBER=openai with OPENAI_API_KEY.`
    );
  }
}
