import fs from "node:fs";
import {
  deadlineMs,
  sessionPaths,
  type TranscriptSession,
} from "@resound/core";
import type { Sink, SinkResult } from "./types.js";

export interface WebhookOptions {
  url: string;
  /** Default: RESOUND_SINK_TIMEOUT_MS or 30 seconds. */
  timeoutMs?: number;
  /** Optional extra headers (e.g. an auth token). */
  headers?: Record<string, string>;
  /** Injectable fetch for testing. */
  fetchImpl?: typeof fetch;
}

/**
 * POSTs a JSON payload (manifest + segments + markdown) to an HTTP endpoint.
 * Vendor-neutral: any downstream that accepts JSON can receive a session.
 */
export class WebhookSink implements Sink {
  readonly name = "webhook";
  constructor(private readonly options: WebhookOptions) {}

  async send(session: TranscriptSession): Promise<SinkResult> {
    const paths = sessionPaths(session.dir, session.manifest);
    const markdown = fs.existsSync(paths.markdown)
      ? fs.readFileSync(paths.markdown, "utf8")
      : "";
    const payload = {
      schema_version: session.manifest.schema_version,
      session_id: session.manifest.session_id,
      manifest: session.manifest,
      segments: session.segments,
      markdown,
    };

    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const res = await doFetch(this.options.url, {
        method: "POST",
        signal: AbortSignal.timeout(
          deadlineMs(
            this.options.timeoutMs ?? process.env.RESOUND_SINK_TIMEOUT_MS,
            30_000,
          ),
        ),
        headers: {
          "content-type": "application/json",
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(payload),
      });
      // This sink needs only the status; release an unused/streaming body.
      await res.body?.cancel();
      if (!res.ok) {
        return {
          sink: this.name,
          ok: false,
          detail: `POST ${this.options.url} -> ${res.status}`,
        };
      }
      return {
        sink: this.name,
        ok: true,
        detail: `POST ${this.options.url} -> ${res.status}`,
      };
    } catch (err) {
      return {
        sink: this.name,
        ok: false,
        skipped: true,
        detail: `Webhook request failed: ${(err as Error).message}`,
      };
    }
  }
}
