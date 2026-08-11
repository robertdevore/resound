import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { loadSession, readManifest, validateSession } from "@resound/core";
import { SessionManager } from "./session-manager.js";
import type { Recorder } from "@resound/audio";

function envFor(): NodeJS.ProcessEnv {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "resound-bot-"));
  return { RESOUND_OUTPUT_DIR: out, RESOUND_BOT_MODE: "mock", RESOUND_TRANSCRIBER: "mock" } as NodeJS.ProcessEnv;
}

describe("SessionManager (mock mode)", () => {
	it("creates exactly one recorder for a session", async () => {
		let calls = 0;
		const recorder: Recorder = {
			capabilities: {
				mixedAudio: true,
				separateSpeakerTracks: false,
				reliableSpeakerIdentity: false,
				liveParticipantEvents: false,
				pauseResume: false,
				localOnly: true,
				reconnectSupport: false,
				healthMetrics: false,
				strictConsentCompatible: false
			},
			mode: "mock",
			async start() {},
			async stop() { return []; }
		};
		const mgr = new SessionManager(envFor(), () => {
			calls += 1;
			return recorder;
		});
		await mgr.start("Standup", {
			guildId: "g1",
			channelId: "c1",
			startedBy: { id: "u1", username: "robert" }
		});
		expect(calls).toBe(1);
	});

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
    const paths = mgr.currentPaths()!;
    expect(readManifest(paths.dir).participants.some((participant) => participant.id === "u2")).toBe(true);
  });

  it("persists consent immediately and refuses consent after completion", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("Standup", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" }
    });
    mgr.consent({ id: "u2", username: "ashley" });
    const paths = mgr.currentPaths()!;
    expect(readManifest(paths.dir).consent_events.some((event) => event.user_id === "u2")).toBe(true);
    await mgr.stop();
    expect(() => mgr.consent({ id: "u2", username: "ashley" })).toThrow(/No active session/);
  });

  it("does not remain active when recorder startup fails", async () => {
    const recorder: Recorder = {
      capabilities: {
        mixedAudio: true,
        separateSpeakerTracks: false,
        reliableSpeakerIdentity: false,
        liveParticipantEvents: false,
        pauseResume: false,
        localOnly: true,
        reconnectSupport: false,
        healthMetrics: false,
        strictConsentCompatible: false
      },
      mode: "mock",
      async start() { throw new Error("device failed"); },
      async stop() { return []; }
    };
    const mgr = new SessionManager(envFor(), () => recorder);
    await expect(mgr.start("Broken", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" }
    })).rejects.toThrow(/device failed/);
    expect(mgr.active).toBe(false);
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

  it("forces mock transcription in bot mock mode", async () => {
    const env = {
      ...envFor(),
      RESOUND_BOT_MODE: "mock",
      RESOUND_TRANSCRIBER: "local-whisper",
      RESOUND_WHISPER_COMMAND: "missing-whisper-binary"
    } as NodeJS.ProcessEnv;
    const mgr = new SessionManager(env);
    await mgr.start("Discord Smoke", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" }
    });

    const session = await mgr.stop();
    const saved = loadSession(session.dir);

    expect(saved.manifest.transcriber.provider).toBe("mock");
    expect(saved.segments.length).toBeGreaterThan(0);
  });

  it("keeps configured transcription in local-capture mode", async () => {
    const env = {
      ...envFor(),
      RESOUND_BOT_MODE: "local-capture",
      RESOUND_TRANSCRIBER: "mock"
    } as NodeJS.ProcessEnv;
    const recorder: Recorder = {
      capabilities: {
        mixedAudio: true,
        separateSpeakerTracks: false,
        reliableSpeakerIdentity: false,
        liveParticipantEvents: false,
        pauseResume: false,
        localOnly: true,
        reconnectSupport: false,
        healthMetrics: false,
        strictConsentCompatible: false
      },
      mode: "local-capture",
      async start() {},
      async stop() {
        return [
          {
            userId: "local",
            username: "Local Capture",
            path: "/tmp/fake.wav",
            startSeconds: 0,
            durationSeconds: 1
          }
        ];
      }
    };
    const mgr = new SessionManager(env, () => recorder);
    await mgr.start("Local Capture", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" }
    });

    expect(mgr.status()).toContain("Mode: local-capture");
    const session = await mgr.stop();
    expect(session.manifest.transcriber.provider).toBe("mock");
  });

  it("rejects pause when the recorder does not support it", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("S", { guildId: "g", channelId: "c", startedBy: { id: "1", username: "a" } });
    await expect(mgr.pause()).rejects.toThrow(/does not support pausing/);
    expect(mgr.status()).toContain("State: recording");
  });

  it("pauses and resumes the underlying recorder", async () => {
    const calls: string[] = [];
    const recorder: Recorder = {
      capabilities: {
        mixedAudio: true,
        separateSpeakerTracks: false,
        reliableSpeakerIdentity: false,
        liveParticipantEvents: false,
        pauseResume: true,
        localOnly: true,
        reconnectSupport: false,
        healthMetrics: false,
        strictConsentCompatible: false
      },
      mode: "local-capture",
      async start() {},
      pause() { calls.push("pause"); },
      resume() { calls.push("resume"); },
      async stop() {
        return [{ userId: "local", username: "Local Capture", path: "/tmp/fake.wav", startSeconds: 0, durationSeconds: 1 }];
      }
    };
    const env = { ...envFor(), RESOUND_BOT_MODE: "local-capture", RESOUND_TRANSCRIBER: "mock" } as NodeJS.ProcessEnv;
    const mgr = new SessionManager(env, () => recorder);
    await mgr.start("Local", { guildId: "g", channelId: "c", startedBy: { id: "1", username: "a" } }, recorder);
    await mgr.pause();
    await mgr.resume();
    expect(calls).toEqual(["pause", "resume"]);
  });
});
