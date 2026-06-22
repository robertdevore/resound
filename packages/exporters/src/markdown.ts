import type { SessionManifest, TranscriptSegment } from "@resound/core";

function dateOnly(iso: string): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function participantNames(manifest: SessionManifest): string {
  const names = manifest.participants.map((p) => p.username).filter(Boolean);
  return names.length ? names.join(", ") : "—";
}

export interface MarkdownOptions {
  summary?: string;
  actionItems?: string[];
}

/** Render the human-readable Markdown transcript. */
export function toMarkdown(
  manifest: SessionManifest,
  segments: TranscriptSegment[],
  options: MarkdownOptions = {}
): string {
  const lines: string[] = [];
  lines.push(`# Resound Transcript: ${manifest.title}`);
  lines.push("");
  lines.push(`Date: ${dateOnly(manifest.started_at)}`);
  lines.push(`Source: ${cap(manifest.source)}`);
  if (manifest.channel_id) lines.push(`Channel: ${manifest.channel_id}`);
  lines.push(`Participants: ${participantNames(manifest)}`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(options.summary?.trim() || "_No summary generated._");
  lines.push("");

  lines.push("## Action Items");
  lines.push("");
  if (options.actionItems && options.actionItems.length > 0) {
    for (const item of options.actionItems) lines.push(`- [ ] ${item}`);
  } else {
    lines.push("- [ ] _None captured._");
  }
  lines.push("");

  lines.push("## Transcript");
  lines.push("");
  if (segments.length === 0) {
    lines.push("_No transcript segments._");
  } else {
    for (const seg of segments) {
      lines.push(`**${seg.ts} ${seg.speaker}:** ${seg.text}`);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
