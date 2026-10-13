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
export function sessionPaths(
  dir: string,
  manifest?: SessionManifest,
): SessionPaths {
  const outputs = manifest?.outputs;
  const resolvedDir = path.resolve(dir);
  // Exports must never replace recording inputs or occupy their directories.
  // Audio paths in manifests use the recorder's cwd-relative/absolute contract,
  // whereas output paths are relative to the session directory.
  const audio = manifest?.audio_files;
  const declaredAudio = [
    audio?.mixed,
    audio?.system,
    audio?.microphone,
    audio?.chunks_dir,
    ...(Array.isArray(audio?.tracks)
      ? audio.tracks.map((track) => track?.path)
      : []),
  ];
  const reserved = [
    path.join(resolvedDir, "manifest.json"),
    path.join(resolvedDir, "audio", "raw"),
    path.join(resolvedDir, "audio", "chunks"),
    ...declaredAudio
      .filter(
        (file): file is string => typeof file === "string" && file.length > 0,
      )
      .map((file) => path.resolve(file)),
  ];
  const outputPath = (
    configured: string | undefined,
    fallback: string,
  ): string => {
    const relative = configured ?? fallback;
    if (
      typeof relative !== "string" ||
      !relative.trim() ||
      relative.includes("\0")
    ) {
      throw new Error(
        "Session output path must be a non-empty filename without NUL bytes.",
      );
    }
    if (path.isAbsolute(relative)) {
      throw new Error(`Session output path must be relative: ${relative}`);
    }
    const resolved = path.resolve(resolvedDir, relative);
    const within = path.relative(resolvedDir, resolved);
    if (
      within === ".." ||
      within.startsWith(`..${path.sep}`) ||
      path.isAbsolute(within)
    ) {
      throw new Error(
        `Session output path escapes session directory: ${relative}`,
      );
    }
    if (
      !within ||
      reserved.some(
        (other) =>
          resolved === other ||
          resolved.startsWith(`${other}${path.sep}`) ||
          other.startsWith(`${resolved}${path.sep}`),
      )
    ) {
      throw new Error(
        `Session output path conflicts with another artifact: ${relative}`,
      );
    }
    reserved.push(resolved);
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
    audioChunks: path.join(dir, "audio", "chunks"),
  };
}
