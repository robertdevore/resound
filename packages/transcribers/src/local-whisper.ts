import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { formatTimestamp, type TranscriptSegment } from "@resound/core";
import type { Transcriber, TranscriptionInput } from "./types.js";

/**
 * Local-first transcription. Shells out to a locally installed Whisper binary so
 * audio never leaves the machine. Two output dialects are supported:
 *
 *  - "whisper.cpp"   (default): `whisper-cli -f audio -oj -of out` → out.json
 *  - "openai-whisper": the Python `whisper` CLI → <audio>.json with `segments`
 *
 * Everything is configurable via env so users can point at whatever they have
 * (whisper.cpp, faster-whisper wrappers, etc.) without code changes.
 */

export type WhisperFormat = "whisper.cpp" | "openai-whisper";

interface RawSeg {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

/** Parse whisper.cpp full JSON (offsets are milliseconds). */
export function parseWhisperCppJson(json: string): RawSeg[] {
  const data = JSON.parse(json) as {
    transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
  };
  const rows = data.transcription ?? [];
  return rows.map((r) => ({
    start: (r.offsets?.from ?? 0) / 1000,
    end: (r.offsets?.to ?? 0) / 1000,
    text: (r.text ?? "").trim()
  }));
}

/** Parse the OpenAI/openai-whisper Python CLI JSON (start/end in seconds). */
export function parseOpenAiWhisperJson(json: string): RawSeg[] {
  const data = JSON.parse(json) as {
    segments?: { start?: number; end?: number; text?: string }[];
    text?: string;
  };
  const rows = data.segments ?? [];
  if (rows.length === 0 && data.text) {
    return [{ start: 0, end: 0, text: data.text.trim() }];
  }
  return rows.map((r) => ({
    start: r.start ?? 0,
    end: r.end ?? 0,
    text: (r.text ?? "").trim()
  }));
}

export interface LocalWhisperOptions {
  /** Binary to invoke. Default: RESOUND_WHISPER_COMMAND or "whisper-cli". */
  command?: string;
  /** Output dialect. Default: RESOUND_WHISPER_FORMAT or "whisper.cpp". */
  format?: WhisperFormat;
  /** Model name/path. Default: RESOUND_WHISPER_MODEL (e.g. a ggml .bin path). */
  model?: string;
  /** Extra raw args inserted before the audio file. */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Injectable runner for testing. */
  run?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export class LocalWhisperTranscriber implements Transcriber {
  readonly provider = "local-whisper";
  readonly model: string;
  private readonly command: string;
  private readonly format: WhisperFormat;
  private readonly extraArgs: string[];
  private readonly run: NonNullable<LocalWhisperOptions["run"]>;

  constructor(opts: LocalWhisperOptions = {}) {
    const env = opts.env ?? process.env;
    this.command = opts.command ?? env.RESOUND_WHISPER_COMMAND ?? "whisper-cli";
    this.format = opts.format ?? (env.RESOUND_WHISPER_FORMAT as WhisperFormat) ?? "whisper.cpp";
    this.model = opts.model ?? env.RESOUND_WHISPER_MODEL ?? "local";
    this.extraArgs = opts.extraArgs ?? splitArgs(env.RESOUND_WHISPER_ARGS);
    this.run = opts.run ?? defaultRunner;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptSegment[]> {
    if (!input.audioPath || !fs.existsSync(input.audioPath)) {
      throw new Error(
        "LocalWhisperTranscriber requires an existing audioPath. Record the call to a file first, or use the mock provider."
      );
    }

    const speaker = input.participants?.[0]?.username ?? "Speaker";
    const userId = input.participants?.[0]?.id ?? "";

    const raw =
      this.format === "openai-whisper"
        ? await this.runOpenAiWhisper(input)
        : await this.runWhisperCpp(input);

    return raw
      .filter((s) => s.text.length > 0)
      .map((s) => ({
        ts: formatTimestamp(s.start),
        end_ts: formatTimestamp(s.end),
        speaker,
        user_id: userId,
        text: s.text,
        confidence: 0
      }));
  }

  private async runWhisperCpp(input: TranscriptionInput): Promise<RawSeg[]> {
    const outBase = path.join(os.tmpdir(), `resound-whisper-${Date.now()}`);
    const args = [
      ...(this.model && this.model !== "local" ? ["-m", this.model] : []),
      ...(input.language ? ["-l", input.language] : []),
      ...this.extraArgs,
      "-f",
      input.audioPath!,
      "-oj",
      "-of",
      outBase
    ];
    const { code, stderr } = await this.invoke(args);
    const jsonPath = `${outBase}.json`;
    if (!fs.existsSync(jsonPath)) {
      throw new Error(
        `whisper.cpp produced no JSON (exit ${code}). stderr: ${stderr.slice(0, 400)}`
      );
    }
    const parsed = parseWhisperCppJson(fs.readFileSync(jsonPath, "utf8"));
    fs.rmSync(jsonPath, { force: true });
    return parsed;
  }

  private async runOpenAiWhisper(input: TranscriptionInput): Promise<RawSeg[]> {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-whisper-"));
    const args = [
      input.audioPath!,
      "--model",
      this.model && this.model !== "local" ? this.model : "base",
      "--output_format",
      "json",
      "--output_dir",
      outDir,
      ...(input.language ? ["--language", input.language] : []),
      ...this.extraArgs
    ];
    const { code, stderr } = await this.invoke(args);
    const base = path.basename(input.audioPath!).replace(/\.[^.]+$/, "");
    const jsonPath = path.join(outDir, `${base}.json`);
    if (!fs.existsSync(jsonPath)) {
      throw new Error(
        `openai-whisper produced no JSON (exit ${code}). stderr: ${stderr.slice(0, 400)}`
      );
    }
    const parsed = parseOpenAiWhisperJson(fs.readFileSync(jsonPath, "utf8"));
    fs.rmSync(outDir, { recursive: true, force: true });
    return parsed;
  }

  private async invoke(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      return await this.run(this.command, args);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error(
          `Local Whisper binary "${this.command}" not found. Install whisper.cpp (provides ` +
            `whisper-cli) or set RESOUND_WHISPER_COMMAND to your transcription binary. ` +
            `See docs/providers.md.`
        );
      }
      throw err;
    }
  }
}

function splitArgs(s?: string): string[] {
  return s ? s.split(/\s+/).filter(Boolean) : [];
}

function defaultRunner(
  cmd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
