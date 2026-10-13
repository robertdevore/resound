# Resound repository integrity audit — 2026-10-12

## Scope and revision

- Repository: `robertdevore/resound`, initial branch `main`, initially clean.
- Publication branch: `codex/repository-integrity-20261012`; direct `main` push
  was rejected by the existing five-required-check branch protection.
- Starting SHA: `92e91623c367e591210635e24a005bc0c697f4dc`.
- Ending implementation SHA: `8d02be4dce20c796268a244fac1949f21df93b69`.
  The subsequent evidence-only commit contains this report. Resolve its exact SHA
  with `git log -1 --format=%H -- docs/audits/repository-hardening-2026-10-12.md`.
- Purpose: self-hosted Discord/local audio capture and file imports, transcription,
  consent-aware portable artifacts, and optional downstream delivery.
- Dependencies: Node 20/22/24, pnpm 9–11, TypeScript, discord.js/undici,
  ffmpeg/AVFoundation, Whisper CLI or compatible HTTP provider, pinned
  Pycord/DAVE/PyNaCl/libopus. Strata and TotalRecall remain optional.
- This pass builds on the [September audit](repository-hardening.md), preserving
  its immutable evidence. No sibling implementation, real meeting, credential
  file, private transcript, or model weight was modified or used as a fixture.

## Ground truth and coverage

Read all runtime modules and their tests, workspace/build configuration,
CI/release workflows, deployment files, security policy, operator/architecture
contracts, and Kujo scaffolding. The executable Kujo checks live in
`packages/kujo`; `.kujo` is declarative scaffolding, not an installed runtime.

| Surface                 | Review conclusion                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core/session storage    | Atomic per-file replacement and collision-resistant session reservation remain. Logical artifact collisions and ambiguous session selection were real integrity gaps, now rejected. Local filesystem ownership/ACLs remain trusted; lexical checks are not a symlink sandbox.                           |
| Bot permissions/consent | Operator/owner authorization, guild operation admission, ephemeral delivery, and pre-capture notices retained. Announcement is not unanimous capture-time consent. Shutdown crossed the existing operation guard; fixed below.                                                                          |
| Audio/resources         | Legacy PCM remains bounded to 30-second chunks; Python WAV conversion remains streaming. Receiver timeline/mixing, disk reserve, progress deadlines and subprocess ownership reviewed. Sidecar command pipe errors could crash the bot; fixed.                                                          |
| Transcription/network   | Sequential tracks, file-backed remote upload, finite full-response deadlines, no automatic remote retries, shell-free local execution retained. Operator-configured endpoints/executables are trusted. No new remotely selectable URL or command surface introduced.                                    |
| Export/sinks            | JSONL remains canonical; projections and explicit sink contracts retained. Large stdout was truncated by process exit, and Strata default syntax had drifted; fixed.                                                                                                                                    |
| Concurrency/persistence | Recorder operation ownership now covers shutdown. Atomicity remains per artifact, not a multi-file transaction or power-loss guarantee. No new cache, queue, worker, or lock introduced.                                                                                                                |
| Dependencies/release    | Nine package versions agree at 1.0.1. Two transitive locks patched within parent ranges. No runtime dependency added. Docker/systemd configuration and pinned Python receiver reviewed.                                                                                                                 |
| Agent/context/output    | No LLM prompt, MCP schema, conversation replay or agent dispatch implementation exists here. Concise `AGENTS.md` exposes verification and boundaries. Full logs stay in evidence; normal CLI smoke emits one receipt. No token savings claimed.                                                         |
| Complexity/removal      | Preserved optional receiver, placeholder providers, command overrides and declarative workflows as documented contracts. Replaced the narrower pause boolean with one tracked capture-operation promise; reused existing deadline/diagnostic helpers. No speculative abstraction or dependency removal. |

Baseline on macOS with Node **24.20.0**, pnpm **9.15.0**, Python **3.10.5**:

