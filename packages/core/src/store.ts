import fs from "node:fs";
import path from "node:path";
import { sessionPaths } from "./paths.js";
import { parseJsonl } from "./jsonl.js";
import type { SessionManifest, TranscriptSession } from "./types.js";

/** Read + parse a manifest.json from a session directory. */
export function readManifest(dir: string): SessionManifest {
  const p = sessionPaths(dir).manifest;
  return JSON.parse(fs.readFileSync(p, "utf8")) as SessionManifest;
}

/** Write a manifest.json (pretty-printed) into a session directory. */
export function writeManifest(dir: string, manifest: SessionManifest): void {
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = sessionPaths(dir).manifest;
  const tempPath = `${manifestPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, manifestPath);
}

/** Load a full session (manifest + segments) from disk. */
export function loadSession(dir: string): TranscriptSession {
  const manifest = readManifest(dir);
  const paths = sessionPaths(dir, manifest);
  let segments = [] as TranscriptSession["segments"];
  if (fs.existsSync(paths.jsonl)) {
    segments = parseJsonl(fs.readFileSync(paths.jsonl, "utf8")).segments;
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
