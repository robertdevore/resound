# Consent

**Resound forbids hidden recording.** Consent metadata is required on every
session, and the `consent-required` check fails any session without it.

## What Resound records

Every session manifest carries a `consent_events` array. Event types:

| Type | When |
| --- | --- |
| `recording-announced` | At `/resound start` — the bot announces recording + transcription in the channel. |
| `session-consent` | Optional explicit "yes, record this session" acknowledgement. |
| `participant-joined` | Auto-logged when someone joins **while recording is active**, with a visible announcement. |
| `participant-consent` | `/resound consent` — a participant explicitly consents. |
| `participant-left` | When a participant leaves. |
| `recording-stopped` | At `/resound stop`. |

A session is considered valid only if it has at least one consent event **and** a
`recording-announced` event (enforced by `.kujo/checks/consent-required.kujo`
and `packages/kujo`).

## Late joiners

If someone joins after recording starts, Resound logs a `participant-joined`
consent event and the bot announces that transcription is active. This keeps the
audit trail honest: the record shows recording was already running when they
arrived.

## Operator responsibilities

Resound gives you the mechanics of consent; **you are responsible for the law and
policy** in your jurisdiction and community:

- Announce recording before you start, every time.
- Tell people where transcripts are stored and who can read them.
- Honor deletion requests — a session is just a folder; delete it.
- Don't repurpose transcripts beyond what participants agreed to.

The bot's announcement on `/resound start` and the per-user `/resound consent`
command exist so this is the default, not an afterthought.
