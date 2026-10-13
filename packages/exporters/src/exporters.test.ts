import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createManifest,
  addParticipant,
  type TranscriptSegment,
} from "@resound/core";
import { toMarkdown } from "./markdown.js";
import { toSrt, toVtt } from "./subtitles.js";
import { extractActionItems } from "./summary.js";
import { writeSessionOutputs } from "./write.js";

const at = new Date("2026-06-22T14:32:00Z");

function fixture() {
  const manifest = createManifest({
    title: "Engineering Standup",
    startedAt: at,
  });
  addParticipant(manifest, { id: "1", username: "Robert" });
  addParticipant(manifest, { id: "2", username: "Ashley" });
  const segments: TranscriptSegment[] = [
    {
      ts: "00:03:12",
      end_ts: "00:03:17",
      speaker: "Robert",
      user_id: "1",
      text: "Let's review blockers first.",
      confidence: 0.94,
    },
    {
      ts: "00:03:18",
      end_ts: "00:03:25",
      speaker: "Ashley",
      user_id: "2",
      text: "I will ship the migration by tomorrow.",
      confidence: 0.91,
    },
  ];
  return { manifest, segments };
}

describe("markdown export", () => {
  it("renders title, participants, and transcript lines", () => {
    const { manifest, segments } = fixture();
    const md = toMarkdown(manifest, segments, {});
    expect(md).toContain("# Resound Transcript: Engineering Standup");
    expect(md).toContain("Date: 2026-06-22");
    expect(md).toContain("Participants: Robert, Ashley");
    expect(md).toContain("**00:03:12 Robert:** Let's review blockers first.");
  });
});

describe("subtitles", () => {
  it("renders VTT with a header and cue", () => {
    const { segments } = fixture();
    const vtt = toVtt(segments);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:03:12.000 --> 00:03:17.000");
    expect(vtt).toContain("<v Robert>Let's review blockers first.");
  });

  it("renders SRT with comma millis", () => {
    const { segments } = fixture();
    const srt = toSrt(segments);
    expect(srt).toContain("00:03:18,000 --> 00:03:25,000");
    expect(srt).toContain("Ashley: I will ship the migration by tomorrow.");
  });
});

describe("action items", () => {
  it("extracts items from heuristic hints", () => {
    const { segments } = fixture();
    const items = extractActionItems(segments);
    expect(items.some((i) => i.includes("migration"))).toBe(true);
  });
});

describe("output writing", () => {
  it("creates parent directories for configured nested output paths", () => {
    const { manifest, segments } = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-export-"));
    manifest.outputs.markdown = "exports/transcript.md";
    manifest.outputs.summary = "exports/summary.md";

    writeSessionOutputs({ manifest, segments, dir });

    expect(fs.existsSync(path.join(dir, "exports", "transcript.md"))).toBe(
      true,
    );
    if (process.platform !== "win32") {
      expect(
        fs.statSync(path.join(dir, "exports", "transcript.md")).mode & 0o777,
      ).toBe(0o600);
      expect(fs.statSync(path.join(dir, "manifest.json")).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(fs.existsSync(path.join(dir, "exports", "summary.md"))).toBe(true);
  });
});

it.each([
  "transcript.jsonl",
  "./transcript.jsonl",
  "manifest.json",
  ".",
  "",
  "transcript.jsonl/child.md",
])(
  "rejects conflicting output %j before changing any artifact",
  (configured) => {
    const { manifest, segments } = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-collision-"));
    try {
      writeSessionOutputs({ manifest, segments, dir });
      const before = new Map(
        fs
          .readdirSync(dir)
          .map((file) => [file, fs.readFileSync(path.join(dir, file))]),
      );
      manifest.outputs.markdown = configured;
      expect(() => writeSessionOutputs({ manifest, segments, dir })).toThrow(
        /Session output path/,
      );
      expect(fs.readdirSync(dir).sort()).toEqual([...before.keys()].sort());
      for (const [file, bytes] of before)
        expect(fs.readFileSync(path.join(dir, file))).toEqual(bytes);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.each([
  "audio/raw/source.wav",
  "audio/chunks/track.wav",
  "audio/raw",
  "audio",
])(
  "rejects output %s overlapping retained audio before writing",
  (configured) => {
    const { manifest, segments } = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-audio-export-"));
    try {
      writeSessionOutputs({ manifest, segments, dir });
      const canonical = fs.readFileSync(path.join(dir, "transcript.jsonl"));
      const audio = path.join(dir, "audio/raw/source.wav");
      fs.mkdirSync(path.dirname(audio), { recursive: true });
      fs.writeFileSync(audio, "synthetic retained audio");
      manifest.outputs.jsonl = configured;
      expect(() => writeSessionOutputs({ manifest, segments, dir })).toThrow(
        /Session output path/,
      );
      expect(fs.readFileSync(audio, "utf8")).toBe("synthetic retained audio");
      expect(fs.readFileSync(path.join(dir, "transcript.jsonl"))).toEqual(
        canonical,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

it.each(["mixed", "system", "microphone", "chunks_dir", "track"] as const)(
  "preserves declared %s audio outside standard recording directories",
  (field) => {
    const { manifest, segments } = fixture();
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "resound-declared-audio-"),
    );
    try {
      const audio = path.join(dir, "legacy.wav");
      fs.writeFileSync(audio, "synthetic legacy audio");
      if (field === "track") {
        manifest.audio_files.tracks = [
          {
            user_id: "1",
            username: "A",
            path: path.relative(process.cwd(), audio),
            start_seconds: 0,
            duration_seconds: 1,
          },
        ];
      } else {
        manifest.audio_files[field] = audio;
      }
      manifest.outputs.markdown = "legacy.wav";
      expect(() => writeSessionOutputs({ manifest, segments, dir })).toThrow(
        /Session output path/,
      );
      expect(fs.readFileSync(audio, "utf8")).toBe("synthetic legacy audio");
      expect(fs.readdirSync(dir)).toEqual(["legacy.wav"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("allows distinct nested exports alongside declared audio", () => {
  const { manifest, segments } = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-distinct-"));
  try {
    manifest.audio_files.mixed = path.join(dir, "legacy.wav");
    manifest.outputs.markdown = "exports/legacy.wav.md";
    fs.writeFileSync(manifest.audio_files.mixed, "synthetic audio");
    writeSessionOutputs({ manifest, segments, dir });
    expect(fs.readFileSync(manifest.audio_files.mixed, "utf8")).toBe(
      "synthetic audio",
    );
    expect(
      fs.readFileSync(path.join(dir, manifest.outputs.markdown), "utf8"),
    ).toContain("Engineering Standup");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
