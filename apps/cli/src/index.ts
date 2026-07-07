#!/usr/bin/env node
try {
  (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env file — rely on the ambient environment */
}
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  loadSession,
  listSessions,
  outputRoot,
  resolveSession,
  sessionPaths,
  validateSession
} from "@resound/core";
import {
  buildActionItemsMarkdown,
  buildSummary,
  buildSummaryMarkdown,
  extractActionItems,
  toMarkdown,
  toSrt,
  toVtt,
  writeSessionOutputs
} from "@resound/exporters";
import {
  FilesystemSink,
  StdoutSink,
  StrataSink,
  TotalRecallSink,
  WebhookSink,
  type Sink
} from "@resound/sinks";
import { runChecks } from "@resound/kujo";
import os from "node:os";
import { createFileSession, createMockSession, parseParticipants } from "./session-runner.js";
import { isInteractiveStopInput, listAudioDevices, recordAudio } from "./record.js";

const program = new Command();
program
  .name("resound")
  .description("Resound — portable Discord voice transcription. Conversations become memory.")
  .version("0.1.0");

function root(): string {
  return outputRoot(process.env);
}

function mustResolve(ref: string): string {
  const dir = resolveSession(ref, root());
  if (!dir) {
    console.error(`Session not found: "${ref}" (looked under ${root()})`);
    process.exit(1);
  }
  return dir;
}

program
  .command("init")
  .description("Create the transcripts output directory and show next steps")
  .action(() => {
    const dir = root();
    fs.mkdirSync(dir, { recursive: true });
    const keep = path.join(dir, ".gitkeep");
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
    console.log(`Initialized Resound output dir: ${dir}`);
    console.log("Next: copy .env.example to .env, then `resound mock \"My First Session\"`.");
  });

const sessions = program.command("sessions").description("Inspect local transcript sessions");

sessions
  .command("list")
  .description("List session folders under the output directory")
  .action(() => {
    const dirs = listSessions(root());
    if (dirs.length === 0) {
      console.log(`No sessions found under ${root()}.`);
      return;
    }
    for (const dir of dirs) {
      try {
        const { manifest, segments } = loadSession(dir);
        console.log(
          `${manifest.session_id}\t${segments.length} segs\t${path.relative(root(), dir)}`
        );
      } catch {
        console.log(`(unreadable)\t${dir}`);
      }
    }
  });

sessions
  .command("show <session>")
  .description("Show a session's manifest summary and first transcript lines")
  .action((ref: string) => {
    const dir = mustResolve(ref);
    const { manifest, segments } = loadSession(dir);
    console.log(`# ${manifest.title} (${manifest.session_id})`);
    console.log(`source:       ${manifest.source}`);
    console.log(`started:      ${manifest.started_at}`);
    console.log(`ended:        ${manifest.ended_at || "(in progress)"}`);
    console.log(`participants: ${manifest.participants.map((p) => p.username).join(", ") || "—"}`);
    console.log(`consent:      ${manifest.consent_events.length} event(s)`);
    console.log(`transcriber:  ${manifest.transcriber.provider} ${manifest.transcriber.model}`);
    console.log(`segments:     ${segments.length}`);
    console.log("");
    for (const seg of segments.slice(0, 5)) {
      console.log(`  ${seg.ts} ${seg.speaker}: ${seg.text}`);
    }
  });

program
  .command("export <session>")
  .description("Export a session to a format")
  .option("-f, --format <format>", "md | jsonl | vtt | srt | all", "md")
  .option("-o, --out <file>", "Write to a file instead of stdout")
  .action((ref: string, opts: { format: string; out?: string }) => {
    const dir = mustResolve(ref);
    const { manifest, segments } = loadSession(dir);
    const format = opts.format.toLowerCase();

    if (format === "all") {
      const written = writeSessionOutputs({ manifest, segments, dir });
      console.log(`Wrote ${written.length} file(s) to ${dir}`);
      return;
    }

    let content: string;
    switch (format) {
      case "md":
      case "markdown":
        content = toMarkdown(manifest, segments, {
          summary: buildSummary(manifest, segments),
          actionItems: extractActionItems(segments)
        });
        break;
      case "jsonl":
        content = fs.readFileSync(sessionPaths(dir, manifest).jsonl, "utf8");
        break;
      case "vtt":
        content = toVtt(segments);
        break;
      case "srt":
        content = toSrt(segments);
        break;
      default:
        console.error(`Unknown format: ${opts.format}`);
        process.exit(1);
    }
    if (opts.out) {
      fs.writeFileSync(opts.out, content!, "utf8");
      console.log(`Wrote ${opts.out}`);
    } else {
      process.stdout.write(content!);
    }
  });

