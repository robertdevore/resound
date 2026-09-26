import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sessionPaths } from "./paths.js";
import { parseJsonl } from "./jsonl.js";
import type { SessionManifest, TranscriptSession } from "./types.js";

/** Read + parse a manifest.json from a session directory. */
export function readManifest(dir: string): SessionManifest {
  const p = sessionPaths(dir).manifest;
  return JSON.parse(fs.readFileSync(p, "utf8")) as SessionManifest;
}

/** Atomically replace one private artifact; failures preserve the old file. */
export function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tempDir = fs.mkdtempSync(
    path.join(path.dirname(file), ".resound-write-"),
  );
  try {
    const tempFile = path.join(tempDir, "content");
    fs.writeFileSync(tempFile, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempFile, file);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Reserve a new session folder without reusing another session's artifacts. */
export function reserveSessionDirectory(
  dir: string,
  manifest: SessionManifest,
): string {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  let candidate = dir;
  for (;;) {
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      if (candidate !== dir) manifest.session_id += candidate.slice(dir.length);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      candidate = `${dir}-${randomUUID()}`;
    }
  }
}

/** Write a manifest.json (pretty-printed) into a session directory. */
export function writeManifest(dir: string, manifest: SessionManifest): void {
  writePrivateFile(
    sessionPaths(dir).manifest,
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

/** Load a full session (manifest + segments) from disk. */
export function loadSession(dir: string): TranscriptSession {
  const manifest = readManifest(dir);
  const paths = sessionPaths(dir, manifest);
  let segments = [] as TranscriptSession["segments"];
  if (fs.existsSync(paths.jsonl)) {
    const parsed = parseJsonl(fs.readFileSync(paths.jsonl, "utf8"));
    if (parsed.errors.length > 0) {
      throw new Error(`Invalid transcript JSONL:\n${parsed.errors.join("\n")}`);
    }
    segments = parsed.segments;
  }
  return { manifest, segments, dir };
}

/**
 * List session directories under a transcripts root. A session directory is
 * any folder containing a manifest.json, searched one or two levels deep
 * (root/date/session).
 */
export function listSessions(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "manifest.json")) {
      found.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * Resolve a session reference to a directory. Accepts an absolute/relative
 * path, or a session_id / folder name searched under the root.
 */
export function resolveSession(ref: string, root: string): string | undefined {
  if (fs.existsSync(path.join(ref, "manifest.json"))) return ref;
  const sessions = listSessions(root);
  // Exact directory-name match.
  const byName = sessions.find((s) => path.basename(s) === ref);
  if (byName) return byName;
  // session_id match from manifest.
  for (const dir of sessions) {
    try {
      if (readManifest(dir).session_id === ref) return dir;
    } catch {
      /* ignore unreadable manifests */
    }
  }
  // Loose substring match on folder name.
  return sessions.find((s) => path.basename(s).includes(ref));
}
