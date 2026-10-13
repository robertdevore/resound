# Working on Resound

Resound is a self-hosted TypeScript workspace with a Python Discord receiver.
Read `docs/architecture.md` for the package graph and `docs/providers.md` for
runtime limits. Canonical data types live in `packages/core/src/types.ts`.

- Use Node 20, 22, or 24 and the pinned pnpm 9.15.0. Run `pnpm install --frozen-lockfile`.
- `pnpm verify` checks formatting, builds, workspace types, and all TypeScript tests.
- After building, `pnpm test:cli` exercises the built CLI with synthetic sessions.
- Select tests with `pnpm exec vitest run <test-file>`. Tests resolve workspace
  source; no build is needed for selective tests.
- Run `python3 -m unittest discover -s packages/audio/python -p 'test_*.py'`
  for offline sidecar tests. Real receiver readiness additionally requires the
  pinned `requirements.txt`, libopus, and the sidecar `--probe` command.
- Run `pnpm release:check` for workspace version consistency and `pnpm audit`
  for dependency advisories. Neither substitutes for live acceptance.
- Use synthetic temporary audio/session fixtures. Do not read `.env`, existing
  transcripts, or model weights as test data. Follow `SECURITY.md` boundaries.
- Keep recorder lifetime, session state, and consent durable. Never omit missing
  speaker audio silently or retry remote transcription/ingest automatically.
- Preserve schema 1.2.0 and explicit command overrides. Export replacements are
  atomic per file, not a multi-file transaction or a power-loss guarantee.
- Save audit evidence under `docs/audits`; preserve historical baselines. Current
  offline tests do not prove live Discord/device/provider acceptance.
