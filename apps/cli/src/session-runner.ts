import fs from "node:fs";
import path from "node:path";
import {
  addParticipant,
  buildSessionFolder,
  createManifest,
  outputRoot,
  recordConsentEvent,
  sessionPaths,
  type TranscriptSession
} from "@resound/core";
import { MockRecorder } from "@resound/audio";
import { getTranscriber } from "@resound/transcribers";
import { writeSessionOutputs } from "@resound/exporters";

export interface MockSessionOptions {
  title: string;
  participants?: { id: string; username: string }[];
  env?: NodeJS.ProcessEnv;
  at?: Date;
}

/**
 * Drive the full pipeline with the mock recorder + configured transcriber:
 * create session -> record consent -> capture (mock) audio -> transcribe ->
 * write all portable outputs. Returns the in-memory session and its directory.
 */
export async function createMockSession(
  options: MockSessionOptions
): Promise<TranscriptSession> {
  const env = options.env ?? process.env;
  const at = options.at ?? new Date();
  const participants =
    options.participants && options.participants.length > 0
      ? options.participants
      : [
          { id: "1", username: "Robert" },
          { id: "2", username: "Ashley" }
        ];

  const transcriber = getTranscriber({ env });
  const manifest = createManifest({
    title: options.title,
    source: "mock",
    startedAt: at,
    startedBy: { id: participants[0]!.id, username: participants[0]!.username },
    transcriberProvider: transcriber.provider,
    transcriberModel: transcriber.model
  });

  recordConsentEvent(manifest, {
    type: "recording-announced",
    user_id: "bot",
    username: "resound",
    ts: at.toISOString(),
    note: "Recording and transcription announced at session start."
  });
  for (const p of participants) {
    addParticipant(manifest, { id: p.id, username: p.username, joinedAt: at.toISOString() });
  }

  const dir = path.join(outputRoot(env), buildSessionFolder({ title: options.title, source: "mock", at }));

  const recorder = new MockRecorder({ participants });
  await recorder.start({ sessionDir: dir });
  const chunks = await recorder.stop();

  const segments = await transcriber.transcribe({
    sessionDir: dir,
    participants: manifest.participants,
    audioTracks: chunks,
    audioPath: chunks[0]?.path,
    mock: true
  });

  manifest.ended_at = new Date(at.getTime() + 60_000).toISOString();
  recordConsentEvent(manifest, {
    type: "recording-stopped",
    user_id: "bot",
    username: "resound",
    note: "Recording stopped."
  });

  const session: TranscriptSession = { manifest, segments, dir };
  writeSessionOutputs(session);
  return session;
}

export interface FileSessionOptions {
  title: string;
  audioFile: string;
  /** Override RESOUND_TRANSCRIBER for this run (e.g. "openai"). */
  provider?: string;
  /** Comma-separated names, or a prepared list. */
  participants?: { id: string; username: string }[];
  language?: string;
  env?: NodeJS.ProcessEnv;
  at?: Date;
}

/**
 * Transcribe a real, already-recorded audio file end-to-end. This is the path
 * that works TODAY without Discord voice receive: record the meeting to a file
 * (system audio, OBS, a recording bot, etc.), then turn it into a full,
 * portable Resound session with the configured provider (e.g. OpenAI).
 */
export async function createFileSession(
  options: FileSessionOptions
): Promise<TranscriptSession> {
  const env = options.env ?? process.env;
  const at = options.at ?? new Date();

  if (!fs.existsSync(options.audioFile)) {
    throw new Error(`Audio file not found: ${options.audioFile}`);
  }

  const transcriber = getTranscriber({ name: options.provider, env });
  const participants = options.participants ?? [];

  const manifest = createManifest({
    title: options.title,
    source: "file",
    startedAt: at,
    startedBy: participants[0] ?? { id: "", username: "" },
    transcriberProvider: transcriber.provider,
    transcriberModel: transcriber.model
  });
  recordConsentEvent(manifest, {
    type: "recording-announced",
    user_id: "operator",
    username: "operator",
    ts: at.toISOString(),
    note: `Transcribing pre-recorded audio: ${path.basename(options.audioFile)}. Operator attests recording consent was obtained.`
  });
  for (const p of participants) {
    addParticipant(manifest, { id: p.id, username: p.username, joinedAt: at.toISOString() });
  }

  const dir = path.join(
    outputRoot(env),
    buildSessionFolder({ title: options.title, source: "file", at })
  );
  // Reference the source audio inside the session for provenance.
  const paths = sessionPaths(dir);
  fs.mkdirSync(paths.audioRaw, { recursive: true });
  const audioCopy = path.join(paths.audioRaw, path.basename(options.audioFile));
  try {
    fs.copyFileSync(options.audioFile, audioCopy);
  } catch {
    /* large file or permission issue — transcription still proceeds from source */
  }

  const segments = await transcriber.transcribe({
    sessionDir: dir,
    audioPath: fs.existsSync(audioCopy) ? audioCopy : options.audioFile,
    participants: manifest.participants,
    language: options.language
  });

  manifest.ended_at = new Date().toISOString();
  recordConsentEvent(manifest, {
    type: "recording-stopped",
    user_id: "operator",
    username: "operator",
    note: "Transcription complete."
  });

  const session: TranscriptSession = { manifest, segments, dir };
  writeSessionOutputs(session);
  return session;
}

/** Parse a comma-separated name list into synthetic participants. */
export function parseParticipants(csv?: string): { id: string; username: string }[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((username, i) => ({ id: `p${i + 1}`, username }));
}
