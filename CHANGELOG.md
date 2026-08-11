# Changelog

All notable changes to Resound are documented here.

## [0.2.0] - 2026-08-11

### Changed

- Session IDs and folders include seconds and milliseconds to avoid same-minute collisions.
- Simplified the README around setup, recording, commands, and production constraints.

### Fixed

- Create only one recorder per bot session, avoiding duplicate factory work and side effects.
- Carry rounded subtitle milliseconds into the next second instead of emitting invalid `.1000` or `,1000` timestamps.

### Security

- Verified the pnpm dependency graph has no known audit findings at release preparation time.

## [0.1.0] - 2026-08-08

The first official release of Resound: local-first, vendor-neutral Discord
voice transcription with portable session artifacts.

### Added

- Local macOS system-audio and microphone capture, plus recording preflight and
  device diagnostics.
- Discord slash-command control with mock, local-capture, Discord-native, and
  automatic recorder modes.
- Pycord sidecar support for Discord-native receive, including DAVE runtime
  compatibility and per-speaker audio tracks.
- Local Whisper and OpenAI-compatible transcription providers.
- Markdown, JSONL, VTT, and SRT exports with summaries and action items.
- Optional filesystem, webhook, stdout, Strata, and TotalRecall sinks.
- Consent-aware session manifests, validation, and Kujo checks.

### Security

- Require PostCSS 8.5.23 or newer to address GHSA-6g55-p6wh-862q.
- Require Undici 6.28.0 or newer to address GHSA-8xcm-r25x-g524,
  GHSA-m8rv-5g2x-5cg5, and GHSA-v3r7-h72x-cjcm.

[0.1.0]: https://github.com/robertdevore/resound/releases/tag/v0.1.0
[0.2.0]: https://github.com/robertdevore/resound/releases/tag/v0.2.0
