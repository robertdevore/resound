import fs from "node:fs";
import path from "node:path";
import {
  addParticipant,
  buildSessionFolder,
  createManifest,
  listSessions,
  outputRoot,
  readManifest,
  recordConsentEvent,
  reserveSessionDirectory,
  removeParticipant,
  sessionPaths,
  writeManifest,
  type SessionManifest,
  type TranscriptSession,
} from "@resound/core";
import { MockRecorder, type AudioChunk, type Recorder } from "@resound/audio";
import {
  getTranscriber,
  type Transcriber,
  type TranscriptionProgress,
} from "@resound/transcribers";
import { writeSessionOutputs } from "@resound/exporters";

export interface SessionContext {
  guildId: string;
  /** Text channel where recording lifecycle announcements are sent. */
  channelId: string;
  /** Voice channel being captured, when the recorder is Discord-native. */
  voiceChannelId?: string;
  startedBy: { id: string; username: string };
  initialParticipants?: { id: string; username: string }[];
}

function normalizeRecorderMode(
  mode: string | undefined,
): "mock" | "local-capture" | "discord-native" {
  if (mode === "discord" || mode === "discord-native") return "discord-native";
  if (mode === "system" || mode === "local-capture") return "local-capture";
  return "mock";
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | undefined)?.then === "function";
}

function normalizeStoredManifest(manifest: SessionManifest): SessionManifest {
  manifest.voice_channel_id ??= "";
  manifest.audio_files ??= { tracks: [] };
  manifest.audio_files.tracks ??= [];
  return manifest;
}

const INTERRUPTED_STATUSES = new Set<SessionManifest["status"]>([
  "created",
  "announced",
  "preflighting",
  "awaiting-consent",
  "recording",
  "recording-degraded",
  "audio-finalizing",
  "audio-finalized",
  "transcribing",
  "transcribed",
  "exporting",
  "exported",
]);

export type SessionState =
  | "idle"
  | "preflighting"
  | "recording"
  | "paused"
  | "audio-finalizing"
  | "transcribing"
  | "exporting"
  | "recoverable"
  | "completed"
  | "failed";

/**
 * Holds one guild's active or most recent session and drives the recorder →
 * transcriber → exporter pipeline. Discord-specific permission and event
 * routing remains in the app layer; durable ownership and channel identities
 * live in the manifest so restarts do not erase them.
 */
