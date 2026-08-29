# Resound

[![Release](https://img.shields.io/github/v/release/robertdevore/resound)](https://github.com/robertdevore/resound/releases) [![CI](https://github.com/robertdevore/resound/actions/workflows/ci.yml/badge.svg)](https://github.com/robertdevore/resound/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

Resound turns voice conversations into portable local memory. It records or imports audio, transcribes with local Whisper or an OpenAI-compatible provider, and writes files you own: Markdown, JSONL, VTT, SRT, summaries, action items, and a consent-aware manifest.

No hosted service, dashboard, or database is required. Strata and TotalRecall are optional sinks.

## Quick start

Requirements: Node.js 20, 22, or 24 and pnpm 9 through 11.

```bash
corepack enable
pnpm install
pnpm build
pnpm test
pnpm cli mock "Engineering Standup"
```

Inspect the result:

```bash
pnpm cli sessions list
pnpm cli validate <session>
pnpm cli export <session> --format all
```

## Record or transcribe

On macOS, route call audio through a virtual input such as BlackHole, then run:

```bash
pnpm cli doctor --mode local-capture
pnpm cli audio devices
pnpm cli record --title "Client Call" --system <device-index> --mic <device-index>
```

Or transcribe an existing recording:

```bash
pnpm cli transcribe ./meeting.m4a --title "Q3 Planning" --provider local-whisper
```

See [recording](docs/recording.md) and [providers](docs/providers.md) for device routing and model configuration.

## Commands

| Command                      | Purpose                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `doctor`                     | Check recorder and transcriber readiness                |
| `audio devices`              | List macOS inputs                                       |
| `record`                     | Capture and transcribe audio                            |
| `transcribe <file>`          | Import an existing recording                            |
| `mock <title>`               | Run the complete offline workflow                       |
| `sessions list/show`         | Inspect stored sessions                                 |
| `validate <session>`         | Validate consent, manifest, and outputs                 |
| `export <session>`           | Generate Markdown, JSONL, VTT, and SRT                  |
| `summarize` / `action-items` | Regenerate derived artifacts                            |
| `sink <target> <session>`    | Send to stdout, folder, webhook, Strata, or TotalRecall |

Run `pnpm cli --help` for all flags.

## Discord bot

The `/resound` bot is designed to run on your own Linux server, VPS, NAS, or
local machine. It joins Discord voice through a DAVE-aware receiver, records
separate speaker tracks, transcribes them, and keeps the artifacts on your host.
No ReSound-hosted service is involved.

The safest first run uses mock audio. Copy the environment template, add your
Discord token and application ID, then:

```bash
cp .env.example .env
pnpm bot:register
pnpm bot:start
```

For real server-side voice capture, install the pinned Python receiver
dependencies and set `RESOUND_BOT_MODE=discord`. Docker Compose installs the
complete runtime automatically. See [self-hosting](docs/self-hosting.md) for the
Discord application permissions, production configuration, upgrades, backups,
and an end-to-end acceptance check.

Only members with **Manage Server** or an explicit configured operator user/role
can start sessions. The session owner and operators control recording. Transcript
downloads are ephemeral by default; public channel delivery is opt-in.

## Architecture

- `apps/cli`: command-line interface
- `apps/bot`: Discord controller
- `packages/audio`: capture and receiver adapters
- `packages/core`: sessions, consent, validation, and storage
- `packages/transcribers`: local and remote providers
- `packages/exporters`: transcript and derived artifacts
- `packages/sinks`: optional destinations
- `packages/kujo`: executable checks

See [usage](docs/usage.md), [architecture](docs/architecture.md), [consent](docs/consent.md), and the [changelog](CHANGELOG.md).
