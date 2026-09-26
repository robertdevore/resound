import path from "node:path";
import { runCommand, deadlineMs, type TranscriptSession } from "@resound/core";
import type { Sink, SinkResult } from "./types.js";

export interface TotalRecallOptions {
  /**
   * Ingest command template. The session DIRECTORY is appended as the final
   * arg. Defaults to TOTALRECALL_INGEST_COMMAND or "totalrecall ingest".
   */
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** Default: RESOUND_SINK_TIMEOUT_MS or 60 seconds. */
  timeoutMs?: number;
  run?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stderr: string }>;
}

/**
 * Optional / scaffolded TotalRecall sink. Resound session folders are designed
 * so TotalRecall can ingest a whole directory later. Not required in V1.
 */
export class TotalRecallSink implements Sink {
  readonly name = "totalrecall";
  constructor(private readonly options: TotalRecallOptions = {}) {}

  async send(session: TranscriptSession): Promise<SinkResult> {
    const env = this.options.env ?? process.env;
    const template =
      this.options.command ??
      env.TOTALRECALL_INGEST_COMMAND ??
      "totalrecall ingest";
    const dir = path.resolve(session.dir);
    const parts = template.split(/\s+/).filter(Boolean);
    const cmd = parts[0]!;
    const args = [...parts.slice(1), dir];
    const timeout = deadlineMs(
      this.options.timeoutMs ?? env.RESOUND_SINK_TIMEOUT_MS,
      60_000,
    );
    const runner =
      this.options.run ??
      ((cmd: string, args: string[]) => runCommand(cmd, args, timeout));

    try {
      const { code, stderr } = await runner(cmd, args);
      if (code === 0) {
        return {
          sink: this.name,
          ok: true,
          detail: `Ran: ${cmd} ${args.join(" ")}`,
        };
      }
      return {
        sink: this.name,
        ok: false,
        detail: `TotalRecall command exited ${code}: ${stderr.trim()}`,
      };
    } catch (err) {
      return {
        sink: this.name,
        ok: false,
        skipped: true,
        detail:
          `TotalRecall is optional and not configured. To ingest manually:\n  totalrecall ingest ${dir}\n` +
          `(${(err as Error).message})`,
      };
    }
  }
}
