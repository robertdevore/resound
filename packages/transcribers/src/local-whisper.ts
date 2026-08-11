import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { formatTimestamp, type TranscriptSegment } from "@resound/core";
import type {
  Transcriber,
  TranscriptionInput,
  TranscriberCapabilities,
  TranscriberPreflightResult,
  TranscriptionProgress
} from "./types.js";
import {
  defaultSpeaker,
  mapRawSegmentsToSpeakerSegments,
  mergeTranscriptSegments,
  selectEffectiveTracks,
  type RawSegment
} from "./tracks.js";

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

/** Parse whisper.cpp full JSON (offsets are milliseconds). */
export function parseWhisperCppJson(json: string): RawSegment[] {
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
export function parseOpenAiWhisperJson(json: string): RawSegment[] {
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
  readonly capabilities: TranscriberCapabilities = {
    local: true,
    remote: false,
    segmentTimestamps: true,
    speakerAware: true,
    wordTimestamps: false,
    contextualPrompting: false,
    confidence: false,
    retrySafe: true,
    privacy: "local-only"
  };
  private readonly command: string;
  private readonly format: WhisperFormat;
  private readonly extraArgs: string[];
  private readonly defaultThreads: string;
  private readonly run: NonNullable<LocalWhisperOptions["run"]>;

  constructor(opts: LocalWhisperOptions = {}) {
    const env = opts.env ?? process.env;
    this.command = opts.command ?? env.RESOUND_WHISPER_COMMAND ?? "whisper-cli";
    this.format = opts.format ?? (env.RESOUND_WHISPER_FORMAT as WhisperFormat) ?? "whisper.cpp";
    this.model = opts.model ?? env.RESOUND_WHISPER_MODEL ?? "local";
    this.extraArgs = opts.extraArgs ?? splitArgs(env.RESOUND_WHISPER_ARGS);
    this.defaultThreads = env.RESOUND_WHISPER_THREADS ?? String(Math.min(8, Math.max(2, os.cpus().length - 2)));
    this.run = opts.run ?? defaultRunner;
  }

  async preflight(): Promise<TranscriberPreflightResult> {
    try {
      const result = await this.invoke(["--help"]);
      if (result.code !== 0) {
        throw new Error(
          `Local Whisper binary "${this.command}" exited ${result.code}: ${result.stderr.slice(0, 400)}`
        );
      }
    } catch (err) {
      return {
        status: "fail",
        provider: this.provider,
        model: this.model,
        summary: "Local Whisper preflight failed.",
        warnings: [],
        errors: [(err as Error).message],
        remediation: [
          "Install whisper.cpp or configure RESOUND_WHISPER_COMMAND to a working local transcription binary."
        ]
      };
    }

    const warnings: string[] = [];
    const errors: string[] = [];
    if (!this.model || this.model === "local") {
      warnings.push("No explicit local Whisper model configured; runtime defaults will be used.");
    } else if (!fs.existsSync(this.model)) {
      warnings.push(`Configured model path does not exist on disk: ${this.model}`);
    }

    return {
      status: errors.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass",
      provider: this.provider,
      model: this.model,
      summary:
        warnings.length > 0
          ? "Local Whisper preflight passed with warnings."
          : "Local Whisper preflight passed.",
      warnings,
      errors,
      remediation: warnings.length > 0
        ? ["Set RESOUND_WHISPER_MODEL to an explicit local model path before production recording."]
        : []
    };
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptSegment[]> {
    const tracks = selectEffectiveTracks(input);
    const singlePath = input.audioPath && fs.existsSync(input.audioPath) ? input.audioPath : undefined;
    if (!singlePath && tracks.length === 0) {
      throw new Error(
        "LocalWhisperTranscriber requires an existing audioPath. Record the call to a file first, or use the mock provider."
      );
    }

    if (tracks.length > 0) {
      const startedAt = Date.now();
      const totalDurationSeconds = tracks.reduce((sum, track) => sum + track.durationSeconds, 0);
      let completedTracks = 0;
      let completedDurationSeconds = 0;
      const perTrack: ReturnType<typeof mapRawSegmentsToSpeakerSegments>[] = [];
      for (const [trackIndex, track] of tracks.entries()) {
        emitProgress(input.onProgress, {
          phase: "track-started",
          trackIndex,
          trackCount: tracks.length,
          trackLabel: track.resolvedUsername,
          completedTracks,
          completedDurationSeconds,
          totalDurationSeconds,
          elapsedMs: Date.now() - startedAt
        });
        const raw = await this.transcribeRaw({ ...input, audioPath: track.path });
        perTrack.push(
          mapRawSegmentsToSpeakerSegments(raw, {
            userId: track.userId,
            username: track.resolvedUsername,
            startSeconds: track.startSeconds
          })
        );
        completedTracks += 1;
        completedDurationSeconds += track.durationSeconds;
        emitProgress(input.onProgress, {
          phase: "track-completed",
          trackIndex,
          trackCount: tracks.length,
          trackLabel: track.resolvedUsername,
          completedTracks,
          completedDurationSeconds,
          totalDurationSeconds,
          elapsedMs: Date.now() - startedAt
        });
      }
      return mergeTranscriptSegments(perTrack.flat());
    }

    const speaker = defaultSpeaker(input);
    return mapRawSegmentsToSpeakerSegments(await this.transcribeRaw({ ...input, audioPath: singlePath }), speaker);
  }

  private async transcribeRaw(input: TranscriptionInput): Promise<RawSegment[]> {
    return this.format === "openai-whisper"
      ? this.runOpenAiWhisper(input)
      : this.runWhisperCpp(input);
  }

  private async runWhisperCpp(input: TranscriptionInput): Promise<RawSegment[]> {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-whisper-"));
    const outBase = path.join(outDir, "transcript");
    const args = [
      ...(this.model && this.model !== "local" ? ["-m", this.model] : []),
      ...(input.language ? ["-l", input.language] : []),
      ...(hasThreadArg(this.extraArgs) ? [] : ["-t", this.defaultThreads]),
      ...this.extraArgs,
      "-f",
      input.audioPath!,
      "-oj",
      "-of",
      outBase
    ];
    try {
      const { code, stderr } = await this.invoke(args);
      if (code !== 0) {
        throw new Error(`whisper.cpp exited ${code}. stderr: ${stderr.slice(0, 400)}`);
      }
      const jsonPath = `${outBase}.json`;
      if (!fs.existsSync(jsonPath)) {
        throw new Error(`whisper.cpp produced no JSON. stderr: ${stderr.slice(0, 400)}`);
      }
      return parseWhisperCppJson(fs.readFileSync(jsonPath, "utf8"));
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }

  private async runOpenAiWhisper(input: TranscriptionInput): Promise<RawSegment[]> {
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
    try {
      const { code, stderr } = await this.invoke(args);
      if (code !== 0) {
        throw new Error(`openai-whisper exited ${code}. stderr: ${stderr.slice(0, 400)}`);
      }
      const base = path.basename(input.audioPath!).replace(/\.[^.]+$/, "");
      const jsonPath = path.join(outDir, `${base}.json`);
      if (!fs.existsSync(jsonPath)) {
        throw new Error(`openai-whisper produced no JSON. stderr: ${stderr.slice(0, 400)}`);
      }
      return parseOpenAiWhisperJson(fs.readFileSync(jsonPath, "utf8"));
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
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

function hasThreadArg(args: string[]): boolean {
  return args.some((arg) => arg === "-t" || arg === "--threads");
}

function emitProgress(
  callback: TranscriptionInput["onProgress"],
  progress: TranscriptionProgress
): void {
  callback?.(progress);
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
