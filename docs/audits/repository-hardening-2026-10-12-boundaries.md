# Resound transcript-boundary audit — 2026-10-12

- Repository: `robertdevore/resound`, `/Users/robertdevore/2026/resound`.
- Starting branch/SHA: `main`, `5bb8da8c1190eae3cdc45b9d88f133d907652907` (PR #14 merged).
- Working branch: `codex/transcript-boundary-audit-20261012`.
- Ending implementation SHA: `253f2f48c2c810322e2e2f3b8fc660d1f9d1702f`. The subsequent documentation/evidence commit is
  available in this file's Git history.
- Purpose: rerun the supplied integrity audit against updated main, fixing
  remaining demonstrated boundary failures without rewriting established APIs.
- Prior evidence: [repeat audit](repository-hardening-2026-10-12-repeat.md), retained.
- This pass's evidence: [boundary audit logs](evidence/2026-10-12-boundaries).

## Baseline and inspection

Resound is a self-hosted TypeScript CLI/Discord bot plus Python voice sidecar.
Its important paths remain recorder → transcriber → canonical JSONL/exporters →
optional sinks. Core schema is 1.2.0 and package version 1.0.1. Dependencies and
integrations include Discord.js/voice, pinned Pycord/DAVE/PyNaCl, ffmpeg, local
Whisper or an optional compatible HTTP endpoint, Strata and TotalRecall commands.
Kujo declarative contracts have local executable validation counterparts.

Fetched origin and confirmed main had zero ahead/behind. Baseline passed format,
build, workspace types, 139 TypeScript tests, eight Python tests and 17 built CLI
smoke commands. No existing suite failure was observed. Tests added before fixes
reproduced 26 provider/timestamp failures plus one destructive delivery failure;
raw red logs distinguish these from regressions introduced by this work.

Reviewed current core storage/path/JSONL/time/validation/subprocess/HTTP helpers,
local and remote provider parsing/resolution/tracks, export projections and
filesystem/stdout/webhook/command sinks. Rechecked CLI lifecycle and failure
persistence from PR14, bot permission/guild exclusion/shutdown ownership and
recovery, receiver deadlines and streaming PCM/WAV architecture from prior
passes. Reviewed package manifests, CI matrix, Docker/release contracts, tests,
synthetic fixtures, benchmark, AGENTS.md, security policy, provider and usage docs.
No credentials, real meeting audio/transcripts or model weights were inspected.

## Changes

| Demonstrated problem / root cause                                                                                                                                                                             | Implementation / files                                                                                                                                                                                                                 | Regression coverage                                                                                                                                                                                                                                                        | Compatibility and impact                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local and HTTP-success JSON with no transcript shape silently returned an empty result. Type assertions accepted malformed rows and coerced timestamps; bad log-probability could produce invalid confidence. | `transcribers/src/provider-json.ts` validates recognized shapes/row text/numeric timestamps and optional remote confidence. Local Whisper parsers and the compatible client share it; obsolete casts/helper and unused import removed. | Dialect matrix covers missing/null/array/error bodies, malformed collections/rows, string offsets, silence and optional timestamps. Loopback HTTP covers error-shaped success, string offsets and bad confidence. Existing successful local/HTTP parsing tests stay green. | Public signatures unchanged. Explicit empty arrays, text-only output, empty text, omitted/null optional offsets and confidence defaults remain supported. Malformed outputs now fail with bounded field-specific messages, without echoing response payloads. |
| Canonical JSONL accepted timestamp strings that subtitle export rejected, and huge hour values overflowed to Infinity.                                                                                        | `core/src/jsonl.ts` reuses the existing timestamp parser before accepting rows; `time.ts` rejects a non-finite total.                                                                                                                  | Five new canonical tests plus built CLI validation/export failure checks.                                                                                                                                                                                                  | Valid minute/second and fractional forms preserved. Empty end timestamp retains existing unknown-end behavior. Invalid input now fails at validation/load rather than later export or delivery.                                                               |
| Failed filesystem copy could replace a complete destination with partial bytes. Direct copy overwrote before success was known.                                                                               | `sinks/src/filesystem.ts` copies to a private sibling staging directory, chmods, then renames; finally cleans staging. Manifest copied last.                                                                                           | Fault injection wrote partial bytes and threw: before, old content was lost; after, old content survives and staging is removed. Existing nested-session validation roundtrip now also checks private mode.                                                                | Destination layout, sink result and partial-session support unchanged. Atomic per file, not an all-files transaction or fsync durability. File-backed copying avoids new whole-file JS buffering.                                                             |

Provider and usage docs describe changed failure behavior and compatibility.
Existing CI includes all new regression tests; CLI smoke adds two public failure
commands. No new dependencies, caches, background work or retry behavior.

## Measured evidence and resource review

| Dimension                                 | Before                                               | After / interpretation                                 |
| ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| TypeScript tests                          | 139 pass                                             | 169 pass, 30 new cases                                 |
| CLI smoke                                 | 17 commands                                          | 19 commands; all 2,600,000 piped bytes still preserved |
| Python tests                              | 8 pass                                               | 8 pass; receiver implementation unchanged              |
| Registry audit                            | 0 advisories / 156 dependencies                      | Dependency/lockfile unchanged                          |
| Current streaming WAV path, 128 MiB input | 2,108,957 peak traced bytes; 0.527 s median of three | Unchanged code; byte-identical result reconfirmed      |

The benchmark also runs the historical whole-file comparator: 134,234,838 peak
traced bytes and 0.457 s median. It is not this pass's baseline implementation.
No runtime or memory improvement is claimed. Validation adds linear checks to
already parsed rows. Atomic delivery requires transient room for old and new
copies, an intentional data-integrity tradeoff. Raw test timing is evidence of
execution, not a portable performance budget.

Reviewed bounded command/provider diagnostics, finite process/request lifetime,
sequential file-backed uploads, speaker-track completeness and PCM streaming.
No measured bottleneck justified changing concurrency, caching, mixing or summary
algorithms. Retained diagnostics and host disk quotas remain operator concerns.

Agent instructions remain compact with selective verification commands. This repo
has no live LLM prompt replay or MCP tool registration to shrink. Invalid provider
errors now identify a field rather than dump provider data; this is a code-supported
output bound, not a claimed token percentage. Logs remain in evidence files.

## Contracts and trust boundaries

Reviewed operator-configured commands/endpoints/paths, shell-free execution,
manifest confinement, canonical row parsing, provider JSON, private artifact
replacement, Discord operator/session-owner policy, consent and operation
serialization. Changes address correctness/data-integrity boundaries, not a claim
of a newly established remote exploit. No security checks were weakened.

- Public API: existing signatures and return shapes preserved; shared parser is
  internal to the package, not added to its index exports.
- CLI: malformed timestamps now produce validation/export failure (exit 1);
  successful behavior unchanged. Delivery errors still surface.
- Schema/file formats: unchanged schema 1.2.0; no new manifest fields.
- Config/environment/network interfaces: unchanged.
- External consumers: no migration for valid data. Wrappers must emit recognized
  transcript JSON with correctly typed fields instead of error-shaped success.
- Cross-repository work: none required; sibling implementations untouched.

## Exact verification commands

Used Node 24.20.0 and pnpm 9.15.0, with synthetic fixtures/loopback servers only.

| Command                                                                                                                                                                                           | Result                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `git fetch origin` and `git rev-list --left-right --count HEAD...origin/main`                                                                                                                     | Clean baseline, 0/0                                 |
| `pnpm verify` before edits                                                                                                                                                                        | PASS: formatting, build, workspace types, 139 tests |
| `pnpm test:cli` before edits                                                                                                                                                                      | PASS: 17 commands                                   |
| `python3 -m unittest discover -s packages/audio/python -p 'test_*.py'` before/after                                                                                                               | PASS: eight tests                                   |
| `pnpm audit --json`                                                                                                                                                                               | PASS: zero advisories                               |
| `python3 scripts/benchmarks/wav-memory.py`                                                                                                                                                        | PASS: byte equality and metrics above               |
| `pnpm exec vitest run packages/core/src/core.test.ts packages/transcribers/src/provider-validation.test.ts packages/transcribers/src/http.test.ts` before fixes                                   | EXPECTED FAIL: 26 cases                             |
| `pnpm exec vitest run packages/sinks/src/sinks.test.ts` before sink fix                                                                                                                           | EXPECTED FAIL: one case                             |
| `pnpm exec vitest run packages/core/src/core.test.ts packages/transcribers/src/provider-validation.test.ts packages/transcribers/src/http.test.ts packages/transcribers/src/transcribers.test.ts` | PASS: 77 focused cases                              |
| `pnpm verify` after fixes                                                                                                                                                                         | PASS: formatting, build, workspace types, 169 tests |
| `pnpm test:cli` after fixes                                                                                                                                                                       | PASS: 19 commands, 2,600,000 bytes preserved        |
| `pnpm release:check`                                                                                                                                                                              | PASS: version 1.0.1 across nine packages            |
| `pnpm format:check` and `git diff --check` after evidence edits                                                                                                                                   | PASS                                                |

Source inspection used targeted `rg`, `cat`, `sed`, Git status/diff and existing
prior audit artifacts. Targeted edits were formatted with `pnpm exec prettier
--write` on changed files. No tests/assertions were disabled or relaxed.

## Remaining work assessment

- P0/P1/P2: no unresolved newly demonstrated issue from this pass.
- Needs more evidence: live Discord/DAVE, actual macOS devices, real Whisper
  models and external providers still need operator setup. Offline tests cannot
  establish live acceptance.
- Not worth changing: unmeasured micro-optimizations, new caching, broad API
  redesign and removal of compatibility adapters without consumer evidence.
- P3: no new required follow-up; host retention, aliases and quotas remain
  existing operator responsibilities. Per-file atomicity does not claim a
  multi-artifact transaction, durability after power loss or host sandboxing.
- SignalBox: no captures warranted. All new reproduced failures were resolved;
  known deployment limitations do not warrant duplicate captures.