- Frozen install, formatting, build, all workspace type checks passed.
- **112 TypeScript tests / 14 files**, **8 Python tests** passed.
- Pinned receiver probe passed (Pycord `2.8.1.dev91+g326b72acc`, DAVE receive, opus).
- Dependency audit reported **4 advisories** across two packages (2 high,
  1 moderate, 1 low). This is an advisory count, not four demonstrated exploits
  against Resound.
- Docker CLI could not connect to its local daemon socket. Live Discord,
  macOS devices and paid/remote providers were not exercised; these were already
  unverified in the previous audit.

[Baseline verification](evidence/2026-10-12/baseline-verify.txt),
[Python](evidence/2026-10-12/baseline-python.txt),
[advisories](evidence/2026-10-12/dependency-audit.json).

## Implemented changes

| Priority / problem                                  | Root cause and implementation                                                                                                                                                                                                                                                       | Files / regression evidence                                                                                                                                                 | Compatibility                                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1: incomplete recovery silently succeeded          | `storedAudioChunks` filtered missing tracks before provider validation. Require every declared speaker track; preserve the recoverable manifest and retry after audio restoration.                                                                                                  | `apps/bot/src/session-manager{,.test}.ts`; missing-speaker fixture fails before fix, passes after; mixed-only legacy recovery retained.                                     | Complete recordings unchanged. Missing declared speakers now fail even if mixed audio exists.                                                                               |
| P1: shutdown races with capture                     | Shutdown bypassed pending startup/pause/stop, could stop twice or clear ownership before audio completed. Share one capture-operation promise and one shutdown promise; suppress new transcription and late exports after shutdown.                                                 | Same manager files; controlled promises test pending startup, overlapping stop, concurrent shutdown and late provider completion. Existing pause/stop tests remain.         | Same public methods and persisted statuses. A manager interrupted for shutdown rejects new work; restart with a new manager to recover. No new sleeps/timeouts.             |
| P1: output path collisions overwrite canonical data | Containment alone allowed Markdown to alias JSONL/manifest or a parent path. Reject normalized logical duplicates, ancestors, root/empty/NUL paths before export writes.                                                                                                            | `packages/core/src/paths.ts`, `packages/exporters/src/exporters.test.ts`; six conflict fixtures preserve every existing byte.                                               | Valid relative/nested paths retained. Invalid overlapping declarations now fail. No schema change; host symlink/case-alias manipulation remains outside this lexical check. |
| P1: ambiguous reference can send wrong session      | Resolver chose the first substring/name/ID match. Require uniqueness at each precedence level and reject empty references.                                                                                                                                                          | `packages/core/src/{store,core.test}.ts`; exact path/name and unique substring still resolve, ambiguity fails. Built CLI tests require zero transcript output on ambiguity. | Same resolution precedence. Ambiguous callers must supply an exact path.                                                                                                    |
| P1: piped Markdown truncated                        | `process.exit` discarded queued stdout after sink success. Set `process.exitCode` and allow pipe drainage.                                                                                                                                                                          | `apps/cli/src/{index,cli.test}.ts`; real child pipe, exact 2.6 MB fixture. `scripts/verify-cli.mjs` checks 17 built CLI commands; CI runs it on every Node/OS matrix entry. | Exit code and receipt destination unchanged; complete content now reaches stdout.                                                                                           |
| P1/P2: sidecar pipe/config/log failures             | Unhandled stdin EPIPE crashed the process; invalid timers could clamp to 1 ms; synchronous log append ran on every stderr chunk. Validate deadlines and prepare private diagnostics before spawn; handle command pipe errors; redirect stderr directly to disk and preview on exit. | `packages/audio/src/{pycord-discord-recorder,audio.test}.ts`; actual closed pipe, invalid deadlines, 1 MiB diagnostic fixture plus existing startup/stop/progress tests.    | Protocol and default deadlines unchanged. Invalid timeout configuration now fails before capture. Diagnostic path retained; error tail is bounded.                          |
| P2: optional Strata integration drift               | Default `notes add --file` is absent from inspected Strata 0.9.3 CLI. Use `notes create --file`; keep explicit overrides and document legacy migration.                                                                                                                             | `packages/sinks/src/{strata,sinks.test}.ts`, `.env.example`, `docs/usage.md`; injected command tests and actual Strata CLI dry-run.                                         | Explicit old commands remain untouched. Users with older Strata can configure `notes add`. No ingestion was performed for verification.                                     |
| P1: vulnerable transitive locks                     | Update undici **6.28.0 → 6.29.0** and source-map-js **1.2.1 → 1.2.2**; retain all unrelated versions.                                                                                                                                                                               | `pnpm-lock.yaml`; frozen install, complete suite and fresh audit with zero advisories.                                                                                      | Same major versions/parent ranges, no direct dependency or engine change.                                                                                                   |

