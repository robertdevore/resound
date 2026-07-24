# Providers & the Discord voice constraint

## Transcription providers

Resound is **local-first**. Set `RESOUND_TRANSCRIBER`. No vendor is required and
nothing is hardcoded to a single cloud provider.

| Provider | Status | Config |
| --- | --- | --- |
| `mock` | ✅ offline, deterministic (tests/dev) | none |
| `local-whisper` | ✅ **recommended** — local, audio stays on the machine | `RESOUND_WHISPER_COMMAND`, `RESOUND_WHISPER_MODEL`, `RESOUND_WHISPER_FORMAT` |
| `openai-compatible` | ✅ any OpenAI-compatible endpoint | `RESOUND_OPENAI_BASE_URL`, `RESOUND_OPENAI_API_KEY` |
| `openai` | ✅ shorthand: compatible client → api.openai.com | `OPENAI_API_KEY` |
| `deepgram` | 🧩 scaffolded (interface only) | `DEEPGRAM_API_KEY` |
| `assemblyai` | 🧩 scaffolded (interface only) | `ASSEMBLYAI_API_KEY` |

All providers implement the `Transcriber` interface in `packages/transcribers`.
Scaffolded providers resolve by name but throw a clear "not implemented yet"
error if invoked. Adding a real provider is one new class + a `case` in
`getTranscriber()`.

### local-whisper (recommended, local-first)

Shells out to a locally installed Whisper binary so audio never leaves your
machine. Defaults to **whisper.cpp**'s `whisper-cli`:

```bash
# macOS example
brew install whisper-cpp
# download a model, e.g. base.en
curl -L -o models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# .env
RESOUND_TRANSCRIBER=local-whisper
RESOUND_WHISPER_COMMAND=whisper-cli
RESOUND_WHISPER_FORMAT=whisper.cpp
RESOUND_WHISPER_MODEL=./models/ggml-base.en.bin
```

To use the Python `openai-whisper` / `faster-whisper` CLIs instead, set
`RESOUND_WHISPER_FORMAT=openai-whisper` and `RESOUND_WHISPER_COMMAND=whisper`.
Anything else: point `RESOUND_WHISPER_COMMAND` at your binary and add flags via
`RESOUND_WHISPER_ARGS`.

### openai-compatible (optional remote expansion)

For an optional cloud/remote path that is **not** locked to OpenAI:

```bash
RESOUND_TRANSCRIBER=openai-compatible
RESOUND_OPENAI_BASE_URL=https://api.groq.com/openai/v1   # or LM Studio, vLLM, OpenRouter, a local whisper server…
RESOUND_OPENAI_API_KEY=...                                # many local servers accept any/empty token
RESOUND_TRANSCRIBER_MODEL=whisper-1
```

> Speaker labels: REST transcription APIs do not diarize, so cloud/`local-whisper`
> on a single mixed file labels everything as the first participant. Real
> per-speaker labels come from **per-speaker audio** (one file/stream per user) —
> which is exactly what the live Discord receive adapter produces, once DAVE
> receive works (below).

## ⚠️ Discord voice receive, DAVE, and E2EE — current status (Friday, July 24, 2026)

**As of Friday, July 24, 2026, live voice *receive* in third-party bots is effectively
blocked by DAVE.** This is an upstream limitation, not a Resound one.

- **DAVE is now mandatory.** Discord's MLS-based end-to-end encryption (DAVE)
  was enforced across all voice channels (enforcement March 2, 2026; rollout
  reported complete May 19, 2026). Voice is E2EE by default.
- **`@discordjs/voice` receive is broken under DAVE.** With DAVE on, bots that
  try to *receive* audio hit reconnect loops, no `speaking` events, and
  decryption failures such as `DecryptionFailed(UnencryptedWhenPassthroughDisabled)`
  and `Cannot read properties of undefined (reading 'decrypt')` in
  `VoiceReceiver.onUdpMessage`. **Sending** works; **receiving** does not.
