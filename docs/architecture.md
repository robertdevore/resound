# Architecture

Resound is a small monorepo of single-purpose packages. Data flows one way:

```
  ┌────────────┐   audio chunks   ┌───────────────┐   segments   ┌────────────┐
  │  Recorder  │ ───────────────▶ │  Transcriber  │ ───────────▶ │ Exporters  │
  │ (audio)    │                  │ (transcribers)│              │            │
  └────────────┘                  └───────────────┘              └─────┬──────┘
        ▲                                                              │ writes
        │ mock | discord(DAVE, pending)                                ▼
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
4. **Audio capture is decoupled.** `Recorder` is an interface. `MockRecorder`
   drives the whole pipeline today. A `DiscordRecorder` will implement the same
   interface once DAVE/E2EE voice receive is viable (see
   [providers.md](providers.md)).
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

## Build & test

- TypeScript project references; `pnpm build` builds packages in dependency
  order, then the apps.
- Vitest resolves `@resound/*` to package **source** (see `vitest.config.ts`),
  so tests run without a prior build.
