import fs from "node:fs";
import { formatTimestamp, type Participant, type TranscriptSegment } from "@resound/core";
import type { TranscriptionInput, TranscriptionTrack } from "./types.js";

export interface RawSegment {
  start: number;
  end: number;
  text: string;
  confidence?: number;
}

interface EffectiveTrack extends TranscriptionTrack {
  resolvedUsername: string;
}

export function selectEffectiveTracks(input: TranscriptionInput): EffectiveTrack[] {
  const tracks = (input.audioTracks ?? [])
    .filter((track) => track.userId !== "mixed")
    .filter((track) => fs.existsSync(track.path));
  if (tracks.length === 0) return [];
  const participants = new Map((input.participants ?? []).map((participant) => [participant.id, participant]));
  return tracks.map((track) => ({
    ...track,
    resolvedUsername: participants.get(track.userId)?.username ?? track.username
  }));
}

export function mapRawSegmentsToSpeakerSegments(
  raw: RawSegment[],
  speaker: { userId: string; username: string; startSeconds?: number }
): TranscriptSegment[] {
  const offset = speaker.startSeconds ?? 0;
  return raw
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment) => ({
      ts: formatTimestamp(segment.start + offset),
      end_ts: formatTimestamp(segment.end + offset),
      speaker: speaker.username,
      user_id: speaker.userId,
      text: segment.text.trim(),
      confidence: segment.confidence ?? 0
    }));
}

export function defaultSpeaker(input: TranscriptionInput): { userId: string; username: string; startSeconds: number } {
  const participant = input.participants?.[0];
  return {
    userId: participant?.id ?? "",
    username: participant?.username ?? "Speaker",
    startSeconds: 0
  };
}

export function mergeTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((left, right) => {
    const startDiff = parseTimestamp(left.ts) - parseTimestamp(right.ts);
    if (startDiff !== 0) return startDiff;
    const endDiff = parseTimestamp(left.end_ts) - parseTimestamp(right.end_ts);
    if (endDiff !== 0) return endDiff;
    return left.user_id.localeCompare(right.user_id);
  });
}

function parseTimestamp(value: string): number {
  const [hours = "0", minutes = "0", seconds = "0"] = value.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
