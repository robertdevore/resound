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
