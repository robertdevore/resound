import { SlashCommandBuilder } from "discord.js";

/**
 * The `/resound` slash command and its subcommands. Kept in its own module so
 * it can be imported by both the gateway client and the registration script.
 */
export const resoundCommand = new SlashCommandBuilder()
  .setName("resound")
  .setDescription("Resound voice transcription")
  .addSubcommand((s) =>
    s
      .setName("start")
      .setDescription("Start a recording/transcription session")
      .addStringOption((o) =>
        o.setName("title").setDescription("Session title").setRequired(true)
      )
  )
  .addSubcommand((s) => s.setName("stop").setDescription("Stop and finalize the session"))
  .addSubcommand((s) => s.setName("pause").setDescription("Pause recording"))
  .addSubcommand((s) => s.setName("resume").setDescription("Resume recording"))
  .addSubcommand((s) => s.setName("status").setDescription("Show current session status"))
  .addSubcommand((s) => s.setName("consent").setDescription("Record your consent to be transcribed"))
  .addSubcommand((s) =>
    s
      .setName("export")
      .setDescription("Export the current/last session")
      .addStringOption((o) =>
        o
          .setName("format")
          .setDescription("Output format")
          .addChoices(
            { name: "markdown", value: "markdown" },
            { name: "jsonl", value: "jsonl" },
            { name: "vtt", value: "vtt" },
            { name: "srt", value: "srt" }
          )
      )
  );

export const commandsJson = [resoundCommand.toJSON()];