program
  .command("summarize <session>")
  .description("(Re)generate summary.md for a session")
  .action((ref: string) => {
    const dir = mustResolve(ref);
    const { manifest, segments } = loadSession(dir);
    const out = sessionPaths(dir, manifest).summary;
    fs.writeFileSync(out, buildSummaryMarkdown(manifest, segments), "utf8");
    console.log(`Wrote ${out}`);
  });

program
  .command("action-items <session>")
  .description("(Re)generate action-items.md for a session")
  .action((ref: string) => {
    const dir = mustResolve(ref);
    const { manifest, segments } = loadSession(dir);
    const items = extractActionItems(segments);
    const out = sessionPaths(dir, manifest).actionItems;
    fs.writeFileSync(out, buildActionItemsMarkdown(items), "utf8");
    console.log(`Wrote ${out} (${items.length} item(s))`);
  });

program
  .command("validate <session>")
  .description("Validate a session folder (manifest, consent, outputs, Kujo checks)")
  .action((ref: string) => {
    const dir = mustResolve(ref);
    const result = validateSession(dir);
    for (const w of result.warnings) console.log(`  war: ${w}`);
    for (const e of result.errors) console.error(`  err:  ${e}`);

    const checks = runChecks(dir);
    for (const c of checks) {
      console.log(`  [${c.pass ? "PASS" : "FAIL"}] ${c.check}`);
      for (const m of c.messages) console.log(`         - ${m}`);
    }

    const ok = result.valid && checks.every((c) => c.pass);
    console.log(ok ? "\n✓ valid" : "\n✗ invalid");
    process.exit(ok ? 0 : 1);
  });

const sink = program.command("sink").description("Send a session to an optional downstream sink");

