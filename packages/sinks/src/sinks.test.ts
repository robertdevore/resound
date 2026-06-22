import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  createManifest,
  recordConsentEvent,
  type TranscriptSession
} from "@resound/core";
import { StdoutSink } from "./stdout.js";
import { StrataSink } from "./strata.js";
import { WebhookSink } from "./webhook.js";

function tempSession(): TranscriptSession {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-sink-"));
  const manifest = createManifest({ title: "Test", startedAt: new Date("2026-06-22T00:00:00Z") });
  recordConsentEvent(manifest, { type: "recording-announced", user_id: "1", username: "bot" });
  fs.writeFileSync(path.join(dir, "transcript.md"), "# Resound Transcript: Test\n", "utf8");
  return { manifest, segments: [], dir };
}

describe("stdout sink", () => {
  it("writes the markdown to the provided writer", async () => {
    const session = tempSession();
    let out = "";
    const sink = new StdoutSink((s) => (out += s));
    const result = await sink.send(session);
    expect(result.ok).toBe(true);
    expect(out).toContain("# Resound Transcript: Test");
  });
});

describe("strata sink", () => {
  it("invokes the configured command with the markdown path", async () => {
    const session = tempSession();
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: "" });
    const sink = new StrataSink({ command: "strata notes add --file", run });
    const result = await sink.send(session);
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledWith("strata", [
      "notes",
      "add",
      "--file",
      path.join(session.dir, "transcript.md")
    ]);
  });

  it("fails gracefully when the command is missing", async () => {
    const session = tempSession();
    const run = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const sink = new StrataSink({ command: "strata notes add --file", run });
    const result = await sink.send(session);
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.detail).toMatch(/optional/i);
  });
});

describe("webhook sink", () => {
  it("posts a json payload", async () => {
    const session = tempSession();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    const sink = new WebhookSink({ url: "https://example.test/hook", fetchImpl });
    const result = await sink.send(session);
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
