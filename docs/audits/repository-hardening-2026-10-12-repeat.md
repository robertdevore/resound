# Resound repeat integrity audit — 2026-10-12

- Repository: `robertdevore/resound`, `/Users/robertdevore/2026/resound`.
- Starting branch/SHA: `main`, `4b87961c2424ef893f02b15d6baf135431666097` (merged PR #13).
- Working branch: `codex/repository-integrity-repeat-20261012`.
- Ending implementation SHA: `ef3b35e71e213dc01833c3f0b7341b3dec58cd26`.
  The subsequent audit commit changes only documentation/evidence; its SHA is
  available from this file's Git history.
- Purpose: independent repeat inspection after the first integrity pass, with
  emphasis on uncovered file-session failure and configuration boundaries.
- Prior baseline: [first pass](repository-hardening-2026-10-12.md), retained intact.
- Evidence: [repeat evidence](evidence/2026-10-12-repeat).

## Ground truth and scope

Resound is a self-hosted TypeScript CLI/Discord bot with a Python voice receiver.
Recorders feed transcribers, canonical JSONL and portable exporters, then optional
filesystem/stdout/webhook/Strata/TotalRecall sinks. The core schema remains 1.2.0;
package versions remain 1.0.1. Discord.js/voice, pinned Pycord/DAVE/PyNaCl, ffmpeg,
local Whisper or an optional OpenAI-compatible endpoint are the important runtime
integration boundaries. Kujo definitions are declarative scaffolds backed by
`packages/kujo` validation, not an installed remote execution service.

Reviewed implementation across core paths/store/validation/consent/time/JSONL/
subprocess/HTTP helpers; CLI file/mock/record/export flows; bot authorization,
operations, restoration, capture ownership, shutdown and export; native and Python
receiver lifecycle, PCM alignment/mixing/WAV conversion; local/remote transcriber
resolution and track selection; all sink adapters and exporter projections.
Also checked workspace manifests, build/reference configuration, Dockerfile,
release checks, CI matrix, `.kujo` contracts, AGENTS.md, security policy, provider,
architecture and usage documentation. No real credentials, transcripts, meeting
audio or model weights were read. No sibling repository implementation changed.

Baseline verification passed: build, formatting, workspace types, 129 TypeScript
tests, eight Python tests, and the built CLI's 17-command smoke. No pre-existing
suite failures were found. The added regression tests then reproduced seven
failures against the unchanged implementation; `red.txt` preserves the results.

## Changes and evidence

| Problem and root cause                                                                                                                                                                                | Implementation and files                                                                                                                                                                                                                                                                                     | Regression proof                                                                                                                                                                                                       | Compatibility / measured impact                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File copy exceptions were swallowed; `existsSync` could select a partially copied destination. Provider errors left copied audio without a manifest. File and mock success retained `created` status. | `apps/cli/src/session-runner.ts`: validate regular-file input, persist consent before side effects, require copy success, restrict retained audio to 0600, declare it before transcription, persist failed/completed lifecycle; shared failure persistence preserves both errors if state saving also fails. | `apps/cli/src/cli.test.ts`: success status/audio/permissions, provider failure, partial-copy failure, directory rejection, export failure, mock-provider failure; existing mock success now requires completed status. | No method signatures or filenames changed. Copy errors now fail visibly instead of unsafe fallback. Failed sessions are discoverable and retain evidence. Original source bytes remain unchanged. |
| `getTranscriber({env})` forwarded provider/key/base URL but ignored that environment's HTTP timeout. Constructors instead consulted the unrelated process environment.                                | `packages/transcribers/src/index.ts`: validate and pass the supplied deadline to both remote adapters. `docs/providers.md` describes precedence.                                                                                                                                                             | Two invalid-value factory tests plus two loopback HTTP tests with a stalled response body prove the 100 ms configured deadline reaches both factories.                                                                 | Same environment name and default 600,000 ms; no network protocol or public signature change. Explicit environment isolation is now honored.                                                      |

Usage documentation explains retained copies, explicit retries, failed lifecycle
and partial-export regeneration. The existing full-suite CI automatically runs all
ten new tests; another gate or dependency is unnecessary.

## Performance, resources and output

| Dimension                   | Baseline                                                                     | After                      | Interpretation                                                                   |
| --------------------------- | ---------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| TypeScript regression suite | 129 passing                                                                  | 139 passing                | Ten new behavior/failure tests; strengthened existing completion assertion.      |
| Dependency advisories       | 0 across 156 audited dependencies                                            | Same lockfile/dependencies | No update justified by this registry audit.                                      |
| Built CLI output            | 2,600,000 piped bytes preserved                                              | 2,600,000 preserved        | Existing no-truncation contract retained.                                        |
| 128 MiB PCM conversion      | Current streaming path: 2,108,957 peak traced bytes; 0.669 s median of three | Implementation unchanged   | Existing bounded-memory behavior reconfirmed; not an improvement from this pass. |

The WAV script also runs a historical whole-file comparator (134,234,838 peak
traced bytes, 0.621 s median), and confirms byte-identical output. That comparator
is not the starting repository implementation. No speedup is claimed. Test wall
times are preserved in logs but not treated as stable performance measurements.
The new failure-state writes add a small fixed number of atomic manifest writes
per CLI session in exchange for durable diagnostics; they do not buffer audio.
No production benchmark justified additional caching, concurrency or algorithm
changes. Existing remote uploads remain sequential and file-backed; subprocess
and provider error previews remain bounded with full diagnostics on disk.

There are no LLM prompts, live MCP schemas or conversation replays to optimize in
this repository. Agent instructions are compact and point at selective tests and
contracts. Heuristic summaries remain local and dependency-free. Audit command
logs are saved in evidence; final receipts stay concise. No token reduction claim
or speculative token budget was introduced.

## Trust boundaries and contracts

Reviewed filesystem confinement and unique session reservation, private atomic
artifact writes, JSONL validation, shell-free subprocess argument vectors,
deadlines, remote upload lifetime, optional sink side effects, Discord operator
and owner checks, guild operation exclusion, consent announcements, shutdown
ownership, restart recovery and complete speaker-track requirements. The new
fix closes a data-integrity failure boundary; it is not claimed as a newly
exploitable remote vulnerability. Caller-selected paths, commands and endpoints
remain operator configuration. Host symlink aliases, retention and quotas remain
host responsibilities. Automatic remote retries remain disabled.

- Public APIs: unchanged signatures.
- CLI behavior: copy/non-file errors now stop; failed sessions remain listed;
  successful file/mock manifests correctly say completed.
- File formats/schema: unchanged, including schema 1.2.0 and all existing fields.
  `audio_files.mixed` now records the successful retained file copy.
- Configuration/environment: same names/defaults; injected timeout respected.
- External consumers: no migration or sibling code changes required. Consumers
  should already understand failed/completed statuses in the existing schema.
- Exports remain atomic per artifact, not a multi-file transaction or fsync
  durability guarantee. Export failure can leave valid partial outputs, recorded
  as failed; tests cover this boundary.

## Commands and results

Commands used Node 24.20.0 from
`/Users/robertdevore/.nvm/versions/node/v24.20.0/bin` and pinned pnpm 9.15.0.
All tests used synthetic files or loopback HTTP; no paid/provider requests.

| Exact command                                                                                                                                     | Result                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `pnpm verify` before changes                                                                                                                      | PASS: format, build, workspace types, 129 tests |
| `pnpm test:cli` before changes                                                                                                                    | PASS: 17 commands, 2,600,000 bytes              |
| `python3 -m unittest discover -s packages/audio/python -p 'test_*.py'` before/after                                                               | PASS: eight tests each                          |
| `pnpm audit --json`                                                                                                                               | PASS: zero advisories; lockfile unchanged       |
| `python3 scripts/benchmarks/wav-memory.py`                                                                                                        | PASS: byte equality, metrics above              |
| `pnpm exec vitest run apps/cli/src/cli.test.ts packages/transcribers/src/transcribers.test.ts` before fixes                                       | EXPECTED FAIL: seven reproduced regressions     |
| `pnpm exec vitest run apps/cli/src/cli.test.ts packages/transcribers/src/http.test.ts packages/transcribers/src/transcribers.test.ts` after fixes | PASS: 33 tests                                  |
| `pnpm verify` after fixes                                                                                                                         | PASS: build, format, workspace types, 139 tests |
| `pnpm --filter @resound/cli build` after final mock-lifecycle edit                                                                                | PASS: refreshed built CLI                       |
| `pnpm test:cli` after refreshed build                                                                                                             | PASS: 17 commands, 2,600,000 bytes              |
| `pnpm release:check`                                                                                                                              | PASS: 1.0.1 consistent across nine packages     |
| `git diff --check`                                                                                                                                | PASS                                            |

Source reads/searches used `cat`, `sed`, `rg`; changes used targeted Python edits
and `pnpm exec prettier --write` on affected files. Git status/diff/log checks
verified the isolated branch. No tests/assertions were disabled or weakened.

## Remaining assessment

- P0/P1/P2: no unresolved newly established defect from this pass.
- Needs more evidence: live Discord/DAVE, macOS audio devices, real local Whisper
  models and external provider acceptance still require operator setup. Offline
  evidence and mock/loopback tests do not establish live readiness.
- Not worth changing: duplicate summary computation and small synchronous
  metadata operations lack a measured bottleneck; extra abstraction/caching would
  add invalidation and compatibility risk. Preserve established adapters and
  deprecated receiver interfaces without proof their consumers are absent.
- P3: no new follow-up required. Existing host retention/quotas and deployment
  validation responsibilities are unchanged.
- Cross-repository requirements: none. Strata/TotalRecall command contracts and
  public exports were preserved. No new SignalBox capture warranted.
