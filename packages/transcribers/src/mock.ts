import { formatTimestamp, type TranscriptSegment } from "@resound/core";
import type { Transcriber, TranscriptionInput } from "./types.js";

const SCRIPT = [
  "Let's review blockers first.",
  "I pushed the migration last night, it's in review.",
  "Great. I will ship the migration by tomorrow.",
  "Any concerns about the release window?",
  "We need to update the docs before we cut the tag.",
  "Action item: I'll draft the changelog this afternoon.",
  "Sounds good, let's regroup on Friday."
];

/**
 * Deterministic provider for tests and local development. Produces a plausible
 * transcript from the known participants without touching any network.
 */
export class MockTranscriber implements Transcriber {
  readonly provider = "mock";
  readonly model = "mock-1";

  async transcribe(input: TranscriptionInput): Promise<TranscriptSegment[]> {
    const speakers =
      input.participants && input.participants.length > 0
        ? input.participants.map((p) => ({ name: p.username, id: p.id }))
        : [
            { name: "Robert", id: "1" },
            { name: "Ashley", id: "2" }
          ];

    const segments: TranscriptSegment[] = [];
    let t = 5;
    SCRIPT.forEach((text, i) => {
      const speaker = speakers[i % speakers.length]!;
      const start = t;
      const end = t + 4;
      segments.push({
        ts: formatTimestamp(start),
        end_ts: formatTimestamp(end),
        speaker: speaker.name,
        user_id: speaker.id,
        text,
        confidence: 0.9
      });
      t = end + 1;
    });
    return segments;
  }
}
