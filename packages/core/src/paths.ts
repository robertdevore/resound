import path from "node:path";
import type { SessionManifest } from "./types.js";

/** Resolve the configured output root (defaults to ./transcripts). */
export function outputRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.RESOUND_OUTPUT_DIR && env.RESOUND_OUTPUT_DIR.trim().length > 0
    ? env.RESOUND_OUTPUT_DIR.trim()
    : "transcripts";
}

export interface SessionPaths {
  dir: string;
  manifest: string;
  jsonl: string;
  markdown: string;
  vtt: string;
  srt: string;
  summary: string;
  actionItems: string;
  audioRaw: string;
  audioChunks: string;
}

/** Build the set of well-known file paths for a session directory. */
export function sessionPaths(dir: string, manifest?: SessionManifest): SessionPaths {
  const outputs = manifest?.outputs;
  const outputPath = (configured: string | undefined, fallback: string): string => {
    const relative = configured ?? fallback;
    if (path.isAbsolute(relative)) {
      throw new Error(`Session output path must be relative: ${relative}`);
    }
    const resolvedDir = path.resolve(dir);
    const resolved = path.resolve(resolvedDir, relative);
    if (resolved !== resolvedDir && !resolved.startsWith(`${resolvedDir}${path.sep}`)) {
      throw new Error(`Session output path escapes session directory: ${relative}`);
    }
    return path.join(dir, relative);
  };
  return {
    dir,
    manifest: path.join(dir, "manifest.json"),
    jsonl: outputPath(outputs?.jsonl, "transcript.jsonl"),
    markdown: outputPath(outputs?.markdown, "transcript.md"),
    vtt: outputPath(outputs?.vtt, "transcript.vtt"),
    srt: outputPath(outputs?.srt, "transcript.srt"),
    summary: outputPath(outputs?.summary, "summary.md"),
    actionItems: outputPath(outputs?.action_items, "action-items.md"),
    audioRaw: path.join(dir, "audio", "raw"),
    audioChunks: path.join(dir, "audio", "chunks")
  };
}
