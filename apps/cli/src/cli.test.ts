import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  listSessions,
  loadSession,
  readManifest,
  validateSession,
} from "@resound/core";
import { runChecks } from "@resound/kujo";
import {
  createFileSession,
  createMockSession,
  parseParticipants,
} from "./session-runner.js";

describe("createMockSession", () => {
  it("produces a complete, valid, portable session", async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "resound-cli-"));
    const session = await createMockSession({
      title: "Engineering Standup",
      env: {
        RESOUND_OUTPUT_DIR: out,
        RESOUND_TRANSCRIBER: "mock",
      } as NodeJS.ProcessEnv,
      at: new Date("2026-06-22T14:32:00Z"),
    });

    // All six canonical outputs + manifest exist.
    for (const f of [
      "manifest.json",
      "transcript.jsonl",
      "transcript.md",
      "transcript.vtt",
      "transcript.srt",
      "summary.md",
      "action-items.md",
    ]) {
      expect(fs.existsSync(path.join(session.dir, f)), f).toBe(true);
    }

    // Reloads from disk identically and validates.
    const reloaded = loadSession(session.dir);
    expect(reloaded.segments.length).toBe(session.segments.length);
    expect(reloaded.manifest.status).toBe("completed");
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
      { id: "p3", username: "Jelena" },
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
      env: {
        RESOUND_OUTPUT_DIR: out,
        RESOUND_TRANSCRIBER: "mock",
      } as NodeJS.ProcessEnv,
      at: new Date("2026-06-22T15:00:00Z"),
    });
    expect(session.manifest.source).toBe("file");
    expect(session.segments.length).toBeGreaterThan(0);
    expect(validateSession(session.dir).valid).toBe(true);
    // Source audio is referenced inside the session for provenance.
    expect(
      fs.existsSync(path.join(session.dir, "audio", "raw", "meeting.wav")),
    ).toBe(true);
  });

  it("errors clearly when the audio file is missing", async () => {
    await expect(
      createFileSession({
        title: "x",
        audioFile: "/no/such/file.wav",
        env: { RESOUND_TRANSCRIBER: "mock" } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/not found/);
  });
});

it("flushes the complete stdout sink through a pipe before exiting", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "resound-stdout-pipe-"));
  try {
    const session = await createMockSession({
      title: "Pipe",
      env: { RESOUND_OUTPUT_DIR: out, RESOUND_TRANSCRIBER: "mock" },
    });
    const markdown = "synthetic transcript line\n".repeat(100_000);
    fs.writeFileSync(path.join(session.dir, "transcript.md"), markdown);
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
        ),
        "--tsconfig",
        fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url)),
        fileURLToPath(new URL("./index.ts", import.meta.url)),
        "sink",
        "stdout",
        session.dir,
      ],
      { cwd: out, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    expect(stdout.length).toBe(markdown.length);
    expect(stdout).toBe(markdown);
    expect(stderr).toContain("[ok] stdout:");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

describe("file session durability", () => {
  const directories: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of directories.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });
  function fixture() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "resound-file-durable-"));
    directories.push(out);
    const audio = path.join(out, "meeting.wav");
    fs.writeFileSync(audio, "synthetic audio");
    return {
      out,
      audio,
      env: { RESOUND_OUTPUT_DIR: out, RESOUND_TRANSCRIBER: "mock" },
    };
  }
  it("marks successful sessions completed and declares the retained audio", async () => {
    const { out, audio, env } = fixture();
    const session = await createFileSession({
      title: "Durable",
      audioFile: audio,
      env,
    });
    const manifest = readManifest(session.dir);
    expect(manifest.status).toBe("completed");
    expect(manifest.audio_files.mixed).toBe(
      path.join(session.dir, "audio/raw/meeting.wav"),
    );
    expect(fs.readFileSync(manifest.audio_files.mixed!, "utf8")).toBe(
      "synthetic audio",
    );
    expect(fs.statSync(manifest.audio_files.mixed!).mode & 0o077).toBe(0);
    expect(listSessions(out)).toEqual([session.dir]);
  });
  it("persists consent and retained audio when transcription fails", async () => {
    const { out, audio, env } = fixture();
    await expect(
      createFileSession({
        title: "Failure",
        audioFile: audio,
        env,
        provider: "deepgram",
      }),
    ).rejects.toThrow(/not implemented/);
    const sessions = listSessions(out);
    expect(sessions).toHaveLength(1);
    const manifest = readManifest(sessions[0]!);
    expect(manifest.status).toBe("failed");
    expect(manifest.ended_at).not.toBe("");
    expect(
      manifest.consent_events.some((e) => e.type === "recording-announced"),
    ).toBe(true);
    expect(fs.readFileSync(manifest.audio_files.mixed!, "utf8")).toBe(
      "synthetic audio",
    );
    expect(fs.existsSync(path.join(sessions[0]!, "transcript.jsonl"))).toBe(
      false,
    );
  });
  it("fails visibly on copy errors instead of transcribing a partial destination", async () => {
    const { out, audio, env } = fixture();
    vi.spyOn(fs, "copyFileSync").mockImplementation((_source, destination) => {
      fs.writeFileSync(destination, "partial");
      throw new Error("synthetic disk full");
    });
    await expect(
      createFileSession({ title: "Copy failure", audioFile: audio, env }),
    ).rejects.toThrow(/synthetic disk full/);
    const sessions = listSessions(out);
    expect(sessions).toHaveLength(1);
    const manifest = readManifest(sessions[0]!);
    expect(manifest.status).toBe("failed");
    expect(manifest.audio_files.mixed).toBeUndefined();
    expect(fs.existsSync(path.join(sessions[0]!, "transcript.jsonl"))).toBe(
      false,
    );
    expect(fs.readFileSync(audio, "utf8")).toBe("synthetic audio");
  });
  it("retains audio and marks a partial export failed", async () => {
    const { out, audio, env } = fixture();
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(destination).endsWith("transcript.md"))
        throw new Error("synthetic export failure");
      rename(source, destination);
    });
    await expect(
      createFileSession({ title: "Export failure", audioFile: audio, env }),
    ).rejects.toThrow(/synthetic export failure/);
    const [dir] = listSessions(out);
    const manifest = readManifest(dir!);
    expect(manifest.status).toBe("failed");
    expect(fs.readFileSync(manifest.audio_files.mixed!, "utf8")).toBe(
      "synthetic audio",
    );
    expect(fs.existsSync(path.join(dir!, "transcript.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(dir!, "transcript.md"))).toBe(false);
    expect(manifest.warnings.join(" ")).toContain("synthetic export failure");
  });
  it("retains a discoverable mock session when its configured provider fails", async () => {
    const { out, env } = fixture();
    await expect(
      createMockSession({
        title: "Mock failure",
        env: { ...env, RESOUND_TRANSCRIBER: "deepgram" },
      }),
    ).rejects.toThrow(/not implemented/);
    const [dir] = listSessions(out);
    expect(dir).toBeDefined();
    expect(readManifest(dir!).status).toBe("failed");
  });
  it("rejects directories before reserving a session", async () => {
    const { out, env } = fixture();
    await expect(
      createFileSession({ title: "Directory", audioFile: out, env }),
    ).rejects.toThrow(/regular file/);
    expect(listSessions(out)).toEqual([]);
  });
});
