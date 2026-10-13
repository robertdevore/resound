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
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    const files = [
      paths.jsonl,
      paths.markdown,
      paths.vtt,
      paths.srt,
      paths.summary,
      paths.actionItems,
      paths.manifest,
    ];
    let copied = 0;
    for (const f of files) {
      if (fs.existsSync(f)) {
        const target = path.join(dest, path.relative(session.dir, f));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        // Stage beside the destination so failures cannot truncate its prior
        // contents. Copying stays file-backed even for large transcripts.
        const staging = fs.mkdtempSync(
          path.join(path.dirname(target), ".resound-copy-"),
        );
        try {
          const staged = path.join(staging, "content");
          fs.copyFileSync(f, staged);
          fs.chmodSync(staged, 0o600);
          fs.renameSync(staged, target);
        } finally {
          fs.rmSync(staging, { recursive: true, force: true });
        }
        copied++;
      }
    }
    return {
      sink: this.name,
      ok: true,
      detail: `Copied ${copied} file(s) to ${dest}`,
    };
  }
}
