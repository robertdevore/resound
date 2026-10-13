import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createManifest,
  recordConsentEvent,
  validateManifest,
  validateSession,
  writeManifest,
} from "./index.js";

function fixture() {
  const manifest = createManifest({
    title: "Synthetic validation",
    source: "mock",
  });
  recordConsentEvent(manifest, {
    type: "recording-announced",
    user_id: "1",
    username: "operator",
  });
  return manifest;
}

describe("manifest structure validation", () => {
  it.each([
    ["title", 42],
    ["started_at", 42],
    ["ended_at", null],
    ["status", {}],
    ["schema_version", null],
    ["source", []],
    ["started_by", null],
    ["started_by", { id: 1, username: "x" }],
    ["recorder", []],
    ["recorder", { id: "x" }],
    ["transcriber", null],
    ["transcriber", { provider: "x", model: 1 }],
    ["participants", [null]],
    ["participants", [{ id: "1", username: 42, joined_at: "now" }]],
    ["consent_events", [null]],
    ["consent_events", [{ type: "recording-announced" }]],
    ["audio_health", [1]],
    ["warnings", [{}]],
    ["audio_files", { tracks: [null] }],
    ["audio_files", { tracks: [], mixed: 42 }],
    [
      "audio_files",
      {
        tracks: [
          {
            user_id: "1",
            username: "x",
            path: "audio.wav",
            start_seconds: -1,
            duration_seconds: 1,
          },
        ],
      },
    ],
    [
      "audio_files",
      {
        tracks: [
          {
            user_id: "1",
            username: "x",
            path: "audio.wav",
            start_seconds: 0,
            duration_seconds: "1",
          },
        ],
      },
    ],
  ])("rejects malformed %s", (field, value) => {
    const result = validateManifest({ ...fixture(), [field]: value });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain(field);
  });
  it("does not mutate valid custom-source manifests or reject extension fields", () => {
    const manifest = {
      ...fixture(),
      source: "custom-provider",
      extra: { future: true },
    };
    const before = JSON.stringify(manifest);
    expect(validateManifest(manifest).valid).toBe(true);
    expect(JSON.stringify(manifest)).toBe(before);
  });
  it("preserves older schema warnings and optional legacy tracks", () => {
    const manifest = { ...fixture(), schema_version: "1.1.0", audio_files: {} };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.warnings.join(" ")).toContain("schema_version");
  });
  it("reports nested corruption through on-disk validation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-manifest-"));
    try {
      writeManifest(dir, fixture());
      const file = path.join(dir, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      manifest.participants = [null];
      fs.writeFileSync(file, JSON.stringify(manifest));
      fs.writeFileSync(path.join(dir, "transcript.jsonl"), "");
      const result = validateSession(dir);
      expect(result.valid).toBe(false);
      expect(result.errors.join(" ")).toContain("participants[0]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("returns errors for a schema object that cannot be coerced to text", () => {
    const manifest = { ...fixture(), schema_version: { toString: null } };
    expect(validateManifest(manifest).errors).toContain(
      "schema_version must be a string",
    );
  });
  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite track durations: %s",
    (duration) => {
      const manifest = fixture();
      manifest.audio_files.tracks = [
        {
          user_id: "1",
          username: "A",
          path: "a.wav",
          start_seconds: 0,
          duration_seconds: duration,
        },
      ];
      expect(validateManifest(manifest).errors.join(" ")).toContain(
        "duration_seconds",
      );
    },
  );
  it("accepts fully populated optional metadata and fractional track times", () => {
    const manifest = fixture();
    manifest.participants = [
      {
        id: "1",
        username: "A",
        joined_at: manifest.started_at,
        left_at: manifest.started_at,
      },
    ];
    manifest.audio_files = {
      mixed: "mixed.wav",
      system: "system.wav",
      microphone: "mic.wav",
      chunks_dir: "chunks",
      tracks: [
        {
          user_id: "1",
          username: "A",
          path: "a.wav",
          start_seconds: 1.5,
          duration_seconds: 0,
        },
      ],
    };
    manifest.transcriber.profile = "local";
    manifest.consent_events[0].note = "synthetic";
    manifest.audio_health = ["ok"];
    manifest.warnings = ["synthetic"];
    expect(validateManifest(manifest).valid).toBe(true);
  });
});
