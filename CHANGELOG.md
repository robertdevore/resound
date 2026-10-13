# Changelog

All notable changes to Resound are documented here.

## [1.0.2] - 2026-10-13

### Fixed

- Preserve recorder ownership until child processes close; reject overlapping starts and share repeated stop results.
- Correct Discord speaker alignment and keep long recordings responsive during finalization.
- Serialize bot shutdown and session operations; require every declared speaker track during recovery.
- Reserve unique session directories and replace exports and delivered artifacts atomically per file.
- Reject output paths that overlap retained audio, conflicting artifacts, and ambiguous session references.
- Save consent and failure state when file imports or transcription fail.
- Reject malformed provider responses, manifest fields, transcript timestamps, and audio-track timing.
- Preserve large piped transcripts and honor deadlines from explicitly supplied environments.
- Align the optional Strata sink with the current CLI.

### Changed

- Bound subprocess and HTTP lifetimes, stream diagnostic logs, upload tracks sequentially, and convert PCM to WAV in bounded reads.
- Add regression coverage for storage, shutdown, recorder ownership, provider failures, and recovery.

### Security

- Update vulnerable JavaScript dependencies and restrict the Docker build context.
- Keep private artifacts and diagnostic files owner-accessible; preserve audio on failed exports.

Manifest schema 1.2.0, CLI flags, configuration keys, and provider interfaces remain compatible. Invalid or destructive inputs now fail explicitly. Live receiver, device, and provider acceptance still depends on the host setup.

## [1.0.1] - 2026-08-29

### Changed

- Updated the production container to Node.js 20.20.2.
- Updated the supported JavaScript build tooling within the existing major-version contract.

### Security

- Reverified the complete dependency graph with no open Dependabot alerts or known high-severity audit findings.

## [1.0.0] - 2026-08-29

### Added

- Production self-hosting through Docker Compose or a hardened systemd service.
- Session-owner and administrator authorization for recording controls and exports.
- Durable audio-track metadata, graceful shutdown, restart recovery, and `/resound recover`.
- Discord voice-state lifecycle tracking for initial occupants, joins, and departures.
- CI coverage across Node.js 20/22, pnpm 9/11, macOS/Linux, the Python DAVE sidecar, and the container build.
- Security policy, contribution guidance, templates, and dependency update automation.

### Changed

- Discord-native Pycord/DAVE capture is the supported headless production receiver.
- New installations start in mock mode and deliver transcripts ephemerally by default.
- Text control channels and recorded voice channels are stored separately.
- Session manifest schema 1.2 records durable per-speaker audio tracks.

### Fixed

- Prevented ordinary server members from starting, stopping, or exporting sessions.
- Prevented transcript files and host paths from being posted publicly by default.
- Persisted late joins, departures, and existing voice-channel participants.
- Made frozen installs compatible with supported pnpm major versions.

### Security

- Centralized the complete slash-command authorization matrix.
- Disabled commands in direct messages and kept operational errors private.
- Hardened the default container with a non-root user, read-only filesystem, and no-new-privileges.

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
[1.0.0]: https://github.com/robertdevore/resound/releases/tag/v1.0.0
[1.0.1]: https://github.com/robertdevore/resound/releases/tag/v1.0.1
[1.0.2]: https://github.com/robertdevore/resound/releases/tag/v1.0.2
