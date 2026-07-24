#!/usr/bin/env node
// Load .env from the current working directory if present (no dependency).
try {
  (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env file — rely on the ambient environment */
}
import fs from "node:fs";
import path from "node:path";
import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type GuildMember,
  MessageFlags,
  type ChatInputCommandInteraction
} from "discord.js";
import { sessionPaths } from "@resound/core";
import {
  DiscordRecorder,
  MockRecorder,
  PycordDiscordRecorder,
  SystemRecorder,
  type Recorder
} from "@resound/audio";
import { getTranscriber } from "@resound/transcribers";
import type { TranscriptionProgress } from "@resound/transcribers";
import { SessionManager } from "./session-manager.js";

/**
 * Resound Discord bot.
 *
 * Three modes (RESOUND_BOT_MODE):
 *  - "mock": consent-aware sessions + full transcript artifacts using
 *    the mock recorder, WITHOUT joining voice. Always works.
 *  - "local-capture": slash commands control this machine's system/mic capture
 *    via ffmpeg + avfoundation. This is the reliable real-audio path today.
 *  - "discord" (default): joins the caller's voice channel and uses the configured
 *    Discord-native receiver backend. `RESOUND_DISCORD_RECEIVER_BACKEND=auto`
 *    prefers the Pycord sidecar and falls back to the legacy
 *    `@discordjs/voice` path. Live acceptance still matters, but this is now a
 *    real backend instead of a placeholder-only path.
 */

const BOT_MODE = (process.env.RESOUND_BOT_MODE ?? "discord").trim();
const DISCORD_MODE = BOT_MODE === "discord" || BOT_MODE === "discord-native";
const LOCAL_CAPTURE_MODE = BOT_MODE === "local-capture";
const AUTO_MODE = BOT_MODE === "auto";
type DiscordReceiverBackend = "auto" | "pycord" | "discordjs";
const DISCORD_RECEIVER_BACKEND = (
  process.env.RESOUND_DISCORD_RECEIVER_BACKEND ?? "pycord"
).trim() as DiscordReceiverBackend;

// Live voice connections per guild, so we can leave on stop.
const connections = new Map<string, { destroy(): void }>();

// One active session per guild.
const managers = new Map<string, SessionManager>();
function managerFor(guildId: string): SessionManager {
  let m = managers.get(guildId);
  if (!m) {
    m = new SessionManager();
    managers.set(guildId, m);
  }
  return m;
}

async function reply(i: ChatInputCommandInteraction, content: string, ephemeral = false) {
  if (i.deferred) {
    await i.editReply(content);
    return;
  }
  if (i.replied) {
    await i.followUp(ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content });
    return;
  }
  await i.reply(ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content });
}

async function safeReply(i: ChatInputCommandInteraction, content: string, ephemeral = false): Promise<void> {
  try {
    await reply(i, content, ephemeral);
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 10062) {
      console.warn("Discarded late interaction reply:", content);
      return;
    }
    throw err;
  }
}

async function ensureDeferred(i: ChatInputCommandInteraction, ephemeral = false): Promise<void> {
  if (i.deferred || i.replied) return;
  await i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);
}

/**
 * In discord mode, join the caller's voice channel and build a live recorder.
 * @discordjs/voice is imported lazily (optional dependency). Any failure is
 * downgraded to a warning so the session still starts and produces a manifest.
 */
async function buildLiveRecorder(
  i: ChatInputCommandInteraction
): Promise<{ recorder?: Recorder; channelId: string; warning: string }> {
  const member = i.member as GuildMember | null;
  const voiceChannel = member?.voice?.channel;
  const guild = i.guild;
  if (!voiceChannel || !guild) {
    return {
      channelId: "",
      warning:
        "\n⚠️ You are not in a voice channel, so nothing is being captured. Join voice and `/resound start` again."
    };
  }

  const backends: Exclude<DiscordReceiverBackend, "auto">[] =
    DISCORD_RECEIVER_BACKEND === "auto" ? ["pycord", "discordjs"] : [DISCORD_RECEIVER_BACKEND];
  const failures: string[] = [];

  for (const backend of backends) {
    try {
      if (backend === "pycord") {
        return {
          recorder: new PycordDiscordRecorder({
            token: process.env.DISCORD_TOKEN ?? "",
            guildId: guild.id,
            channelId: voiceChannel.id,
            pythonPath: process.env.RESOUND_DISCORD_PYTHON,
            pythonPathEntries: process.env.RESOUND_DISCORD_PYTHONPATH
              ?.split(path.delimiter)
              .filter(Boolean)
          }),
          channelId: voiceChannel.id,
          warning:
            "\n🎙️ Discord-native capture is using the Pycord sidecar receiver. " +
            "Run `/resound doctor` and a real voice-channel smoke test before treating it as production-ready."
        };
      }

      const voiceMod = "@discordjs/voice";
      const { joinVoiceChannel } = (await import(voiceMod)) as {
        joinVoiceChannel: (opts: Record<string, unknown>) => { destroy(): void; receiver: unknown };
      };
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true
      });
      connections.set(guild.id, connection);

      return {
        recorder: new DiscordRecorder({
          connection: connection as never,
          resolveUsername: (id) => guild.members.cache.get(id)?.user.username ?? id
        }),
        channelId: voiceChannel.id,
        warning:
          "\n⚠️ Discord-native capture is using the legacy @discordjs/voice backend. " +
          "DAVE/E2EE can still leave this path empty; prefer the Pycord backend unless you are intentionally comparing stacks."
      };
    } catch (err) {
      failures.push(`${backend}: ${(err as Error).message}`);
    }
  }

  return {
    channelId: "",
    warning:
      "\n⚠️ Could not start live voice capture (" +
      failures.join("; ") +
      "). Session still recorded; use `resound transcribe <file>` for a real transcript."
  };
}