export class SessionManager {
  private manifest?: SessionManifest;
  private dir?: string;
  private state: SessionState = "idle";
  private recorder?: Recorder;
  private controlPending = false;
  private lastCaptureReport: string[] = [];
  private readonly mode: "mock" | "discord-native" | "local-capture" | "auto";
  private readonly makeTranscriber: () => Transcriber;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly makeRecorder: (
      participants: { id: string; username: string }[],
    ) => Recorder = (participants) => new MockRecorder({ participants }),
    makeTranscriber?: () => Transcriber,
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
    return [
      "preflighting",
      "recording",
      "paused",
      "audio-finalizing",
      "transcribing",
      "exporting",
    ].includes(this.state);
  }

  get ownerId(): string | undefined {
    return this.manifest?.started_by.id || undefined;
  }

  get guildId(): string | undefined {
    return this.manifest?.guild_id || undefined;
  }

  get controlChannelId(): string | undefined {
    return this.manifest?.channel_id || undefined;
  }

  get voiceChannelId(): string | undefined {
    return this.manifest?.voice_channel_id || undefined;
  }

  get canRecover(): boolean {
    return this.state === "recoverable";
  }

  /** Restore the newest durable session for a guild, reconciling interrupted work. */
  restoreLatestForGuild(guildId: string): boolean {
    if (this.active)
      throw new Error("Cannot restore while a session is active.");
    const candidates = listSessions(outputRoot(this.env))
      .flatMap((dir) => {
        try {
          const manifest = normalizeStoredManifest(readManifest(dir));
          const started = Date.parse(manifest.started_at);
          return manifest.guild_id === guildId && Number.isFinite(started)
            ? [{ dir, manifest, started }]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.started - a.started || b.dir.localeCompare(a.dir));
    for (const { dir: candidate, manifest } of candidates) {
      try {
        this.manifest = manifest;
        this.dir = candidate;
        this.lastCaptureReport = [...manifest.audio_health];
        if (INTERRUPTED_STATUSES.has(manifest.status)) {
          this.state = "recoverable";
          manifest.status = "recoverable";
          manifest.ended_at ||= new Date().toISOString();
          const warning =
            "The bot restarted before this session completed. Audio may be recoverable with /resound recover.";
          if (!manifest.warnings.includes(warning))
            manifest.warnings.push(warning);
          this.persist();
        } else if (manifest.status === "completed") {
          this.state = "completed";
        } else if (manifest.status === "recoverable") {
          this.state = "recoverable";
        } else {
          this.state = "failed";
        }
        return true;
      } catch {
        // Ignore corrupt/unrelated historical sessions and keep searching.
      }
    }
    return false;
  }

  private persist(): void {
    if (this.dir && this.manifest) writeManifest(this.dir, this.manifest);
  }

  private transition(
    state: SessionState,
    manifestStatus: SessionManifest["status"],
  ): void {
    this.state = state;
    if (this.manifest) this.manifest.status = manifestStatus;
    this.persist();
  }

  private recordStopped(note: string): void {
    if (!this.manifest) return;
    this.manifest.ended_at ||= new Date().toISOString();
    if (
      !this.manifest.consent_events.some(
        (event) => event.type === "recording-stopped",
      )
    ) {
      recordConsentEvent(this.manifest, {
        type: "recording-stopped",
        user_id: this.manifest.started_by.id,
        username: this.manifest.started_by.username,
        note,
      });
    }
  }

  private persistCapturedAudio(chunks: AudioChunk[]): void {
    if (!this.manifest || !this.dir) return;
    const paths = sessionPaths(this.dir, this.manifest);
    this.manifest.audio_files = {
      mixed:
        chunks.find((chunk) => chunk.userId === "mixed")?.path ??
        chunks[0]?.path,
      system: this.lastCaptureReport.some((line) =>
        line.includes("meeting/system audio"),
      )
        ? path.join(paths.audioRaw, "system.wav")
        : undefined,
      microphone: this.lastCaptureReport.some((line) =>
        line.includes("local microphone"),
      )
        ? path.join(paths.audioRaw, "microphone.wav")
        : undefined,
      chunks_dir: paths.audioChunks,
      tracks: chunks.map((chunk) => ({
        user_id: chunk.userId,
        username: chunk.username,
        path: chunk.path,
        start_seconds: chunk.startSeconds,
        duration_seconds: chunk.durationSeconds,
      })),
    };
    this.persist();
  }

  private storedAudioChunks(): AudioChunk[] {
    if (!this.manifest) return [];
    const tracks = this.manifest.audio_files.tracks
      .map((track) => ({
        userId: track.user_id,
        username: track.username,
        path: track.path,
        startSeconds: track.start_seconds,
        durationSeconds: track.duration_seconds,
      }))
      .filter((track) => fs.existsSync(track.path));
    if (tracks.length > 0) return tracks;
    const mixed = this.manifest.audio_files.mixed;
    return mixed && fs.existsSync(mixed)
      ? [
          {
            userId: "mixed",
            username: "Recovered Audio",
            path: mixed,
            startSeconds: 0,
            durationSeconds: 0,
          },
        ]
      : [];
  }

  async start(
    title: string,
    ctx: SessionContext,
    recorderOverride?: Recorder,
  ): Promise<{ dir: string; announce: string }> {
    if (this.active)
      throw new Error(
        "A session is already in progress. Use /resound stop first.",
      );

    const participants = [
      ctx.startedBy,
      ...(ctx.initialParticipants ?? []).filter(
        (participant) => participant.id !== ctx.startedBy.id,
      ),
    ];
    const transcriber = this.makeTranscriber();
    const requestedMode = this.mode === "auto" ? "auto" : this.mode;
    const at = new Date();
    const recorder = recorderOverride ?? this.makeRecorder(participants);
    const selectedMode = normalizeRecorderMode(recorder.mode);
    this.manifest = createManifest({
      title,
      source: "discord",
      requestedCaptureMode: requestedMode,
      selectedCaptureMode: selectedMode,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      voiceChannelId: ctx.voiceChannelId,
      startedBy: ctx.startedBy,
      startedAt: at,
      recorderId: recorder.id ?? selectedMode,
      transcriberProvider: transcriber.provider,
      transcriberModel: transcriber.model,
    });
    this.dir = reserveSessionDirectory(
      path.join(
        outputRoot(this.env),
        buildSessionFolder({ title, source: "discord", at }),
      ),
      this.manifest,
    );
    this.transition("preflighting", "preflighting");

    recordConsentEvent(this.manifest, {
      type: "recording-announced",
      user_id: ctx.startedBy.id,
      username: ctx.startedBy.username,
      note: "Recording and transcription started — announced in the control channel.",
    });
    for (const participant of participants)
      addParticipant(this.manifest, participant);

    this.recorder = recorder;
    this.manifest.recorder = {
      id: recorder.id ?? selectedMode,
      mode: selectedMode,
    };
    try {
      const preflight = await recorder.preflight?.({
        sessionDir: this.dir,
        outputDir: outputRoot(this.env),
      });
      if (preflight?.warnings.length)
        this.manifest.warnings.push(...preflight.warnings);
      if (preflight?.status === "fail") {
        throw new Error(preflight.errors[0] ?? "Recorder preflight failed.");
      }
      const transcriberPreflight = await transcriber.preflight?.();
      if (transcriberPreflight?.warnings.length) {
        this.manifest.warnings.push(...transcriberPreflight.warnings);
      }
      if (transcriberPreflight?.status === "fail") {
        throw new Error(
          transcriberPreflight.errors[0] ?? "Transcriber preflight failed.",
        );
      }
      await recorder.start({ sessionDir: this.dir });
    } catch (error) {
      try {
        await recorder.abort?.(
          "Session start failed before recording became ready.",
        );
      } catch {
        // Preserve the original startup failure after best-effort cleanup.
      }
      this.transition("failed", "failed");
      this.recorder = undefined;
      throw error;
    }
    this.lastCaptureReport = [];
    this.transition("recording", "recording");

    return {
      dir: this.dir,
      announce: `🔴 **Resound is now recording & transcribing**: "${title}". Use \`/resound consent\` to acknowledge.`,
    };
  }

  /** Log and persist a participant entering the recorded voice channel. */
  participantJoined(participant: {
    id: string;
    username: string;
  }): string | undefined {
    if (!this.manifest || !["recording", "paused"].includes(this.state))
      return undefined;
    const existing = this.manifest.participants.find(
      (entry) => entry.id === participant.id,
    );
    const isNewJoin = !existing || existing.left_at !== undefined;
    addParticipant(this.manifest, participant);
    this.persist();
    return isNewJoin
      ? `🔴 ${participant.username} joined the recorded voice channel — transcription is active.`
      : undefined;
  }

  /** Log and persist a participant leaving the recorded voice channel. */
  participantLeft(userId: string): string | undefined {
    if (!this.manifest || !["recording", "paused"].includes(this.state))
      return undefined;
    const participant = this.manifest.participants.find(
      (entry) => entry.id === userId && entry.left_at === undefined,
    );
    if (!participant) return undefined;
    removeParticipant(this.manifest, userId);
    this.persist();
    return `↪️ ${participant.username} left the recorded voice channel.`;
  }

  consent(user: { id: string; username: string }): string {
    if (!this.manifest || !["recording", "paused"].includes(this.state)) {
      throw new Error("No active session is recording.");
    }
    if (
      !this.manifest.participants.some(
        (participant) => participant.id === user.id,
      )
    ) {
      addParticipant(this.manifest, user);
    }
    recordConsentEvent(this.manifest, {
      type: "participant-consent",
      user_id: user.id,
      username: user.username,
      note: "Explicit consent to be transcribed.",
    });
    this.persist();
    return `✅ Consent recorded for ${user.username}.`;
  }

  async pause(): Promise<string> {
    if (this.state !== "recording") throw new Error("Nothing is recording.");
    if (!this.recorder?.capabilities.pauseResume || !this.recorder.pause) {
      throw new Error("The active recorder does not support pausing.");
    }
    if (this.controlPending)
      throw new Error("A recorder control operation is in progress.");
    this.controlPending = true;
    try {
      await this.recorder.pause();
      this.transition("paused", "recording-degraded");
    } finally {
      this.controlPending = false;
    }
    return "⏸️ Recording paused.";
  }

  async resume(): Promise<string> {
    if (this.state !== "paused") throw new Error("Session is not paused.");
    if (!this.recorder?.capabilities.pauseResume || !this.recorder.resume) {
      throw new Error("The active recorder does not support resuming.");
    }
    if (this.controlPending)
      throw new Error("A recorder control operation is in progress.");
    this.controlPending = true;
    try {
      await this.recorder.resume();
      this.transition("recording", "recording");
    } finally {
      this.controlPending = false;
    }
    return "▶️ Recording resumed.";
  }

  status(): string {
    if (!this.manifest) return "No session found.";
    const health = this.recorder?.getHealth?.();
    const healthSummary =
      health && !isPromiseLike(health) ? health.summary : undefined;
    return [
      `Title: ${this.manifest.title}`,
      `State: ${this.state}`,
      `Manifest status: ${this.manifest.status}`,
      `Mode: ${this.manifest.selected_capture_mode || this.mode}`,
      `Participants: ${this.manifest.participants.map((participant) => participant.username).join(", ") || "—"}`,
      `Consent events: ${this.manifest.consent_events.length}`,
      ...(this.state === "recoverable"
        ? ["Recovery: run /resound recover"]
        : []),
      ...(healthSummary ? [`Health: ${healthSummary}`] : []),
    ].join("\n");
  }

  private async transcribeAndExport(
    chunks: AudioChunk[],
    onProgress?: (progress: TranscriptionProgress) => void,
  ): Promise<TranscriptSession> {
    if (!this.manifest || !this.dir)
      throw new Error("No session to transcribe.");
    const transcriber = this.makeTranscriber();
    this.transition("transcribing", "transcribing");
    try {
      const segments = await transcriber.transcribe({
        sessionDir: this.dir,
        participants: this.manifest.participants,
        audioTracks: chunks,
        audioPath: this.manifest.audio_files.mixed ?? chunks[0]?.path,
        mock: this.mode === "mock",
        onProgress,
      });
      this.manifest.status = "transcribed";
      const session: TranscriptSession = {
        manifest: this.manifest,
        segments,
        dir: this.dir,
      };
      this.transition("exporting", "exporting");
      writeSessionOutputs(session);
      this.transition("completed", "completed");
      return session;
    } catch (error) {
      const warning = `Transcription or export failed and can be retried: ${(error as Error).message}`;
      if (!this.manifest.warnings.includes(warning))
        this.manifest.warnings.push(warning);
      this.transition("recoverable", "recoverable");
      throw error;
    }
  }

  /** Finalize capture, then transcribe and export every portable artifact. */
  async stop(
    onProgress?: (progress: TranscriptionProgress) => void,
  ): Promise<TranscriptSession> {
    if (
      !this.manifest ||
      !this.dir ||
      !this.recorder ||
      !["recording", "paused"].includes(this.state)
    )
      throw new Error("No active session is ready to stop.");
    if (this.controlPending)
      throw new Error("A recorder control operation is in progress.");
    const recorder = this.recorder;
    this.transition("audio-finalizing", "audio-finalizing");
    let chunks: AudioChunk[];
    try {
      chunks = await recorder.stop();
      this.lastCaptureReport = (await recorder.captureSummary?.()) ?? [];
    } catch (error) {
      this.recorder = undefined;
      this.manifest.warnings.push(
        `Audio finalization failed: ${(error as Error).message}`,
      );
      this.recordStopped("Recording interrupted during audio finalization.");
      this.transition("failed", "failed");
      throw error;
    }
    this.recorder = undefined;
    this.manifest.audio_health = [...this.lastCaptureReport];
    this.persistCapturedAudio(chunks);
    this.recordStopped("Recording stopped; transcription started.");
    this.persist();

    if (this.mode !== "mock" && chunks.length === 0) {
      this.transition("failed", "failed");
      throw new Error(
        "No audio was captured. Check the configured devices and audio routing, then try again.",
      );
    }
    return this.transcribeAndExport(chunks, onProgress);
  }

  /** Retry transcription/export for a durable interrupted session. */
  async recover(
    onProgress?: (progress: TranscriptionProgress) => void,
  ): Promise<TranscriptSession> {
    if (!this.manifest || !this.dir || this.state !== "recoverable") {
      throw new Error("No recoverable session is available.");
    }
    const chunks = this.storedAudioChunks();
    if (chunks.length === 0) {
      throw new Error(
        "The interrupted session has no finalized audio to recover.",
      );
    }
    return this.transcribeAndExport(chunks, onProgress);
  }

  /** Finalize audio on SIGINT/SIGTERM without starting a long transcription. */
  async interruptForShutdown(): Promise<void> {
    if (!this.manifest || !this.dir || !this.active) return;
    const recorder = this.recorder;
    if (recorder && ["recording", "paused"].includes(this.state)) {
      try {
        const chunks = await recorder.stop();
        this.lastCaptureReport = (await recorder.captureSummary?.()) ?? [];
        this.manifest.audio_health = [...this.lastCaptureReport];
        this.persistCapturedAudio(chunks);
      } catch (error) {
        this.manifest.warnings.push(
          `Graceful shutdown could not finalize audio: ${(error as Error).message}`,
        );
      }
    }
    this.recorder = undefined;
    this.recordStopped(
      "Bot process stopped; use /resound recover after restart.",
    );
    this.transition("recoverable", "recoverable");
  }

  captureReport(): string[] {
    return [...this.lastCaptureReport];
  }

  currentPaths() {
    if (!this.dir || !this.manifest) return undefined;
    return sessionPaths(this.dir, this.manifest);
  }
}
