import {
  SCHEMA_VERSION,
  type SessionManifest,
  type SessionOutputs,
  type SessionSource,
  type StartedBy
} from "./types.js";

/** Lower-case, dash-separated, filesystem-safe slug. */
export function slugify(input: string): string {
  return (
    input
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "session"
  );
}

function datePart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function timePart(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The canonical default output file names. */
export function defaultOutputs(): SessionOutputs {
  return {
    jsonl: "transcript.jsonl",
    markdown: "transcript.md",
    vtt: "transcript.vtt",
    srt: "transcript.srt",
    summary: "summary.md",
    action_items: "action-items.md"
  };
}

export interface BuildSessionIdOptions {
  title: string;
  source?: SessionSource;
  at?: Date;
}

/** `2026-06-22-discord-engineering-standup` */
export function buildSessionId(opts: BuildSessionIdOptions): string {
  const at = opts.at ?? new Date();
  const source = opts.source ?? "discord";
  return `${datePart(at)}-${source}-${slugify(opts.title)}`;
}

/**
 * Relative session folder, e.g.
 * `2026-06-22/discord-engineering-standup-1432`.
 */
export function buildSessionFolder(opts: BuildSessionIdOptions): string {
  const at = opts.at ?? new Date();
  const source = opts.source ?? "discord";
  return `${datePart(at)}/${source}-${slugify(opts.title)}-${timePart(at)}`;
}

export interface CreateManifestOptions {
  title: string;
  source?: SessionSource;
  guildId?: string;
  channelId?: string;
  startedBy?: StartedBy;
  startedAt?: Date;
  transcriberProvider?: string;
  transcriberModel?: string;
}

/** Build a fresh, in-progress manifest. `ended_at` stays empty until stop. */
export function createManifest(opts: CreateManifestOptions): SessionManifest {
  const startedAt = opts.startedAt ?? new Date();
  return {
    schema_version: SCHEMA_VERSION,
    session_id: buildSessionId({
      title: opts.title,
      source: opts.source,
      at: startedAt
    }),
    title: opts.title,
    source: opts.source ?? "discord",
    guild_id: opts.guildId ?? "",
    channel_id: opts.channelId ?? "",
    started_at: startedAt.toISOString(),
    ended_at: "",
    started_by: opts.startedBy ?? { id: "", username: "" },
    participants: [],
    consent_events: [],
    outputs: defaultOutputs(),
    transcriber: {
      provider: opts.transcriberProvider ?? "",
      model: opts.transcriberModel ?? ""
    }
  };
}
