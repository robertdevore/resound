import type { TranscriptSegment } from "./types.js";

const REQUIRED_FIELDS: (keyof TranscriptSegment)[] = [
  "ts",
  "end_ts",
  "speaker",
  "user_id",
  "text",
  "confidence"
];

export interface ParseResult {
  segments: TranscriptSegment[];
  errors: string[];
}

/** Parse JSONL transcript content. Blank lines are ignored. */
export function parseJsonl(content: string): ParseResult {
  const segments: TranscriptSegment[] = [];
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      errors.push(`Line ${index + 1}: not valid JSON`);
      return;
    }
    if (typeof obj !== "object" || obj === null) {
      errors.push(`Line ${index + 1}: expected an object`);
      return;
    }
    const record = obj as Record<string, unknown>;
    const missing = REQUIRED_FIELDS.filter((f) => !(f in record));
    if (missing.length > 0) {
      errors.push(`Line ${index + 1}: missing field(s): ${missing.join(", ")}`);
      return;
    }
    segments.push({
      ts: String(record.ts),
      end_ts: String(record.end_ts),
      speaker: String(record.speaker),
      user_id: String(record.user_id),
      text: String(record.text),
      confidence: Number(record.confidence)
    });
  });

  return { segments, errors };
}

/** Serialize segments to JSONL (one compact JSON object per line). */
export function toJsonl(segments: TranscriptSegment[]): string {
  return segments.map((s) => JSON.stringify(s)).join("\n") + (segments.length ? "\n" : "");
}
