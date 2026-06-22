import { parseTimestamp, toSrtTimestamp, toVttTimestamp, type TranscriptSegment } from "@resound/core";

/** Render a WebVTT subtitle file from transcript segments. */
export function toVtt(segments: TranscriptSegment[]): string {
  const out: string[] = ["WEBVTT", ""];
  segments.forEach((seg, i) => {
    const start = parseTimestamp(seg.ts);
    const end = endOf(seg, start);
    out.push(String(i + 1));
    out.push(`${toVttTimestamp(start)} --> ${toVttTimestamp(end)}`);
    out.push(`<v ${seg.speaker}>${seg.text}`);
    out.push("");
  });
  return out.join("\n");
}

/** Render a SubRip (SRT) subtitle file from transcript segments. */
export function toSrt(segments: TranscriptSegment[]): string {
  const out: string[] = [];
  segments.forEach((seg, i) => {
    const start = parseTimestamp(seg.ts);
    const end = endOf(seg, start);
    out.push(String(i + 1));
    out.push(`${toSrtTimestamp(start)} --> ${toSrtTimestamp(end)}`);
    out.push(`${seg.speaker}: ${seg.text}`);
    out.push("");
  });
  return out.join("\n");
}

function endOf(seg: TranscriptSegment, start: number): number {
  if (seg.end_ts) {
    const end = parseTimestamp(seg.end_ts);
    if (end > start) return end;
  }
  return start + 2; // sensible default cue length
}
