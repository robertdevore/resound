# Providers & the Discord voice constraint

## Transcription providers

Resound is **local-first**. Set `RESOUND_TRANSCRIBER`. No vendor is required and
nothing is hardcoded to a single cloud provider.

| Provider            | Status                                                 | Config                                                                       |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `mock`              | ✅ offline, deterministic (tests/dev)                  | none                                                                         |
| `local-whisper`     | ✅ **recommended** — local, audio stays on the machine | `RESOUND_WHISPER_COMMAND`, `RESOUND_WHISPER_MODEL`, `RESOUND_WHISPER_FORMAT` |
| `openai-compatible` | ✅ any OpenAI-compatible endpoint                      | `RESOUND_OPENAI_BASE_URL`, `RESOUND_OPENAI_API_KEY`                          |
| `openai`            | ✅ shorthand: compatible client → api.openai.com       | `OPENAI_API_KEY`                                                             |
| `deepgram`          | 🧩 scaffolded (interface only)                         | `DEEPGRAM_API_KEY`                                                           |
| `assemblyai`        | 🧩 scaffolded (interface only)                         | `ASSEMBLYAI_API_KEY`                                                         |

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
# Use more CPU threads when no explicit RESOUND_WHISPER_ARGS are set.
RESOUND_WHISPER_THREADS=8
```

To use the Python `openai-whisper` / `faster-whisper` CLIs instead, set
`RESOUND_WHISPER_FORMAT=openai-whisper` and `RESOUND_WHISPER_COMMAND=whisper`.
Anything else: point `RESOUND_WHISPER_COMMAND` at your binary and add flags via
`RESOUND_WHISPER_ARGS`.

For long Discord meetings, Resound transcribes speaker tracks sequentially by
default so multiple Whisper processes do not compete for the same CPU. The bot
posts elapsed time, completed tracks, analyzed audio, and an estimated remaining
time while `/resound stop` is finalizing. Set `RESOUND_WHISPER_ARGS` explicitly
to override the default thread setting.

#### Choosing a Whisper model

Use a **multilingual** model for international meetings. The `.en` models are
English-only; they can handle English accents, but they are not the right choice
when participants may speak other languages. The practical progression is:

| Model            | Use case                                               | Tradeoff                                                 |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `small.en`       | English-only, fastest local option                     | More recognition errors than larger models               |
| `medium`         | Recommended first upgrade for global meetings          | About 1.5 GB; slower and more CPU/RAM intensive          |
| `large-v3-turbo` | Stronger accuracy with a large-model architecture      | About 1.6 GB; benchmark locally before production use    |
| `large-v3`       | Highest accuracy target in the official Whisper family | About 3.1 GB and usually impractical on CPU-only laptops |

The official `whisper.cpp` model registry includes `medium`, `large-v3`, and
`large-v3-turbo` conversions. Model size improves recognition, but cannot
guarantee perfect transcripts: microphone quality, crosstalk, packet loss,
language switching, and overlapping speakers still matter. On this Intel Mac,
Homebrew `whisper-cli` uses CPU/BLAS rather than Metal, so `medium` is the
recommended production starting point; benchmark `large-v3-turbo` against a
representative multilingual recording before moving up again.

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
> which is exactly what the supported Discord receive adapter produces.

## Discord voice receive, DAVE, and E2EE

ReSound's supported production receiver is a pinned Pycord sidecar with DAVE
receive support. It has passed dependency probes, live DAVE connection tests,
real-voice capture, per-speaker WAV generation, and end-to-end transcription.

- **DAVE is now mandatory.** Discord's MLS-based end-to-end encryption (DAVE)
  was enforced across all voice channels (enforcement March 2, 2026; rollout
  reported complete May 19, 2026). Voice is E2EE by default.
- **`@discordjs/voice` receive is still unreliable under DAVE.** With DAVE on, bots that
  try to _receive_ audio hit reconnect loops, no `speaking` events, and
  decryption failures such as `DecryptionFailed(UnencryptedWhenPassthroughDisabled)`
  and `Cannot read properties of undefined (reading 'decrypt')` in
  `VoiceReceiver.onUdpMessage`. **Sending** works; **receiving** does not.
- `@snazzah/davey` is the DAVE protocol library bundled with `@discordjs/voice`,
  but the _receive_ decrypt path is not yet wired up.
- **Pycord's DAVE receive fix is pinned to an audited upstream commit because it
  is not yet in the released 2.8.0 wheel.** ReSound uses a Python sidecar around the
  patched Pycord voice receiver by default in
  `RESOUND_BOT_MODE=discord` / `discord-native`, with a real runtime preflight
  for the pinned Pycord build, `davey`, `PyNaCl`, and `libopus`.
- Legacy "subscribe to a user's Opus stream and decode it" snippets predate DAVE
  and will not work in DAVE-protected calls.

Sources: [discord.js #11419](https://github.com/discordjs/discord.js/issues/11419),
[discord.js #10735](https://github.com/discordjs/discord.js/issues/10735),
[DAVE whitepaper](https://daveprotocol.com/),
[Discord blog: Bringing DAVE to all platforms](https://discord.com/blog/bringing-dave-to-all-discord-platforms).

**Tradeoffs of the available approaches**

| Approach                   | Notes                                                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@discordjs/voice` receive | Mature API surface for receive, but DAVE support for _receiving_ is the gating question — verify the installed version's status before relying on it. Needs `prism-media` + an Opus decoder (`@discordjs/opus` or `opusscript`) and `libsodium`/`sodium-native`. |
| Bring-your-own DAVE stack  | Implement/track an MLS + DAVE layer directly. Most control, most work; only justified if library support stalls.                                                                                                                                                 |
| Account/self-bot capture   | ❌ Against Discord ToS. Not supported by Resound.                                                                                                                                                                                                                |
| Out-of-band capture        | Record the host's system/app audio outside Discord and feed the file to Resound's transcriber. Sidesteps DAVE entirely; loses per-user diarization.                                                                                                              |

