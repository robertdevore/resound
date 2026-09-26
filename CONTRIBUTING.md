# Contributing

Thank you for improving ReSound. Open an issue before a large behavioral change
so scope and compatibility can be agreed first. Security reports belong in the
private channel described in [SECURITY.md](SECURITY.md).

## Development

Use Node.js 20, 22, or 24 and pnpm 9 through 11.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Keep changes focused, add tests for behavior, preserve consent and private-data
defaults, and update user documentation when configuration or commands change.
Pull requests must pass CI and should explain user impact and verification.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Run the offline Python audio checks when changing capture or finalization:

```bash
python3 -m unittest discover -s packages/audio/python -p 'test_*.py'
python3 scripts/benchmarks/wav-memory.py
```

The memory regression uses a structural bound, not a timing threshold. Benchmark
latencies are informational and machine-dependent. See
[the repository audit](docs/audits/repository-hardening.md) for reviewed boundaries,
verification receipts, and remaining deployment checks.
