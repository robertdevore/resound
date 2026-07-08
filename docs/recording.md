# Recording a real Discord call (macOS) — the for-real path

Discord's mandatory DAVE/E2EE breaks bot-side voice receive (see
[providers.md](providers.md)). The reliable way to get a **real** transcript is
to capture the call's audio at the macOS system level — the audio is already
decrypted as it plays on your Mac — and transcribe it locally. No bot needed.

This machine is already set up: ffmpeg, BlackHole 2ch, a Multi-Output Device, a
mic, and whisper.cpp + a model are installed. `.env` is preconfigured. So the
short version is:

```bash
nvm use 22
pnpm cli record --title "Team Sync"      # talk… then press Enter or q
# → writes a full session under ./transcripts with a REAL local transcript
```

## How the audio is routed

```
 Discord call  ──► Multi-Output Device ──► your headphones (you hear it)
   (others)                         └────► BlackHole 2ch ──┐
                                                           ├─► ffmpeg amix ─► WAV ─► whisper.cpp
 Your mic ────────────────────────────► MacBook Pro Mic ──┘
```

- **Other people's voices** come out of Discord → routed through the
  **Multi-Output Device** (so you still hear them) → also into **BlackHole 2ch**.
- **Your voice** is captured directly from the **microphone**.
- `resound record` runs ffmpeg with both as inputs and mixes them to one mono
  16 kHz WAV, then transcribes it.

## One-time setup (already done on this Mac — here for reference / other machines)

1. **Install the pieces**
   ```bash
   brew install ffmpeg blackhole-2ch whisper-cpp
   # download a model:
   mkdir -p models
   curl -L -o models/ggml-base.en.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
   ```
2. **Create a Multi-Output Device** (Audio MIDI Setup → `+` → *Create Multi-Output
   Device*) and tick **both** your headphones/speakers **and** BlackHole 2ch.
3. **Send the call to it.** Either set the Multi-Output Device as your system
   output, or, better, set it only for Discord: Discord → **Settings → Voice &
   Video → Output Device → Multi-Output Device**. Keep your mic as the **Input
   Device**.
4. **Tell Resound the device indices.** Run `pnpm cli devices` and put the
   BlackHole and mic indices into `.env` as `RESOUND_AUDIO_SYSTEM_DEVICE` and
   `RESOUND_AUDIO_MIC_DEVICE` (indices can shift when you plug/unplug gear).

## Using it

```bash
pnpm cli devices                         # confirm current device indices
pnpm cli record --title "Team Sync"      # Enter/q to stop & transcribe
pnpm cli record --title "Sync" --duration 1800   # or auto-stop after 30 min
pnpm cli record --title "Solo" --device 2        # mic only (no system audio)

pnpm cli validate <session>
pnpm cli export   <session> --format md
```

### Permissions

The first time ffmpeg reads an input device, macOS will ask the terminal app for
**Microphone** permission — allow it (System Settings → Privacy & Security →
Microphone). Capturing BlackHole counts as audio input too.

### Limitations

- **One mixed track → no per-speaker labels.** Everyone is attributed to the
  first participant. True per-speaker diarization needs separate audio per
  person (the Discord receive adapter, once DAVE receive works). For a meeting
  summary + searchable transcript this is usually fine.
- Use a bigger model (`ggml-small.en.bin`, `ggml-medium.en.bin`) for higher
  accuracy at the cost of speed; point `RESOUND_WHISPER_MODEL` at it.

## Using Slash Commands With Local Capture

Once the local capture path works from the CLI, the Discord bot can control the
same local recorder:

```bash
RESOUND_BOT_MODE=local-capture
RESOUND_AUDIO_SYSTEM_DEVICE=1
RESOUND_AUDIO_MIC_DEVICE=2
pnpm bot:start
```

Then use `/resound start`, `/resound stop`, and `/resound export` in Discord.
The bot must run on the same Mac that is capturing audio. This is intentionally
local-first: every operator can run their own bot and recorder for their own
Discord server without depending on a central hosted service.