- `@snazzah/davey` is the DAVE protocol library bundled with `@discordjs/voice`,
  but the *receive* decrypt path is not yet wired up.
- Legacy "subscribe to a user's Opus stream and decode it" snippets predate DAVE
  and will not work in DAVE-protected calls.

Sources: [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419),
[discord.js #10735](https://github.com/discordjs/discord.js/issues/10735),
[DAVE whitepaper](https://daveprotocol.com/),
[Discord blog: Bringing DAVE to all platforms](https://discord.com/blog/bringing-dave-to-all-discord-platforms).

**Tradeoffs of the available approaches**

| Approach | Notes |
| --- | --- |
| `@discordjs/voice` receive | Mature API surface for receive, but DAVE support for *receiving* is the gating question — verify the installed version's status before relying on it. Needs `prism-media` + an Opus decoder (`@discordjs/opus` or `opusscript`) and `libsodium`/`sodium-native`. |
| Bring-your-own DAVE stack | Implement/track an MLS + DAVE layer directly. Most control, most work; only justified if library support stalls. |
| Account/self-bot capture | ❌ Against Discord ToS. Not supported by Resound. |
| Out-of-band capture | Record the host's system/app audio outside Discord and feed the file to Resound's transcriber. Sidesteps DAVE entirely; loses per-user diarization. |

### What Resound does about it

1. **The reliable path today: local capture + transcription.** Capture the call
   from the operator machine (system audio, OBS, QuickTime, Audio Hijack, or the
   built-in `resound record` / `RESOUND_BOT_MODE=local-capture` flow) and run it
   through `local-whisper` or an OpenAI-compatible endpoint. This works now and
   needs no bot-side voice receive. See [usage.md](usage.md#meeting-workflow--transcribe-a-recording-works-today-no-dave).

2. **The live path is built and gated, ready for when upstream is fixed.**
   `DiscordRecorder` (`packages/audio/src/discord-recorder.ts`) implements the
   real receive pipeline: subscribe per speaker → Opus decode (`prism-media`) →
   per-utterance WAV in `audio/chunks/` (one file per user, so diarization maps
   to real `user_id`s). It is wired into the bot under `RESOUND_BOT_MODE=discord`
   and joins the caller's voice channel. Its native deps (`@discordjs/voice`,
   `prism-media`, `@discordjs/opus`) are lazy-loaded and intentionally not
   installed by default, so the supported local-capture path stays small and
   avoids a fragile native Opus build.

   Because of the DAVE receive bug above, live mode **may capture no audio**
   right now — the bot says so in its `/resound start` reply. In `auto` mode,
   Resound now falls back only to preflighted local-capture; if neither real
   recorder is ready, start fails before recording begins. When
   `@discordjs/voice` ships working DAVE receive, install the optional deps and
   set `RESOUND_BOT_MODE=discord`; **no Resound code change is required.**

To enable live mode (once upstream receive works):

```bash
pnpm --filter @resound/bot add @discordjs/voice prism-media @discordjs/opus libsodium-wrappers
RESOUND_BOT_MODE=discord pnpm bot:start
```

**Re-verify before relying on live capture:** DAVE receive support in the exact
`@discordjs/voice` version, the Opus + crypto native deps, and per-user stream
separation.

### What `local-capture` means

`RESOUND_BOT_MODE=local-capture` does not use Discord voice receive. The slash
commands run on the same operator machine that captures local audio devices
through ffmpeg/avfoundation. This mode is the recommended real-audio bot
workflow until bot-side receive is reliable:

```bash
RESOUND_BOT_MODE=local-capture
RESOUND_AUDIO_SYSTEM_DEVICE=1
RESOUND_AUDIO_MIC_DEVICE=2
pnpm bot:start
```

The operator still needs macOS audio routing that sends Discord/system output
into a capture device such as BlackHole, plus a microphone device for their own
voice.
