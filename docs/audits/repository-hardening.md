# Repository hardening audit — 2026-09-26

## Repository and scope

- Repository: `robertdevore/resound`, branch `main`.
- Starting SHA: `f2b5e10a2b1bcada6fe65f91807d31c32d6dcc96` (clean tree).
- Ending SHA: `5100158b9da6923871ac29e12c9a64d1a6adaea1` (verified implementation).
  The following documentation/evidence-only commit contains this report; obtain
  its exact revision with `git log -1 --format=%H -- docs/audits/repository-hardening.md`.
- Purpose: self-hosted voice capture/import, local or remote transcription, and
  portable consent-aware session artifacts. The CLI and Discord bot compose six
  leaf packages; core types are the canonical data contract.
- Dependencies/integrations: Node 20/22/24, pnpm 9–11, TypeScript, discord.js,
  ffmpeg/AVFoundation, local Whisper, optional OpenAI-compatible REST, pinned
  Pycord/DAVE/PyNaCl/libopus, optional Strata/TotalRecall/webhook sinks.
- Inspected runtime source, interfaces, tests, package/build configuration,
  lockfile, CI/release workflows, Docker/systemd deployment, operator docs,
  `.kujo` specifications/checks/workflows, persistence, subprocesses and network
  boundaries. No sibling repository implementation was changed. Private `.env`,
  recordings, transcripts and model weights were not read.

The audit includes an independent static security baseline and architecture
review. Codex Security scan `f37561be-f1b5-4d14-8476-2bdfdb7ec5e0` was finalized
with two source-validated baseline findings, subsequently fixed here. Its coverage
is explicitly partial because the receiver clock contract/live boundaries remain
unverified; this is not a claim of exhaustive security assurance.

## Baseline

On macOS, Node **24.20.0**, pnpm **9.15.0**, Python **3.10.5**:

- Frozen installation succeeded without lockfile changes.
- `pnpm verify`: formatting, build, all workspace type checks, **87 tests / 10
  files passed**. Test-run duration was **6.86 s**; this is context, not a speed
  baseline suitable for comparing different suites under concurrent host load.
- Release metadata passed for version 1.0.1 across nine packages.
- Installed sidecar probe passed: Pycord `2.8.1.dev91+g326b72acc`, DAVE receive and
  libopus available. This is dependency readiness, not live capture verification.
- `pnpm audit --json` reported two moderate package entries (`vitest` and
  `@vitest/mocker`) for one advisory.
- Initial ambient `pnpm verify` used the host's Node 26 wrapper, which remained
  in a supply-chain install check; it was terminated and rerun with supported
  Node/pnpm. No source failure was attributed to that environment problem.
- Docker CLI exists, but the daemon socket does not. Container execution was
  unavailable before/after this pass. No real conversations were recorded or
  sent to external transcription services.

Raw verification receipts: [baseline](evidence/baseline-verification.txt),
[final](evidence/final-verification.txt), [Node 22](evidence/node22-tests.txt).

## Findings

