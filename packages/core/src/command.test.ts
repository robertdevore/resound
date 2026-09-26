import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { deadlineMs, runCommand } from "./command.js";

it("preserves full diagnostics while bounding the returned preview", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "process.stderr.write('x'.repeat(1024*1024));process.exitCode=7",
  ]);
  expect(result.code).toBe(7);
  expect(result.stderr.length).toBeLessThan(8500);
  const file = result.stderr.match(/\[Full diagnostics: (.+)\]/)![1]!;
  expect(fs.statSync(file).size).toBe(1024 * 1024);
  expect(fs.statSync(file).mode & 0o077).toBe(0);
  fs.rmSync(path.dirname(file), { recursive: true });
});

it("terminates hung commands and reports a deadline failure", async () => {
  await expect(
    runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], 100),
  ).rejects.toThrow(/exceeded 100ms.*diagnostics/);
});

it("preserves missing executable errors and validates deadline configuration", async () => {
  await expect(
    runCommand("/nonexistent-resound-command", []),
  ).rejects.toMatchObject({ code: "ENOENT" });
  for (const value of [0, -1, NaN, Infinity, "oops", "", 2 ** 32]) {
    expect(() => deadlineMs(value, 100)).toThrow(/positive integer/);
  }
});
