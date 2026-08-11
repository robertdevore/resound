import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  getTranscriber,
  LocalWhisperTranscriber,
  MockTranscriber,
  NotImplementedTranscriber,
  OpenAICompatibleTranscriber,
  parseOpenAiWhisperJson,
  parseWhisperCppJson
} from "./index.js";

describe("transcriber resolution", () => {
  it("defaults to mock", () => {
    const t = getTranscriber({ env: {} as NodeJS.ProcessEnv });
    expect(t).toBeInstanceOf(MockTranscriber);
  });

  it("resolves local-whisper (local-first)", () => {
    const t = getTranscriber({ name: "local-whisper", env: {} as NodeJS.ProcessEnv });
    expect(t).toBeInstanceOf(LocalWhisperTranscriber);
  });

  it("resolves scaffolded providers to a not-implemented stub", () => {
    const t = getTranscriber({ name: "deepgram", env: {} as NodeJS.ProcessEnv });
    expect(t).toBeInstanceOf(NotImplementedTranscriber);
  });

  it("throws for openai without an api key", () => {
    expect(() => getTranscriber({ name: "openai", env: {} as NodeJS.ProcessEnv })).toThrow(
      /OPENAI_API_KEY/
    );
  });

  it("accepts any OpenAI-compatible base URL", () => {
    const t = getTranscriber({
      name: "openai-compatible",
      env: { RESOUND_OPENAI_BASE_URL: "http://localhost:8080/v1" } as NodeJS.ProcessEnv
    });
    expect(t).toBeInstanceOf(OpenAICompatibleTranscriber);
    expect((t as OpenAICompatibleTranscriber).endpoint).toBe(
      "http://localhost:8080/v1/audio/transcriptions"
    );
  });

  it("requires a base URL for openai-compatible", () => {
    expect(() =>
      getTranscriber({ name: "openai-compatible", env: {} as NodeJS.ProcessEnv })
    ).toThrow(/RESOUND_OPENAI_BASE_URL/);
  });
});

describe("local-whisper output parsing", () => {
  it("parses whisper.cpp JSON (ms offsets → seconds)", () => {
    const json = JSON.stringify({
      transcription: [
        { offsets: { from: 0, to: 4000 }, text: " Hello there" },
        { offsets: { from: 4000, to: 8000 }, text: " second line" }
      ]
    });
    const segs = parseWhisperCppJson(json);
    expect(segs).toEqual([
      { start: 0, end: 4, text: "Hello there" },
      { start: 4, end: 8, text: "second line" }
    ]);
  });

  it("parses openai-whisper JSON (seconds)", () => {
    const json = JSON.stringify({ segments: [{ start: 1.5, end: 3.2, text: " hi" }] });
    expect(parseOpenAiWhisperJson(json)).toEqual([{ start: 1.5, end: 3.2, text: "hi" }]);
  });
});

describe("local-whisper transcriber", () => {
  it("invokes the binary and maps segments to the first participant", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-lw-"));
    const audio = path.join(dir, "a.wav");
    fs.writeFileSync(audio, "x");
    // Fake whisper.cpp: write the -of <base>.json then succeed.
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      const ofIdx = args.indexOf("-of");
      const base = args[ofIdx + 1];
      fs.writeFileSync(
        `${base}.json`,
        JSON.stringify({ transcription: [{ offsets: { from: 0, to: 2000 }, text: " hello world" }] })
      );
      return { code: 0, stdout: "", stderr: "" };
    });
    const t = new LocalWhisperTranscriber({ command: "whisper-cli", run });
    const segs = await t.transcribe({
      audioPath: audio,
      participants: [{ id: "u1", username: "Robert", joined_at: "" }]
    });
    expect(run).toHaveBeenCalledOnce();
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ ts: "00:00:00", end_ts: "00:00:02", speaker: "Robert", user_id: "u1" });
    expect(segs[0]!.text).toBe("hello world");
  });

  it("gives a clear error when the binary is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-lw-"));
    const audio = path.join(dir, "a.wav");
    fs.writeFileSync(audio, "x");
    const run = vi.fn(async () => {
      const e = new Error("spawn enoent") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    });
    const t = new LocalWhisperTranscriber({ command: "nope", run });
    await expect(t.transcribe({ audioPath: audio })).rejects.toThrow(/not found|RESOUND_WHISPER_COMMAND/);
  });

  it("fails preflight and transcription on non-zero process exits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-lw-"));
    const audio = path.join(dir, "a.wav");
    fs.writeFileSync(audio, "x");
    const run = vi.fn(async () => ({ code: 2, stdout: "", stderr: "bad model" }));
    const t = new LocalWhisperTranscriber({ command: "whisper-cli", run });

    await expect(t.preflight()).resolves.toMatchObject({ status: "fail" });
    await expect(t.transcribe({ audioPath: audio })).rejects.toThrow(/exited 2.*bad model/);
  });

  it("merges per-speaker tracks back into one timestamp-ordered transcript", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-lw-"));
    const robert = path.join(dir, "robert.wav");
    const ashley = path.join(dir, "ashley.wav");
    fs.writeFileSync(robert, "r");
    fs.writeFileSync(ashley, "a");
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      const audioPath = args[args.indexOf("-f") + 1]!;
      const outBase = args[args.indexOf("-of") + 1]!;
      const payload =
        audioPath === robert
          ? { transcription: [{ offsets: { from: 0, to: 2000 }, text: " robert first" }] }
          : { transcription: [{ offsets: { from: 0, to: 2000 }, text: " ashley later" }] };
      fs.writeFileSync(`${outBase}.json`, JSON.stringify(payload));
      return { code: 0, stdout: "", stderr: "" };
    });
    const t = new LocalWhisperTranscriber({ command: "whisper-cli", run });
    const progress = vi.fn();
    const segs = await t.transcribe({
      participants: [
        { id: "u1", username: "Robert", joined_at: "" },
        { id: "u2", username: "Ashley", joined_at: "" }
      ],
      audioTracks: [
        { userId: "mixed", username: "Discord Mixed", path: path.join(dir, "mixed.wav"), startSeconds: 0, durationSeconds: 4 },
        { userId: "u1", username: "Robert", path: robert, startSeconds: 0, durationSeconds: 2 },
        { userId: "u2", username: "Ashley", path: ashley, startSeconds: 5, durationSeconds: 2 }
      ],
      onProgress: progress
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ ts: "00:00:00", end_ts: "00:00:02", speaker: "Robert", user_id: "u1", text: "robert first" });
    expect(segs[1]).toMatchObject({ ts: "00:00:05", end_ts: "00:00:07", speaker: "Ashley", user_id: "u2", text: "ashley later" });
    expect(progress.mock.calls.map(([event]) => event.phase)).toEqual([
      "track-started",
      "track-completed",
      "track-started",
      "track-completed"
    ]);
  });
});

describe("mock transcriber", () => {
  it("produces deterministic segments mapped to participants", async () => {
    const t = new MockTranscriber();
    const segments = await t.transcribe({
      participants: [
        { id: "1", username: "Robert", joined_at: "" },
        { id: "2", username: "Ashley", joined_at: "" }
      ]
    });
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0]!.speaker).toBe("Robert");
    expect(segments.every((s) => /\d\d:\d\d:\d\d/.test(s.ts))).toBe(true);
  });
});
