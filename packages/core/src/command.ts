import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/** Validate deadlines at the configuration boundary, including environment values. */
export function deadlineMs(
  value: number | string | undefined,
  fallback: number,
): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) {
    throw new Error(
      "Command/request timeout must be a positive integer in milliseconds (at most 2147483647).",
    );
  }
  return result;
}

/** Shell-free command execution with finite lifetime and disk-backed diagnostics.
 * Full output stays in private files; returned previews have a fixed memory bound.
 */
export async function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  deadlineMs(timeoutMs, 60_000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resound-command-"));
  const stdoutPath = path.join(directory, "stdout.log");
  const stderrPath = path.join(directory, "stderr.log");
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const terminate = () => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else child.kill("SIGKILL");
  };
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    terminate();
  }, timeoutMs);
  const closed = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  try {
    const [code] = await Promise.all([
      closed,
      pipeline(child.stdout, fs.createWriteStream(stdoutPath, { mode: 0o600 })),
      pipeline(child.stderr, fs.createWriteStream(stderrPath, { mode: 0o600 })),
    ]);
    if (expired)
      throw new Error(
        `Command exceeded ${timeoutMs}ms; diagnostics: ${directory}`,
      );
    const result = {
      code,
      stdout: diagnosticPreview(stdoutPath),
      stderr:
        (code !== 0 ? `[Diagnostics: ${stderrPath}]\n` : "") +
        diagnosticPreview(stderrPath),
    };
    if (
      code === 0 &&
      fs.statSync(stdoutPath).size <= 8192 &&
      fs.statSync(stderrPath).size <= 8192
    )
      fs.rmSync(directory, { recursive: true });
    return result;
  } catch (error) {
    terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function diagnosticPreview(file: string): string {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(
      fd,
      buffer,
      0,
      buffer.length,
      Math.max(0, size - buffer.length),
    );
    const text = buffer.toString("utf8");
    return size > buffer.length
      ? `[Full diagnostics: ${file}]\n${text}\n[preview limited to last 8192 bytes]`
      : text;
  } finally {
    fs.closeSync(fd);
  }
}
