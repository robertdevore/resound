import type { ConsentEvent, ConsentEventType, SessionManifest } from "./types.js";

/** Append a consent event to a manifest (mutates and returns it). */
export function recordConsentEvent(
  manifest: SessionManifest,
  event: {
    type: ConsentEventType;
    user_id: string;
    username: string;
    ts?: string;
    note?: string;
  }
): ConsentEvent {
  const entry: ConsentEvent = {
    type: event.type,
    user_id: event.user_id,
    username: event.username,
    ts: event.ts ?? new Date().toISOString(),
    note: event.note
  };
  manifest.consent_events.push(entry);
  return entry;
}

/**
 * Add (or re-activate) a participant. If they join after recording started,
 * a `participant-joined` consent event is logged so the audit trail shows the
 * recording was active when they arrived.
 */
export function addParticipant(
  manifest: SessionManifest,
  participant: { id: string; username: string; joinedAt?: string }
): void {
  const joinedAt = participant.joinedAt ?? new Date().toISOString();
  const existing = manifest.participants.find((p) => p.id === participant.id);
  if (existing) {
    existing.left_at = undefined;
    return;
  }
  manifest.participants.push({
    id: participant.id,
    username: participant.username,
    joined_at: joinedAt
  });

  const recordingActive = manifest.started_at !== "" && manifest.ended_at === "";
  if (recordingActive) {
    recordConsentEvent(manifest, {
      type: "participant-joined",
      user_id: participant.id,
      username: participant.username,
      ts: joinedAt,
      note: "Joined while recording/transcription was active."
    });
  }
}

/** Mark a participant as having left the session. */
export function removeParticipant(
  manifest: SessionManifest,
  userId: string,
  leftAt?: string
): void {
  const existing = manifest.participants.find((p) => p.id === userId);
  if (existing) existing.left_at = leftAt ?? new Date().toISOString();
}

/** True if at least one explicit consent/announcement event is present. */
export function hasConsent(manifest: SessionManifest): boolean {
  return manifest.consent_events.length > 0;
}
