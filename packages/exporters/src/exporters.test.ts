import { describe, expect, it } from "vitest";
import { createManifest, addParticipant, type TranscriptSegment } from "@resound/core";
import { toMarkdown } from "./markdown.js";
import { toSrt, toVtt } from "./subtitles.js";
import { extractActionItems } from "./summary.js";

const at = new Date("2026-06-22T14:32:00Z");

function fixture() {
  const manifest = createManifest({ title: "Engineering Standup", startedAt: at });
  addParticipant(manifest, { id: "1", username: "Robert" });
  addParticipant(manifest, { id: "2", username: "Ashley" });
  const segments: TranscriptSegment[] = [
    {
      ts: "00:03:12",
      end_ts: "00:03:17",
      speaker: "Robert",
      user_id: "1",
      text: "Let's review blockers first.",
      confidence: 0.94
    },
    {
      ts: "00:03:18",
      end_ts: "00:03:25",
      speaker: "Ashley",
      user_id: "2",
      text: "I will ship the migration by tomorrow.",
      confidence: 0.91
    }
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