| ID  | Priority            | Area                     | Finding and evidence                                                                                                                                   | Action                                                                                                                  | Status                                                     |
| --- | ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| H01 | P0                  | Capture privacy          | Legacy decoder accepted samples regardless of pause; stop only slept, leaving reception active through transcription (`discord-recorder.ts`).          | Gate incoming samples, flush pre-pause samples, detach/close reception on stop/abort.                                   | Fixed; deterministic stream tests.                         |
| H02 | P1                  | Audio memory             | Legacy `pcm.push` accumulated until participant-controlled silence and duplicated the utterance on finalization.                                       | Emit bounded 30-second chunks; retain offsets and all samples; propagate receive failures.                              | Fixed; uninterrupted 31-second regression.                 |
| H03 | P1                  | Sidecar memory           | `_pcm_to_wav` read the whole PCM file into Python memory.                                                                                              | Copy 1 MiB blocks with `writeframesraw`; finalize header on close.                                                      | Fixed; byte equality and memory gate.                      |
| H04 | P1                  | Session state            | Concurrent stops called the recorder twice; pending pause could overwrite stop state; app authorization/selection crossed awaits.                      | Stop-state checks, pending-control guard, per-guild operation admission before authorization.                           | Fixed; operation/lifecycle regressions.                    |
| H05 | P1                  | Recovery                 | Reverse directory sorting chose title order before time on the same day.                                                                               | Sort matching manifests by parsed `started_at`, deterministic path tie-break.                                           | Fixed; old z-title/new a-title regression.                 |
| H06 | P1                  | Storage integrity        | Same-title, same-millisecond sessions shared a folder; fixed `manifest.json.tmp` name conflicted across writers. Export files were truncated in place. | Exclusive directory reservation; UUID suffix only on collision; unique private staging and atomic per-file replacement. | Fixed; collision and failed-rename regressions.            |
| H07 | P1                  | Consent                  | Public ready announcement occurred only after capture began.                                                                                           | Await public pre-capture notice before starting manager/recorder; failed notice blocks capture.                         | Fixed; source-order review; live Discord not exercised.    |
| H08 | P1                  | Remote resources         | `Promise.all` buffered/uploaded every speaker at once; filtering nonexistent speaker files silently omitted speech.                                    | Sequential uploads and explicit missing-track failure.                                                                  | Fixed; four-track peak-concurrency and failure tests.      |
| H09 | P2                  | Portability/output       | Filesystem sink flattened nested declared paths; stdout sink appended a status receipt to the Markdown stream.                                         | Preserve relative directories; private copy permissions; receipt on stderr.                                             | Fixed; copied-session validation and byte-exact CLI smoke. |
| H10 | P2                  | Validation               | Unsafe output paths escaped the Kujo check result; unreadable canonical files threw from validation.                                                   | Return structured failed checks/errors.                                                                                 | Fixed; malformed-path/file regressions.                    |
| H11 | P1                  | Development dependencies | Vitest 3.2.7 and mocker affected by GHSA-82fw-gwwq-j7x9.                                                                                               | Upgrade to Vitest 4.1.11, preserve compatible Vite/Node support, frozen lock.                                           | Fixed; 0 audit advisories, full suites pass.               |
| H12 | P1                  | Build confidentiality    | Docker context excluded `.env` but not alternate env files, models, keys or stray raw audio.                                                           | Extend `.dockerignore` exclusions, retain `.env.example`.                                                               | Fixed by source review; daemon unavailable.                |
| H13 | P1 / needs evidence | Timeline alignment       | Sidecar subtracts speaker RTP origins and mixes each file from zero. Synthetic independent timestamps produce a huge offset.                           | Preserve evidence and request pinned-receiver contract/live-fixture validation before semantic changes.                 | Open; SignalBox reference below.                           |
| H14 | P2                  | Sidecar protocol         | Child `exit` could precede stdout drainage of final `stopped` event.                                                                                   | Close protocol reader on child `close`.                                                                                 | Fixed; existing sidecar protocol/deadline tests pass.      |

P0 here is engineering priority for recording privacy, not a claim of critical
remote exploit severity. The two security findings are calibrated medium and
require the optional legacy backend to receive audio successfully. Production
Pycord does not advertise pause support and is unaffected by H01/H02.

## Changes implemented and compatibility

| Change                 | Root cause / implementation and affected files                                                                                                                                     | Tests and contract considerations                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture lifetime       | `packages/audio/src/discord-recorder.ts`: lifecycle-owned stream cleanup, state-gated samples, bounded chunks, propagated errors, optional dependency injection for offline tests. | Four new tests in `discord-recorder.test.ts`; chunk metadata unchanged, continuous utterances may split; stop no longer waits an arbitrary silence delay. Optional `off` preserves structural connection compatibility.                                     |
| WAV conversion         | `packages/audio/python/discord_native_sidecar.py`: streaming reads; sidecar TS adapter waits for stdout close.                                                                     | `test_sidecar.py`: exact samples/header, 32 MiB fixture with <4 MiB traced allocation gate, read failure. Python CI runs these tests; benchmark is informational.                                                                                           |
| State and announcement | `apps/bot/src/{index,session-manager,operations}.ts`: guild operation guard, capture notice before start, state checks, chronological restoration.                                 | Three manager tests plus cross-guild operation admission test. Overlapping control/export requests now fail clearly rather than run against changing state; status/consent remain available.                                                                |
| Atomic/session storage | `packages/core/src/store.ts`, `packages/exporters/src/write.ts`, CLI session runner and summary/action-item writes.                                                                | Same-name reservation, unique identities and old-file preservation on failure. Export bytes unchanged; atomicity is per file, not across six files; no `fsync`/power-loss durability claim. Existing filenames remain except real collisions gain suffixes. |
| Pipeline and sinks     | `packages/transcribers/src/{openai,tracks}.ts`, `packages/sinks/src/filesystem.ts`, `apps/cli/src/index.ts`.                                                                       | Two remote tests, nested-copy test and full CLI smoke. Remote track requests are sequential, no implicit retry; missing declared speaker audio fails instead of partial success. stdout artifact is now clean.                                              |
| Validation             | `packages/core/src/validation.ts`, `packages/kujo/src/index.ts`.                                                                                                                   | Two error-path regressions; established validation result shape and CLI nonzero invalid-session behavior retained.                                                                                                                                          |
| Supply chain/context   | `package.json`, `pnpm-lock.yaml`, `.dockerignore`.                                                                                                                                 | Patched development-only dependency; zero new runtime dependencies. Build ignores do not affect required source inputs; runtime image still needs operator-supplied Whisper model/executable.                                                               |

