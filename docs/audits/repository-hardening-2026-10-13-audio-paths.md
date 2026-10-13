# Resound hardening sweep: audio artifact preservation

- Repository: `robertdevore/resound`.
- Starting branch/SHA: clean `main`, `51df0cd1382aa7f21777d76bf1d486a929566930` (PR18 merged).
- Working branch: `codex/audio-artifact-hardening`.
- Ending implementation SHA: `edaa5ba4274f1bae7b59c485f0f86ff991589986`.
  The following documentation-only commit contains this report and evidence.
- Purpose: self-hosted recording/import, transcription, consent metadata and portable exports.
- Integrations: Node20/22/24, pinned pnpm9.15.0, Discord.js/Pycord, ffmpeg,
  local Whisper, optional OpenAI-compatible HTTP and Strata/TotalRecall/webhook sinks.

## Scope and baseline

Repeated the repository-wide boundary review on updated main. Inspected core
storage, manifest/JSONL validation, consent and timestamp contracts; exporter
renderers and writers; CLI orchestration and export dispatch; bot operation
ownership and recovery; recorder/sidecar resource handling; transcription track
selection and HTTP handling; sink delivery; subprocess diagnostics; package
metadata, CI, release scripts and agent-facing documentation. Prior lifecycle,
provider and manifest fixes remain covered by the complete test suite.

No private recordings, environment files, model weights or real transcripts were
used. All new fixtures are synthetic temporary directories, cleaned in `finally`.
No sibling repository changes were required. No independent subagent review was
performed. Offline checks do not prove live Discord/device/model/provider acceptance.

The clean implementation baseline passed format/build/types and 238 tests.
A premature baseline run overlapped the initial added regression tests; it was
not retained as a clean baseline. The test file was restored from HEAD and the
entire baseline rerun successfully before changing implementation. The saved
baseline is that clean rerun. Four new collision cases then reproduced failures
against the unchanged implementation; their separate red evidence is retained.

## Changes and compatibility

| Problem and root cause                                                                                                                          | Implementation/files                                                                                                                                                                                                  | Regression evidence                                                                                                                                                                                                                            | Compatibility and impact                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configured output paths were checked against other exports and the manifest, but could overwrite retained WAVs or occupy recording directories. | `packages/core/src/paths.ts` reserves standard raw/chunk directories and declared mixed/system/microphone/track/chunk paths before resolving outputs. Existing equality/ancestor/descendant checks reject collisions. | Ten added exporter cases cover standard directories, all declared audio fields, cwd-relative track paths, unchanged original audio/canonical bytes and valid nested exports. Four initial cases failed before the fix; all ten pass afterward. | No API signature changes. Unsafe configured paths now throw before export writes. Normal output names, nested paths, and audio path interpretation remain unchanged. No audio buffering or filesystem scanning added. |

`docs/architecture.md` documents the boundary. The existing shared path resolver
also applies the guard to validation and filesystem delivery without duplicating
logic. Invalid historical optional audio values remain the structural validator's
responsibility; the collision collector safely ignores non-string entries.

Public APIs, CLI flags/explicit `--out` overrides, schema1.2.0, serialization,
configuration keys, environment variables and dependencies remain unchanged.
CLI commands loading a manifest with colliding configured outputs now fail
explicitly, rather than permitting destructive export. Operators must move those
output paths to distinct locations. No external-consumer migration is otherwise
required. This is lexical integrity protection, not a filesystem sandbox against
concurrent symlink manipulation by a host operator.

## Verification and measurements

Evidence is under `evidence/2026-10-13-audio-paths/`.

| Command                                                                                                                         | Result                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                                                                | Passed, lockfile unchanged                                         |
| `pnpm verify` before/after                                                                                                      | Passed, 238 → 248 tests across 20 files; format/build/types passed |
| `pnpm exec vitest run packages/exporters/src/exporters.test.ts` before fix                                                      | Four expected new failures; 11 existing tests passed               |
| `pnpm exec vitest run packages/exporters/src/exporters.test.ts packages/core/src/core.test.ts packages/sinks/src/sinks.test.ts` | 60 tests passed                                                    |
| `pnpm test:cli` before/after                                                                                                    | 20 checks passed; 2,600,000 piped bytes preserved                  |
| `python3 -m unittest discover -s packages/audio/python -p 'test_*.py'`                                                          | Eight passed                                                       |
| `pnpm release:check`                                                                                                            | v1.0.1 consistent across nine packages                             |
| `pnpm audit --json`                                                                                                             | Zero advisories, 156 dependencies                                  |
| `python3 scripts/benchmarks/wav-memory.py`                                                                                      | 128 MiB, three repetitions, byte-identical output                  |
| `git diff --check`                                                                                                              | Passed                                                             |

Existing WAV conversion benchmark: historical whole-file implementation median
0.438642 s and 134,234,838 peak traced bytes; current streaming implementation
0.483392 s and 2,108,957 bytes. The converter was not changed in this pass. These
are a resource-bound reconfirmation, not a new speed or memory improvement claim.
The verification suite's measured test duration was 7.58 s before and 7.69 s after;
concurrent host load makes this unsuitable as a performance claim. No meaningful
binary/token/output-size optimization was identified, and no such gain is claimed.

## Boundaries and remaining work

Trust boundaries reviewed include manifest-derived paths, provider payloads,
subprocess arguments/lifetime, Discord ownership, durable consent/state and
private export/delivery artifacts. The demonstrated audio overwrite path is
closed. Existing shell-free execution, provider deadlines, sequential uploads,
private atomic-per-file replacements and no-implicit-retry semantics remain.
Exports are still not a multi-file transaction or power-loss durability guarantee.

Agent ergonomics remain compact: root instructions identify targeted and full
checks; canonical types and docs identify contracts; full evidence is stored in
files and final receipts remain short. No model prompts or MCP schemas are
introduced here. Cosmetic rewrites, speculative caching and dependency removal
had no demonstrated benefit and were not performed.

- P0/P1/P2: no unresolved demonstrated issue from this sweep.
- Needs more evidence: existing operator acceptance for live Discord/DAVE,
  devices, models and remote services; not inferred from offline success.
- Not worth changing: compatibility APIs, existing module boundaries and
  heuristic summaries without evidence of a regression or useful measured gain.
- Cross-repository requirements: none.
- SignalBox: no captures warranted; the confirmed finding is resolved.
