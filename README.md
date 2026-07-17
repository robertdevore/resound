# Resound

**Local-first, vendor-neutral Discord voice transcription.** A lightweight
"Fathom for Discord" built around operator-owned capture, portable files, and
no lock-in.

Resound turns conversations into **portable memory**:

- **Discord voice** is captured from the operator's local machine today.
- **Markdown / JSONL / VTT / SRT** are the canonical portable outputs.
- **[TotalRecall](https://github.com/robertdevore/totalrecall/)** and **[Strata](https://github.com/robertdevore/strata/)** are *optional* downstream sinks.
- **[Kujo](https://github.com/kujolang/kujo/)** is the workflow / spec / verification layer.

No web dashboard, database-first design, hosted service, or required vendor. You can use
Resound and never touch Strata, OpenAI, or TotalRecall - the artifacts are
useful on their own.

## Quick start

```bash
nvm use            # Node 20+ (this repo is tested on 22)
corepack enable
pnpm install
pnpm build
pnpm test

# Create a complete mock session end-to-end (no Discord, no API key):
pnpm cli mock "Engineering Standup"

# Inspect and validate it:
pnpm cli sessions list
pnpm cli validate <session-folder-name>
pnpm cli export <session-folder-name> --format md
```

`pnpm cli ...` runs the CLI from source via `tsx`. After `pnpm build`, the
`resound` binary is available at `apps/cli/dist/index.js`.

## How Real Discord Recording Works Today

Discord's DAVE/E2EE rollout makes bot-side voice receive unreliable for
third-party bots. Resound therefore treats the Discord bot as the consent and
control surface, while the operator's machine captures the audio it can already
hear.

Recommended real path:

```bash
pnpm cli devices
pnpm cli record --title "Client Call" --system <blackhole-index> --mic <mic-index> --participants "Robert,Client"
```

Recommended slash-command path:

```bash
pnpm bot:start  # .env.example defaults the bot to local-capture
```

Then use `/resound start` and `/resound stop` in your own Discord server; stop
attaches the Markdown transcript automatically. The bot process must run on the machine doing the audio capture.
Other operators can clone this repo, create their own Discord app, configure
their own local audio devices, and run the same workflow for their servers.

## Repository layout

```
resound/
  apps/
    bot/          Discord bot (slash commands; mock/local-capture/experimental receive)
    cli/          `resound` CLI — works on local folders, no bot required
  packages/
    core/         canonical data model, session/manifest, validation, store
    audio/        capture abstraction + mock, local system, and Discord recorders
    transcribers/ provider adapters: mock, openai, + scaffolds
    exporters/    jsonl/md/vtt/srt/summary/action-items renderers
    sinks/        filesystem, stdout, webhook, strata, totalrecall
    kujo/         executable Kujo checks
  .kujo/          declarative specs / workflows / checks
  transcripts/    session output (file-first, git-ignored)
  docs/           architecture, usage, consent, providers
```

## Documentation

- [docs/usage.md](docs/usage.md) — setup, env, every command, all workflows
- [docs/recording.md](docs/recording.md) — **record a real Discord call on macOS** (system-audio capture, the for-real path)
- [docs/architecture.md](docs/architecture.md) — how the pieces fit
- [docs/consent.md](docs/consent.md) — the consent model (Resound forbids hidden recording)
- [docs/providers.md](docs/providers.md) — transcription providers **and the Discord voice / DAVE / E2EE constraint**

## Status

- ✅ Full architecture, schemas, CLI, exporters, sinks, mock recorder, Kujo checks.
- ✅ **Local-first transcription** (`local-whisper`) + an optional, vendor-neutral
  `openai-compatible` provider (any OpenAI-compatible endpoint).
- ✅ **`resound transcribe <file>`** — turn any recording into a full session today.
- ✅ **Local capture bot mode** (`RESOUND_BOT_MODE=local-capture`) — slash
  commands control this machine's system/mic capture.
- ✅ Live `DiscordRecorder` is implemented and wired into the bot
  (`RESOUND_BOT_MODE=discord`), with optional/lazy native deps.
- ⛔ **Live Discord voice *receive* is currently blocked upstream by DAVE/E2EE**
  (mandatory across Discord voice as of 2026; `@discordjs/voice` receive is broken).
  See [docs/providers.md](docs/providers.md). Until upstream fixes it, use the
  record-a-file workflow; the day receive works, flip `RESOUND_BOT_MODE=discord`
  with no code change.
