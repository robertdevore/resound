# Resound: recorder lifecycle and track timing audit

- Branch: `codex/recorder-lifecycle-audit`.
- Starting main SHA: `4498650dd8afe431b95e4dab2ba70311eae19140` (PR15 merged).
- Ending implementation SHA: `ae8475293eda1411bc0231d4c43ab55733bfb8da`; the following documentation commit records this evidence.
- Purpose: repeat the attached repository audit against updated main, with reproducible fixes and compatibility proof.
- Dependencies/integrations: Node20/22/24, pnpm9–11, TypeScript, Discord.js, pinned Pycord/DAVE sidecar, ffmpeg/AVFoundation, local Whisper, optional OpenAI-compatible HTTP and filesystem/stdout/webhook/Strata/TotalRecall sinks. No sibling repository changes required.

## Baseline and inspection

Clean main passed formatting, build, workspace typechecking, 169 TypeScript tests,
19 built CLI smoke commands (2,600,000 piped bytes), and eight Python tests before
implementation edits. Registry audit reported zero advisories in 156 dependencies.
Evidence is in [the immutable pass directory](evidence/2026-10-12-lifecycle/).

Inspected recorder implementations and public interfaces, subprocess ownership,
startup/stop deadlines, paused and failed states, speaker metadata and provider
mapping, local/remote scheduling, canonical storage/path/JSONL/time contracts,
export replacement, command/HTTP diagnostics and sinks. Rechecked bot session
recovery/shutdown and authorization, CLI capture/lifecycle, package/build scripts,
CI/release/container configuration, Python streaming, security and operator docs,
Kujo checks and compact agent instructions. Earlier reports remain historical
evidence; this pass concentrates new fault injection on uncovered recorder and
track-input boundaries. No real audio, transcripts, credentials or model weights
were used.

## Reproduced changes

| Problem and root cause                                                                                                           | Implementation/files                                                                                                                                               | Regression proof                                                                                                                                                                                                        | Compatibility/impact                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A second system-recorder start replaced the owned child; concurrent stops wrote shutdown twice; failed stop retained state.      | `packages/audio/src/system-recorder.ts`: reject overlapping start, share stop promise, capture the owned child/output, release references in finalization.         | Eight deterministic fake-child lifecycle tests, including duplicate start, concurrent/repeated stop, retry, pause and deadline. Original five reproductions all failed before the fix.                                  | Existing async API and chunk shape unchanged. Double-start now rejects instead of leaking a process. Repeated stop returns the same outcome until next start. |
| ffmpeg failure/signal exit left health reporting recording; startup failure left its probe timer.                                | Same recorder: update health on error/close, reject pause/resume after termination or during stop, clear startup timer, wait for close before releasing ownership. | Failure health, spawn-error close ownership, timer cleanup, paused shutdown, SIGKILL failure and reuse cases.                                                                                                           | Existing clean-exit rules (0/255/SIGINT/SIGTERM) retained; failed health is now visible through existing status API.                                          |
| Malformed speaker offsets/durations reached local execution or remote upload; offset addition could overflow and format as zero. | `packages/transcribers/src/tracks.ts`: validate all selected tracks before provider work, reject nonfinite/negative mapped timestamps; remove unused import.       | 19 cases: both providers × eight invalid values, valid fractional offsets, overflow, existing unknown-end default. 17 cases failed before fixes. Transport/runner calls remain zero even when a later track is invalid. | Required numeric fields unchanged. Zero/fractional values and optional provider end defaults preserved. Invalid input now fails explicitly.                   |

Recording/provider docs describe the tightened behavior. No new dependencies,
public exports, caches, retries, or background jobs. Existing CI automatically runs
these tests; no new flaky timing gate. Tests use fake timers, not arbitrary waits.

## Measurements and resource review

