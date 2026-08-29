# ReSound Production Release Checklist

- [ ] Wire Discord voice-state joins/leaves into persisted participant and consent events with visible late-join announcements.
- [ ] Enforce safe slash-command authorization and session-owner control without breaking legitimate operators.
- [ ] Make transcript delivery private/configurable and remove host filesystem paths from Discord responses.
- [ ] Add graceful shutdown, interrupted-session recovery, and durable last-session export behavior.
- [ ] Provide a supported, reproducible source installation and self-hosted service lifecycle.
- [ ] Make the documented package-manager contract reliable across supported installs.
- [ ] Change defaults so experimental Discord-native capture is opt-in and production-safe paths are explicit.
- [ ] Add Python-sidecar, clean-install, platform, lifecycle, and Discord interaction verification proportional to runtime risk.
- [ ] Add production repository governance, security guidance, contribution guidance, and release criteria.
- [ ] Cut a current release-ready version from all fixes with accurate changelog and release notes.
- [ ] Pass install, lint/format, typecheck, tests, build, audit, smoke, packaging, and release gates.
- [ ] Commit in small meaningful commits, push, and leave the working tree clean.
