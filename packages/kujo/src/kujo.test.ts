import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkConsentRequired } from "./index.js";
import { createManifest, recordConsentEvent } from "@resound/core";

describe("consent-required check", () => {
  it("fails with no consent", () => {
    const m = createManifest({
      title: "x",
      startedAt: new Date("2026-06-22T00:00:00Z"),
    });
    expect(checkConsentRequired(m).pass).toBe(false);
  });

  it("passes once recording is announced", () => {
    const m = createManifest({
      title: "x",
      startedAt: new Date("2026-06-22T00:00:00Z"),
    });
    recordConsentEvent(m, {
      type: "recording-announced",
      user_id: "1",
      username: "bot",
    });
    expect(checkConsentRequired(m).pass).toBe(true);
  });
});

it("reports unsafe manifest output paths without throwing out of the check suite", async () => {
  const { createManifest, writeManifest } = await import("@resound/core");
  const { runChecks } = await import("./index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-kujo-invalid-"));
  try {
    const manifest = createManifest({ title: "invalid" });
    manifest.outputs.jsonl = "../outside.jsonl";
    writeManifest(dir, manifest);
    const checks = runChecks(dir);
    expect(checks).toHaveLength(3);
    expect(
      checks.find((check) => check.check === "export-completeness")?.pass,
    ).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
