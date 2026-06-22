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
  const parts = ts.trim().split(":").map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p))) {
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
  const ms = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${formatTimestamp(totalSeconds)}.${pad(ms, 3)}`;
}

/** Seconds -> SubRip (SRT) timestamp `hh:mm:ss,mmm`. */
export function toSrtTimestamp(totalSeconds: number): string {
  const ms = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return `${formatTimestamp(totalSeconds)},${pad(ms, 3)}`;
}
