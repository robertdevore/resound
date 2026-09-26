# Usage

## Setup

```bash
nvm use            # Node 20+ (repo tested on 22)
corepack enable    # provides pnpm
pnpm install
pnpm build
pnpm test
cp .env.example .env   # without .env, Resound falls back to mock mode
```

## Environment variables

| Variable                                    | Default                   | Purpose                                                                                    |
| ------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `RESOUND_OUTPUT_DIR`                        | `./transcripts`           | Where session folders are written                                                          |
| `RESOUND_TRANSCRIBER`                       | `mock`                    | `mock` \| `local-whisper` \| `openai-compatible` \| `openai` \| `deepgram` \| `assemblyai` |
| `RESOUND_TRANSCRIBER_MODEL`                 | provider default          | Override the model                                                                         |
| `RESOUND_WHISPER_COMMAND`                   | `whisper-cli`             | local-whisper binary                                                                       |
| `RESOUND_WHISPER_FORMAT`                    | `whisper.cpp`             | `whisper.cpp` \| `openai-whisper`                                                          |
| `RESOUND_WHISPER_MODEL`                     | —                         | local-whisper model name / ggml path                                                       |
| `RESOUND_OPENAI_BASE_URL`                   | api.openai.com            | OpenAI-compatible endpoint base URL                                                        |
| `RESOUND_OPENAI_API_KEY` / `OPENAI_API_KEY` | —                         | key for the compatible endpoint                                                            |
| `DEEPGRAM_API_KEY` / `ASSEMBLYAI_API_KEY`   | —                         | For scaffolded providers                                                                   |
| `DISCORD_TOKEN` / `DISCORD_CLIENT_ID`       | —                         | Discord bot                                                                                |
| `DISCORD_GUILD_ID`                          | —                         | Register slash commands to one guild (instant)                                             |
| `RESOUND_BOT_MODE`                          | `mock`                    | `mock` \| `local-capture` \| `discord` / `discord-native` \| `auto`                        |
| `RESOUND_DISCORD_RECEIVER_BACKEND`          | `pycord`                  | `auto` \| `pycord` \| `discordjs` for Discord-native bot receive                           |
| `RESOUND_DISCORD_PYTHON`                    | `python3` on PATH         | Python interpreter for the Pycord sidecar                                                  |
| `RESOUND_DISCORD_PYTHONPATH`                | —                         | Extra `PYTHONPATH` entries for the Pycord sidecar                                          |
| `RESOUND_OPERATOR_USER_IDS`                 | —                         | Comma-separated Discord user IDs allowed to operate the bot                                |
| `RESOUND_OPERATOR_ROLE_IDS`                 | —                         | Comma-separated Discord role IDs allowed to operate the bot                                |
| `RESOUND_TRANSCRIPT_DELIVERY`               | `ephemeral`               | `ephemeral` \| `channel` \| `disabled`                                                     |
| `RESOUND_AUDIO_DEVICE`                      | —                         | Single local input device for `record` / local-capture                                     |
| `RESOUND_AUDIO_SYSTEM_DEVICE`               | —                         | Local system/call audio input, usually BlackHole                                           |
| `RESOUND_AUDIO_MIC_DEVICE`                  | —                         | Local microphone input                                                                     |
| `STRATA_INGEST_COMMAND`                     | `strata notes add --file` | Strata sink command                                                                        |
| `TOTALRECALL_INGEST_COMMAND`                | `totalrecall ingest`      | TotalRecall sink command                                                                   |

## CLI

Run from source with `pnpm cli <args>`, or `node apps/cli/dist/index.js` after a build.

```bash
resound init                                  # create the transcripts dir
resound doctor                                # recorder + transcriber preflight
resound audio devices                         # list macOS audio input devices
resound devices                               # backward-compatible alias
resound record --title "Team Sync"            # record system+mic audio, then transcribe (Enter/q to stop)
resound record --title "Team Sync" --preflight
resound mock "Engineering Standup"            # full mock session (record→transcribe→export)
resound transcribe meeting.m4a --title "Q3"   # transcribe an existing recorded file
resound sessions list                         # list local sessions
resound sessions show <session>               # manifest summary + first lines
resound export <session> --format md          # md | jsonl | vtt | srt | all
resound export <session> --format all         # (re)write every output in place
resound summarize <session>                   # regenerate summary.md
resound action-items <session>                # regenerate action-items.md
resound validate <session>                    # manifest + consent + outputs + Kujo checks
resound sink stdout <session>                 # print transcript.md
resound sink filesystem <session> --dest DIR  # copy artifacts elsewhere
resound sink webhook <session> --url URL      # POST JSON payload
resound sink strata <session>                 # optional; fails gracefully
resound sink totalrecall <session>            # optional/scaffolded
```

`<session>` accepts a folder path, a folder name, or a `session_id`.

### Local-only workflow

No Discord, no API key, no Strata:

```bash
resound mock "Design Review"
resound validate design-mock-...   # name printed by the mock command
resound export design-mock-... --format md > review.md
```

The session folder under `transcripts/` is a complete, portable artifact.

## Meeting workflow — transcribe an existing recording

Importing an existing recording is useful when you do not want the bot in a
voice channel or need to process historical audio.

1. **Record the meeting audio to a file.** Any of:
   - macOS screen/audio recording, OBS, QuickTime, or Audio Hijack capturing
     system output while in the Discord call;
   - a dedicated Discord recording bot that exports audio;
   - any `.m4a` / `.mp3` / `.wav` / `.webm` file.
