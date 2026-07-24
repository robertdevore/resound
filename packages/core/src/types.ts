/**
 * Resound canonical data model.
 *
 * These types are the source of truth. Markdown / JSONL / VTT / SRT are
 * projections of this model; Strata and TotalRecall are optional sinks that
 * consume it. Nothing here depends on Discord or any transcription vendor.
 */

export const SCHEMA_VERSION = "1.1.0";

export type SessionSource = "discord" | "file" | "mock" | (string & {});
export type CaptureMode = "mock" | "local-capture" | "discord-native";
export type RequestedCaptureMode = CaptureMode | "auto";
export type SessionStatus =
  | "created"
  | "announced"
  | "preflighting"
  | "awaiting-consent"
  | "recording"
  | "recording-degraded"
  | "audio-finalizing"
  | "audio-finalized"
  | "transcribing"
  | "transcribed"
  | "exporting"
  | "exported"
  | "completed"
  | "failed"
  | "aborted"
  | "recoverable";

/**
 * A consent event is an auditable record that recording/transcription was
 * announced and/or acknowledged. Consent metadata is required on every session.
 */
export type ConsentEventType =
  | "recording-announced"
  | "session-consent"
  | "participant-joined"
  | "participant-consent"
  | "participant-left"
  | "recording-stopped";

export interface ConsentEvent {
  type: ConsentEventType;
  user_id: string;
  username: string;
  /** ISO-8601 timestamp. */
  ts: string;
  note?: string;
}

export interface Participant {
  id: string;
  username: string;
  /** ISO-8601 timestamp the participant joined the session. */
  joined_at: string;
  /** ISO-8601 timestamp the participant left, if known. */
  left_at?: string;
}

export interface TranscriberInfo {
  provider: string;
  model: string;
  profile?: string;
}

export interface SessionOutputs {
  jsonl: string;
  markdown: string;
  vtt: string;
  srt: string;
  summary: string;
  action_items: string;
}

export interface StartedBy {
  id: string;
  username: string;
}

export interface SessionRecorderInfo {
  id: string;
  mode: CaptureMode;
}

export interface SessionAudioFiles {
  mixed?: string;
  system?: string;
  microphone?: string;
  chunks_dir?: string;
}

export interface SessionManifest {
  schema_version: string;
  session_id: string;
  title: string;
  source: SessionSource;
  guild_id: string;
  channel_id: string;
  /** ISO-8601. */
  started_at: string;
  /** ISO-8601. Empty string while a session is in progress. */
  ended_at: string;
  status: SessionStatus;
  started_by: StartedBy;
  requested_capture_mode: RequestedCaptureMode;
  selected_capture_mode: CaptureMode | "";
  fallback_reason?: string;
  recorder: SessionRecorderInfo;
  participants: Participant[];
  consent_events: ConsentEvent[];
  audio_files: SessionAudioFiles;
  audio_health: string[];
  outputs: SessionOutputs;
  transcriber: TranscriberInfo;
  warnings: string[];
}

/**
 * One line of the canonical JSONL transcript. Timestamps are clock-style
 * `hh:mm:ss` offsets from the start of the recording.
 */
export interface TranscriptSegment {
  ts: string;
  end_ts: string;
  speaker: string;
  user_id: string;
  text: string;
  confidence: number;
}

/** An in-memory session: manifest + segments + the folder they live in. */
export interface TranscriptSession {
  manifest: SessionManifest;
  segments: TranscriptSegment[];
  /** Absolute or relative path to the session folder. */
  dir: string;
}
