/**
 * Audio capture abstraction.
 *
 * IMPORTANT: Discord voice receive now sits behind the DAVE end-to-end
 * encryption protocol (see docs/providers.md). Real receive support depends on
 * the chosen Discord voice library finalizing DAVE. The Recorder interface is
 * deliberately decoupled from Discord so the rest of Resound (sessions,
 * transcription, exporters, sinks) is ready the moment a working voice adapter
 * lands. Until then, MockRecorder drives the whole pipeline.
 */

export interface AudioChunk {
  /** The participant this chunk belongs to (for per-speaker diarization). */
  userId: string;
  username: string;
  /** Path to the written chunk file. */
  path: string;
  /** Start offset from session start, in seconds. */
  startSeconds: number;
  /** Duration in seconds. */
  durationSeconds: number;
}

export type RecorderMode = "mock" | "local-capture" | "discord-native";
export type RecorderPreflightStatus = "pass" | "warning" | "fail";

export interface RecorderCapabilities {
  mixedAudio: boolean;
  separateSpeakerTracks: boolean;
  reliableSpeakerIdentity: boolean;
  liveParticipantEvents: boolean;
  pauseResume: boolean;
  localOnly: boolean;
  reconnectSupport: boolean;
  healthMetrics: boolean;
  strictConsentCompatible: boolean;
  supportedPlatforms?: string[];
  requiredCommands?: string[];
  requiredPermissions?: string[];
  warnings?: string[];
}

export interface RecordingContext {
  sessionDir: string;
  outputDir?: string;
  strictConsent?: boolean;
}

export interface RecorderStartOptions {
  /** Directory where audio (raw + chunks) should be written. */
  sessionDir: string;
}

export interface RecorderDependencyStatus {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RecorderPreflightResult {
  status: RecorderPreflightStatus;
  recorderId: string;
  mode: RecorderMode;
  summary: string;
  dependencies: RecorderDependencyStatus[];
  warnings: string[];
  errors: string[];
  remediation: string[];
  selectedDevices?: Array<{ role: string; value: string }>;
}

export interface RecordingHealth {
  status: "idle" | "recording" | "paused" | "stopping" | "warning" | "failed";
  summary: string;
  warnings: string[];
  metrics?: Record<string, number | string | boolean>;
}

export interface Recorder {
  readonly id: string;
  readonly mode: RecorderMode;
  readonly capabilities: RecorderCapabilities;
  preflight?(context: RecordingContext): Promise<RecorderPreflightResult>;
  start(options: RecorderStartOptions): Promise<void>;
  /** Pause capture when the recorder supports it. */
  pause?(): Promise<void> | void;
  /** Resume a previously paused capture. */
  resume?(): Promise<void> | void;
  /** Returns the chunks captured between start() and stop(). */
  stop(): Promise<AudioChunk[]>;
  abort?(reason: string): Promise<AudioChunk[]>;
  getHealth?(): Promise<RecordingHealth> | RecordingHealth;
  /** Human-readable health report for the most recently completed capture. */
  captureSummary?(): Promise<string[]> | string[];
}
