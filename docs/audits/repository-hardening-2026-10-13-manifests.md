# Resound manifest validation audit

- Branch: `codex/manifest-validation-audit`.
- Starting SHA: `b9c5a12fbe9a9f669bdf6f740baf4ef503c7b4da`, clean updated main after PR16.
- Ending implementation SHA: `4d5cebebaad3c58a42c64607f289b80054a5a98d`. The following documentation commit preserves this audit evidence.
- Purpose: repeat the attached deep audit; fix demonstrated remaining defects while preserving supported behavior.
- Integrations: Discord.js, pinned Pycord/DAVE Python receiver, ffmpeg/macOS capture, local Whisper, optional OpenAI-compatible transcription, filesystem/stdout/webhook/Strata/TotalRecall delivery. Node20/22/24 and pnpm9–11; version1.0.1/schema1.2.0 unchanged.

## Baseline and review scope

Before edits, `pnpm verify` passed formatting, builds, workspace types and 196
TypeScript tests. Built CLI smoke passed 19 commands and preserved 2,600,000 piped
bytes; eight Python tests passed. Registry audit found zero advisories across
156 dependencies. Fetch confirmed zero ahead/behind on main.

Inspected canonical types, manifest/JSONL validation, consent metadata, session
creation/loading/path confinement, CLI validate/export/sink dispatch, bot recovery,
recorder process ownership and timing, provider scheduling/configuration, export
projections and sink behavior. Rechecked shell-free command execution, bounded
previews, request deadlines, Python streaming, package scripts, CI/release inputs,
Kujo scaffold/executable checks, architecture/security/operator docs and AGENTS.md.
Prior audit artifacts and unchanged-code regression tests remain useful evidence;
new fault injection focuses on the manifest boundary that lacked nested validation.
No real meeting data, credentials or model weights were used.

## Demonstrated changes

| Problem / root cause                                                                                                                                                                                                | Implementation and files                                                                                                                                                                                                                    | Regression evidence                                                                                                                                                                                              | Compatibility and impact                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest validation only checked some containers and required-key presence. Null participant/consent rows, wrong scalar types, broken recorder/provider records and malformed track timing could be reported valid. | `packages/core/src/validation.ts` checks object shapes, required nested strings, optional strings when present, string warning/health entries and finite nonnegative track times. Small shared local checks avoid repeating row validation. | `manifest-validation.test.ts`: 30 cases covering malformed input, on-disk validation, nonfinite times and positive compatibility cases. Initial suite reproduced 23 failures / two passes before implementation. | Same ValidationResult/API/schema. Invalid data now receives indexed field errors. Empty placeholder strings, custom sources, extension fields, fractional/zero timing and legacy omitted tracks remain supported. |
| A non-string schema version could throw during warning interpolation instead of returning a validation error.                                                                                                       | Only interpolate string schema versions; malformed values follow ordinary type validation.                                                                                                                                                  | Object with non-callable toString returns an error without throwing.                                                                                                                                             | Valid version strings and older-version warnings unchanged.                                                                                                                                                       |
| CLI validation exited successfully for a portable session whose participants contained null.                                                                                                                        | `scripts/verify-cli.mjs` creates synthetic corruption, requires exit1 and indexed diagnostic, then restores the fixture. Usage docs describe structural validation.                                                                         | Built baseline CLI returned exit0 and failed the new smoke assertion; rebuilt CLI passes.                                                                                                                        | Only malformed input changes exit behavior. Successful CLI output/flags and serialization stay unchanged.                                                                                                         |

No validation was added implicitly to `readManifest`/`loadSession`; this change
strengthens the explicit validator and its CLI/Kujo callers. It validates structure,
not the truth of consent records, live capture readiness, or every semantic value
in an extensible manifest. No external dependency or schema framework was added.

## Measurements and efficiency

| Dimension                       | Before                    | After                        |
| ------------------------------- | ------------------------- | ---------------------------- |
| TypeScript cases                | 196 pass                  | 226 pass (+30)               |
| CLI smoke                       | 19 commands               | 20 commands, all pass        |
| Piped stdout                    | 2,600,000 bytes preserved | Same                         |
| Python tests                    | 8 pass                    | 8 pass                       |
| Dependency surface              | 156, zero advisories      | Unchanged manifests/lockfile |
| Corrupt manifest CLI validation | exit0                     | exit1 with field diagnostic  |

