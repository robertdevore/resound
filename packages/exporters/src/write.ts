import fs from "node:fs";
import path from "node:path";
import {
  sessionPaths,
  toJsonl,
  writeManifest,
  type TranscriptSession
} from "@resound/core";
import { toMarkdown } from "./markdown.js";
import { toSrt, toVtt } from "./subtitles.js";
import {
  buildActionItemsMarkdown,
  buildSummary,
  buildSummaryMarkdown,
  extractActionItems
} from "./summary.js";

export interface WriteOptions {
  /** Also (re)write manifest.json. Default true. */
  writeManifest?: boolean;
}

/**
 * Write every canonical output for a session to its directory:
 * manifest.json, transcript.jsonl/md/vtt/srt, summary.md, action-items.md.
 * Returns the list of files written.
 */
export function writeSessionOutputs(
  session: TranscriptSession,
  options: WriteOptions = {}
): string[] {
  const { manifest, segments, dir } = session;
  fs.mkdirSync(dir, { recursive: true });
  const paths = sessionPaths(dir, manifest);
  const written: string[] = [];

  const actionItems = extractActionItems(segments);
  const summary = buildSummary(manifest, segments);

  const files: [string, string][] = [
    [paths.jsonl, toJsonl(segments)],
    [paths.markdown, toMarkdown(manifest, segments, { summary, actionItems })],
    [paths.vtt, toVtt(segments)],
    [paths.srt, toSrt(segments)],
    [paths.summary, buildSummaryMarkdown(manifest, segments)],
    [paths.actionItems, buildActionItemsMarkdown(actionItems)]
  ];

  for (const [p, content] of files) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    written.push(p);
  }

  if (options.writeManifest !== false) {
    writeManifest(dir, manifest);
    written.push(paths.manifest);
  }

  return written;
}
