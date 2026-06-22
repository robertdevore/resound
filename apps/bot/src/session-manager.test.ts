import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { validateSession } from "@resound/core";
import { SessionManager } from "./session-manager.js";

function envFor(): NodeJS.ProcessEnv {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "resound-bot-"));
  return { RESOUND_OUTPUT_DIR: out, RESOUND_BOT_MODE: "mock", RESOUND_TRANSCRIBER: "mock" } as NodeJS.ProcessEnv;
}

describe("SessionManager (mock mode)", () => {
  it("starts, announces, records consent, and refuses double-start", async () => {
    const mgr = new SessionManager(envFor());
    const { announce } = await mgr.start("Standup", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" }
    });
    expect(announce).toMatch(/recording/i);
    expect(mgr.active).toBe(true);
    await expect(
      mgr.start("Again", { guildId: "g1", channelId: "c1", startedBy: { id: "u1", username: "robert" } })
    ).rejects.toThrow(/already in progress/);
  });

  it("announces late joiners while recording", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("Standup", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" }
    });
    const msg = mgr.participantJoined({ id: "u2", username: "ashley" });
    expect(msg).toMatch(/transcription is active/i);
  });

  it("stops and writes a complete, valid session", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("Engineering Standup", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" }
    });
    mgr.consent({ id: "u1", username: "robert" });
    const session = await mgr.stop();
    expect(session.segments.length).toBeGreaterThan(0);
    expect(validateSession(session.dir).valid).toBe(true);
    expect(fs.existsSync(path.join(session.dir, "transcript.md"))).toBe(true);
    expect(mgr.active).toBe(false);
  });

  it("pause/resume guards state transitions", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("S", { guildId: "g", channelId: "c", startedBy: { id: "1", username: "a" } });
    expect(mgr.pause()).toMatch(/paused/i);
    expect(() => mgr.pause()).toThrow();
    expect(mgr.resume()).toMatch(/resumed/i);
  });
});
