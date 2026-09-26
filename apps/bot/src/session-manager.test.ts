import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { loadSession, readManifest, validateSession } from "@resound/core";
import { SessionManager } from "./session-manager.js";
import type { Recorder } from "@resound/audio";

function envFor(): NodeJS.ProcessEnv {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "resound-bot-"));
  return {
    RESOUND_OUTPUT_DIR: out,
    RESOUND_BOT_MODE: "mock",
    RESOUND_TRANSCRIBER: "mock",
  } as NodeJS.ProcessEnv;
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
        strictConsentCompatible: false,
      },
      mode: "mock",
      async start() {},
      async stop() {
        return [];
      },
    };
    const mgr = new SessionManager(envFor(), () => {
      calls += 1;
      return recorder;
    });
    await mgr.start("Standup", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" },
    });
    expect(calls).toBe(1);
  });

  it("starts, announces, records consent, and refuses double-start", async () => {
    const mgr = new SessionManager(envFor());
    const { announce } = await mgr.start("Standup", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" },
    });
    expect(announce).toMatch(/recording/i);
    expect(mgr.active).toBe(true);
    await expect(
      mgr.start("Again", {
        guildId: "g1",
        channelId: "c1",
        startedBy: { id: "u1", username: "robert" },
      }),
    ).rejects.toThrow(/already in progress/);
  });

  it("announces late joiners while recording", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("Standup", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" },
    });
    const msg = mgr.participantJoined({ id: "u2", username: "ashley" });
    expect(msg).toMatch(/transcription is active/i);
    const paths = mgr.currentPaths()!;
    expect(
      readManifest(paths.dir).participants.some(
        (participant) => participant.id === "u2",
      ),
    ).toBe(true);
  });

  it("persists the initial voice roster and participant departures", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("Standup", {
      guildId: "g1",
      channelId: "text-1",
      voiceChannelId: "voice-1",
      startedBy: { id: "u1", username: "robert" },
      initialParticipants: [
        { id: "u1", username: "robert" },
        { id: "u2", username: "ashley" },
      ],
    });

    expect(mgr.voiceChannelId).toBe("voice-1");
    expect(mgr.controlChannelId).toBe("text-1");
    expect(mgr.participantLeft("u2")).toMatch(
      /left the recorded voice channel/i,
    );
    const manifest = readManifest(mgr.currentPaths()!.dir);
    expect(
      manifest.participants.find((participant) => participant.id === "u2")
        ?.left_at,
    ).toBeTruthy();
    expect(
      manifest.consent_events.some(
        (event) => event.type === "participant-left" && event.user_id === "u2",
      ),
    ).toBe(true);
  });

  it("persists consent immediately and refuses consent after completion", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("Standup", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" },
    });
    mgr.consent({ id: "u2", username: "ashley" });
    const paths = mgr.currentPaths()!;
    expect(
      readManifest(paths.dir).consent_events.some(
        (event) => event.user_id === "u2",
      ),
    ).toBe(true);
    await mgr.stop();
    expect(() => mgr.consent({ id: "u2", username: "ashley" })).toThrow(
      /No active session/,
    );
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
        strictConsentCompatible: false,
      },
      mode: "mock",
      async start() {
        throw new Error("device failed");
      },
      async stop() {
        return [];
      },
    };
    const mgr = new SessionManager(envFor(), () => recorder);
    await expect(
      mgr.start("Broken", {
        guildId: "g1",
        channelId: "c1",
        startedBy: { id: "u1", username: "robert" },
      }),
    ).rejects.toThrow(/device failed/);
    expect(mgr.active).toBe(false);
  });

  it("stops and writes a complete, valid session", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("Engineering Standup", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" },
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
      RESOUND_WHISPER_COMMAND: "missing-whisper-binary",
    } as NodeJS.ProcessEnv;
    const mgr = new SessionManager(env);
    await mgr.start("Discord Smoke", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" },
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
      RESOUND_TRANSCRIBER: "mock",
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
        strictConsentCompatible: false,
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
            durationSeconds: 1,
          },
        ];
      },
    };
    const mgr = new SessionManager(env, () => recorder);
    await mgr.start("Local Capture", {
      guildId: "g1",
      channelId: "c1",
      startedBy: { id: "u1", username: "robert" },
    });

    expect(mgr.status()).toContain("Mode: local-capture");
    const session = await mgr.stop();
    expect(session.manifest.transcriber.provider).toBe("mock");
  });

  it("rejects pause when the recorder does not support it", async () => {
    const mgr = new SessionManager(envFor());
    await mgr.start("S", {
      guildId: "g",
      channelId: "c",
      startedBy: { id: "1", username: "a" },
    });
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
        strictConsentCompatible: false,
      },
      mode: "local-capture",
      async start() {},
      pause() {
        calls.push("pause");
      },
      resume() {
        calls.push("resume");
      },
      async stop() {
        return [
          {
            userId: "local",
            username: "Local Capture",
            path: "/tmp/fake.wav",
            startSeconds: 0,
            durationSeconds: 1,
          },
        ];
      },
    };
    const env = {
      ...envFor(),
      RESOUND_BOT_MODE: "local-capture",
      RESOUND_TRANSCRIBER: "mock",
    } as NodeJS.ProcessEnv;
    const mgr = new SessionManager(env, () => recorder);
    await mgr.start(
      "Local",
      { guildId: "g", channelId: "c", startedBy: { id: "1", username: "a" } },
      recorder,
    );
    await mgr.pause();
    await mgr.resume();
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("finalizes audio on shutdown and recovers after a restart", async () => {
    const env = envFor();
    const first = new SessionManager(env);
    await first.start("Recoverable", {
      guildId: "g-recover",
      channelId: "text",
      startedBy: { id: "owner", username: "Robert" },
    });

    await first.interruptForShutdown();
    expect(first.canRecover).toBe(true);

    const restored = new SessionManager(env);
    expect(restored.restoreLatestForGuild("g-recover")).toBe(true);
    expect(restored.ownerId).toBe("owner");
    expect(restored.canRecover).toBe(true);

    const session = await restored.recover();
    expect(session.manifest.status).toBe("completed");
    expect(session.segments.length).toBeGreaterThan(0);
    expect(validateSession(session.dir).valid).toBe(true);
  });

  it("restores the latest completed session for durable export", async () => {
    const env = envFor();
    const first = new SessionManager(env);
    await first.start("Durable Export", {
      guildId: "g-export",
      channelId: "text",
      startedBy: { id: "owner", username: "Robert" },
    });
    await first.stop();

    const restored = new SessionManager(env);
    expect(restored.restoreLatestForGuild("g-export")).toBe(true);
    expect(restored.ownerId).toBe("owner");
    expect(restored.currentPaths()?.markdown).toMatch(/transcript\.md$/);
    expect(fs.existsSync(restored.currentPaths()!.markdown)).toBe(true);
  });
});

