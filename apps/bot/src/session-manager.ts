import path from "node:path";
import {
  addParticipant,
  buildSessionFolder,
  createManifest,
  outputRoot,
  recordConsentEvent,
  sessionPaths,
  type SessionManifest,
  type TranscriptSession
} from "@resound/core";
import { MockRecorder, type Recorder } from "@resound/audio";
import { getTranscriber, type Transcriber } from "@resound/transcribers";
import { writeSessionOutputs } from "@resound/exporters";

export interface SessionContext {
  guildId: string;
  channelId: string;
  startedBy: { id: string; username: string };
}

export type SessionState = "recording" | "paused" | "stopped";

/**
 * Holds the active session for a guild and drives the pipeline. Deliberately
 * free of any discord.js import so the bot's core behavior is unit-testable and
 * so swapping a real voice Recorder in later (once DAVE is supported) is a
 * one-line change.
 */
export class SessionManager {
  private manifest?: SessionManifest;
  private dir?: string;
  private state: SessionState = "stopped";
  private recorder?: Recorder;
  private readonly mode: "mock" | "discord";
  private readonly makeTranscriber: () => Transcriber;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly makeRecorder: (participants: { id: string; username: string }[]) => Recorder = (
      p
    ) => new MockRecorder({ participants: p }),
    makeTranscriber?: () => Transcriber
  ) {
    this.mode = (env.RESOUND_BOT_MODE ?? "mock") === "discord" ? "discord" : "mock";
    this.makeTranscriber =
      makeTranscriber ??
      (() =>
        this.mode === "mock"
          ? getTranscriber({ name: "mock", env: this.env })
          : getTranscriber({ env: this.env }));
  }

  get active(): boolean {
    return this.state !== "stopped";
  }

  async start(
    title: string,
    ctx: SessionContext,
    recorderOverride?: Recorder
  ): Promise<{ dir: string; announce: string }> {
    if (this.active) throw new Error("A session is already in progress. Use /resound stop first.");

    const transcriber = this.makeTranscriber();
    const at = new Date();
    this.manifest = createManifest({
      title,
      source: "discord",
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      startedBy: ctx.startedBy,
      startedAt: at,
      transcriberProvider: transcriber.provider,
      transcriberModel: transcriber.model
    });
    this.dir = path.join(
      outputRoot(this.env),
      buildSessionFolder({ title, source: "discord", at })
    );

    recordConsentEvent(this.manifest, {
      type: "recording-announced",
      user_id: ctx.startedBy.id,
      username: ctx.startedBy.username,
      note: "🔴 Recording and transcription started — announced in channel."
    });
    addParticipant(this.manifest, ctx.startedBy);

    this.recorder = recorderOverride ?? this.makeRecorder([ctx.startedBy]);
    await this.recorder.start({ sessionDir: this.dir });
    this.state = "recording";

    return {
      dir: this.dir,
      announce: `🔴 **Resound is now recording & transcribing** this channel: "${title}". Use \`/resound consent\` to acknowledge.`
    };
  }

  /** Log a participant joining mid-session (auto-announces if recording). */
  participantJoined(p: { id: string; username: string }): string | undefined {
    if (!this.manifest || !this.active) return undefined;
    const before = this.manifest.participants.length;
    addParticipant(this.manifest, p);
    if (this.manifest.participants.length > before && this.state === "recording") {
      return `🔴 ${p.username} joined — transcription is active.`;
    }
    return undefined;
  }

  consent(user: { id: string; username: string }): string {
    if (!this.manifest) throw new Error("No active session.");
    recordConsentEvent(this.manifest, {
      type: "participant-consent",
      user_id: user.id,
      username: user.username,
      note: "Explicit consent to be transcribed."
    });
    return `✅ Consent recorded for ${user.username}.`;
  }

  pause(): string {
    if (this.state !== "recording") throw new Error("Nothing is recording.");
    this.state = "paused";
    return "⏸️ Recording paused.";
  }

  resume(): string {
    if (this.state !== "paused") throw new Error("Session is not paused.");
    this.state = "recording";
    return "▶️ Recording resumed.";
  }

  status(): string {
    if (!this.manifest) return "No active session.";
    return [
      `Title: ${this.manifest.title}`,
      `State: ${this.state}`,
      `Mode: ${this.mode}`,
      `Participants: ${this.manifest.participants.map((p) => p.username).join(", ") || "—"}`,
      `Consent events: ${this.manifest.consent_events.length}`
    ].join("\n");
  }

  /** Finalize: transcribe captured audio and write all portable outputs. */
  async stop(): Promise<TranscriptSession> {
    if (!this.manifest || !this.dir || !this.recorder) throw new Error("No active session.");
    const chunks = await this.recorder.stop();
    const transcriber = this.makeTranscriber();
    const segments = await transcriber.transcribe({
      sessionDir: this.dir,
      participants: this.manifest.participants,
      audioPath: chunks[0]?.path,
      mock: this.mode === "mock"
    });

    this.manifest.ended_at = new Date().toISOString();
    recordConsentEvent(this.manifest, {
      type: "recording-stopped",
      user_id: this.manifest.started_by.id,
      username: this.manifest.started_by.username,
      note: "Recording stopped."
    });

    const session: TranscriptSession = { manifest: this.manifest, segments, dir: this.dir };
    writeSessionOutputs(session);

    this.state = "stopped";
    this.recorder = undefined;
    return session;
  }

  currentPaths() {
    if (!this.dir || !this.manifest) return undefined;
    return sessionPaths(this.dir, this.manifest);
  }
}
