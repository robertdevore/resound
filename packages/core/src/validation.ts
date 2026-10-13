import fs from "node:fs";
import { parseJsonl } from "./jsonl.js";
import { sessionPaths } from "./paths.js";
import { SCHEMA_VERSION, type SessionManifest } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const REQUIRED_MANIFEST_FIELDS: (keyof SessionManifest)[] = [
  "schema_version",
  "session_id",
  "title",
  "source",
  "guild_id",
  "channel_id",
  "started_at",
  "ended_at",
  "status",
  "started_by",
  "requested_capture_mode",
  "selected_capture_mode",
  "recorder",
  "participants",
  "consent_events",
  "audio_files",
  "audio_health",
  "outputs",
  "transcriber",
  "warnings",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a parsed manifest object in isolation (no filesystem). */
export function validateManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(manifest)) {
    return { valid: false, errors: ["manifest is not an object"], warnings };
  }
  const m = manifest as Record<string, unknown>;

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in m)) errors.push(`manifest missing required field: ${field}`);
  }

  if (
    typeof m.schema_version === "string" &&
    m.schema_version &&
    m.schema_version !== SCHEMA_VERSION
  ) {
    warnings.push(
      `manifest schema_version is "${m.schema_version}", expected "${SCHEMA_VERSION}"`,
    );
  }
  if (
    m.schema_version === SCHEMA_VERSION &&
    m.source === "discord" &&
    m.selected_capture_mode === "discord-native" &&
    (typeof m.voice_channel_id !== "string" || m.voice_channel_id.length === 0)
  ) {
    errors.push("manifest missing required field: voice_channel_id");
  }

  // Validate external JSON before declaring it safe for typed consumers.
  const strings = (
    record: Record<string, unknown>,
    fields: string[],
    prefix = "",
  ) => {
    for (const field of fields) {
      if (typeof record[field] !== "string")
        errors.push(`${prefix}${field} must be a string`);
    }
  };
  const optionalStrings = (
    record: Record<string, unknown>,
    fields: string[],
    prefix: string,
  ) => {
    strings(
      record,
      fields.filter((field) => record[field] !== undefined),
      prefix,
    );
  };
  const object = (value: unknown, label: string, fields: string[]) => {
    if (!isRecord(value)) {
      errors.push(`${label} must be an object`);
      return undefined;
    }
    strings(value, fields, `${label}.`);
    return value;
  };
  const rows = (
    field: string,
    check: (row: unknown, label: string) => void,
  ) => {
    if (!(field in m)) return; // Missing required fields are reported above.
    if (!Array.isArray(m[field])) {
      errors.push(`${field} must be an array`);
      return;
    }
    m[field].forEach((row, index) => check(row, `${field}[${index}]`));
  };
  strings(
    m,
    [
      "schema_version",
      "session_id",
      "title",
      "source",
      "guild_id",
      "channel_id",
      "started_at",
      "ended_at",
      "status",
      "requested_capture_mode",
      "selected_capture_mode",
    ].filter((field) => field in m),
  );
  optionalStrings(m, ["voice_channel_id", "fallback_reason"], "");
  if ("started_by" in m) object(m.started_by, "started_by", ["id", "username"]);
  if ("recorder" in m) object(m.recorder, "recorder", ["id", "mode"]);
  if ("transcriber" in m) {
    const transcriber = object(m.transcriber, "transcriber", [
      "provider",
      "model",
    ]);
    if (transcriber) optionalStrings(transcriber, ["profile"], "transcriber.");
  }
  if (Array.isArray(m.consent_events) && m.consent_events.length === 0) {
    errors.push("consent_events is empty — Resound requires recorded consent");
  }
  rows("consent_events", (row, label) => {
    const event = object(row, label, ["type", "user_id", "username", "ts"]);
    if (event) optionalStrings(event, ["note"], `${label}.`);
  });
  rows("participants", (row, label) => {
    const participant = object(row, label, ["id", "username", "joined_at"]);
    if (participant) optionalStrings(participant, ["left_at"], `${label}.`);
  });
  for (const field of ["warnings", "audio_health"]) {
    rows(field, (row, label) => {
      if (typeof row !== "string") errors.push(`${label} must be a string`);
    });
  }
  if ("audio_files" in m) {
    const audio = object(m.audio_files, "audio_files", []);
    if (audio) {
      optionalStrings(
        audio,
        ["mixed", "system", "microphone", "chunks_dir"],
        "audio_files.",
      );
      if (!Array.isArray(audio.tracks)) {
        if (audio.tracks !== undefined || m.schema_version === SCHEMA_VERSION) {
          errors.push("audio_files.tracks must be an array");
        }
      } else {
        audio.tracks.forEach((value, index) => {
          const label = `audio_files.tracks[${index}]`;
          const track = object(value, label, ["user_id", "username", "path"]);
          if (!track) return;
          for (const field of ["start_seconds", "duration_seconds"]) {
            const seconds = track[field];
            if (
              typeof seconds !== "number" ||
              !Number.isFinite(seconds) ||
              seconds < 0
            ) {
              errors.push(
                `${label}.${field} must be a finite nonnegative number`,
              );
            }
          }
        });
      }
    }
  }

  if ("outputs" in m) {
    if (!isRecord(m.outputs)) {
      errors.push("outputs must be an object");
    } else {
      const outputs = m.outputs as Record<string, unknown>;
      for (const field of [
        "jsonl",
        "markdown",
        "vtt",
        "srt",
        "summary",
        "action_items",
      ]) {
        if (typeof outputs[field] !== "string" || outputs[field].length === 0) {
          errors.push(`outputs.${field} must be a non-empty string`);
        }
      }
    }
  }

  if (!m.ended_at) {
    warnings.push("ended_at is empty — session may still be in progress");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Validate a session folder on disk: manifest, consent, declared outputs. */
export function validateSession(dir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return {
      valid: false,
      errors: [`session directory not found: ${dir}`],
      warnings,
    };
  }

  const manifestPath = sessionPaths(dir).manifest;
  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      errors: [`missing manifest.json in ${dir}`],
      warnings,
    };
  }

  let manifest: SessionManifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    ) as SessionManifest;
  } catch (err) {
    return {
      valid: false,
      errors: [`manifest.json is not valid JSON: ${(err as Error).message}`],
      warnings,
    };
  }

  const manifestResult = validateManifest(manifest);
  errors.push(...manifestResult.errors);
  warnings.push(...manifestResult.warnings);

  // Declared outputs should exist on disk.
  let paths: ReturnType<typeof sessionPaths>;
  try {
    paths = sessionPaths(dir, manifest);
  } catch (err) {
    errors.push((err as Error).message);
    return { valid: false, errors, warnings };
  }
  const declared: [string, string][] = [
    ["jsonl", paths.jsonl],
    ["markdown", paths.markdown],
    ["vtt", paths.vtt],
    ["srt", paths.srt],
    ["summary", paths.summary],
    ["action_items", paths.actionItems],
  ];
  for (const [label, p] of declared) {
    if (!fs.existsSync(p))
      warnings.push(`declared output "${label}" not found: ${p}`);
  }

  // The canonical JSONL, if present, must parse.
  if (fs.existsSync(paths.jsonl)) {
    try {
      const { errors: jsonlErrors } = parseJsonl(
        fs.readFileSync(paths.jsonl, "utf8"),
      );
      errors.push(...jsonlErrors.map((e) => `transcript.jsonl: ${e}`));
    } catch (error) {
      errors.push(
        `Cannot read canonical transcript.jsonl: ${(error as Error).message}`,
      );
    }
  } else {
    errors.push("canonical transcript.jsonl is missing");
  }

  return { valid: errors.length === 0, errors, warnings };
}
