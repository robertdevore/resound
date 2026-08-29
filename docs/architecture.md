# Architecture

Resound is a small monorepo of single-purpose packages. Data flows one way:

```
  ┌────────────┐   audio chunks   ┌───────────────┐   segments   ┌────────────┐
  │  Recorder  │ ───────────────▶ │  Transcriber  │ ───────────▶ │ Exporters  │
  │ (audio)    │                  │ (transcribers)│              │            │
  └────────────┘                  └───────────────┘              └─────┬──────┘
        ▲                                                              │ writes
        │ mock | local-capture | discord-native | auto                 ▼
  ┌────────────┐                                              transcripts/<date>/<session>/
  │ SessionMgr │                                                manifest.json
  │ bot / cli  │                                                transcript.jsonl  ← canonical
  └────────────┘                                                transcript.md / .vtt / .srt
        │ optional                                              summary.md / action-items.md
        ▼                                                              │
  ┌────────────┐                                                       ▼
  │   Sinks    │  filesystem | stdout | webhook | strata | totalrecall (all optional)
  └────────────┘
```

## Design rules

1. **JSONL is canonical.** Every other transcript format is a projection of
   `transcript.jsonl`. The data model lives in `@resound/core` and depends on
   nothing — not Discord, not a vendor, not Strata.
2. **The session folder is the unit of portability.** A folder is fully
   self-describing (`manifest.json` + outputs). It is useful with zero tooling.
3. **Vendors are adapters.** Transcription providers implement `Transcriber`;
   downstream targets implement `Sink`. None are required; `mock` is the
   default and always works offline.
4. **Audio capture is decoupled.** `Recorder` is an interface with structured
   capabilities, preflight, and health. `MockRecorder` drives deterministic
   tests, `SystemRecorder` captures the operator machine's local system/mic
   audio, and `PycordDiscordRecorder` receives DAVE-protected Discord voice
   through the pinned Python sidecar (see [providers.md](providers.md)).
5. **Kujo is the verification layer**, not the audio layer. `.kujo/` holds
   declarative specs/workflows/checks; `@resound/kujo` is their executable
   counterpart, surfaced through `resound validate`.

## Package dependencies

```
core         (no deps)
audio        → core
transcribers → core
exporters    → core
sinks        → core
kujo         → core
cli          → core, audio, transcribers, exporters, sinks, kujo
bot          → core, audio, transcribers, exporters, sinks
```

The bot and CLI each own a thin orchestration layer (`SessionManager` /
`createMockSession`) that wires recorder → transcriber → exporters. Keeping it
in the apps avoids a circular dependency between the leaf packages.

## Deployment Model

Resound is self-hosted and local-first. For Discord-native voice, the deployment
unit is one bot process on a Linux server, VPS, NAS, or local machine with
persistent storage. The supported Pycord sidecar joins the voice channel and
writes portable artifacts without a hosted ReSound control plane.

`RESOUND_BOT_MODE=local-capture` makes `/resound` a control surface for a macOS
system recorder. `RESOUND_BOT_MODE=discord` uses the DAVE-aware server-side
receiver and is the production headless deployment mode.

`RESOUND_BOT_MODE=auto` now performs recorder preflight before a session starts.
It prefers Discord-native capture only when that recorder passes preflight, then
falls back explicitly to local-capture when the host is configured for it.

A VPS needs no access to a user's local Discord app audio: the bot joins voice
directly. Persistent transcript storage and a supported transcriber must be
configured on the VPS.

## Build & test

- TypeScript project references; `pnpm build` builds packages in dependency
  order, then the apps.
- Vitest resolves `@resound/*` to package **source** (see `vitest.config.ts`),
  so tests run without a prior build.