Additional documentation: `docs/architecture.md`, `docs/providers.md` and
`AGENTS.md` explain the final lifecycle, diagnostic and verification contracts.

The regression suite demonstrated 8 failing artifact/recovery cases, 2 shutdown
failures, 2 sidecar failures (including uncaught errors), and the large-pipe failure
against pre-fix behavior. See the four `red-*.txt` receipts in the evidence folder.
A new large-log test initially used a regex that did not span its diagnostic
newline; its matcher was corrected, retaining tail and complete-file assertions.
No production failure was hidden or asserted as expected.

## Measurements and ratchets

| Measurement                                                            |           Before |                              After |
| ---------------------------------------------------------------------- | ---------------: | ---------------------------------: |
| Bytes delivered by real stdout pipe, 2,600,000-byte synthetic Markdown | 131,072 observed |          2,600,000, exact equality |
| TypeScript behavioral tests                                            |              112 |                                129 |
| Python behavioral tests                                                |                8 |                                  8 |
| Dependency audit advisories                                            |                4 |                                  0 |
| Changed transitive package versions                                    |                — | 2; zero added runtime dependencies |

The pipe cutoff varies with OS buffering; 131,072 is the recorded observation,
not a contractual threshold. CI asserts complete equality, not that cutoff.
The full-suite durations (6.84 s baseline, 6.03 s final Node 24) use different
suite sizes and shared host load; **no runtime speedup is claimed**.

The unchanged streaming WAV path was remeasured with a 128 MiB fixture:
**2,108,957 peak traced Python bytes**, byte-identical to whole-file conversion.
The benchmark's historical whole-file implementation used 134,234,838 traced
bytes; that memory improvement belongs to the September work, not this pass.
[Measurement](evidence/2026-10-12/wav-memory.json). Mixer/decoder hot paths are
unchanged. No new cache or misleading wall-clock CI budget was added.

Sidecar stderr now bypasses per-chunk JavaScript callbacks and synchronous appends
(code-supported work reduction, not a measured latency claim). Full diagnostics
remain on disk. Existing subprocess/HTTP output-bound tests still pass. No model
input/output tokens are involved, so no token budget or savings estimate applies.

