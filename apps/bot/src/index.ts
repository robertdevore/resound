#!/usr/bin/env node
// Load .env from the current working directory if present (no dependency).
try {
  (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env file — rely on the ambient environment */
}
import fs from "node:fs";
import {
  Client,
  Events,
  GatewayIntentBits,
  type GuildMember,
  MessageFlags,
  type ChatInputCommandInteraction
} from "discord.js";
import { sessionPaths } from "@resound/core";
import { DiscordRecorder, SystemRecorder, type Recorder } from "@resound/audio";
import { SessionManager } from "./session-manager.js";

/**
 * Resound Discord bot.
 *
 * Three modes (RESOUND_BOT_MODE):
 *  - "mock" (default): consent-aware sessions + full transcript artifacts using
 *    the mock recorder, WITHOUT joining voice. Always works.
 *  - "local-capture": slash commands control this machine's system/mic capture
 *    via ffmpeg + avfoundation. This is the reliable real-audio path today.
 *  - "discord": joins the caller's voice channel and uses the live
 *    DiscordRecorder. ⚠️ As of June 2026, Discord voice *receive* is blocked by
 *    DAVE/E2EE in @discordjs/voice, so live capture may yield no audio until
 *    upstream fixes land — see docs/providers.md. For a real transcript today,
 *    record the call and run `resound transcribe <file>`.
 */

const BOT_MODE = process.env.RESOUND_BOT_MODE ?? "mock";
const DISCORD_MODE = BOT_MODE === "discord";
const LOCAL_CAPTURE_MODE = BOT_MODE === "local-capture";

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

/**
 * In discord mode, join the caller's voice channel and build a live recorder.
 * @discordjs/voice is imported lazily (optional dependency). Any failure is
 * downgraded to a warning so the session still starts and produces a manifest.
 */
async function buildLiveRecorder(
  i: ChatInputCommandInteraction
): Promise<{ recorder?: Recorder; channelId: string; warning: string }> {
  try {
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

    const voiceMod = "@discordjs/voice";
    const { joinVoiceChannel } = (await import(voiceMod)) as {
      joinVoiceChannel: (opts: Record<string, unknown>) => { destroy(): void; receiver: unknown };
    };
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // must hear others to receive
      selfMute: true
    });
    connections.set(guild.id, connection);

    const recorder = new DiscordRecorder({
      connection: connection as never,
      resolveUsername: (id) => guild.members.cache.get(id)?.user.username ?? id
    });

    return {
      recorder,
      channelId: voiceChannel.id,
      warning:
        "\n⚠️ Live capture is experimental: Discord DAVE/E2EE currently blocks voice receive in " +
        "@discordjs/voice, so audio may be empty. If the transcript is empty, record the call and use " +
        "`resound transcribe <file>`."
    };
  } catch (err) {
    return {
      channelId: "",
      warning:
        `\n⚠️ Could not start live voice capture (${(err as Error).message}). ` +
        "Session still recorded; use `resound transcribe <file>` for a real transcript."
    };
  }
}

function buildLocalCaptureRecorder(): Recorder {
  return new SystemRecorder({
    systemDevice: process.env.RESOUND_AUDIO_SYSTEM_DEVICE,
    micDevice: process.env.RESOUND_AUDIO_MIC_DEVICE,
    device: process.env.RESOUND_AUDIO_DEVICE
  });
}

async function handle(i: ChatInputCommandInteraction): Promise<void> {
  const guildId = i.guildId ?? "dm";
  const mgr = managerFor(guildId);
  const sub = i.options.getSubcommand();
  const user = { id: i.user.id, username: i.user.username };

  try {
    switch (sub) {
      case "start": {
        const title = i.options.getString("title", true);
        let recorder: Recorder | undefined;
        let channelId = i.channelId ?? "";
        let voiceWarning = "";

        if (DISCORD_MODE) {
          const built = await buildLiveRecorder(i);
          recorder = built.recorder;
          channelId = built.channelId || channelId;
          voiceWarning = built.warning;
        } else if (LOCAL_CAPTURE_MODE) {
          recorder = buildLocalCaptureRecorder();
          voiceWarning =
            "\n🎙️ Local capture mode is recording this operator machine's configured audio devices. " +
            "Use `RESOUND_AUDIO_SYSTEM_DEVICE` / `RESOUND_AUDIO_MIC_DEVICE` or `RESOUND_AUDIO_DEVICE` to choose inputs.";
        }

        const { announce } = await mgr.start(title, { guildId, channelId, startedBy: user }, recorder);
        await reply(i, announce + voiceWarning);
        return;
      }
      case "consent":
        await reply(i, mgr.consent(user), true);
        return;
      case "pause":
        await reply(i, mgr.pause());
        return;
      case "resume":
        await reply(i, mgr.resume());
        return;
      case "status":
        await reply(i, "```\n" + mgr.status() + "\n```", true);
        return;
      case "stop": {
        await i.deferReply();
        const session = await mgr.stop();
        connections.get(guildId)?.destroy();
        connections.delete(guildId);
        await i.editReply(
          `✅ Session saved: \`${session.dir}\`\n${session.segments.length} segment(s) transcribed. ` +
            `Markdown, JSONL, VTT, SRT, summary and action items written.`
        );
        return;
      }
      case "export": {
        const format = i.options.getString("format") ?? "markdown";
        const paths = mgr.currentPaths();
        if (!paths) {
          await reply(i, "No session to export yet.", true);
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
          await reply(i, `Nothing exported yet — run \`/resound stop\` first.`, true);
          return;
        }
        await i.reply({ content: `📄 \`${file}\``, files: [file] });
        return;
      }
      default:
        await reply(i, `Unknown subcommand: ${sub}`, true);
    }
  } catch (err) {
    await reply(i, `⚠️ ${(err as Error).message}`, true);
  }
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
    await handle(interaction);
  });

  void client.login(token);
}

main();