Public APIs: additive storage helpers and optional audio dependency injection;
existing Recorder/Transcriber/Sink methods retained. CLI command names, flags and
exit success/failure meaning retained. stdout receipt destination is an intentional
pipe-correctness fix. File formats and schema version **1.2.0** unchanged.
No environment variable or configuration schema changes. Existing consumers
should treat session IDs as opaque; collisions now receive a UUID suffix.
No ecosystem-wide migration or sibling change is required.

## Performance and efficiency

Reproducible command: `python3 scripts/benchmarks/wav-memory.py`. A patterned
**134,217,728-byte (128 MiB)** PCM file is converted three times by each version;
SHA-256 verifies full output equality. [Raw result](evidence/wav-memory.json).

| Measurement                                    | Original whole-file conversion | Streaming conversion |
| ---------------------------------------------- | -----------------------------: | -------------------: |
| Peak Python allocations (`tracemalloc`, bytes) |                    134,234,838 |            2,108,505 |
| Median elapsed seconds, 3 runs                 |             1.0582542379997903 |   1.1632027980012936 |
| Output bytes                                   |                    134,217,772 |          134,217,772 |

This is a measured memory improvement, **not a latency improvement**. Python
allocation tracing is not total process RSS. Timing is hardware/cache/load
sensitive and is not a CI ratchet.

Additional bounds/evidence:

- Legacy PCM: previously unbounded until silence; now **5,760,000 bytes per
  active speaker chunk**, plus bounded finalization copies and decoder buffers.
  The 31-second fixture emits exactly 30 + 1 seconds, byte-for-byte. Metadata and
  disk usage still grow with recording length; host quotas/retention remain
  operator responsibilities.
- Remote upload concurrency: fixture observes **1** active request for four
  tracks; baseline source scheduled all four with `Promise.all`. This bounds
  fanout and upload memory, not a provider latency claim or a per-file size cap.
- stdout sink smoke verifies output exactly matches `transcript.md`; the concise
  receipt remains available on stderr.
- Dependency audit: **2 affected package entries / 1 advisory → 0**. One direct
  development dependency upgraded; **0 runtime dependencies added**. Installed
  package counts are not used as a performance claim.
- No prompt, MCP schema, conversational replay or model tool-dispatch surface
  exists in this repository. Transcription audio and optional sink payloads are
  the relevant data flows. No invented token savings or token budget added.
- Avoided speculative caches, sorting rewrites, regex command parsers, blanket
  logging truncation and cosmetic cleanup. Full canonical session data remains
  available. Build latency/output size were not optimization targets.

## Security review

Reviewed Discord member → operator/owner checks; guild/session ownership;
recording consent/lifecycle; voice decoding and buffers; trusted local manifests
and path containment; CLI file selection; native/subprocess arguments and token
transport; local/remote provider boundaries; explicit optional publication sinks;
artifact permissions; container/service mounts and credentials; CI/release
privileges. No shell injection, remote SSRF entry point or executable Markdown
renderer was substantiated. Locally configured executables/URLs and host state
remain trusted; the audit does not invent a sandbox around an operator account.