Dependency sources: [undici 6.29.0](https://github.com/nodejs/undici/releases/tag/v6.29.0)
and [source-map-js 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2).
Registry audit details and advisory URLs are retained in baseline evidence.

## Verification commands and results

Local commands used the supported runtime explicitly, since ambient Node is 26:

```sh
export PATH=/Users/robertdevore/.nvm/versions/node/v24.20.0/bin:$PATH
node /Users/robertdevore/.cache/node/corepack/v1/pnpm/9.15.0/bin/pnpm.cjs install --frozen-lockfile
node /Users/robertdevore/.cache/node/corepack/v1/pnpm/9.15.0/bin/pnpm.cjs verify
node /Users/robertdevore/.cache/node/corepack/v1/pnpm/9.15.0/bin/pnpm.cjs audit --json
node scripts/verify-release.mjs
node scripts/verify-cli.mjs
python3 -m unittest discover -s packages/audio/python -p 'test_*.py'
python3 -m py_compile packages/audio/python/discord_native_sidecar.py
python3 packages/audio/python/discord_native_sidecar.py --probe
python3 scripts/benchmarks/wav-memory.py
PATH=/Users/robertdevore/.nvm/versions/node/v22.22.0/bin:$PATH node node_modules/vitest/vitest.mjs run
node node_modules/prettier/bin/prettier.cjs --check .
git diff --check
```

All passed after fixes: format/build/types, **129 tests on Node 24 and Node 22**,
8 Python tests, release metadata, receiver probe, zero audit advisories, 17 CLI
commands and WAV sample equality. [Final suite](evidence/2026-10-12/final-verify.txt),
[Node 22](evidence/2026-10-12/node22-tests.txt),
[Python](evidence/2026-10-12/final-python.txt),
[CLI receipt](evidence/2026-10-12/cli-smoke.txt),
[final advisory audit](evidence/2026-10-12/dependency-audit-final.json).

Targeted regression commands used `node node_modules/vitest/vitest.mjs run` with
`apps/bot/src/session-manager.test.ts`, `packages/exporters/src/exporters.test.ts`,
`packages/core/src/core.test.ts`, `packages/audio/src/audio.test.ts`, and
`apps/cli/src/cli.test.ts`, as shown in the red receipts. The full suite supersedes
those targeted runs. Formatting used `node node_modules/prettier/bin/prettier.cjs
--write` on affected files only.

Dependency update command was `pnpm update -r undici source-map-js --depth Infinity`.
It also refreshed unrelated transitive packages; those unrelated changes were
removed before frozen installation and final verification. Only the two intended
package versions and their verified integrity entries changed.

Strata contract verification (sibling read-only CLI, no note write):
`npm run strata -- --dry-run --json notes create --file /Users/robertdevore/2026/resound/AGENTS.md`
from `/Users/robertdevore/2026/strata`. The CLI returned a valid `notes.create`
request. Its implementation exposes `create`, not `add`.

`docker info --format '{{.ServerVersion}}'` failed because the daemon socket was
absent. The existing container CI job remains; local container verification is
not claimed. No external audio service or actual Discord channel was contacted.

## Compatibility and remaining work

- **Public APIs:** method signatures retained; invalid input and shutdown error
  behavior tightened. Session resolution may now throw on ambiguity.
- **CLI:** command names/options and exit-code meanings retained. Large stdout
  drains fully. New developer command `pnpm test:cli` requires a prior build.
- **Formats/schemas:** canonical session schema **1.2.0** and export formats
  unchanged. Ambiguous artifact declarations rejected.
- **Configuration/environment:** no new variables; existing timeout values are
  validated before sidecar startup. Default Strata command changed as documented;
  explicit user configuration is preserved.
- **External consumers:** complete valid sessions remain compatible. Callers
  relying on partial recovery, ambiguous references, colliding paths, invalid
  timers or the implicit old Strata default must correct those inputs.
- **Cross-repository requirements:** none. Strata CLI source was inspected to
  repair this repository's adapter; no Strata change is required. TotalRecall
  remains an explicitly configurable/scaffolded sink, not a newly verified ingest
  integration. No sibling writes or ecosystem migrations.
- **P0/P1:** no known unresolved defect introduced by this pass.
- **P2 verification limitation:** live private-channel/device/provider acceptance
  still needs an operator-designated setup and consenting participants. Local
  Docker daemon unavailable. These limits predate this pass.
- **P3 / not worth changing:** retained optional adapters, simplistic documented
  summaries, and Kujo scaffolds; no evidence warrants deletion or redesign.
- **Needs more evidence:** generalized latency/RSS claims or production receive
  quality; synthetic checks and Python allocation tracing are not live/RSS proof.

SignalBox: no captures warranted. The live acceptance limitation and operational
retention responsibilities were already recorded; completed repairs and routine
verification belong in Strata, not new captures.
