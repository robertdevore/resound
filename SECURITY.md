# Security Policy

## Supported versions

Security fixes are provided for the latest tagged release. Self-hosters should
upgrade promptly and keep Node.js, Python, Discord dependencies, and the host OS
patched.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's **Report a
vulnerability** button in the repository Security tab to submit a private report.
Include the affected version, impact, reproduction steps, and any suggested fix.

You should receive an acknowledgement within seven days. Confirmed reports will
be coordinated privately until a fix is available. Please do not access other
people's Discord servers, audio, transcripts, tokens, or systems while testing.

## Security boundaries

- Discord tokens and transcription API keys must remain in the host environment;
  ReSound never needs them in a transcript directory.
- Starting a session requires Discord **Manage Server** permission or an explicit
  operator allow-list entry. The session owner and operators control the session.
- Transcript delivery is ephemeral by default. Public channel delivery is an
  explicit administrator choice.
- ReSound stores audio and transcripts unencrypted on the self-hosted machine.
  Host access controls, backups, retention, and deletion remain the operator's
  responsibility.
- Recording laws and community consent policies vary. ReSound provides visible
  announcements and an audit trail, but operators remain responsible for lawful
  use.