The development advisory requires the relevant exposed mocker/dev-server path;
this repository's normal `vitest run` configuration did not establish remote
production exposure. See the [reviewed advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
The patched suite supports the existing Node range.

Files are unencrypted. A recording announcement is not unanimous capture-time
opt-in. New file permissions do not repair existing parent ACLs. External tools,
provider behavior, live device access, OS/storage failure and retention remain
outside the verified offline boundary.

## Cross-repository follow-ups

No change to another Kujo repository is required. Strata and TotalRecall command
interfaces were preserved; no actual transcript was sent to either sink during
verification. H13 requires checking the pinned **external Pycord** timestamp
contract, not an assumed upstream defect or a required Kujo migration.

## Remaining work and explicit non-changes

- **P0:** no known unresolved source-validated P0 introduced by this pass.
- **P1 / needs more evidence (H13):** verify receiver clock normalization and
  alignment. Two immediate synthetic packets, timestamps `1000` and `4000000000`,
  produce speaker offsets `0` and `83333.3125` seconds while mixed duration is
  `0.02` seconds. This proves behavior for those inputs, not exposure in the
  pinned live receiver. Obtain nonprivate real packet fixtures before choosing
  timestamp/wraparound/silence/mixing semantics.
- **P2 verification limitation:** run the documented private-channel/macOS/provider
  acceptance checks. The remote CI matrix passed on Linux and macOS, including
  Node 20/22, pnpm 9/11, Python sidecar and container build (receipt below).
- **P2 / needs more evidence:** very long sessions can still fill disk, Python
  mixing remains CPU work, and external command/HTTP responses may hang or emit
  large diagnostics. No timeout/retry changes or arbitrary data truncation were
  made without workload-specific contracts.
- **P3 / not worth changing:** placeholder provider names, legacy receiver,
  optional sinks and `.kujo` declarative scaffolding remain documented contracts;
  absence of a default caller does not prove they are dead. No cosmetic rewrite.

SignalBox: capture `cap_bb647ed3-5c36-4218-b835-13633520ffca`, signal
`sig_a208fd76-b6a8-4aba-9f19-1e3827c38fc2` for H13. Exact-ID and `RTP` concept
retrieval passed. No duplicate found; completed fixes/routine checks were rejected
as capture material.

## Verification receipt

Commands ran from repository root unless stated. For Node commands the supported
runtime was selected with
`PATH=/Users/robertdevore/.nvm/versions/node/v24.20.0/bin:$PATH`.

| Exact command                                                                                                                  | Result                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                               | Baseline passed, pnpm 9.15.0.                                                                                                                      |
| `pnpm verify`                                                                                                                  | Baseline 87 tests; final formatting/build/all type checks and **102 tests / 12 files passed**.                                                     |
| `pnpm exec vitest run packages/audio/src/discord-recorder.test.ts apps/bot/src/session-manager.test.ts`                        | Focused lifecycle checks passed.                                                                                                                   |
| `PATH=/Users/robertdevore/.nvm/versions/node/v22.22.0/bin:$PATH /Users/robertdevore/.nvm/versions/node/v24.20.0/bin/pnpm test` | **102 tests passed**, Node 22.22.0.                                                                                                                |
| `python3 -m unittest discover -s packages/audio/python -p 'test_*.py'`                                                         | **3 tests passed**.                                                                                                                                |
| `python3 -m py_compile packages/audio/python/discord_native_sidecar.py`                                                        | Passed.                                                                                                                                            |
| `python3 packages/audio/python/discord_native_sidecar.py --probe`                                                              | Baseline/final passed; DAVE receive and Opus ready.                                                                                                |
| `python3 scripts/benchmarks/wav-memory.py`                                                                                     | Passed output hash equivalence; measured table above.                                                                                              |
| `pnpm audit --json`                                                                                                            | Baseline advisory present; final **0 advisories**.                                                                                                 |
| `pnpm up -D vitest@^4.1.11`                                                                                                    | Upgrade and lockfile update passed.                                                                                                                |
| `pnpm release:check`                                                                                                           | Passed, 1.0.1 across nine packages.                                                                                                                |
| `/Users/robertdevore/.nvm/versions/node/v24.20.0/bin/node /tmp/resound-hardening/cli-smoke.mjs`                                | Mock → list/show → validate → all four exports → exact stdout → filesystem copy → copied-session validate passed; isolated temp directory cleaned. |
| `docker info --format '{{.ServerVersion}}'`                                                                                    | Blocked: local daemon socket absent. No container build claimed.                                                                                   |
| `git diff --check`                                                                                                             | Passed.                                                                                                                                            |

During implementation, a new large-buffer assertion exceeded the test timeout;
using Node's byte-exact `Buffer.equals` removed assertion-framework traversal
without increasing the timeout or weakening byte equality. A test-only readonly
assignment and missing imports were corrected. A Python benchmark initially used
`hashlib.file_digest` unavailable on Python 3.10; it now streams hashing with the
supported standard library. None are baseline product failures; final checks
contain no known introduced regression.

## Publication and required CI

Protected `main` rejected direct push because required status checks had not run.
The changes were pushed to `hardening/repository-audit-20260926` and
[draft PR #12](https://github.com/robertdevore/resound/pull/12); no protection
bypass or merge was performed.

[CI run 36220933243](https://github.com/robertdevore/resound/actions/runs/36220933243)
passed all five required jobs for revision
`2acd0986fb2b6b3bc8a956c7f54a7586ae273eee`:

- Node 20 / pnpm 9 / Linux: 33 s.
- Node 22 / pnpm 11 / Linux: 35 s.
- Node 22 / pnpm 9 / macOS: 26 s.
- Python sidecar, including new offline regressions: 33 s.
- Container build: 1 min 29 s.

The container result closes the local-daemon verification gap; live recording
acceptance and H13 remain open. This final receipt changes documentation only.
