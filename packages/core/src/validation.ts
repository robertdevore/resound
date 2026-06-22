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
  "started_at",
  "started_by",
  "participants",
  "consent_events",
  "outputs",
  "transcriber"
];

/** Validate a parsed manifest object in isolation (no filesystem). */
export function validateManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof manifest !== "object" || manifest === null) {
    return { valid: false, errors: ["manifest is not an object"], warnings };
  }
  const m = manifest as Record<string, unknown>;

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in m)) errors.push(`manifest missing required field: ${field}`);
  }

  if (m.schema_version && m.schema_version !== SCHEMA_VERSION) {
    warnings.push(
      `manifest schema_version is "${m.schema_version}", expected "${SCHEMA_VERSION}"`
    );
  }

  const consent = m.consent_events;
  if (Array.isArray(consent)) {
    if (consent.length === 0) {
      errors.push("consent_events is empty — Resound requires recorded consent");
    }
  } else if ("consent_events" in m) {
    errors.push("consent_events must be an array");
  }

  if ("participants" in m && !Array.isArray(m.participants)) {
    errors.push("participants must be an array");
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
    return { valid: false, errors: [`session directory not found: ${dir}`], warnings };
  }

  const manifestPath = sessionPaths(dir).manifest;
  if (!fs.existsSync(manifestPath)) {
    return { valid: false, errors: [`missing manifest.json in ${dir}`], warnings };
  }

  let manifest: SessionManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as SessionManifest;
  } catch (err) {
    return {
      valid: false,
      errors: [`manifest.json is not valid JSON: ${(err as Error).message}`],
      warnings
    };
  }

  const manifestResult = validateManifest(manifest);
  errors.push(...manifestResult.errors);
  warnings.push(...manifestResult.warnings);

  // Declared outputs should exist on disk.
  const paths = sessionPaths(dir, manifest);
  const declared: [string, string][] = [
    ["jsonl", paths.jsonl],
    ["markdown", paths.markdown],
    ["vtt", paths.vtt],
    ["srt", paths.srt],
    ["summary", paths.summary],
    ["action_items", paths.actionItems]
  ];
  for (const [label, p] of declared) {
    if (!fs.existsSync(p)) warnings.push(`declared output "${label}" not found: ${p}`);
  }

  // The canonical JSONL, if present, must parse.
  if (fs.existsSync(paths.jsonl)) {
    const { errors: jsonlErrors } = parseJsonl(fs.readFileSync(paths.jsonl, "utf8"));
    errors.push(...jsonlErrors.map((e) => `transcript.jsonl: ${e}`));
  } else {
    errors.push("canonical transcript.jsonl is missing");
  }

  return { valid: errors.length === 0, errors, warnings };
}
