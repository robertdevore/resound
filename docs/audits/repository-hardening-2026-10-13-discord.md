# Resound Discord adapter ownership audit

- Branch: `codex/discord-ownership-audit`.
- Starting SHA: `f1387bc3c970a091d85ab682e6a8ecb253ce29ae`, clean main after PR17.
- Ending implementation SHA: `e453ea3d9b53b9e47a223ee370bd538361304862`. The following documentation commit records the evidence.
- Purpose: repeat the attached audit, fix remaining reproduced failures and preserve public contracts.
- Integrations: Discord.js and pinned Pycord/DAVE receiver; optional JavaScript voice adapter; ffmpeg, local Whisper, optional compatible HTTP transcription and downstream sinks. Version1.0.1/schema1.2.0 unchanged.

## Baseline and inspection

Before implementation changes, formatting, build, workspace types and 226
TypeScript tests passed. Built CLI smoke passed 20 commands and preserved
2,600,000 piped bytes; all eight Python tests passed. Main matched origin/main.
The registry audit found zero advisories across 156 dependencies.

Reviewed both Discord capture adapters, startup/stop/abort ownership, stream
setup, pause flushes, process-close ordering, pending waiters, deadlines, health
and existing failure tests. Rechecked SystemRecorder fixes, bot operation/shutdown
serialization and policy, manifest validation/storage/path confinement, speaker
metadata/provider scheduling, export/sink contracts, command/HTTP diagnostics,
Python streaming, package/CI/release configuration and agent/operator docs.
Earlier audit findings remain covered by the full suite. No live meeting data,
credentials or model weights were used; new reproductions use synthetic streams,
controlled promises and fake child events, alongside existing real fake-sidecar
subprocess tests.

## Reproduced changes

| Problem / root cause                                                                                                                                                                            | Implementation and files                                                                                                                                                  | Regression proof                                                                                                                                                                     | Compatibility / impact                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pycord allowed another start to overwrite its owned child. Concurrent stop calls wrote twice and competed for one stopped event.                                                                | `pycord-discord-recorder.ts`: reject overlapping start, retain startup/stop ownership, share one stop promise until next start.                                           | Fake-child tests assert one spawn/quit write and matching success/failure outcomes.                                                                                                  | Same Recorder signatures and sorted chunk results. Invalid overlapping starts reject rather than orphaning capture; repeated stops reuse the original result.                       |
| Stop returned on a stopped event and abort released ownership on exit, before close/stdout drainage. A late close could interfere with reuse; pending readiness could survive a closed process. | Keep a close promise; finalization includes close under the idle deadline; termination waits for close after SIGTERM/SIGKILL escalation; close rejects remaining waiters. | Tests separate stopped/exit/close, exercise restart, stop-before-ready, repeated failure, and a process that reports stopped but stays alive. Existing deadline/progress tests pass. | Stop completion now guarantees child close. Healthy protocol and progress-based timeout refresh stay supported; timeout still rejects and cleanup owns the child through close.     |
| Optional JavaScript Discord adapter checked idle before awaiting dependency loading, allowing duplicate startup or capture activation after stop.                                               | `discord-recorder.ts`: reserve startup identity before await; stop invalidates it; stale completion cannot install a speaking listener.                                   | Deferred-loader races reproduce duplicate startup and late activation; dependency-failure retry stays supported.                                                                     | No new state enum or public API. Valid startup unchanged; cancelled startup rejects explicitly.                                                                                     |
| Decoder construction could leak its subscription; pause flush failure was thrown but forgotten, allowing stop success. Failed health summaries also said idle.                                  | Track partially acquired streams and dispose on setup failure; retain pause error and failed state; report failed health for both adapters.                               | Synthetic decoder throw destroys input; injected disk failure remains a stop rejection. Existing pause byte-exclusion and bounded chunk tests pass.                                  | Errors remain visible; no silent recovery or loss of required audio is described as success. Pycord remains supported default; optional adapter live DAVE readiness is not claimed. |

Recording docs describe the lifecycle contract. Existing CI runs all new tests;
no arbitrary sleeps, timeout increases, new dependencies, retries or background
jobs were introduced. Audit index points to this pass without relabeling historical
evidence as current.

## Measurements and resource review

| Dimension                     | Before                                 | After                                       |
| ----------------------------- | -------------------------------------- | ------------------------------------------- |
| TypeScript tests              | 226 pass                               | 238 pass (+12)                              |
| Initial new regression matrix | Eight fail, one pass                   | All pass; three additional edge cases added |
| Focused audio checks          | Existing capture coverage              | 30 pass                                     |
| CLI smoke                     | 20 commands, 2,600,000 bytes preserved | Same                                        |
| Python tests                  | 8 pass                                 | 8 pass                                      |
| Pycord concurrent start/stop  | Two spawns/quit writes possible        | One owned spawn/quit write                  |
| Dependency surface            | 156, zero advisories                   | Unchanged manifests/lockfile                |

