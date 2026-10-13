import type { RawSegment } from "./tracks.js";

function invalid(field: string): never {
  // Identify the contract failure without echoing provider text or credentials.
  throw new Error(`Invalid transcription response: ${field}.`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function seconds(value: unknown, field: string): number {
  if (value == null) return 0; // Existing optional timestamp defaults.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalid(`${field} must be a finite nonnegative number`);
  return value;
}

/** Validate external JSON before it can become a successful canonical transcript. */
export function parseProviderJson(
  value: unknown,
  dialect: "openai" | "whisper.cpp",
  includeConfidence = false,
): RawSegment[] {
  const data = object(value, "response");
  const field = dialect === "openai" ? "segments" : "transcription";
  if (!(field in data) && !(dialect === "openai" && "text" in data))
    invalid(`expected ${field}${dialect === "openai" ? " or text" : ""}`);
  if (field in data && !Array.isArray(data[field]))
    invalid(`${field} must be an array`);
  if (dialect === "openai" && "text" in data && typeof data.text !== "string")
    invalid("text must be a string");
  const rows = (data[field] ?? []) as unknown[];
  if (rows.length === 0 && dialect === "openai" && data.text) {
    return [
      {
        start: 0,
        end: 0,
        text: (data.text as string).trim(),
        ...(includeConfidence ? { confidence: 0 } : {}),
      },
    ];
  }
  return rows.map((value, index) => {
    const label = `${field}[${index}]`;
    const row = object(value, label);
    if (typeof row.text !== "string") invalid(`${label}.text must be a string`);
    const offsets =
      dialect === "whisper.cpp"
        ? object(row.offsets ?? {}, `${label}.offsets`)
        : row;
    const divisor = dialect === "whisper.cpp" ? 1000 : 1;
    const startKey = dialect === "whisper.cpp" ? "from" : "start";
    const endKey = dialect === "whisper.cpp" ? "to" : "end";
    const segment: RawSegment = {
      start: seconds(offsets[startKey], `${label}.${startKey}`) / divisor,
      end: seconds(offsets[endKey], `${label}.${endKey}`) / divisor,
      text: row.text.trim(),
    };
    if (includeConfidence) {
      const logprob = row.avg_logprob;
      if (
        logprob != null &&
        (typeof logprob !== "number" || !Number.isFinite(logprob))
      )
        invalid(`${label}.avg_logprob must be a finite number`);
      segment.confidence =
        logprob == null
          ? 0
          : Math.max(0, Math.min(1, Math.exp(logprob as number)));
    }
    return segment;
  });
}