The unchanged streaming WAV benchmark produced byte-identical output for 128 MiB,
with 2,108,957 peak traced bytes and 0.583 s median of three runs. Its historical
whole-file comparator used 134,234,838 bytes and 0.973 s. That comparator is not
the pre-edit implementation; **no new performance improvement is claimed**.

Validation adds linear work in already-parsed manifest rows. It does not copy
large artifacts, mutate inputs, schedule subprocesses/network requests, or introduce
caches/retries. Reviewed whole-transcript export/sink buffering and sequential
file-backed uploads; no measured bottleneck justified API or algorithm changes.
Retained diagnostics and host quotas remain operator responsibilities.

AGENTS.md is already compact and provides selective verification commands. Kujo
files are documented scaffolds with executable checks in the package. There is no
active LLM replay/MCP registration layer to optimize. New errors identify field
paths without dumping malformed data; logs stay in the evidence directory. No
token/output percentage or latency improvement is claimed.

## Boundaries and contracts

Reviewed external JSON, operator paths/commands/endpoints, private file replacement,
Discord authorization/consent metadata, recorder lifetime and failure recovery.
This is correctness hardening of an explicit validation boundary, not a claim of
a demonstrated remote exploit. No security checks, assertions or diagnostics were
weakened. Valid consumers require no migration.

- Public API/signatures: unchanged.
- CLI: malformed manifest structures now fail validation with exit1; successful behavior unchanged.
- File formats/schema: unchanged schema1.2.0; existing optional/extension fields preserved.
- Configuration/environment variables/network protocols: unchanged.
- Dependencies/package versions: unchanged.
- Cross-repository requirements: none; no sibling implementation modified.

## Commands and evidence

Node24.20.0 and pnpm9.15.0 locally. Logs are in
[evidence/2026-10-13-manifests](evidence/2026-10-13-manifests/).

| Command                                                                                                                                              | Result                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `git fetch origin`; `git rev-list --left-right --count HEAD...origin/main`                                                                           | Clean baseline, 0/0                                                     |
| `pnpm verify` before/after                                                                                                                           | PASS: format/build/workspace types/full tests                           |
| `pnpm test:cli` baseline                                                                                                                             | PASS: 19 commands                                                       |
| `pnpm exec vitest run packages/core/src/manifest-validation.test.ts` before fix                                                                      | Expected fail: 23 failing, two passing                                  |
| `pnpm test:cli` with new smoke against baseline build                                                                                                | Expected fail: actual exit0, required exit1                             |
| `pnpm exec vitest run packages/core/src/core.test.ts packages/core/src/manifest-validation.test.ts packages/kujo/src/kujo.test.ts` after initial fix | PASS: 59 cases; five additional boundary cases pass in final full suite |
| `pnpm test:cli` after rebuild                                                                                                                        | PASS: 20 commands, byte preservation                                    |
| `python3 -m unittest discover -s packages/audio/python -p 'test_*.py'` before/after                                                                  | PASS: eight cases                                                       |
| `pnpm audit --json`                                                                                                                                  | PASS: zero advisories                                                   |
| `python3 scripts/benchmarks/wav-memory.py`                                                                                                           | PASS: byte equality and baseline metrics above                          |
| `pnpm release:check`                                                                                                                                 | PASS: v1.0.1 across nine packages                                       |
| Targeted `pnpm exec prettier --write`, `pnpm format:check`, `git diff --check`                                                                       | PASS                                                                    |

Inspection used targeted `rg`, `cat`, `sed` and Git reads. Existing CI runs the new
cases on Node20/pnpm9 Linux, Node22/pnpm11 Linux, Node22/pnpm9 macOS, plus pinned
Python sidecar/probe and Docker build. The published PR carries remote results.

## Remaining assessment

- P0/P1/P2: no newly demonstrated unresolved issue from this pass.
- Needs more evidence: live macOS devices, Discord/DAVE, Whisper models and remote
  provider acceptance still require operator setup. Offline/CI proof has those limits.
- P3: no new required follow-up. Host retention/quotas and per-file rather than
  multi-artifact atomicity remain existing deployment considerations.
- Not worth changing: unmeasured micro-optimizations, schema framework adoption,
  blanket rejection of extension fields, or removing compatibility scaffolds.
- SignalBox: no captures warranted; all new reproduced failures were resolved.
