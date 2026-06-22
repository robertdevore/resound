import fs from "node:fs";
import { formatTimestamp, type TranscriptSegment } from "@resound/core";
import type { Transcriber, TranscriptionInput } from "./types.js";

interface VerboseSegment {
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

  async transcribe(input: TranscriptionInput): Promise<TranscriptSegment[]> {
    if (!input.audioPath || !fs.existsSync(input.audioPath)) {
      throw new Error(
        "OpenAICompatibleTranscriber requires an existing audioPath. Use local-whisper or mock for sessions without an audio file."
      );
    }

    const speaker = input.participants?.[0]?.username ?? "Speaker";
    const userId = input.participants?.[0]?.id ?? "";

    const form = new FormData();
    const data = await fs.promises.readFile(input.audioPath);
    form.append("file", new Blob([data]), input.audioPath.split("/").pop() ?? "audio.wav");
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
      return [
        { ts: "00:00:00", end_ts: "00:00:00", speaker, user_id: userId, text: json.text.trim(), confidence: 0 }
      ];
    }
    return raw.map((s) => ({
      ts: formatTimestamp(s.start),
      end_ts: formatTimestamp(s.end),
      speaker,
      user_id: userId,
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