### What Resound does about it

1. **Alternative path: local capture + transcription.** Capture the call
   from the operator machine (system audio, OBS, QuickTime, Audio Hijack, or the
   built-in `resound record` / `RESOUND_BOT_MODE=local-capture` flow) and run it
   through `local-whisper` or an OpenAI-compatible endpoint. This works now and
   needs no bot-side voice receive. See [usage.md](usage.md#meeting-workflow--transcribe-a-recording-works-today-no-dave).

2. **The production live path uses Pycord.**
   `PycordDiscordRecorder` (`packages/audio/src/pycord-discord-recorder.ts`)
   launches a Python sidecar (`packages/audio/python/discord_native_sidecar.py`)
   that logs into Discord, joins the requested voice channel, records per-user
   PCM through Pycord's DAVE-aware receive path, writes aligned speaker WAVs
   plus `audio/raw/mixed.wav`, and returns chunk metadata to the normal Resound
   pipeline. `DiscordRecorder` remains an unsupported compatibility backend for
   maintainers comparing the older `@discordjs/voice` receive stack.

   Production deployments must use
   `RESOUND_DISCORD_RECEIVER_BACKEND=pycord` (the default). `auto` and
   `discordjs` exist for maintainers and are not release-supported.

   In `auto` bot mode, Resound still falls back only to preflighted
   local-capture; if neither real recorder is ready, start fails before
   recording begins.

To enable the preferred live mode on a fresh machine:

```bash
python3 -m pip install -U -r packages/audio/python/requirements.txt
RESOUND_BOT_MODE=discord \
RESOUND_DISCORD_RECEIVER_BACKEND=pycord \
pnpm bot:start
```

On this machine, `python3 packages/audio/python/discord_native_sidecar.py --probe`
returns a successful readiness payload only when the installed Pycord build has
both DAVE support and the DAVE receive fix (`dave_receive=true`).

Each self-hosted installation must complete the acceptance check in
[self-hosting.md](self-hosting.md) before recording real meetings. This catches
server-specific permissions, receiver, storage, and transcriber configuration.

### What `local-capture` means

`RESOUND_BOT_MODE=local-capture` does not use Discord voice receive. The slash
commands run on the same operator machine that captures local audio devices
through ffmpeg/avfoundation. Use this when macOS mixed system capture is
preferred over server-side per-speaker capture:

```bash
RESOUND_BOT_MODE=local-capture
RESOUND_AUDIO_SYSTEM_DEVICE=1
RESOUND_AUDIO_MIC_DEVICE=2
pnpm bot:start
```

The operator still needs macOS audio routing that sends Discord/system output
into a capture device such as BlackHole, plus a microphone device for their own
voice.

### Resource and failure bounds

Remote transcription uploads speaker tracks sequentially, as local Whisper does.
This keeps at most one file upload resident per transcription call and stops
scheduling uploads after a provider failure. Providers are not retried
implicitly. A declared missing speaker track is an error rather than an omitted
participant; restore the audio before retrying. Single-file upload size limits
remain provider-defined.

The legacy Discord receiver flushes at most 30 seconds of decoded PCM per chunk
(5,760,000 bytes at stereo 48 kHz/s16le), even without silence. Pause flushes prior
samples and discards incoming paused samples; stop detaches reception and flushes
immediately. Chunk filenames and metadata remain compatible, but continuous
utterances may span multiple files. This does not change its unsupported DAVE
status or make it a production-supported receiver.

The Pycord sidecar converts PCM to WAV in 1 MiB reads instead of loading each
complete recording into memory. `python3 -m unittest discover -s packages/audio/python
-p 'test_*.py'` runs offline sample-equivalence and bounded-memory checks without
Discord dependencies. `python3 scripts/benchmarks/wav-memory.py` compares the
original conversion with the current implementation and verifies identical bytes.

### Resource bounds and diagnostics

Local Whisper runs have a 30-minute deadline per track. Set
`RESOUND_WHISPER_TIMEOUT_MS` (or `LocalWhisperOptions.timeoutMs`) for larger models
or long recordings. Binary preflight is limited to 30 seconds. Remote uploads
use a file-backed Blob, one track at a time, with a 10-minute deadline including
response consumption; configure `RESOUND_HTTP_TIMEOUT_MS` or the transcriber's
`timeoutMs` option. Deadline values must be positive integer milliseconds.
No automatic retry occurs after a timeout: the remote server may have processed
the request already.

Strata/TotalRecall commands default to 60 seconds; webhook requests default to
30 seconds. `RESOUND_SINK_TIMEOUT_MS` or the sink's `timeoutMs` option overrides
these limits. Unused webhook response bodies are cancelled. Child commands run
without a shell; on POSIX their process group is terminated on deadline.

Subprocess output streams to private `resound-command-*` directories under the
OS temporary directory. Error previews contain at most 8 KiB per stream and link
to retained full logs when larger. Successful small command logs are removed.
Large provider error responses use private `resound-http-*` artifacts. These logs
can contain transcript text and provider details; retain/share them as private
meeting evidence and remove them when no longer needed. Failed command logs and
large diagnostic artifacts are retained until operator/OS temporary-file cleanup;
there is no automatic retention policy. ffmpeg recording diagnostics are written
beside the WAV as `.stderr.log`. Requesting stop has a 15-second deadline
(`stopTimeoutMs` for the recording APIs); forced termination is an error.

### Discord-native timeline and finalization

The pinned Pycord receiver delivers each SSRC's independent RTP timestamp without
cross-speaker normalization. Resound anchors each speaker's first decoded packet
to the shared receiver monotonic clock and uses unsigned 32-bit RTP deltas within
that stream. This gives receive-time alignment, not sender-clock synchronization;
network latency and decode jitter still affect the first-packet anchor. Silence,
wraparound and packet overlap are handled explicitly. SSRC changes or timestamp
jumps inconsistent with elapsed receive time are realigned with a warning.
Mixed audio includes each speaker's session offset; speaker WAVs retain relative
samples and their existing `startSeconds` metadata.

Finalization runs off the Discord event loop. Increasing processed-byte receipts
refresh `RESOUND_SIDECAR_STOP_TIMEOUT_MS` (default 15 seconds), now an **idle**
finalization deadline. Work that stalls still fails. Progress receipts are at
most once per second and contain no audio or transcript content.

The sidecar checks free disk space once per second, reserving estimated space
for speaker WAVs, mixed PCM/WAV and a 64 MiB margin. Disk exhaustion or the WAV
4 GiB format limit fails explicitly and retains raw PCM for recovery. This is a
best-effort reserve, not a filesystem quota: concurrent applications can consume
the free space after a check. Production deployments should use volume quotas
and monitor retention. No old recordings are automatically deleted.
