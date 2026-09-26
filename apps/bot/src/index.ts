#!/usr/bin/env node
process.umask(0o077);
// Load .env from the current working directory if present (no dependency).
try {
  (
    process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }
  ).loadEnvFile?.();
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
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import { sessionPaths } from "@resound/core";
import {
  DiscordRecorder,
  MockRecorder,
  PycordDiscordRecorder,
  SystemRecorder,
  type Recorder,
} from "@resound/audio";
import { getTranscriber } from "@resound/transcribers";
import type { TranscriptionProgress } from "@resound/transcribers";
import { SessionManager } from "./session-manager.js";
import { GuildOperations } from "./operations.js";
import {
  authorizeSubcommand,
  transcriptDelivery,
  voiceLifecycleChanges,
  type OperatorSubject,
} from "./policy.js";

/**
 * Resound Discord bot.
 *
 * Three modes (RESOUND_BOT_MODE):
 *  - "mock": consent-aware sessions + full transcript artifacts using
 *    the mock recorder, WITHOUT joining voice. Always works.
 *  - "local-capture": slash commands control this machine's system/mic capture
 *    via ffmpeg + avfoundation.
 *  - "discord": joins the caller's voice channel. The supported production
 *    receiver is the DAVE-aware Pycord sidecar.
 */

const BOT_MODE = (process.env.RESOUND_BOT_MODE ?? "mock").trim();
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
const operations = new GuildOperations();
function managerFor(guildId: string): SessionManager {
  let m = managers.get(guildId);
  if (!m) {
    m = new SessionManager();
    m.restoreLatestForGuild(guildId);
    managers.set(guildId, m);
  }
  return m;
}

function operatorSubject(i: ChatInputCommandInteraction): OperatorSubject {
  const member = i.member as GuildMember | null;
  return {
    userId: i.user.id,
    hasManageGuild:
      i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    roleIds: member ? [...member.roles.cache.keys()] : [],
  };
}

async function reply(
  i: ChatInputCommandInteraction,
  content: string,
  ephemeral = false,
) {
  if (i.deferred) {
    await i.editReply(content);
    return;
  }
  if (i.replied) {
    await i.followUp(
      ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content },
    );
    return;
  }
  await i.reply(
    ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content },
  );
}