async function runSink(s: Sink, ref: string): Promise<void> {
  const dir = mustResolve(ref);
  const session = loadSession(dir);
  const result = await s.send(session);
  console.log(`[${result.ok ? "ok" : result.skipped ? "skip" : "fail"}] ${result.sink}: ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}

sink
  .command("strata <session>")
  .description("Push transcript.md into Strata (optional; fails gracefully)")
  .option("-c, --command <cmd>", "Override the Strata ingest command")
  .action((ref: string, opts: { command?: string }) =>
    runSink(new StrataSink({ command: opts.command }), ref)
  );

sink
  .command("totalrecall <session>")
  .description("Ingest the session folder into TotalRecall (optional/scaffolded)")
  .option("-c, --command <cmd>", "Override the TotalRecall ingest command")
  .action((ref: string, opts: { command?: string }) =>
    runSink(new TotalRecallSink({ command: opts.command }), ref)
  );

sink
  .command("webhook <session>")
  .description("POST the session as JSON to a webhook URL")
  .requiredOption("-u, --url <url>", "Webhook URL")
  .action((ref: string, opts: { url: string }) => runSink(new WebhookSink({ url: opts.url }), ref));

sink
  .command("filesystem <session>")
  .description("Copy portable artifacts into a destination directory")
  .requiredOption("-d, --dest <dir>", "Destination directory")
  .action((ref: string, opts: { dest: string }) => runSink(new FilesystemSink(opts.dest), ref));

sink
  .command("stdout <session>")
  .description("Write transcript.md to stdout")
  .action((ref: string) => runSink(new StdoutSink(), ref));

program
  .command("transcribe <audioFile>")
  .description("Transcribe a recorded audio file into a full session (real provider; no Discord needed)")
  .requiredOption("-t, --title <title>", "Session title")
  .option("-p, --provider <provider>", "Override RESOUND_TRANSCRIBER (e.g. openai)")
  .option("--participants <csv>", "Comma-separated participant names")
  .option("-l, --language <lang>", "Language hint, e.g. en")
  .action(
    async (
      audioFile: string,
      opts: { title: string; provider?: string; participants?: string; language?: string }
    ) => {
      const session = await createFileSession({
        title: opts.title,
        audioFile,
        provider: opts.provider,
        participants: parseParticipants(opts.participants),
        language: opts.language
      });
      console.log(`Transcribed ${audioFile} → ${session.dir}`);
      console.log(`  provider: ${session.manifest.transcriber.provider} ${session.manifest.transcriber.model}`);
      console.log(`  segments: ${session.segments.length}`);
      console.log(`Validate: resound validate '${path.basename(session.dir)}'`);
    }
  );

program
  .command("devices")
  .description("List macOS audio input devices (ffmpeg/avfoundation) for `resound record`")
  .action(() => {
    const devices = listAudioDevices();
    if (devices.length === 0) {
      console.log("No audio devices found (is ffmpeg installed? `brew install ffmpeg`).");
      return;
    }
    console.log("Audio input devices (use the index with `resound record`):");
    for (const d of devices) console.log(`  [${d.index}] ${d.name}`);
    console.log(
      "\nTip: capture the call output device (e.g. BlackHole) with --system and your mic with --mic."
    );
  });

program
  .command("record")
  .description("Record macOS system audio + mic, then transcribe into a session (the real capture path)")
  .requiredOption("-t, --title <title>", "Session title")
  .option("--system <device>", "avfoundation device for call audio (e.g. BlackHole index)", process.env.RESOUND_AUDIO_SYSTEM_DEVICE)
  .option("--mic <device>", "avfoundation device for your microphone", process.env.RESOUND_AUDIO_MIC_DEVICE)
  .option("--device <device>", "single capture device instead of system+mic")
  .option("-d, --duration <seconds>", "auto-stop after N seconds (default: until Enter/q)", (v) => parseInt(v, 10))
  .option("-p, --provider <provider>", "override RESOUND_TRANSCRIBER (e.g. local-whisper)")
  .option("--participants <csv>", "comma-separated participant names")
  .option("-l, --language <lang>", "language hint, e.g. en")
  .action(
    async (opts: {
      title: string;
      system?: string;
      mic?: string;
      device?: string;
      duration?: number;
      provider?: string;
      participants?: string;
      language?: string;
    }) => {
      if (!opts.system && !opts.mic && !opts.device) {
        console.error(
          "No capture device given. Run `resound devices`, then pass --system <idx> and/or --mic <idx> (or --device <idx>)."
        );
        process.exit(1);
      }
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "resound-rec-")), "recording.wav");
      const rec = recordAudio({
        outFile: tmp,
        systemDevice: opts.system,
        micDevice: opts.mic,
        device: opts.device,
        durationSec: opts.duration
      });

      let cleanupStopControls = () => {};
      if (opts.duration && opts.duration > 0) {
        console.log(`🔴 Recording for ${opts.duration}s…`);
      } else {
        console.log("🔴 Recording… press Enter or q to stop and transcribe.");
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          console.log("\n⏹  Stopping…");
          rec.stop();
        };
        const onData = (chunk: Buffer | string) => {
          if (isInteractiveStopInput(String(chunk))) stop();
        };
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.setEncoding("utf8");
        process.stdin.resume();
        process.stdin.on("data", onData);
        process.once("SIGINT", stop);
        cleanupStopControls = () => {
          process.stdin.off("data", onData);
          process.off("SIGINT", stop);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.pause();
        };
      }

      try {
        await rec.done;
      } finally {
        cleanupStopControls();
      }
      console.log("✅ Audio captured. Transcribing…");

      const session = await createFileSession({
        title: opts.title,
        audioFile: tmp,
        provider: opts.provider,
        participants: parseParticipants(opts.participants),
        language: opts.language
      });
      console.log(`Session: ${session.dir}`);
      console.log(`  provider: ${session.manifest.transcriber.provider} ${session.manifest.transcriber.model}`);
      console.log(`  segments: ${session.segments.length}`);
      console.log(`Validate: resound validate '${path.basename(session.dir)}'`);
      process.exit(0);
    }
  );

program
  .command("mock <title>")
  .description("Create a complete mock session (record -> transcribe -> export)")
  .action(async (title: string) => {
    const session = await createMockSession({ title });
    console.log(`Created mock session: ${session.dir}`);
    console.log(`  segments: ${session.segments.length}`);
    console.log("Try: resound validate '" + path.basename(session.dir) + "'");
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
