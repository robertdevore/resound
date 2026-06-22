import path from "node:path";
import type { SessionManifest } from "./types.js";

/** Resolve the configured output root (defaults to ./transcripts). */
export function outputRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.RESOUND_OUTPUT_DIR && env.RESOUND_OUTPUT_DIR.trim().length > 0
    ? env.RESOUND_OUTPUT_DIR
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
  return {
    dir,
    manifest: path.join(dir, "manifest.json"),
    jsonl: path.join(dir, outputs?.jsonl ?? "transcript.jsonl"),
    markdown: path.join(dir, outputs?.markdown ?? "transcript.md"),
    vtt: path.join(dir, outputs?.vtt ?? "transcript.vtt"),
    srt: path.join(dir, outputs?.srt ?? "transcript.srt"),
    summary: path.join(dir, outputs?.summary ?? "summary.md"),
    actionItems: path.join(dir, outputs?.action_items ?? "action-items.md"),
    audioRaw: path.join(dir, "audio", "raw"),
    audioChunks: path.join(dir, "audio", "chunks")
  };
}
