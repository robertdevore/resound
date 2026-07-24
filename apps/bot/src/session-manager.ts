import path from "node:path";
import {
  addParticipant,
  buildSessionFolder,
  createManifest,
  outputRoot,
  recordConsentEvent,
  sessionPaths,
  writeManifest,
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

function normalizeRecorderMode(mode: string | undefined): "mock" | "local-capture" | "discord-native" {
  if (mode === "discord" || mode === "discord-native") return "discord-native";
  if (mode === "system" || mode === "local-capture") return "local-capture";
  return "mock";
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === "function";
}

export type SessionState =
  | "idle"
  | "preflighting"
  | "awaiting-consent"
  | "recording"
  | "paused"
  | "audio-finalizing"
  | "transcribing"
  | "exporting"
  | "completed"
  | "failed";

/**
 * Holds the active session for a guild and drives the pipeline. Deliberately
 * free of any discord.js import so the bot's core behavior is unit-testable and
 * so swapping a real voice Recorder in later (once DAVE is supported) is a
 * one-line change.
 */
export class SessionManager {
  private manifest?: SessionManifest;
  private dir?: string;
  private state: SessionState = "idle";
  private recorder?: Recorder;
  private lastCaptureReport: string[] = [];
  private readonly mode: "mock" | "discord-native" | "local-capture" | "auto";
  private readonly makeTranscriber: () => Transcriber;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly makeRecorder: (participants: { id: string; username: string }[]) => Recorder = (
      p
    ) => new MockRecorder({ participants: p }),
    makeTranscriber?: () => Transcriber
  ) {
    const configuredMode = env.RESOUND_BOT_MODE ?? "mock";
    this.mode =
      configuredMode === "discord" || configuredMode === "discord-native"
        ? "discord-native"
        : configuredMode === "auto"
          ? "auto"
        : configuredMode === "local-capture"
          ? "local-capture"
          : "mock";
    this.makeTranscriber =
      makeTranscriber ??
      (() =>
        this.mode === "mock"
          ? getTranscriber({ name: "mock", env: this.env })
          : getTranscriber({ env: this.env }));
  }

  get active(): boolean {
    return this.state !== "idle" && this.state !== "completed" && this.state !== "failed";
  }

  private persist(): void {
    if (this.dir && this.manifest) writeManifest(this.dir, this.manifest);
  }

  private transition(state: SessionState, manifestStatus: SessionManifest["status"]): void {
    this.state = state;
    if (this.manifest) this.manifest.status = manifestStatus;
    this.persist();
  }

  async start(
    title: string,
    ctx: SessionContext,
    recorderOverride?: Recorder
  ): Promise<{ dir: string; announce: string }> {
    if (this.active) throw new Error("A session is already in progress. Use /resound stop first.");

    const transcriber = this.makeTranscriber();
    const requestedMode = this.mode === "auto" ? "auto" : this.mode;
    const at = new Date();
    const selectedMode = normalizeRecorderMode(recorderOverride?.mode ?? this.makeRecorder([ctx.startedBy]).mode);
    this.manifest = createManifest({
      title,
      source: "discord",
      requestedCaptureMode: requestedMode,
      selectedCaptureMode: selectedMode,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      startedBy: ctx.startedBy,
      startedAt: at,
      recorderId: recorderOverride?.id ?? normalizeRecorderMode(recorderOverride?.mode),
      transcriberProvider: transcriber.provider,
      transcriberModel: transcriber.model
    });
    this.dir = path.join(
      outputRoot(this.env),
      buildSessionFolder({ title, source: "discord", at })
    );
    this.transition("preflighting", "preflighting");

    recordConsentEvent(this.manifest, {
      type: "recording-announced",
      user_id: ctx.startedBy.id,
      username: ctx.startedBy.username,
      note: "🔴 Recording and transcription started — announced in channel."
    });
    addParticipant(this.manifest, ctx.startedBy);

    this.recorder = recorderOverride ?? this.makeRecorder([ctx.startedBy]);
    this.manifest.recorder = {
      id: this.recorder.id ?? normalizeRecorderMode(this.recorder.mode),
      mode: normalizeRecorderMode(this.recorder.mode)
    };
    const preflight = await this.recorder.preflight?.({
      sessionDir: this.dir,
      outputDir: outputRoot(this.env)
    });
    if (preflight?.warnings.length) this.manifest.warnings.push(...preflight.warnings);
    if (preflight?.status === "fail") {
      this.transition("failed", "failed");
      throw new Error(preflight.errors[0] ?? "Recorder preflight failed.");
    }
    const transcriberPreflight = await transcriber.preflight?.();
    if (transcriberPreflight?.warnings.length) this.manifest.warnings.push(...transcriberPreflight.warnings);
    if (transcriberPreflight?.status === "fail") {
      this.transition("failed", "failed");
      throw new Error(transcriberPreflight.errors[0] ?? "Transcriber preflight failed.");
    }

    await this.recorder.start({ sessionDir: this.dir });
    this.lastCaptureReport = [];
    this.transition("recording", "recording");

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

  async pause(): Promise<string> {
    if (this.state !== "recording") throw new Error("Nothing is recording.");
    await this.recorder?.pause?.();
    this.transition("paused", "recording-degraded");
    return "⏸️ Recording paused.";
  }

  async resume(): Promise<string> {
    if (this.state !== "paused") throw new Error("Session is not paused.");
    await this.recorder?.resume?.();
    this.transition("recording", "recording");
    return "▶️ Recording resumed.";
  }

  status(): string {
    if (!this.manifest) return "No active session.";
    const health = this.recorder?.getHealth?.();
    const healthSummary = health && !isPromiseLike(health) ? health.summary : undefined;
    return [
      `Title: ${this.manifest.title}`,
      `State: ${this.state}`,
      `Manifest status: ${this.manifest.status}`,
      `Mode: ${this.manifest.selected_capture_mode || this.mode}`,
      `Participants: ${this.manifest.participants.map((p) => p.username).join(", ") || "—"}`,
      `Consent events: ${this.manifest.consent_events.length}`,
      ...(healthSummary ? [`Health: ${healthSummary}`] : [])
    ].join("\n");
  }

  /** Finalize: transcribe captured audio and write all portable outputs. */
  async stop(): Promise<TranscriptSession> {
    if (!this.manifest || !this.dir || !this.recorder) throw new Error("No active session.");
    const recorder = this.recorder;
    this.transition("audio-finalizing", "audio-finalizing");
    const chunks = await recorder.stop();
    this.recorder = undefined;
    this.lastCaptureReport = (await recorder.captureSummary?.()) ?? [];
    this.manifest.audio_health = [...this.lastCaptureReport];
    const paths = sessionPaths(this.dir, this.manifest);
    this.manifest.audio_files = {
      mixed: chunks[0]?.path,
      system: this.lastCaptureReport.some((line) => line.includes("meeting/system audio")) ? path.join(paths.audioRaw, "system.wav") : undefined,
      microphone: this.lastCaptureReport.some((line) => line.includes("local microphone")) ? path.join(paths.audioRaw, "microphone.wav") : undefined,
      chunks_dir: path.join(paths.audioChunks)
    };
    if (this.mode !== "mock" && chunks.length === 0) {
      this.transition("failed", "failed");
      throw new Error("No audio was captured. Check the configured devices and audio routing, then try again.");
    }
    const transcriber = this.makeTranscriber();
    this.transition("transcribing", "transcribing");
    const segments = await transcriber.transcribe({
      sessionDir: this.dir,
      participants: this.manifest.participants,
      audioTracks: chunks,
      audioPath: chunks[0]?.path,
      mock: this.mode === "mock"
    });

    this.manifest.ended_at = new Date().toISOString();
    this.manifest.status = "transcribed";
    recordConsentEvent(this.manifest, {
      type: "recording-stopped",
      user_id: this.manifest.started_by.id,
      username: this.manifest.started_by.username,
      note: "Recording stopped."
    });

    const session: TranscriptSession = { manifest: this.manifest, segments, dir: this.dir };
    this.transition("exporting", "exporting");
    writeSessionOutputs(session);
    this.transition("completed", "completed");

    return session;
  }

  captureReport(): string[] {
    return [...this.lastCaptureReport];
  }

  currentPaths() {
    if (!this.dir || !this.manifest) return undefined;
    return sessionPaths(this.dir, this.manifest);
  }
}
