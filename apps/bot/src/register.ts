#!/usr/bin/env node
try {
  (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
} catch {
  /* no .env file — rely on the ambient environment */
}
import { REST, Routes } from "discord.js";
import { commandsJson } from "./commands.js";

/**
 * Registers the /resound slash command. Run with `pnpm --filter @resound/bot
 * register` after building. Registers to a single guild when DISCORD_GUILD_ID is
 * set (instant), otherwise globally (can take up to an hour to propagate).
 */
async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) {
    console.error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required to register commands.");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, { body: commandsJson });
  console.log(
    `Registered ${commandsJson.length} command(s) ${guildId ? `to guild ${guildId}` : "globally"}.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
