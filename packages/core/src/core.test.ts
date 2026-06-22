import { describe, expect, it } from "vitest";
import {
  addParticipant,
  buildSessionFolder,
  buildSessionId,
  createManifest,
  formatTimestamp,
  hasConsent,
  parseJsonl,
  parseTimestamp,
  recordConsentEvent,
  slugify,
  toJsonl,
  toSrtTimestamp,
  toVttTimestamp,
  validateManifest,
  type TranscriptSegment
} from "./index.js";

const at = new Date("2026-06-22T14:32:00Z");

describe("session naming", () => {
  it("slugifies titles", () => {
    expect(slugify("Engineering Standup!")).toBe("engineering-standup");
    expect(slugify("  Weird   Title  ")).toBe("weird-title");
    expect(slugify("")).toBe("session");
  });

  it("builds a session id with date + source + slug", () => {
    expect(buildSessionId({ title: "Engineering Standup", source: "discord", at })).toBe(
      "2026-06-22-discord-engineering-standup"
    );
  });

  it("builds a dated session folder with a time suffix", () => {
    const folder = buildSessionFolder({ title: "Engineering Standup", source: "discord", at });
    expect(folder).toMatch(/^2026-06-22\/discord-engineering-standup-\d{4}$/);
  });
});

describe("manifest", () => {
  it("creates an in-progress manifest with required consent + outputs fields", () => {
    const m = createManifest({ title: "Engineering Standup", startedAt: at });
    expect(m.session_id).toContain("engineering-standup");
    expect(m.ended_at).toBe("");
    expect(m.consent_events).toEqual([]);
    expect(m.outputs.jsonl).toBe("transcript.jsonl");
    expect(m.outputs.action_items).toBe("action-items.md");
  });

  it("flags empty consent as invalid", () => {
    const m = createManifest({ title: "x", startedAt: at });
    const result = validateManifest(m);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/consent/);
  });

  it("passes validation once consent is recorded", () => {
    const m = createManifest({ title: "x", startedAt: at });
    recordConsentEvent(m, {
      type: "recording-announced",
      user_id: "1",
      username: "bot"
    });
    expect(validateManifest(m).valid).toBe(true);
    expect(hasConsent(m)).toBe(true);
  });
});

describe("consent + participants", () => {
  it("logs a join consent event when a participant joins mid-recording", () => {
    const m = createManifest({ title: "x", startedAt: at });
    addParticipant(m, { id: "1", username: "robert" });
    expect(m.participants).toHaveLength(1);
    expect(m.consent_events.some((e) => e.type === "participant-joined")).toBe(true);
  });

  it("does not duplicate participants", () => {
    const m = createManifest({ title: "x", startedAt: at });
    addParticipant(m, { id: "1", username: "robert" });
    addParticipant(m, { id: "1", username: "robert" });
    expect(m.participants).toHaveLength(1);
  });
});

describe("timestamps", () => {
  it("formats and parses round-trip", () => {
    expect(formatTimestamp(192)).toBe("00:03:12");
    expect(parseTimestamp("00:03:12")).toBe(192);
    expect(parseTimestamp("3:12")).toBe(192);
  });

  it("formats vtt and srt fractional timestamps", () => {
    expect(toVttTimestamp(192.5)).toBe("00:03:12.500");
    expect(toSrtTimestamp(192.5)).toBe("00:03:12,500");
  });
});

describe("jsonl", () => {
  const segments: TranscriptSegment[] = [
    {
      ts: "00:03:12",
      end_ts: "00:03:17",
      speaker: "Robert",
      user_id: "123",
      text: "Let's review blockers first.",
      confidence: 0.94
    }
  ];

  it("round-trips segments", () => {
    const parsed = parseJsonl(toJsonl(segments));
    expect(parsed.errors).toEqual([]);
    expect(parsed.segments).toEqual(segments);
  });

  it("reports parse errors and missing fields", () => {
    const bad = '{"ts":"00:00:01"}\nnot json\n';
    const parsed = parseJsonl(bad);
    expect(parsed.errors.length).toBe(2);
  });
});