Unchanged WAV streaming produced byte-identical output for a 128 MiB input:
2,108,957 peak traced bytes, 2.619 s median over three runs. Its historical
whole-file comparator measured 134,234,838 bytes and 2.072 s. This is a resource
baseline, not an optimization made by this pass. No new latency/memory percentage
or token savings are claimed; raw timings are not portable performance budgets.

Resource work here removes duplicate process/control activity and closes setup
leaks. Sequential file-backed uploads, bounded process-error previews, streaming
Python WAV output, private atomic artifacts and transcript projections remain
unchanged. No measured bottleneck justified new caching or algorithm rewrites.
Host diagnostic retention/quotas remain operator responsibilities.

AGENTS.md already provides compact navigation and selective test commands. There
is no active LLM replay or MCP registration layer to shrink. Error and health
messages remain concise; detailed test output is preserved in evidence rather
than emitted as routine status text.

## Contracts and boundaries

Public method signatures, chunk fields, CLI flags, schema1.2.0, file layouts,
configuration/environment names, provider protocols and versions are unchanged.
External callers that overlap starts now receive an error. Pycord stop awaits
process close, preserving its idle deadline and force-kill escalation. Pause/setup
failures now remain failed through finalization. Normal capture output and sorted
track results remain supported. No downstream repository change is required.

Reviewed operator-configured commands/paths/endpoints, credential handoff,
subprocess/stream ownership, Discord control policy and consent metadata,
private artifacts and external JSON boundaries. These are demonstrated lifecycle
and data-integrity fixes, not a claim of a newly established remote exploit.
No safety or validation boundary was weakened.

## Commands and evidence

Node24.20.0 / pnpm9.15.0 locally; synthetic inputs only. Logs are in
[evidence/2026-10-13-discord](evidence/2026-10-13-discord/).

| Command                                                                                                                                                                                                | Result                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `git fetch origin`; `git rev-list --left-right --count HEAD...origin/main`                                                                                                                             | Clean baseline, 0/0                                   |
| `pnpm verify` before/after                                                                                                                                                                             | PASS: formatting, builds, workspace types, full tests |
| `pnpm test:cli` before/after                                                                                                                                                                           | PASS: 20 commands and byte-preserving output          |
| `python3 -m unittest discover -s packages/audio/python -p 'test_*.py'` before/after                                                                                                                    | PASS: eight tests                                     |
| `pnpm audit --json`                                                                                                                                                                                    | PASS: zero advisories                                 |
| `python3 scripts/benchmarks/wav-memory.py`                                                                                                                                                             | PASS: equality and resource baseline above            |
| `pnpm exec vitest run packages/audio/src/pycord-lifecycle.test.ts packages/audio/src/discord-startup.test.ts` before fixes                                                                             | Expected fail: eight failures / one pass              |
| `pnpm exec vitest run packages/audio/src/discord-startup.test.ts packages/audio/src/pycord-lifecycle.test.ts packages/audio/src/audio.test.ts packages/audio/src/discord-recorder.test.ts` after fixes | PASS: 30 checks                                       |
| `pnpm release:check`                                                                                                                                                                                   | PASS: v1.0.1 across nine packages                     |
| Targeted `pnpm exec prettier --write`, `pnpm format:check`, `git diff --check`                                                                                                                         | PASS                                                  |

Source inspection used targeted rg/cat/sed and Git reads. Published PR checks cover
Node20/pnpm9 Linux, Node22/pnpm11 Linux, Node22/pnpm9 macOS, pinned Python
sidecar/probe and Docker build; consult the PR for remote results.

## Remaining assessment

- P0/P1/P2: no newly demonstrated unresolved issue from this pass.
- Needs more evidence: real Discord/DAVE, macOS device/permission behavior,
  Whisper models and remote providers require operator acceptance. Optional
  JavaScript voice tests do not establish live DAVE compatibility.
- P3: no new required follow-up. Existing host retention/quotas and per-file
  rather than all-artifact transactional writes remain deployment considerations.
- Not worth changing: unmeasured micro-optimizations, a generalized recorder
  framework or removal of compatibility adapters without consumer evidence.
- Cross-repository requirements: none.
- SignalBox: no captures warranted; new reproduced failures were resolved.
