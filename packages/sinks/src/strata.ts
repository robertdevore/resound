import fs from "node:fs";
import {
  runCommand,
  deadlineMs,
  sessionPaths,
  type TranscriptSession,
} from "@resound/core";
import type { Sink, SinkResult } from "./types.js";

export interface StrataOptions {
  /**
   * Ingest command template. The Markdown path is appended as the final arg.
   * Defaults to STRATA_INGEST_COMMAND or "strata notes add --file".
   */
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** Default: RESOUND_SINK_TIMEOUT_MS or 60 seconds. */
  timeoutMs?: number;
  /** Injectable runner for testing. Returns the process exit code. */
  run?: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stderr: string }>;
}

/**
 * Optional Strata sink. Strata is NOT required for Resound to work. If the
 * configured command is missing, this sink fails gracefully and tells the user
 * how to export Markdown manually.
 */
export class StrataSink implements Sink {
  readonly name = "strata";
  constructor(private readonly options: StrataOptions = {}) {}

  async send(session: TranscriptSession): Promise<SinkResult> {
    const env = this.options.env ?? process.env;
    const template =
      this.options.command ??
      env.STRATA_INGEST_COMMAND ??
      "strata notes add --file";
    const mdPath = sessionPaths(session.dir, session.manifest).markdown;

    if (!fs.existsSync(mdPath)) {
      return {
        sink: this.name,
        ok: false,
        skipped: true,
        detail: `No transcript.md at ${mdPath}. Run "resound export <session> --format md" first.`,
      };
    }

    const parts = template.split(/\s+/).filter(Boolean);
    const cmd = parts[0]!;
    const args = [...parts.slice(1), mdPath];
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
        detail: `Strata command exited ${code}: ${stderr.trim()}`,
      };
    } catch (err) {
      return {
        sink: this.name,
        ok: false,
        skipped: true,
        detail:
          `Could not run Strata ("${cmd}"). Strata is optional — your transcript is still at ` +
          `${mdPath}. Install Strata or set STRATA_INGEST_COMMAND. (${(err as Error).message})`,
      };
    }
  }
}
