import type { SessionManifest, TranscriptSegment } from "@resound/core";

/**
 * Heuristic, dependency-free summary. This is intentionally simple: Resound's
 * job is to produce portable artifacts. Richer summaries can be layered on by a
 * downstream LLM step, but the system must work with no API key.
 */
export function buildSummary(
  manifest: SessionManifest,
  segments: TranscriptSegment[]
): string {
  if (segments.length === 0) return "_No transcript content to summarize._";

  const speakers = [...new Set(segments.map((s) => s.speaker))];
  const totalWords = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  const lines: string[] = [];
  lines.push(
    `Conversation "${manifest.title}" with ${speakers.length} speaker(s): ${speakers.join(", ")}.`
  );
  lines.push(`${segments.length} segment(s), ~${totalWords} words.`);
  lines.push("");
  lines.push("Opening:");
  for (const seg of segments.slice(0, 3)) {
    lines.push(`- **${seg.speaker}:** ${truncate(seg.text, 160)}`);
  }
  return lines.join("\n");
}

const ACTION_HINTS = [
  /\bwe (?:need|should|have) to\b/i,
  /\b(?:i|you|we|let'?s) (?:will|'ll)\b/i,
  /\baction item\b/i,
  /\bfollow up\b/i,
  /\btodo\b/i,
  /\bnext step\b/i,
  /\bassign(?:ed)?\b/i,
  /\bby (?:tomorrow|monday|friday|next week|eod)\b/i
];

/** Extract candidate action items via keyword heuristics. */
export function extractActionItems(segments: TranscriptSegment[]): string[] {
  const items: string[] = [];
  for (const seg of segments) {
    if (ACTION_HINTS.some((re) => re.test(seg.text))) {
      items.push(`${seg.speaker}: ${truncate(seg.text.trim(), 200)}`);
    }
  }
  return items;
}

/** Render the action-items Markdown file. */
export function buildActionItemsMarkdown(items: string[]): string {
  const lines = ["# Action Items", ""];
  if (items.length === 0) {
    lines.push("- [ ] _None captured._");
  } else {
    for (const item of items) lines.push(`- [ ] ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Render the summary Markdown file. */
export function buildSummaryMarkdown(
  manifest: SessionManifest,
  segments: TranscriptSegment[]
): string {
  return `# Summary: ${manifest.title}\n\n${buildSummary(manifest, segments)}\n`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}
