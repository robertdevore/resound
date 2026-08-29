# Self-hosting the ReSound Discord bot

ReSound runs entirely on infrastructure you control. A Linux server, VPS, NAS,
Docker host, or local machine can run one bot for one or more Discord servers.
Audio, transcripts, credentials, and backups never pass through a ReSound-hosted
service.

## 1. Create the Discord application

In the Discord Developer Portal:

1. Create an application and bot, then enable **Server Members Intent**.
2. Generate an install URL with `bot` and `applications.commands` scopes.
3. Grant only **View Channels**, **Send Messages**, **Attach Files**, and
   **Connect**. ReSound does not need Administrator.
4. Install the bot into your server. Keep its token secret.

Members with Discord **Manage Server** can operate ReSound. Delegate without
granting that permission by setting `RESOUND_OPERATOR_USER_IDS` or
`RESOUND_OPERATOR_ROLE_IDS` to comma-separated IDs. The person who starts a
session remains its owner.

## 2. Configure

```bash
git clone https://github.com/robertdevore/resound.git
cd resound
cp .env.example .env
```

Set at least:

```dotenv
DISCORD_TOKEN=replace-me
DISCORD_CLIENT_ID=replace-me
DISCORD_GUILD_ID=replace-me
RESOUND_BOT_MODE=discord
RESOUND_DISCORD_RECEIVER_BACKEND=pycord
RESOUND_TRANSCRIBER=local-whisper
RESOUND_WHISPER_MODEL=/models/ggml-base.en.bin
```

The template deliberately defaults to mock recording and mock transcription so
a copied configuration cannot silently record or upload real conversations.
For a remote OpenAI-compatible transcriber, set its base URL and API key instead.

Transcript delivery defaults to an ephemeral Discord response. Set
`RESOUND_TRANSCRIPT_DELIVERY=channel` only when everyone with channel access may
read every transcript. Set it to `disabled` to keep files solely on the host.

## 3. Run with Docker Compose

Docker installs Node, Python, the pinned DAVE-aware Pycord receiver, and libopus.
Mount your Whisper executable and model into the container if you use local
Whisper, or configure an OpenAI-compatible transcription endpoint.

```bash
docker compose build
chmod 700 transcripts
docker compose run --rm resound node apps/bot/dist/register.js
docker compose up -d
docker compose logs -f resound
```

The Compose file persists `./transcripts`, makes the container filesystem
read-only, drops privilege to the `node` user, blocks privilege escalation, and
restarts after failures. Protect `.env` and the transcript directory with host
permissions and encrypted backups.

## 4. Run directly

Install Node.js 20/22/24, pnpm 9–11, Python 3.10+, libopus, ffmpeg, and Git:

```bash
corepack enable
pnpm install --frozen-lockfile
python3 -m pip install -r packages/audio/python/requirements.txt
pnpm build
python3 packages/audio/python/discord_native_sidecar.py --probe
pnpm bot:register
pnpm bot:start
```

For Linux service management, adapt [deploy/resound.service](../deploy/resound.service),
put environment values in `/etc/resound/resound.env`, store artifacts under
`/var/lib/resound`, and run the service as a dedicated `resound` user.

## 5. Acceptance check

Use a private test voice and text channel first:

1. Run `/resound doctor`; every required dependency must pass.
2. Join voice and run `/resound start title:Acceptance test` as an operator.
3. Confirm the public recording notice appears. Have two people speak distinct
   phrases, join/leave once, and use `/resound consent`.
4. Confirm an unauthorized member cannot pause, stop, export, or recover.
5. Run `/resound stop`. Confirm both speakers appear in the private transcript,
   no host filesystem path appears in Discord, and the manifest records the
   voice channel, initial occupants, join/leave events, and audio tracks.
6. Restart during a second recording, then run `/resound recover` and verify the
   finalized audio becomes an exportable transcript.

Do not use the bot for real meetings until this check passes in your server.

## Operations

- Upgrade with `git pull`, rebuild, run `pnpm verify`, register commands when
  command definitions changed, and restart the service.
- Monitor process restarts, free disk space, sidecar warnings, transcription
  failures, and sessions left in `interrupted`/`recoverable` state.
- Back up the transcript directory according to your retention policy. Files are
  unencrypted at rest unless the host volume is encrypted.
- Rotate a Discord token immediately if it is exposed. Never paste credentials,
  private transcript content, or audio into an issue.
- Stop the bot before maintenance. SIGINT/SIGTERM finalizes current audio and
  marks unfinished transcription recoverable.
