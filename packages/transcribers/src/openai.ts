import fs from "node:fs";
import type { TranscriptSegment } from "@resound/core";
import type {
  Transcriber,
  TranscriptionInput,
  TranscriberCapabilities,
  TranscriberPreflightResult
} from "./types.js";
import {
  defaultSpeaker,
  mapRawSegmentsToSpeakerSegments,
  mergeTranscriptSegments,
  selectEffectiveTracks,
  type RawSegment
} from "./tracks.js";

interface VerboseSegment extends RawSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
}

export interface OpenAICompatibleOptions {
  apiKey: string;
  model?: string;
  /**
   * Base URL of an OpenAI-compatible API, WITHOUT a trailing slash. Defaults to
   * the real OpenAI API. Point this at any compatible server (a local
   * whisper.cpp server, LM Studio, Groq, OpenRouter, vLLM, etc.) to use this as
   * an optional cloud/remote expansion without locking into OpenAI itself.
   */
  baseUrl?: string;
}

/**
 * Transcriber for any OpenAI-*compatible* `/audio/transcriptions` endpoint.
 * Optional expansion on top of the local-first default — not required, and not
 * tied to OpenAI specifically.
 *
 * Note: the REST API does not diarize; speaker labels fall back to the first
 * known participant. Real per-speaker labels come from per-speaker audio
 * (the Discord receive adapter, pending DAVE — see docs/providers.md).
 */
export class OpenAICompatibleTranscriber implements Transcriber {
  readonly provider: string = "openai-compatible";
  readonly model: string;
  readonly capabilities: TranscriberCapabilities = {
    local: false,
    remote: true,
    segmentTimestamps: true,
    speakerAware: true,
    wordTimestamps: false,
    contextualPrompting: false,
    confidence: true,
    retrySafe: false,
    maxInputSize: "Provider-defined upload limits",
    privacy: "remote-optional"
  };
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAICompatibleOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || "whisper-1";
    this.baseUrl = (opts.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  get endpoint(): string {
    return `${this.baseUrl}/audio/transcriptions`;
  }

  async preflight(): Promise<TranscriberPreflightResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    if (!this.apiKey) errors.push("No API key configured.");
    if (!/^https?:\/\//.test(this.baseUrl)) {
      errors.push(`Base URL must be absolute: ${this.baseUrl}`);
    }
    if (this.provider === "openai-compatible") {
      warnings.push("Remote transcription sends meeting audio to the configured provider endpoint.");
    }
    return {
      status: errors.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass",
      provider: this.provider,
      model: this.model,
      summary:
        errors.length > 0
          ? "Remote transcription preflight failed."
          : warnings.length > 0
            ? "Remote transcription preflight passed with warnings."
            : "Remote transcription preflight passed.",
      warnings,
      errors,
      remediation: errors.length > 0
        ? ["Set the API key and base URL for the configured provider before recording."]
        : []
    };
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptSegment[]> {
    const tracks = selectEffectiveTracks(input);
    const singlePath = input.audioPath && fs.existsSync(input.audioPath) ? input.audioPath : undefined;
    if (!singlePath && tracks.length === 0) {
      throw new Error(
        "OpenAICompatibleTranscriber requires an existing audioPath. Use local-whisper or mock for sessions without an audio file."
      );
    }

    if (tracks.length > 0) {
      const perTrack = await Promise.all(
        tracks.map(async (track) =>
          mapRawSegmentsToSpeakerSegments(await this.transcribeRaw({ ...input, audioPath: track.path }), {
            userId: track.userId,
            username: track.resolvedUsername,
            startSeconds: track.startSeconds
          })
        )
      );
      return mergeTranscriptSegments(perTrack.flat());
    }

    const speaker = defaultSpeaker(input);
    return mapRawSegmentsToSpeakerSegments(await this.transcribeRaw({ ...input, audioPath: singlePath }), speaker);
  }

  private async transcribeRaw(input: TranscriptionInput): Promise<RawSegment[]> {
    const audioPath = input.audioPath;
    if (!audioPath) {
      throw new Error("OpenAICompatibleTranscriber requires an audioPath for transcription.");
    }
    const form = new FormData();
    const data = await fs.promises.readFile(audioPath);
    form.append("file", new Blob([data]), audioPath.split("/").pop() ?? "audio.wav");
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (input.language) form.append("language", input.language);

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form
    });
    if (!res.ok) {
      throw new Error(`Transcription failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { segments?: VerboseSegment[]; text?: string };
    const raw = json.segments ?? [];
    if (raw.length === 0 && json.text) {
      return [{ start: 0, end: 0, text: json.text.trim(), confidence: 0 }];
    }
    return raw.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
      confidence: s.avg_logprob != null ? clamp01(Math.exp(s.avg_logprob)) : 0
    }));
  }
}

/** Back-compat alias: the "openai" provider is the compatible client with the default OpenAI base URL. */
export class OpenAITranscriber extends OpenAICompatibleTranscriber {
  override readonly provider = "openai";
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