describe("session lifecycle integrity", () => {
  it("rejects overlapping stops before the recorder is finalized twice", async () => {
    let release!: () => void;
    let calls = 0;
    const recorder = new (await import("@resound/audio")).MockRecorder();
    recorder.stop = async () => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    };
    const mgr = new SessionManager(envFor(), () => recorder);
    await mgr.start("Stop once", {
      guildId: "g",
      channelId: "c",
      startedBy: { id: "1", username: "a" },
    });
    const first = mgr.stop();
    await expect(mgr.stop()).rejects.toThrow(/ready to stop/);
    expect(calls).toBe(1);
    release();
    await first;
    expect(mgr.status()).toContain("State: completed");
  });

  it("does not let a pending pause overwrite a stop transition", async () => {
    let release!: () => void;
    const recorder: Recorder = new (
      await import("@resound/audio")
    ).MockRecorder();
    recorder.capabilities.pauseResume = true;
    recorder.pause = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const mgr = new SessionManager(envFor(), () => recorder);
    await mgr.start("Pause", {
      guildId: "g",
      channelId: "c",
      startedBy: { id: "1", username: "a" },
    });
    const pausing = mgr.pause();
    await expect(mgr.stop()).rejects.toThrow(/control operation/);
    release();
    await pausing;
    await mgr.stop();
    expect(mgr.status()).toContain("State: completed");
  });

  it("restores by started_at instead of alphabetical title", async () => {
    const { createManifest, writeManifest } = await import("@resound/core");
    const env = envFor();
    for (const [title, date, owner] of [
      ["z-old", "2026-09-25T10:00:00Z", "old"],
      ["a-new", "2026-09-25T11:00:00Z", "new"],
    ]) {
      const manifest = createManifest({
        title: title!,
        guildId: "g",
        startedAt: new Date(date!),
        startedBy: { id: owner!, username: owner! },
        status: "completed",
      });
      writeManifest(
        path.join(env.RESOUND_OUTPUT_DIR!, "2026-09-25", title!),
        manifest,
      );
    }
    const mgr = new SessionManager(env);
    expect(mgr.restoreLatestForGuild("g")).toBe(true);
    expect(mgr.ownerId).toBe("new");
  });
});
