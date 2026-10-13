import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalWhisperTranscriber,
  OpenAICompatibleTranscriber,
} from "./index.js";
import { mapRawSegmentsToSpeakerSegments } from "./tracks.js";
import type { TranscriptionTrack } from "./types.js";

describe("track timing boundary", () => {
  let dir: string;
  let track: TranscriptionTrack;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-track-"));
    const audio = path.join(dir, "audio.wav");
    fs.writeFileSync(audio, "synthetic");
    track = {
      path: audio,
      userId: "a",
      username: "A",
      startSeconds: 0,
      durationSeconds: 1,
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const provider of ["local", "remote"]) {
    it.each([
      ["startSeconds", -1],
      ["startSeconds", NaN],
      ["startSeconds", Infinity],
      ["startSeconds", "2"],
      ["durationSeconds", -1],
      ["durationSeconds", NaN],
      ["durationSeconds", Infinity],
      ["durationSeconds", "2"],
    ])(
      `${provider} rejects invalid %s=%s before processing any track`,
      async (field, value) => {
        const run = vi.fn(async (_cmd: string, args: string[]) => {
          fs.writeFileSync(
            args[args.indexOf("-of") + 1] + ".json",
            JSON.stringify({ transcription: [] }),
          );
          return { code: 0, stdout: "", stderr: "" };
        });
        const fetch = vi.fn(
          async () =>
            new Response(JSON.stringify({ segments: [] }), { status: 200 }),
        );
        vi.stubGlobal("fetch", fetch);
        const transcriber =
          provider === "local"
            ? new LocalWhisperTranscriber({ run, env: {} })
            : new OpenAICompatibleTranscriber({
                apiKey: "synthetic",
                baseUrl: "http://localhost.invalid/v1",
              });
        await expect(
          transcriber.transcribe({
            audioTracks: [track, { ...track, [field]: value }],
          }),
        ).rejects.toThrow(new RegExp(String(field)));
        expect(run).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      },
    );
  }
  it("preserves valid fractional speaker offsets", () => {
    expect(
      mapRawSegmentsToSpeakerSegments([{ start: 1.5, end: 2.5, text: "hi" }], {
        userId: "a",
        username: "A",
        startSeconds: 60.5,
      })[0],
    ).toMatchObject({ ts: "00:01:02", end_ts: "00:01:03" });
  });
  it("rejects overflow instead of silently resetting the timeline to zero", () => {
    expect(() =>
      mapRawSegmentsToSpeakerSegments(
        [{ start: 1e308, end: 1e308, text: "hi" }],
        { userId: "a", username: "A", startSeconds: 1e308 },
      ),
    ).toThrow(/timestamp/);
  });
  it("preserves an unknown provider end timestamp default", () => {
    expect(
      mapRawSegmentsToSpeakerSegments([{ start: 2, end: 0, text: "hi" }], {
        userId: "a",
        username: "A",
      })[0],
    ).toMatchObject({ ts: "00:00:02", end_ts: "00:00:00" });
  });
});