| Dimension                   | Before                          | After                              |
| --------------------------- | ------------------------------- | ---------------------------------- |
| TypeScript tests            | 169 passed                      | 196 passed (+27)                   |
| Python tests                | 8 passed                        | 8 passed                           |
| CLI smoke                   | 19 commands; 2,600,000 bytes    | Same, all pass                     |
| Dependencies                | 156; zero registry advisories   | Unchanged lockfile/manifests       |
| Duplicate recorder start    | Second process could be spawned | One spawn; second request rejected |
| Concurrent shutdown         | Two quit writes                 | One quit write, shared result      |
| Invalid later speaker track | Provider work already scheduled | Zero runner/fetch calls            |

The 128 MiB WAV benchmark confirms byte equality: current streaming path uses
2,108,957 peak traced bytes and a 0.642 s median over three runs. Its historical
whole-file comparator uses 134,234,838 bytes and 1.553 s. Neither implementation
changed in this pass; these are resource baselines, **not a new optimization claim**.
Test duration is execution evidence, not a portable performance budget.

Reviewed sequential file-backed uploads, bounded diagnostic previews, process
lifetimes, audio streaming and retained artifacts. No measurement justified new
caching, broader parallelism or algorithm rewrites. Full logs stay in evidence;
new timing errors are fixed-size field messages, without payload dumps. This repo
has no active LLM prompt replay or MCP registration to shrink. No token savings
are claimed. AGENTS.md already supports selective tests and concise navigation.

## Contracts and trust boundaries

Operator-provided paths/commands/endpoints remain explicit capabilities; shell-free
execution, private artifact writes, manifest path confinement, canonical validation,
Discord authorization/consent, and one-operation ownership remain intact. This
pass fixes reliability and data-integrity defects, not a demonstrated remote exploit.

Public method signatures, CLI flags/success outputs, schema1.2.0, file layouts,
configuration, environment variables, network interfaces and package versions are
unchanged. Consumers passing malformed required timing fields now get an error
before transcription. Direct recorder callers must stop/collect the prior capture
before restarting; a failed startup can be retried after its child closes. No
migration is needed for valid inputs, and no downstream repository change is required.

## Exact checks

Node24.20.0 / pnpm9.15.0 locally, synthetic fixtures only:

- `pnpm verify` before/after: PASS (format, build, workspace types, full tests).
- `pnpm test:cli` before/after: PASS, 19 commands and byte-preserving pipe smoke.
- `python3 -m unittest discover -s packages/audio/python -p 'test_*.py'` before/after: PASS, eight tests.
- `pnpm audit --json`: PASS, zero advisories.
- `python3 scripts/benchmarks/wav-memory.py`: PASS, equality and metrics above.
- `pnpm exec vitest run packages/audio/src/system-recorder.test.ts` before fix: expected five failures.
- `pnpm exec vitest run packages/transcribers/src/tracks.test.ts` before fix: expected 17 failures, one pass.
- `pnpm exec vitest run packages/audio/src/system-recorder.test.ts packages/transcribers/src/tracks.test.ts` after fixes: PASS, 27 tests.
- `pnpm release:check`: PASS, v1.0.1 across nine packages.
- Targeted `pnpm exec prettier --write`, `pnpm format:check`, `git diff --check`: PASS.

Source inspection used targeted `rg`, `cat`, `sed` and Git diff/status. CI on the
published PR independently verifies Node20/pnpm9 Linux, Node22/pnpm11 Linux,
Node22/pnpm9 macOS, pinned Python sidecar/probe and Docker build; consult the PR
checks for current remote outcomes.

## Remaining assessment

- P0/P1/P2: no newly demonstrated unresolved issue in this pass.
- Needs more evidence: real macOS device/permission behavior, live Discord/DAVE,
  Whisper models and remote provider acceptance require operator setup. Mocked
  subprocess tests and CI cannot establish those live outcomes.
- P3: no new required follow-up. Host disk retention/quotas and per-file rather
  than multi-file atomicity remain existing operational limitations.
- Not worth changing: unmeasured micro-optimizations, broad API redesign or
  deleting compatibility adapters without consumer evidence.
- Cross-repository requirements: none.
- SignalBox: no captures warranted; all new reproduced issues were resolved.
