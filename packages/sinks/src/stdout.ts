import fs from "node:fs";
import { sessionPaths, type TranscriptSession } from "@resound/core";
import type { Sink, SinkResult } from "./types.js";

/** Writes the Markdown transcript to stdout. Handy for piping. */
export class StdoutSink implements Sink {
  readonly name = "stdout";
  constructor(private readonly write: (s: string) => void = (s) => process.stdout.write(s)) {}

  async send(session: TranscriptSession): Promise<SinkResult> {
    const md = sessionPaths(session.dir, session.manifest).markdown;
    if (!fs.existsSync(md)) {
      return { sink: this.name, ok: false, skipped: true, detail: `No transcript.md at ${md}` };
    }
    this.write(fs.readFileSync(md, "utf8"));
    return { sink: this.name, ok: true, detail: "Wrote transcript.md to stdout" };
  }
}