2. **Pick a provider (local-first).** For a fully local transcript:
   ```bash
   RESOUND_TRANSCRIBER=local-whisper
   RESOUND_WHISPER_MODEL=./models/ggml-base.en.bin   # see providers.md
   ```
   Or use any OpenAI-compatible endpoint instead:
   ```bash
   RESOUND_TRANSCRIBER=openai-compatible
   RESOUND_OPENAI_BASE_URL=https://api.groq.com/openai/v1
   RESOUND_OPENAI_API_KEY=...
   ```
3. **Transcribe into a full session:**
   ```bash
   resound transcribe ./meeting.m4a \
     --title "Q3 Planning" \
     --participants "Robert,Ashley,Jelena"
   # provider can also be forced per-run:  --provider openai
   ```
4. **Use the artifacts:**
   ```bash
   resound validate file-q3-planning-1544
   resound export  file-q3-planning-1544 --format md
   resound sink strata file-q3-planning-1544     # optional
   ```

Limitations to know:

- The OpenAI REST API does not diarize, so speaker labels default to the first
  participant. Real per-speaker labels need the Discord per-user receive adapter
  or pre-split per-speaker audio files.
- OpenAI's transcription endpoint caps upload size (~25 MB). For long meetings,
  split the audio first (e.g. `ffmpeg -i meeting.m4a -f segment -segment_time 600
-c copy part-%03d.m4a`) and transcribe each part, or use a provider without
  that limit.

## Discord Workflow

There are four bot modes:

| Mode                         | What it proves / does                                                                                  | Real audio?                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `mock`                       | Slash commands, consent, session state, exports, sample transcript                                     | No                                                  |
| `local-capture`              | Slash commands control this machine's configured system/mic recorder                                   | Yes, if local audio routing works                   |
| `discord` / `discord-native` | Discord-native receive through the supported Pycord DAVE sidecar                                       | Yes                                                 |
| `auto`                       | Preflight Discord-native first, then explicit fallback to local-capture if local capture is configured | Yes, but only if one real recorder passes preflight |

For reusable real-world use, each administrator creates and invites their own
Discord application and runs ReSound on infrastructure they control.

1. Create an application at <https://discord.com/developers/applications>, add a
   bot, enable **Server Members Intent**, and copy the token and application
   (client) ID into `.env`.
2. Invite the bot with the `applications.commands` and `bot` scopes and the
   _View Channels_, _Send Messages_, _Attach Files_, and _Connect_ permissions.
3. Pick a mode in `.env`.

   For a command-only smoke test with no real audio:

   ```bash
   RESOUND_BOT_MODE=mock
   ```

   For real local capture:

   ```bash
   RESOUND_BOT_MODE=local-capture
   RESOUND_AUDIO_SYSTEM_DEVICE=1   # BlackHole/system audio from `pnpm cli devices`
   RESOUND_AUDIO_MIC_DEVICE=2      # your mic from `pnpm cli devices`
   RESOUND_TRANSCRIBER=local-whisper
   RESOUND_WHISPER_MODEL=./models/ggml-base.en.bin
   ```

   For Discord-native receive with the preferred Pycord sidecar:

   ```bash
   python3 -m pip install -U -r packages/audio/python/requirements.txt
   RESOUND_BOT_MODE=discord
   RESOUND_DISCORD_RECEIVER_BACKEND=pycord
   ```

4. Register commands and start the bot from the repository root:
   ```bash
   pnpm build
   pnpm bot:register
   pnpm bot:start
   ```
5. In Discord:
   ```
   /resound doctor
   /resound start
   /resound consent
   /resound status
   /resound stop
   # /resound stop privately delivers transcript.md by default
   ```

`/resound start` immediately announces that recording/transcription is active
(no hidden recording). New arrivals and departures are also announced and
persisted. In `RESOUND_BOT_MODE=local-capture`, the bot process must run on the
operator machine doing the local audio capture. In `RESOUND_BOT_MODE=mock`, it
produces full artifacts with a sample transcript. For production deployment,
follow [self-hosting](self-hosting.md).

After a real local capture, `/resound stop` reports independent signal checks
for the system/call track and microphone track. Both must say `audio detected`.

### Local Capture Diagnostics

Run these before trusting a meeting capture:

```bash
pnpm cli devices
pnpm cli record --title "Mic Only Test" --device <mic-index> --participants "me"
pnpm cli record --title "System Output Test" --device <blackhole-index> --participants "system"
pnpm cli record --title "Full Mix Test" --system <blackhole-index> --mic <mic-index> --participants "me,others"
```

If the mic-only test works but system-output test is silent, fix the macOS
BlackHole/Multi-Output routing before using Discord. Hearing audio in headphones
does not prove BlackHole is receiving it.

## Strata workflow (optional)

```bash
resound sink strata <session>
# or set a custom command:
STRATA_INGEST_COMMAND="strata notes add --file" resound sink strata <session>
```

If Strata is not installed the command fails gracefully and reminds you the
Markdown is already portable. To do it by hand:

```bash
strata notes add --file transcripts/2026-06-22/discord-engineering-standup-1432/transcript.md
```

## TotalRecall workflow (optional)

Resound session folders are designed for whole-folder ingest:

```bash
resound sink totalrecall <session>
# equivalently:
totalrecall ingest ./transcripts/2026-06-22/discord-engineering-standup-1432/
```

TotalRecall is not required in V1. The folder remains self-describing without it.

## Provider configuration

See [providers.md](providers.md). The short version: set `RESOUND_TRANSCRIBER`
and the matching API key. With nothing set, Resound uses the deterministic mock
provider.

### Piping and copying artifacts

`resound sink stdout <session>` writes only the Markdown artifact to stdout;
its success/failure receipt goes to stderr. Redirect stdout to preserve an exact
copy. The filesystem sink retains manifest-relative subdirectories, including
custom output paths, so copied sessions remain loadable and valid.
