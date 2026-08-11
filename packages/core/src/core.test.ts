import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addParticipant,
  buildSessionFolder,
  buildSessionId,
  createManifest,
  formatTimestamp,
  hasConsent,
  loadSession,
  outputRoot,
  parseJsonl,
  parseTimestamp,
  recordConsentEvent,
  removeParticipant,
  sessionPaths,
  slugify,
  toJsonl,
  toSrtTimestamp,
  toVttTimestamp,
  validateManifest,
  writeManifest,
  type TranscriptSegment
} from "./index.js";

const at = new Date(2026, 5, 22, 14, 32, 0, 0);

describe("session naming", () => {
  it("slugifies titles", () => {
    expect(slugify("Engineering Standup!")).toBe("engineering-standup");
    expect(slugify("  Weird   Title  ")).toBe("weird-title");
    expect(slugify("")).toBe("session");
  });

	it("builds a session id with date + source + slug", () => {
		expect(buildSessionId({ title: "Engineering Standup", source: "discord", at })).toBe(
			"2026-06-22-143200000-discord-engineering-standup"
		);
	});

  it("builds a dated session folder with a time suffix", () => {
    const folder = buildSessionFolder({ title: "Engineering Standup", source: "discord", at });
		expect(folder).toBe("2026-06-22/discord-engineering-standup-143200000");
	});

	it("does not collide for sessions started in the same minute", () => {
		const later = new Date(2026, 5, 22, 14, 32, 0, 1);
		expect(buildSessionId({ title: "Engineering Standup", source: "discord", at })).not.toBe(
			buildSessionId({ title: "Engineering Standup", source: "discord", at: later })
		);
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
    expect(m.consent_events).toHaveLength(1);
  });

  it("records departures and treats a return as a new join", () => {
    const m = createManifest({ title: "x", startedAt: at });
    addParticipant(m, { id: "1", username: "old", joinedAt: "2026-06-22T14:32:00Z" });
    removeParticipant(m, "1", "2026-06-22T14:40:00Z");
    addParticipant(m, { id: "1", username: "new", joinedAt: "2026-06-22T14:45:00Z" });

    expect(m.participants).toEqual([
      { id: "1", username: "new", joined_at: "2026-06-22T14:45:00Z" }
    ]);
    expect(m.consent_events.map((event) => event.type)).toEqual([
      "participant-joined",
      "participant-left",
      "participant-joined"
    ]);
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

	it("carries rounded milliseconds into the next second", () => {
		expect(toVttTimestamp(1.9996)).toBe("00:00:02.000");
		expect(toSrtTimestamp(59.9996)).toBe("00:01:00,000");
	});

  it("rejects malformed and out-of-range timestamps", () => {
    for (const value of ["", "12", "1:2", "00:60", "00:00:60", "-1:00", "1:02:03:04"]) {
      expect(() => parseTimestamp(value), value).toThrow(/Invalid timestamp/);
    }
    expect(parseTimestamp("03:12.500")).toBe(192.5);
    expect(parseTimestamp("00:03:12,250")).toBe(192.25);
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

  it("rejects wrong field types and invalid confidence instead of coercing them", () => {
    const wrongType = JSON.stringify({
      ts: 1,
      end_ts: "00:00:02",
      speaker: "Robert",
      user_id: "1",
      text: "hello",
      confidence: "high"
    });
    const outOfRange = JSON.stringify({
      ts: "00:00:01",
      end_ts: "00:00:02",
      speaker: "Robert",
      user_id: "1",
      text: "hello",
      confidence: 2
    });
    const parsed = parseJsonl(`${wrongType}\n${outOfRange}\n`);
    expect(parsed.segments).toEqual([]);
    expect(parsed.errors).toHaveLength(2);
  });
});

describe("session storage", () => {
  it("trims a configured output root", () => {
    expect(outputRoot({ RESOUND_OUTPUT_DIR: "  ./records  " } as NodeJS.ProcessEnv)).toBe("./records");
  });

  it("rejects declared outputs that escape the session directory", () => {
    const manifest = createManifest({ title: "x", startedAt: at });
    manifest.outputs.jsonl = "../outside.jsonl";
    expect(() => sessionPaths("/tmp/session", manifest)).toThrow(/escapes session directory/);
  });

  it("does not silently load the valid prefix of a corrupt transcript", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-store-"));
    const manifest = createManifest({ title: "x", startedAt: at });
    recordConsentEvent(manifest, { type: "recording-announced", user_id: "1", username: "bot" });
    writeManifest(dir, manifest);
    fs.writeFileSync(
      path.join(dir, "transcript.jsonl"),
      `${toJsonl([{ ts: "00:00:00", end_ts: "00:00:01", speaker: "A", user_id: "1", text: "ok", confidence: 1 }])}not-json\n`
    );
    expect(() => loadSession(dir)).toThrow(/Invalid transcript JSONL/);
  });

  it("requires the complete manifest output contract", () => {
    const valid = createManifest({ title: "x", startedAt: at });
    recordConsentEvent(valid, {
      type: "recording-announced",
      user_id: "1",
      username: "bot"
    });
    const manifest = valid as unknown as Record<string, unknown>;
    delete manifest.ended_at;
    manifest.outputs = null;
    const result = validateManifest(manifest);
    expect(result.errors).toContain("manifest missing required field: ended_at");
    expect(result.errors).toContain("outputs must be an object");
  });
});
