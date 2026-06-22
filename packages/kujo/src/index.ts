import fs from "node:fs";
import {
  hasConsent,
  readManifest,
  sessionPaths,
  validateSession,
  type SessionManifest
} from "@resound/core";

/**
 * Programmatic implementation of the Kujo checks declared in `.kujo/checks`.
 *
 * Kujo is the workflow/spec/verification layer. The `.kujo/` folder holds the
 * declarative specs and workflows (wired up to a real Kujo runner when one is
 * available in the workspace); these functions are the executable counterpart
 * so `resound validate` and CI can enforce the same contract today.
 */

export interface CheckResult {
  check: string;
  pass: boolean;
  messages: string[];
}

/** consent-required.kujo — every session must carry consent metadata. */
export function checkConsentRequired(manifest: SessionManifest): CheckResult {
  const messages: string[] = [];
  if (!hasConsent(manifest)) {
    messages.push("No consent_events recorded. Resound forbids hidden recording.");
  }
  const announced = manifest.consent_events.some((e) => e.type === "recording-announced");
  if (!announced) {
    messages.push("No 'recording-announced' event — recording was never announced.");
  }
  return { check: "consent-required", pass: messages.length === 0, messages };
}

/** export-completeness.kujo — all six canonical outputs must exist on disk. */
export function checkExportCompleteness(dir: string): CheckResult {
  const messages: string[] = [];
  let manifest: SessionManifest | undefined;
  try {
    manifest = readManifest(dir);
  } catch {
    return {
      check: "export-completeness",
      pass: false,
      messages: ["manifest.json missing or unreadable"]
    };
  }
  const paths = sessionPaths(dir, manifest);
  const required: [string, string][] = [
    ["transcript.jsonl", paths.jsonl],
    ["transcript.md", paths.markdown],
    ["transcript.vtt", paths.vtt],
    ["transcript.srt", paths.srt],
    ["summary.md", paths.summary],
    ["action-items.md", paths.actionItems]
  ];
  for (const [label, p] of required) {
    if (!fs.existsSync(p)) messages.push(`missing required export: ${label}`);
  }
  return { check: "export-completeness", pass: messages.length === 0, messages };
}

/** transcript-validity.kujo — manifest + canonical JSONL must validate. */
export function checkTranscriptValidity(dir: string): CheckResult {
  const result = validateSession(dir);
  return {
    check: "transcript-validity",
    pass: result.valid,
    messages: result.errors
  };
}

/** Run every Kujo check against a session directory. */
export function runChecks(dir: string): CheckResult[] {
  const results: CheckResult[] = [];
  try {
    const manifest = readManifest(dir);
    results.push(checkConsentRequired(manifest));
  } catch {
    results.push({
      check: "consent-required",
      pass: false,
      messages: ["manifest.json missing or unreadable"]
    });
  }
  results.push(checkExportCompleteness(dir));
  results.push(checkTranscriptValidity(dir));
  return results;
}
