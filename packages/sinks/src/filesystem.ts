import fs from "node:fs";
import path from "node:path";
import { sessionPaths, type TranscriptSession } from "@resound/core";
import type { Sink, SinkResult } from "./types.js";

/**
 * Copies the portable artifacts of a session into a destination directory.
 * Useful for shipping a session into another tool's inbox folder.
 */
export class FilesystemSink implements Sink {
  readonly name = "filesystem";
  constructor(private readonly destDir: string) {}

  async send(session: TranscriptSession): Promise<SinkResult> {
    const paths = sessionPaths(session.dir, session.manifest);
    const dest = path.join(this.destDir, path.basename(session.dir));
    fs.mkdirSync(dest, { recursive: true });
    const files = [
      paths.manifest,
      paths.jsonl,
      paths.markdown,
      paths.vtt,
      paths.srt,
      paths.summary,
      paths.actionItems
    ];
    let copied = 0;
    for (const f of files) {
      if (fs.existsSync(f)) {
        fs.copyFileSync(f, path.join(dest, path.basename(f)));
        copied++;
      }
    }
    return { sink: this.name, ok: true, detail: `Copied ${copied} file(s) to ${dest}` };
  }
}
