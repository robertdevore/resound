import { LocalWhisperTranscriber } from "./local-whisper.js";
import { MockTranscriber } from "./mock.js";
import { OpenAICompatibleTranscriber, OpenAITranscriber } from "./openai.js";
import { NotImplementedTranscriber } from "./placeholder.js";
import type { Transcriber, TranscriberName } from "./types.js";

export * from "./types.js";
export { MockTranscriber } from "./mock.js";
export { LocalWhisperTranscriber, parseWhisperCppJson, parseOpenAiWhisperJson } from "./local-whisper.js";
export { OpenAICompatibleTranscriber, OpenAITranscriber } from "./openai.js";
export { NotImplementedTranscriber } from "./placeholder.js";

export interface ResolveOptions {
  name?: string;
  env?: NodeJS.ProcessEnv;
}

function openAiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.RESOUND_OPENAI_API_KEY || env.OPENAI_API_KEY;
}

/**
 * Resolve a transcriber from a name (or RESOUND_TRANSCRIBER). Local-first by
 * design: `mock` needs no setup, `local-whisper` keeps audio on the machine,
 * and `openai-compatible` is an optional remote expansion for ANY compatible
 * endpoint (not OpenAI-specific). Unknown names resolve to a NotImplemented stub
 * so the pipeline still loads.
 */
export function getTranscriber(options: ResolveOptions = {}): Transcriber {
  const env = options.env ?? process.env;
  const name = (options.name?.trim() || env.RESOUND_TRANSCRIBER?.trim() || "mock") as TranscriberName;
  const model = env.RESOUND_TRANSCRIBER_MODEL?.trim() || undefined;

  switch (name) {
    case "mock":
      return new MockTranscriber();

    case "local-whisper":
      return new LocalWhisperTranscriber({ env });

    case "openai": {
      const apiKey = openAiKey(env);
      if (!apiKey) {
        throw new Error(
          "RESOUND_TRANSCRIBER=openai but no OPENAI_API_KEY / RESOUND_OPENAI_API_KEY is set. Use RESOUND_TRANSCRIBER=local-whisper (local-first) or mock."
        );
      }
      return new OpenAITranscriber({ apiKey, model, baseUrl: env.RESOUND_OPENAI_BASE_URL });
    }

    case "openai-compatible": {
      const baseUrl = env.RESOUND_OPENAI_BASE_URL?.trim();
      if (!baseUrl) {
        throw new Error(
          "RESOUND_TRANSCRIBER=openai-compatible requires RESOUND_OPENAI_BASE_URL (e.g. http://localhost:8080/v1)."
        );
      }
      // Many local compatible servers accept any/no token.
      const apiKey = openAiKey(env) || "sk-no-key-required";
      return new OpenAICompatibleTranscriber({ apiKey, model, baseUrl });
    }

    case "deepgram":
    case "assemblyai":
      return new NotImplementedTranscriber(name);

    default:
      return new NotImplementedTranscriber(String(name));
  }
}
