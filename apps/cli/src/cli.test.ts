import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { loadSession, validateSession } from "@resound/core";
import { runChecks } from "@resound/kujo";
import { createFileSession, createMockSession, parseParticipants } from "./session-runner.js";

describe("createMockSession", () => {
  it("produces a complete, valid, portable session", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "resound-cli-"));
    const session = await createMockSession({
      title: "Engineering Standup",
      env: { RESOUND_OUTPUT_DIR: out, RESOUND_TRANSCRIBER: "mock" } as NodeJS.ProcessEnv,
      at: new Date("2026-06-22T14:32:00Z")
    });

    // All six canonical outputs + manifest exist.
    for (const f of [
      "manifest.json",
      "transcript.jsonl",
      "transcript.md",
      "transcript.vtt",
      "transcript.srt",
      "summary.md",
      "action-items.md"
    ]) {
      expect(fs.existsSync(path.join(session.dir, f)), f).toBe(true);
    }

    // Reloads from disk identically and validates.
    const reloaded = loadSession(session.dir);
    expect(reloaded.segments.length).toBe(session.segments.length);
    expect(validateSession(session.dir).valid).toBe(true);
    expect(runChecks(session.dir).every((c) => c.pass)).toBe(true);

    // Portable without Strata: the markdown is readable on its own.
    const md = fs.readFileSync(path.join(session.dir, "transcript.md"), "utf8");
    expect(md).toContain("# Resound Transcript: Engineering Standup");
  });
});

describe("parseParticipants", () => {
  it("parses a comma list into synthetic participants", () => {
    expect(parseParticipants("Robert, Ashley ,Jelena")).toEqual([
      { id: "p1", username: "Robert" },
      { id: "p2", username: "Ashley" },
      { id: "p3", username: "Jelena" }
    ]);
    expect(parseParticipants(undefined)).toEqual([]);
  });
});

describe("createFileSession", () => {
  it("transcribes a real audio file into a valid session (mock provider)", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "resound-file-"));
    const audio = path.join(out, "meeting.wav");
    fs.writeFileSync(audio, "not real audio, mock provider ignores bytes");
    const session = await createFileSession({
      title: "Recorded Meeting",
      audioFile: audio,
      participants: parseParticipants("Robert,Ashley"),
      env: { RESOUND_OUTPUT_DIR: out, RESOUND_TRANSCRIBER: "mock" } as NodeJS.ProcessEnv,
      at: new Date("2026-06-22T15:00:00Z")
    });
    expect(session.manifest.source).toBe("file");
    expect(session.segments.length).toBeGreaterThan(0);
    expect(validateSession(session.dir).valid).toBe(true);
    // Source audio is referenced inside the session for provenance.
    expect(fs.existsSync(path.join(session.dir, "audio", "raw", "meeting.wav"))).toBe(true);
  });

  it("errors clearly when the audio file is missing", async () => {
    await expect(
      createFileSession({
        title: "x",
        audioFile: "/no/such/file.wav",
        env: { RESOUND_TRANSCRIBER: "mock" } as NodeJS.ProcessEnv
      })
    ).rejects.toThrow(/not found/);
  });
});
