import type { TranscriptSession } from "@resound/core";

export interface SinkResult {
  sink: string;
  ok: boolean;
  /** Human-readable detail (path written, URL posted, command run, error). */
  detail: string;
  /** True when the sink could not run but failed gracefully (not a crash). */
  skipped?: boolean;
}

export interface Sink {
  readonly name: string;
  send(session: TranscriptSession): Promise<SinkResult>;
}
