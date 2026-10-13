#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessions } from "../packages/core/dist/index.js";

// Exercise the built public CLI with synthetic artifacts and no local .env.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resound-cli-smoke-"));
const root = path.join(directory, "sessions");
const cli = fileURLToPath(
  new URL("../apps/cli/dist/index.js", import.meta.url),
);
let checks = 0;
function run(args, status = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      RESOUND_TRANSCRIBER: "mock",
      RESOUND_OUTPUT_DIR: root,
    },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, status, `${args.join(" ")}: ${result.stderr}`);
  checks++;
  return result;
}
try {
  run(["mock", "Smoke"]);
  const [session] = listSessions(root);
  assert.ok(session);
  run(["sessions", "list"]);
  run(["sessions", "show", session]);
  run(["validate", session]);
  run(["export", session, "--format", "all"]);
  for (const format of ["md", "jsonl", "vtt", "srt"]) {
    assert.equal(
      run(["export", session, "--format", format]).stdout,
      fs.readFileSync(path.join(session, `transcript.${format}`), "utf8"),
    );
  }
  run(["summarize", session]);
  run(["action-items", session]);
  const copy = path.join(directory, "copy");
  run(["sink", "filesystem", session, "--dest", copy]);
  run(["validate", path.join(copy, path.basename(session))]);
  const markdown = "synthetic transcript line\n".repeat(100_000);
  fs.writeFileSync(path.join(session, "transcript.md"), markdown);
  const piped = run(["sink", "stdout", session]);
  assert.equal(piped.stdout, markdown);
  assert.match(piped.stderr, /\[ok\] stdout:/);
  run(["mock", "Smoke Two"]);
  const ambiguous = run(["sink", "stdout", "mock-smoke"], 1);
  assert.equal(ambiguous.stdout, "");
  assert.match(ambiguous.stderr, /Ambiguous session reference/);
  run(["export", session, "--format", "unsupported"], 1);
  console.log(
    `CLI smoke passed: ${checks} commands; ${Buffer.byteLength(markdown)} stdout bytes preserved.`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