async function safeReply(
  i: ChatInputCommandInteraction,
  content: string,
  ephemeral = false,
): Promise<void> {
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

async function safePrivateError(
  i: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  try {
    if (i.deferred && !i.replied) {
      await i.editReply(
        "⚠️ The command did not complete. Error details were sent privately.",
      );
      await i.followUp({ content, flags: MessageFlags.Ephemeral });
    } else if (i.replied) {
      await i.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await i.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 10062) return;
    throw err;
  }
}

async function deliverTranscript(
  i: ChatInputCommandInteraction,
  file: string,
  label = "Transcript",
): Promise<void> {
  const delivery = transcriptDelivery();
  if (delivery === "disabled") {
    await i.followUp({
      content: `${label} delivery is disabled; artifacts remain on the bot host.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await i.followUp({
    content: `📄 ${label}`,
    files: [file],
    ...(delivery === "ephemeral" ? { flags: MessageFlags.Ephemeral } : {}),
  });
}

async function ensureDeferred(
  i: ChatInputCommandInteraction,
  ephemeral = false,
): Promise<void> {
  if (i.deferred || i.replied) return;
  await i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);
}

/**
 * In discord mode, join the caller's voice channel and build a live recorder.
 */
async function buildLiveRecorder(
  i: ChatInputCommandInteraction,
): Promise<{ recorder?: Recorder; channelId: string; warning: string }> {
  const member = i.member as GuildMember | null;
  const voiceChannel = member?.voice?.channel;
  const guild = i.guild;
  if (!voiceChannel || !guild) {
    return {
      channelId: "",
      warning:
        "\n⚠️ You are not in a voice channel, so nothing is being captured. Join voice and `/resound start` again.",
    };
  }

  const backends: Exclude<DiscordReceiverBackend, "auto">[] =
    DISCORD_RECEIVER_BACKEND === "auto"
      ? ["pycord", "discordjs"]
      : [DISCORD_RECEIVER_BACKEND];
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
            pythonPathEntries: process.env.RESOUND_DISCORD_PYTHONPATH?.split(
              path.delimiter,
            ).filter(Boolean),
          }),
          channelId: voiceChannel.id,
          warning:
            "\n🎙️ Discord-native capture is active through the DAVE-aware Pycord receiver.",
        };
      }

      const voiceMod = "@discordjs/voice";
      const { joinVoiceChannel } = (await import(voiceMod)) as {
        joinVoiceChannel: (opts: Record<string, unknown>) => {
          destroy(): void;
          receiver: unknown;
        };
      };
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      connections.set(guild.id, connection);

      return {
        recorder: new DiscordRecorder({
          connection: connection as never,
          resolveUsername: (id) =>
            guild.members.cache.get(id)?.user.username ?? id,
        }),
        channelId: voiceChannel.id,
        warning:
          "\n⚠️ Discord-native capture is using the legacy @discordjs/voice backend. " +
          "DAVE/E2EE can still leave this path empty; prefer the Pycord backend unless you are intentionally comparing stacks.",
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
      "). Session still recorded; use `resound transcribe <file>` for a real transcript.",
  };
}

function buildLocalCaptureRecorder(): Recorder {
  return new SystemRecorder({
    systemDevice: process.env.RESOUND_AUDIO_SYSTEM_DEVICE,
    micDevice: process.env.RESOUND_AUDIO_MIC_DEVICE,
    device: process.env.RESOUND_AUDIO_DEVICE,
  });
}

function buildMockRecorder(): Recorder {
  return new MockRecorder();
}

async function selectRecorder(
  i: ChatInputCommandInteraction,
): Promise<{ recorder: Recorder; channelId: string; warning: string }> {
  if (DISCORD_MODE) {
    const built = await buildLiveRecorder(i);
    if (built.recorder) {
      return {
        recorder: built.recorder,
        channelId: built.channelId || i.channelId,
        warning: built.warning,
      };
    }
    throw new Error(built.warning.replace(/^\n/, ""));
  }

  if (LOCAL_CAPTURE_MODE) {
    return {
      recorder: buildLocalCaptureRecorder(),
      channelId: i.channelId,
      warning:
        "\n🎙️ Local capture mode is recording this operator machine's configured audio devices. " +
        "Use `RESOUND_AUDIO_SYSTEM_DEVICE` / `RESOUND_AUDIO_MIC_DEVICE` or `RESOUND_AUDIO_DEVICE` to choose inputs.",
    };
  }

  if (AUTO_MODE) {
    const discord = await buildLiveRecorder(i);
    if (
      discord.recorder &&
      (
        await discord.recorder.preflight?.({
          sessionDir: ".",
          outputDir: process.cwd(),
        })
      )?.status !== "fail"
    ) {
      return {
        recorder: discord.recorder,
        channelId: discord.channelId || i.channelId,
        warning: discord.warning,
      };
    }
    const local = buildLocalCaptureRecorder();
    const localPreflight = await local.preflight?.({
      sessionDir: ".",
      outputDir: process.cwd(),
    });
    if (localPreflight?.status !== "fail") {
      return {
        recorder: local,
        channelId: i.channelId,
        warning:
          "\n⚠️ Auto mode fell back to local-capture after Discord-native preflight did not pass.",
      };
    }
    throw new Error(
      "Auto mode could not verify Discord-native or local-capture. Recording did not start.",
    );
  }

  return { recorder: buildMockRecorder(), channelId: i.channelId, warning: "" };
}

async function doctorSummary(i: ChatInputCommandInteraction): Promise<string> {
  const recorderSelection = await selectRecorder(i);
  const recorderResult = await recorderSelection.recorder.preflight?.({
    sessionDir: ".",
    outputDir: process.cwd(),
  });
  const transcriber = getTranscriber({
    env:
      BOT_MODE === "mock"
        ? ({ ...process.env, RESOUND_TRANSCRIBER: "mock" } as NodeJS.ProcessEnv)
        : process.env,
  });
  const transcriberResult = await transcriber.preflight?.();
  return [
    `Requested mode: ${BOT_MODE}`,
    `Selected recorder: ${recorderSelection.recorder.mode}`,
    recorderResult
      ? `Recorder: ${recorderResult.status.toUpperCase()} — ${recorderResult.summary}`
      : "Recorder: no preflight available",
    ...(recorderResult?.warnings ?? []).map(
      (line: string) => `  warn: ${line}`,
    ),
    ...(recorderResult?.errors ?? []).map((line: string) => `  err: ${line}`),
    transcriberResult
      ? `Transcriber: ${transcriberResult.status.toUpperCase()} — ${transcriberResult.provider} ${transcriberResult.model}`
      : "Transcriber: no preflight available",
    ...(transcriberResult?.warnings ?? []).map(
      (line: string) => `  warn: ${line}`,
    ),
    ...(transcriberResult?.errors ?? []).map(
      (line: string) => `  err: ${line}`,
    ),
  ].join("\n");
}

async function handle(i: ChatInputCommandInteraction): Promise<void> {
  if (!i.inGuild() || !i.guildId) {
    await safePrivateError(
      i,
      "⚠️ ReSound commands are only available inside a Discord server.",
    );
    return;
  }
  const guildId = i.guildId;
  const mgr = managerFor(guildId);
  const sub = i.options.getSubcommand();
  const user = { id: i.user.id, username: i.user.username };
  const subject = operatorSubject(i);

  let release: (() => void) | undefined;
  try {
    if (
      [
        "doctor",
        "start",
        "stop",
        "pause",
        "resume",
        "recover",
        "export",
      ].includes(sub)
    ) {
      release = operations.acquire(guildId);
    }
    const authorization = authorizeSubcommand(sub, subject, mgr.ownerId);
    if (authorization.reason === "operator-required") {
      await safePrivateError(
        i,
        "⚠️ This command requires Manage Server or a configured ReSound operator role/user.",
      );
      return;
    }
    if (authorization.reason === "controller-required") {
      await safePrivateError(
        i,
        "⚠️ Only the session owner or a configured ReSound operator can control or export this session.",
      );
      return;
    }

    if (["doctor", "start", "stop", "export", "recover"].includes(sub)) {
      await ensureDeferred(
        i,
        sub === "doctor" || sub === "export" || sub === "recover",
      );
    }

    switch (sub) {
      case "doctor":
        await safeReply(i, "```\n" + (await doctorSummary(i)) + "\n```", true);
        return;
      case "start": {
        if (mgr.active)
          throw new Error(
            "A session is already in progress. Use /resound stop first.",
          );
        const title = i.options.getString("title")?.trim() || "Discord Meeting";
        const selection = await selectRecorder(i);
        const member = i.member as GuildMember;
        const voiceChannel = member.voice.channel;
        const initialParticipants = voiceChannel
          ? [...voiceChannel.members.values()]
              .filter((voiceMember) => !voiceMember.user.bot)
              .map((voiceMember) => ({
                id: voiceMember.id,
                username: voiceMember.user.username,
              }))
          : [user];
        // A failed public announcement must prevent recording from starting.
        await i.editReply(
          "🔴 Recording and transcription are about to begin. Participants should leave the voice channel if they do not consent.",
        );
        const { announce } = await mgr.start(
          title,
          {
            guildId,
            channelId: i.channelId,
            voiceChannelId: voiceChannel?.id,
            startedBy: user,
            initialParticipants,
          },
          selection.recorder,
        );
        await safeReply(i, announce + selection.warning);
        return;
      }
      case "consent": {
        const member = i.member as GuildMember;
        if (
          mgr.voiceChannelId &&
          member.voice.channelId !== mgr.voiceChannelId
        ) {
          await safePrivateError(
            i,
            "⚠️ Join the recorded voice channel before recording your consent.",
          );
          return;
        }
        await safeReply(i, mgr.consent(user), true);
        return;
      }
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
            const elapsedSeconds = Math.max(
              1,
              (Date.now() - transcriptionStartedAt) / 1000,
            );
            const progress = latestProgress;
            const completed = progress?.completedTracks ?? 0;
            const total = progress?.trackCount ?? 0;
            const audioCompleted = progress?.completedDurationSeconds ?? 0;
            const audioTotal = progress?.totalDurationSeconds ?? 0;
            const rate =
              audioCompleted > 0 ? audioCompleted / elapsedSeconds : 0;
            const remainingSeconds =
              rate > 0
                ? Math.max(0, (audioTotal - audioCompleted) / rate)
                : undefined;
            await i.editReply({
              content: [
                "⏳ **Transcription in progress**",
                progress?.phase === "track-started"
                  ? `Currently transcribing: **${progress.trackLabel}**`
                  : "Preparing the next speaker track...",
                total > 0
                  ? `Speaker tracks: ${completed}/${total} complete`
                  : "Speaker tracks: preparing",
                audioTotal > 0
                  ? `Audio analyzed: ${formatDuration(audioCompleted)} / ${formatDuration(audioTotal)}`
                  : "Audio analyzed: calculating",
                `Elapsed: ${formatDuration(elapsedSeconds)}`,
                remainingSeconds === undefined
                  ? "Estimated remaining: calculating from the first completed track"
                  : `Estimated remaining: ${formatDuration(remainingSeconds)}`,
              ].join("\n"),
            });
          } catch (err) {
            console.warn(
              "Could not publish transcription progress:",
              (err as Error).message,
            );
          } finally {
            updateInFlight = false;
            if (updateQueued) {
              updateQueued = false;
              void publishProgress();
            }
          }
        };
        const progressTimer = setInterval(
          () => void publishProgress(),
          120_000,
        );
        try {
          await i.editReply(
            "⏳ Audio capture finalized. Starting local transcription...",
          );
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
        const transcriptStatus =
          session.segments.length > 0
            ? `${session.segments.length} segment(s) transcribed.`
            : "⚠️ No speech was transcribed. Check the capture report and audio routing before the next meeting.";
        await i.editReply({
          content: [
            "✅ Recording stopped and the session was saved on the bot host.",
            transcriptStatus,
            ...captureReport,
            "JSONL, Markdown, VTT, SRT, summary, and action-item artifacts were written.",
          ].join("\n"),
        });
        await deliverTranscript(
          i,
          sessionPaths(session.dir, session.manifest).markdown,
          "Markdown transcript",
        );
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
          await safeReply(
            i,
            mgr.canRecover
              ? "This session is interrupted. Run `/resound recover` before exporting."
              : "Nothing exported yet — run `/resound stop` first.",
            true,
          );
          return;
        }
        await i.editReply("✅ Export prepared.");
        await deliverTranscript(i, file, `${format.toUpperCase()} export`);
        return;
      }
      case "recover": {
        await i.editReply(
          "⏳ Recovering the interrupted session from finalized audio...",
        );
        const session = await mgr.recover();
        await i.editReply(
          `✅ Recovery completed with ${session.segments.length} transcript segment(s).`,
        );
        await deliverTranscript(
          i,
          sessionPaths(session.dir, session.manifest).markdown,
          "Recovered Markdown transcript",
        );
        return;
      }
      default:
        await safeReply(i, `Unknown subcommand: ${sub}`, true);
    }
  } catch (err) {
    await safePrivateError(i, `⚠️ ${(err as Error).message}`);
  } finally {
    release?.();
  }
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

async function sendLifecycleAnnouncement(
  client: Client,
  channelId: string | undefined,
  message: string,
): Promise<void> {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    const send = (
      channel as { send?: (content: string) => Promise<unknown> } | null
    )?.send;
    if (send) await send.call(channel, message);
  } catch (error) {
    console.warn(
      "Could not publish recording lifecycle announcement:",
      (error as Error).message,
    );
  }
}

function main(): void {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error(
      "DISCORD_TOKEN is not set. Set it in .env, then `pnpm --filter @resound/bot register` and `start`.",
    );
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.once(Events.ClientReady, (c) => {
    for (const guildId of c.guilds.cache.keys()) managerFor(guildId);
    console.log(`Resound bot ready as ${c.user.tag} (mode=${BOT_MODE})`);
  });

  client.on(Events.VoiceStateUpdate, async (before, after) => {
    const guildId = after.guild.id;
    const mgr = managers.get(guildId);
    const recordedChannelId = mgr?.voiceChannelId;
    const member = after.member ?? before.member;
    if (!mgr?.active || !recordedChannelId || !member) return;
    const changes = voiceLifecycleChanges(
      {
        channelId: before.channelId,
        userId: member.id,
        username: member.user.username,
        bot: member.user.bot,
      },
      {
        channelId: after.channelId,
        userId: member.id,
        username: member.user.username,
        bot: member.user.bot,
      },
      recordedChannelId,
    );
    for (const change of changes) {
      const message =
        change.type === "joined"
          ? mgr.participantJoined({
              id: change.userId,
              username: change.username,
            })
          : mgr.participantLeft(change.userId);
      if (message)
        await sendLifecycleAnnouncement(client, mgr.controlChannelId, message);
    }
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

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => {
      console.error(
        "Graceful shutdown deadline exceeded; forcing process exit.",
      );
      process.exit(1);
    }, 25_000);
    deadline.unref();
    console.log(`Received ${signal}; finalizing active audio before shutdown.`);
    await Promise.allSettled(
      [...managers.values()].map((manager) => manager.interruptForShutdown()),
    );
    for (const connection of connections.values()) connection.destroy();
    connections.clear();
    client.destroy();
    clearTimeout(deadline);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  void client.login(token).catch((error) => {
    console.error("Discord login failed:", error);
    process.exitCode = 1;
  });
}

main();
