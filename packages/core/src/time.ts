/** Timestamp helpers. Resound stores transcript offsets as `hh:mm:ss`. */

function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, "0");
}

/** Seconds -> `hh:mm:ss`. */
export function formatTimestamp(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** `hh:mm:ss` or `mm:ss` -> seconds. */
export function parseTimestamp(ts: string): number {
  const value = ts.trim();
  if (!/^(?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?$/.test(value)) {
    throw new Error(`Invalid timestamp: "${ts}"`);
  }
  const normalized = value.replace(",", ".");
  const parts = normalized.split(":").map(Number);
  const minutes = parts.at(-2)!;
  const secondsPart = parts.at(-1)!;
  if (minutes >= 60 || secondsPart >= 60) {
    throw new Error(`Invalid timestamp: "${ts}"`);
  }
  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return seconds;
}

/** Seconds -> WebVTT timestamp `hh:mm:ss.mmm`. */
export function toVttTimestamp(totalSeconds: number): string {
	const totalMs = Math.max(0, Math.round(Number.isFinite(totalSeconds) ? totalSeconds * 1000 : 0));
	const wholeSeconds = Math.floor(totalMs / 1000);
	return `${formatTimestamp(wholeSeconds)}.${pad(totalMs % 1000, 3)}`;
}

/** Seconds -> SubRip (SRT) timestamp `hh:mm:ss,mmm`. */
export function toSrtTimestamp(totalSeconds: number): string {
	const totalMs = Math.max(0, Math.round(Number.isFinite(totalSeconds) ? totalSeconds * 1000 : 0));
	const wholeSeconds = Math.floor(totalMs / 1000);
	return `${formatTimestamp(wholeSeconds)},${pad(totalMs % 1000, 3)}`;
}
