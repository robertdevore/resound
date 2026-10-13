# Resound

[![Release](https://img.shields.io/github/v/release/robertdevore/resound)](https://github.com/robertdevore/resound/releases) [![CI](https://github.com/robertdevore/resound/actions/workflows/ci.yml/badge.svg)](https://github.com/robertdevore/resound/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

Resound records or imports audio and turns it into transcripts you keep on your own machine. Use local Whisper or an OpenAI-compatible provider. Each session contains Markdown, JSONL, VTT, SRT, summaries, action items, and a manifest with consent events.

No hosted service, dashboard, or database is required. You can send completed sessions to Strata, TotalRecall, a webhook, or another folder.

Current release: [v1.0.2](https://github.com/robertdevore/resound/releases/tag/v1.0.2). See the [changelog](CHANGELOG.md) for recording, recovery, and storage fixes.

## Quick start

Requirements: Node.js 20, 22, or 24. The repository pins pnpm 9.15.0; pnpm 9 through 11 are supported.

```bash
corepack enable
pnpm install --frozen-lockfile
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

The `/resound` bot runs on your own Linux server, VPS, NAS, or
local machine. It joins Discord voice through a DAVE-aware receiver, records
separate speaker tracks, transcribes them, and keeps the artifacts on your host.

Start with mock audio to check the setup. Copy the environment template, add your
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

## Storage and recovery

Resound retains audio when transcription or export fails. Recorder shutdown waits
for capture to finish, and recovery requires every declared speaker track.
Exports replace files atomically, one file at a time; they are not a multi-file
transaction. Configured transcript paths cannot overwrite retained audio.

Run the [self-hosting acceptance check](docs/self-hosting.md) before recording
real meetings. Offline tests cannot verify your Discord permissions, audio
devices, models, or remote provider.

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
