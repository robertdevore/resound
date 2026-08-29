# ReSound Production Release Checklist

- [x] Wire Discord voice-state joins/leaves into persisted participant and consent events with visible late-join announcements.
- [x] Enforce safe slash-command authorization and session-owner control without breaking legitimate operators.
- [x] Make transcript delivery private/configurable and remove host filesystem paths from Discord responses.
- [x] Add graceful shutdown, interrupted-session recovery, and durable last-session export behavior.
- [x] Provide a supported, reproducible source installation and self-hosted service lifecycle.
- [x] Make the documented package-manager contract reliable across supported installs.
- [x] Change defaults so real capture is opt-in and safe production paths are explicit.
- [x] Add Python-sidecar, clean-install, platform, lifecycle, and Discord interaction verification proportional to runtime risk.
- [x] Add production repository governance, security guidance, contribution guidance, and release criteria.
- [x] Cut a current release-ready version from all fixes with accurate changelog and release notes.
- [x] Pass install, lint/format, typecheck, tests, build, audit, smoke, packaging, and release gates.
- [x] Commit in small meaningful commits, push, and leave the working tree clean.
