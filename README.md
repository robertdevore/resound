# Resound

[![Version](https://img.shields.io/badge/version-0.1.0-black)](https://github.com/robertdevore/resound/releases/tag/v0.1.0)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)
[![built with Kujo](https://img.shields.io/badge/built%20with-Kujo-white.svg)](https://github.com/kujolang/kujo)
[![CI](https://github.com/robertdevore/resound/actions/workflows/ci.yml/badge.svg)](https://github.com/robertdevore/resound/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](#quick-start)

**Portable memory for Discord conversations.** Resound records voice locally,
transcribes with the provider you choose, and writes durable Markdown, JSONL,
VTT, and SRT artifacts that you own.

No hosted service, web dashboard, or database is required. Strata and
TotalRecall are optional destinations, not dependencies.

```bash
pnpm cli mock "Engineering Standup"
pnpm cli validate <session>
pnpm cli export <session> --format md
```

## Contents

- [Why Resound](#why-resound) · [Quick start](#quick-start) · [Real recording](#real-recording)
- [What you can do](#what-you-can-do) · [How it works](#how-it-works) · [Discord bot](#discord-bot)
- [Project status](#project-status) · [Documentation](#documentation) · [License](#license)

---

## Why Resound

- **Local-first** — capture runs on the operator's machine and session files
  stay under operator control.
- **Vendor-neutral** — use local Whisper or any OpenAI-compatible transcription
  endpoint.
- **Portable** — every session is a self-describing folder, not a row trapped in
  a service database.
- **Consent-aware** — recording is announced and consent events are preserved in
  the session manifest.
- **Composable** — keep the files, post them to a webhook, or send them to
  optional Strata and TotalRecall sinks.

## Quick start

> **Prerequisites:** Node.js 20 or newer and pnpm 9.15.0.

```bash
nvm use
corepack enable
pnpm install
pnpm build
pnpm test

# Complete offline smoke test: record, transcribe, and export mock data.
pnpm cli mock "Engineering Standup"
```

Run the CLI from source with `pnpm cli <command>`. After `pnpm build`, the
compiled entry point is `apps/cli/dist/index.js`.

## Real recording

On macOS, route call audio through a virtual input such as BlackHole, then let
Resound capture it alongside your microphone:

```bash
pnpm cli doctor --mode local-capture
pnpm cli audio devices
pnpm cli record \
  --title "Client Call" \
  --system <blackhole-index> \
  --mic <microphone-index> \
  --participants "Robert,Client"
```

To transcribe an existing recording instead:

```bash
pnpm cli transcribe ./meeting.m4a \
  --title "Q3 Planning" \
  --provider local-whisper \
  --participants "Robert,Ashley,Jelena"
```

See the [recording guide](docs/recording.md) for macOS audio routing and the
[provider guide](docs/providers.md) for local Whisper and OpenAI-compatible
configuration.

## What you can do

| Command | What it does |
| --- | --- |
| `resound doctor` | Check recorder and transcriber readiness |
| `resound audio devices` | List macOS audio input devices |
| `resound record` | Capture system audio and microphone, then transcribe |
| `resound transcribe <file>` | Turn an existing audio file into a session |
| `resound mock <title>` | Create a complete offline test session |
| `resound sessions list` | List local sessions |
| `resound sessions show <session>` | Inspect a session manifest and transcript preview |
| `resound validate <session>` | Validate consent, manifest, outputs, and Kujo checks |
| `resound export <session> --format all` | Write Markdown, JSONL, VTT, and SRT outputs |
| `resound summarize <session>` | Regenerate the Markdown summary |
| `resound action-items <session>` | Regenerate extracted action items |
| `resound sink <target> <session>` | Send artifacts to stdout, a folder, webhook, Strata, or TotalRecall |

Run `pnpm cli --help` for the complete command list and
`pnpm cli <command> --help` for every flag.

## How it works

```text
audio source
    │
    ├─ local system audio + microphone
    ├─ existing audio file
    └─ Discord-native receiver (experimental)
    │
    ▼
transcriber ── local Whisper or OpenAI-compatible API
    │
    ▼
portable session folder
    ├─ manifest.json
    ├─ transcript.jsonl
    ├─ transcript.md
    ├─ transcript.vtt / transcript.srt
    ├─ summary.md
    └─ action-items.md
```

## Discord bot

The bot provides consent, status, and recording controls through `/resound`.
It supports four recorder modes:

| Mode | Purpose |
| --- | --- |
| `mock` | Exercise the complete workflow without real audio |
| `local-capture` | Control system-audio and microphone capture on the bot host |
| `discord-native` | Receive Discord voice through the Pycord sidecar |
| `auto` | Prefer Discord-native and fall back when local capture is configured |

```bash
cp .env.example .env
pnpm bot:register
pnpm bot:start
```

Discord-native voice receive is still experimental because Discord's
DAVE/E2EE behavior requires live acceptance testing across real calls. For
reliable production use today, prefer local capture or transcribe an existing
recording. The [provider guide](docs/providers.md) documents the constraint and
current receiver status.

## Repository layout

```text
apps/cli/             command-line interface
apps/bot/             Discord slash-command bot
packages/audio/       capture and Discord receiver adapters
packages/core/        sessions, manifests, consent, validation, storage
packages/transcribers provider adapters
packages/exporters/   Markdown, JSONL, VTT, SRT, summaries, action items
packages/sinks/       filesystem, stdout, webhook, Strata, TotalRecall
packages/kujo/        executable checks
.kujo/                specs and workflows
docs/                 setup, architecture, consent, recording, providers
```

## Project status

Version 0.1.0 includes the complete file-first workflow, local capture,
transcription providers, exporters, sinks, validation, Discord controls, and an
experimental Discord-native receiver. The remaining production-readiness gate
is live, multi-speaker Discord-native acceptance testing.

## Documentation

- [Getting started and CLI reference](docs/usage.md)
- [Recording on macOS](docs/recording.md)
- [Architecture](docs/architecture.md)
- [Consent model](docs/consent.md)
- [Providers and Discord DAVE/E2EE](docs/providers.md)
- [Changelog](CHANGELOG.md)

## License

MIT © Robert DeVore — see [LICENSE](LICENSE).
