import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";

/** Preserve a failed provider's response without buffering it in memory. */
export async function responseErrorDetail(response: Response): Promise<string> {
  if (!response.body) return "";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resound-http-"));
  const file = path.join(directory, "response.log");
  await pipeline(
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
    fs.createWriteStream(file, { mode: 0o600 }),
  );
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(Math.min(size, 8192));
  try {
    fs.readSync(fd, buffer);
  } finally {
    fs.closeSync(fd);
  }
  if (size > buffer.length)
    return `[Full provider error: ${file}]\n${buffer.toString("utf8")}\n[preview limited to 8192 bytes]`;
  fs.rmSync(directory, { recursive: true });
  return buffer.toString("utf8");
}