function buildLocalCaptureRecorder(): Recorder {
  return new SystemRecorder({
    systemDevice: process.env.RESOUND_AUDIO_SYSTEM_DEVICE,
    micDevice: process.env.RESOUND_AUDIO_MIC_DEVICE,
    device: process.env.RESOUND_AUDIO_DEVICE
  });
}

function buildMockRecorder(): Recorder {
  return new MockRecorder();
}

async function selectRecorder(
  i: ChatInputCommandInteraction
): Promise<{ recorder: Recorder; channelId: string; warning: string }> {
  if (DISCORD_MODE) {
    const built = await buildLiveRecorder(i);
    if (built.recorder) {
      return { recorder: built.recorder, channelId: built.channelId || i.channelId, warning: built.warning };
    }
    throw new Error(built.warning.replace(/^\n/, ""));
  }

  if (LOCAL_CAPTURE_MODE) {
    return {
      recorder: buildLocalCaptureRecorder(),
      channelId: i.channelId,
      warning:
        "\n🎙️ Local capture mode is recording this operator machine's configured audio devices. " +
        "Use `RESOUND_AUDIO_SYSTEM_DEVICE` / `RESOUND_AUDIO_MIC_DEVICE` or `RESOUND_AUDIO_DEVICE` to choose inputs."
    };
  }

  if (AUTO_MODE) {
    const discord = await buildLiveRecorder(i);
    if (discord.recorder && (await discord.recorder.preflight?.({ sessionDir: ".", outputDir: process.cwd() }))?.status !== "fail") {
      return { recorder: discord.recorder, channelId: discord.channelId || i.channelId, warning: discord.warning };
    }
    const local = buildLocalCaptureRecorder();
    const localPreflight = await local.preflight?.({ sessionDir: ".", outputDir: process.cwd() });
    if (localPreflight?.status !== "fail") {
      return {
        recorder: local,
        channelId: i.channelId,
        warning:
          "\n⚠️ Auto mode fell back to local-capture after Discord-native preflight did not pass."
      };
    }
    throw new Error(
      "Auto mode could not verify Discord-native or local-capture. Recording did not start."
    );
  }

  return { recorder: buildMockRecorder(), channelId: i.channelId, warning: "" };
}

async function doctorSummary(i: ChatInputCommandInteraction): Promise<string> {
  const recorderSelection = await selectRecorder(i);
  const recorderResult = await recorderSelection.recorder.preflight?.({
    sessionDir: ".",
    outputDir: process.cwd()
  });
  const transcriber = getTranscriber({
    env: BOT_MODE === "mock" ? { ...process.env, RESOUND_TRANSCRIBER: "mock" } as NodeJS.ProcessEnv : process.env
  });
  const transcriberResult = await transcriber.preflight?.();
  return [
    `Requested mode: ${BOT_MODE}`,
    `Selected recorder: ${recorderSelection.recorder.mode}`,
    recorderResult
      ? `Recorder: ${recorderResult.status.toUpperCase()} — ${recorderResult.summary}`
      : "Recorder: no preflight available",
    ...(recorderResult?.warnings ?? []).map((line: string) => `  warn: ${line}`),
    ...(recorderResult?.errors ?? []).map((line: string) => `  err: ${line}`),
    transcriberResult
      ? `Transcriber: ${transcriberResult.status.toUpperCase()} — ${transcriberResult.provider} ${transcriberResult.model}`
      : "Transcriber: no preflight available",
    ...(transcriberResult?.warnings ?? []).map((line: string) => `  warn: ${line}`),
    ...(transcriberResult?.errors ?? []).map((line: string) => `  err: ${line}`)
  ].join("\n");
}

