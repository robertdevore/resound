# Resound

[![Release](https://img.shields.io/github/v/release/robertdevore/resound)](https://github.com/robertdevore/resound/releases) [![CI](https://github.com/robertdevore/resound/actions/workflows/ci.yml/badge.svg)](https://github.com/robertdevore/resound/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

Resound turns voice conversations into portable local memory. It records or imports audio, transcribes with local Whisper or an OpenAI-compatible provider, and writes files you own: Markdown, JSONL, VTT, SRT, summaries, action items, and a consent-aware manifest.

No hosted service, dashboard, or database is required. Strata and TotalRecall are optional sinks.

## Quick start

Requirements: Node.js 20+ and pnpm 9.15+.

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

| Command | Purpose |
| --- | --- |
| `doctor` | Check recorder and transcriber readiness |
| `audio devices` | List macOS inputs |
| `record` | Capture and transcribe audio |
| `transcribe <file>` | Import an existing recording |
| `mock <title>` | Run the complete offline workflow |
| `sessions list/show` | Inspect stored sessions |
| `validate <session>` | Validate consent, manifest, and outputs |
| `export <session>` | Generate Markdown, JSONL, VTT, and SRT |
| `summarize` / `action-items` | Regenerate derived artifacts |
| `sink <target> <session>` | Send to stdout, folder, webhook, Strata, or TotalRecall |

Run `pnpm cli --help` for all flags.

## Discord bot

The `/resound` bot exposes consent, status, pause/resume, and recording controls. Configure `.env`, then:

```bash
pnpm bot:register
pnpm bot:start
```

Recorder modes are `mock`, `local-capture`, `discord-native`, and `auto`. Discord-native receive remains experimental because DAVE/E2EE behavior requires live acceptance testing; local capture and file transcription are the reliable production paths today.

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
