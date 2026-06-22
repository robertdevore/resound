# Resound × Kujo

Kujo is Resound's workflow / spec / verification layer — **not** the low-level
Discord voice or audio implementation layer.

This folder holds declarative specs, workflows, and checks. They are scaffolds:
if a real Kujo runner is available in the workspace, wire these files to it. The
**executable counterparts** ship today in [`packages/kujo`](../packages/kujo)
and run via `resound validate <session>` and in CI.

```
.kujo/
  specs/      what a valid session / segment is
  workflows/  how a recording becomes a transcript becomes a portable artifact
  checks/     enforceable invariants (consent, export completeness, validity)
```

If RunLedger or ChangeBucket are available, the `transcribe-session` and
`export-session` workflows can emit completed sessions as verifiable run
artifacts (see the `runledger:` hooks in those files).