async function handle(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = i.guildId ?? "dm";
  const mgr = managerFor(guildId);
  const sub = i.options.getSubcommand();
  const user = { id: i.user.id, username: i.user.username };

  try {
    if (sub === "doctor" || sub === "start" || sub === "stop" || sub === "export") {
      await ensureDeferred(i, sub === "doctor");
    }

    switch (sub) {
      case "doctor":
        await safeReply(i, "```\n" + (await doctorSummary(i)) + "\n```", true);
        return;
      case "start": {
        const title = i.options.getString("title")?.trim() || "Discord Meeting";
        const selection = await selectRecorder(i);
        const { announce } = await mgr.start(
          title,
          { guildId, channelId: selection.channelId ?? i.channelId, startedBy: user },
          selection.recorder
        );
        await safeReply(i, announce + selection.warning);
        return;
      }
      case "consent":
        await safeReply(i, mgr.consent(user), true);
        return;
      case "pause":
        await safeReply(i, await mgr.pause());
        return;
      case "resume":
        await safeReply(i, await mgr.resume());
        return;
      case "status":
        await safeReply(i, "```\n" + mgr.status() + "\n```", true);
        return;
      case "stop": {
        let session;
        const transcriptionStartedAt = Date.now();
        let latestProgress: TranscriptionProgress | undefined;
        let updateInFlight = false;
        let updateQueued = false;
        const publishProgress = async (): Promise<void> => {
          if (updateInFlight) {
            updateQueued = true;
            return;
          }
          updateInFlight = true;
          try {
            const elapsedSeconds = Math.max(1, (Date.now() - transcriptionStartedAt) / 1000);
            const progress = latestProgress;
            const completed = progress?.completedTracks ?? 0;
            const total = progress?.trackCount ?? 0;
            const audioCompleted = progress?.completedDurationSeconds ?? 0;
            const audioTotal = progress?.totalDurationSeconds ?? 0;
            const rate = audioCompleted > 0 ? audioCompleted / elapsedSeconds : 0;
            const remainingSeconds = rate > 0 ? Math.max(0, (audioTotal - audioCompleted) / rate) : undefined;
            await i.editReply({
              content: [
                "⏳ **Transcription in progress**",
                progress?.phase === "track-started"
                  ? `Currently transcribing: **${progress.trackLabel}**`
                  : "Preparing the next speaker track...",
                total > 0 ? `Speaker tracks: ${completed}/${total} complete` : "Speaker tracks: preparing",
                audioTotal > 0 ? `Audio analyzed: ${formatDuration(audioCompleted)} / ${formatDuration(audioTotal)}` : "Audio analyzed: calculating",
                `Elapsed: ${formatDuration(elapsedSeconds)}`,
                remainingSeconds === undefined
                  ? "Estimated remaining: calculating from the first completed track"
                  : `Estimated remaining: ${formatDuration(remainingSeconds)}`
              ].join("\n")
            });
          } catch (err) {
            console.warn("Could not publish transcription progress:", (err as Error).message);
          } finally {
            updateInFlight = false;
            if (updateQueued) {
              updateQueued = false;
              void publishProgress();
            }
          }
        };
        const progressTimer = setInterval(() => void publishProgress(), 120_000);
        try {
          await i.editReply("⏳ Audio capture finalized. Starting local transcription...");
          session = await mgr.stop((progress) => {
            latestProgress = progress;
            if (progress.phase === "track-completed") void publishProgress();
          });
        } finally {
          clearInterval(progressTimer);
          connections.get(guildId)?.destroy();
          connections.delete(guildId);
        }
        const captureReport = mgr.captureReport();
        const transcriptStatus = session.segments.length > 0
          ? `${session.segments.length} segment(s) transcribed.`
          : "⚠️ No speech was transcribed. Check the capture report and audio routing before the next meeting.";
        await i.editReply({
          content: [
            `✅ Session saved: \`${session.dir}\``,
            transcriptStatus,
            ...captureReport,
            "The Markdown transcript is attached; JSONL, VTT, SRT, summary and action items were also written."
          ].join("\n"),
          files: [sessionPaths(session.dir, session.manifest).markdown]
        });
        return;
      }
      case "export": {
        const format = i.options.getString("format") ?? "markdown";
        const paths = mgr.currentPaths();
        if (!paths) {
          await safeReply(i, "No session to export yet.", true);
          return;
        }
        const file =
          format === "jsonl"
            ? paths.jsonl
            : format === "vtt"
              ? paths.vtt
              : format === "srt"
                ? paths.srt
                : paths.markdown;
        if (!fs.existsSync(file)) {
          await safeReply(i, `Nothing exported yet — run \`/resound stop\` first.`, true);
          return;
        }
        if (i.deferred) {
          await i.editReply({ content: `📄 \`${file}\``, files: [file] });
        } else {
          await i.reply({ content: `📄 \`${file}\``, files: [file] });
        }
        return;
      }
      default:
        await safeReply(i, `Unknown subcommand: ${sub}`, true);
    }
  } catch (err) {
    await safeReply(i, `⚠️ ${(err as Error).message}`, true);
  }
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function main(): void {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error(
      "DISCORD_TOKEN is not set. Set it in .env, then `pnpm --filter @resound/bot register` and `start`."
    );
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`Resound bot ready as ${c.user.tag} (mode=${BOT_MODE})`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "resound") return;
    try {
      await handle(interaction);
    } catch (err) {
      console.error("Unhandled resound interaction error:", err);
    }
  });

  void client.login(token);
}

main();
