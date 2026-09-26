#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import struct
import shutil
import sys
import threading
import time
from contextlib import ExitStack
import wave
from pathlib import Path
from typing import Any


def emit(event: str, **payload: Any) -> None:
    print(json.dumps({"event": event, **payload}), flush=True)


def load_opus() -> bool:
    import discord.opus as opus  # type: ignore

    if opus.is_loaded():
        return True
    loader = getattr(opus, "_load_default", None)
    if loader is None:
        return False
    return bool(loader())


def probe() -> int:
    try:
        import discord  # type: ignore
        import davey  # type: ignore
        import nacl.secret  # type: ignore  # noqa: F401
        from discord.voice import VoiceClient  # type: ignore
        from discord.voice.receive.reader import PacketDecryptor  # type: ignore

        if not load_opus():
            emit("error", message="Pycord could not load libopus for Discord-native recording.")
            return 1

        receive_source = inspect.getsource(PacketDecryptor.decrypt_rtp)
        recording_source = inspect.getsource(VoiceClient.start_recording)
        dave_receive = (
            "dave.decrypt" in receive_source
            and "Voice reception is currently broken" not in recording_source
        )
        if not dave_receive:
            emit(
                "error",
                message=(
                    "Installed Pycord does not contain the DAVE voice-receive fix. "
                    "Install the pinned Pycord receive build from packages/audio/python/requirements.txt."
                ),
                dave_receive=False,
                pycord=getattr(discord, "__version__", "unknown"),
            )
            return 1

        emit(
            "ready",
            dave=bool(getattr(davey, "DAVE_PROTOCOL_VERSION", 0) > 0),
            dave_receive=True,
            pycord=getattr(discord, "__version__", "unknown"),
            opus=True,
        )
        return 0
    except Exception as exc:
        emit("error", message=f"Pycord sidecar probe failed: {exc}")
        return 1


class AlignedTrack:
    def __init__(self, pcm_path: Path, channels: int, sample_width: int, sample_rate: int) -> None:
        self.pcm_path = pcm_path
        self.channels = channels
        self.sample_width = sample_width
        self.sample_rate = sample_rate
        self.file = pcm_path.open("wb")
        self.last_end_ts: int | None = None
        self.last_received: float | None = None
        self.last_packet_samples = 0
        self.ssrc: int | None = None
        self.total_samples = 0
        self.warnings: list[str] = []

    def write_packet(self, packet_ts: int, pcm: bytes, received: float, ssrc: int) -> None:
        frame_bytes = self.channels * self.sample_width
        if len(pcm) % frame_bytes:
            raise ValueError("Decoded PCM is not aligned to complete audio frames.")
        frame_samples = len(pcm) // frame_bytes
        packet_samples = frame_samples
        packet_end = (packet_ts + frame_samples) % 2**32
        gap = 0
        if self.last_end_ts is not None:
            # RTP clocks are per SSRC, unsigned 32-bit sample counters. Signed
            # modular subtraction also detects duplicate/overlapping packets.
            gap = ((packet_ts - self.last_end_ts + 2**31) % 2**32) - 2**31
            elapsed = max(0, round((received - self.last_received) * self.sample_rate))
            if ssrc != self.ssrc or abs(gap - elapsed) > 5 * self.sample_rate:
                # A new SSRC or clock discontinuity has no comparable RTP epoch.
                # Preserve wall-clock silence rather than allocating an RTP-sized hole.
                gap = max(0, elapsed - self.last_packet_samples)
                if not self.warnings:
                    self.warnings.append("RTP clock discontinuity; realigned using receiver monotonic time.")
            elif gap < 0:
                overlap = min(frame_samples, -gap)
                pcm = pcm[overlap * frame_bytes:]
                frame_samples -= overlap
                if not frame_samples:
                    return
                gap = 0
        if (self.total_samples + max(0, gap) + frame_samples) * frame_bytes > 0xFFFFFFFF - 36:
            raise OSError("WAV 4 GiB format limit reached; raw PCM retained. Start a new session.")
        if gap > 0:
            # Sparse silence avoids allocating a buffer proportional to a pause.
            self.file.seek(gap * frame_bytes, os.SEEK_CUR)
            self.total_samples += gap
        self.file.write(pcm)
        self.total_samples += frame_samples
        self.last_end_ts = packet_end
        self.last_packet_samples = packet_samples
        self.last_received = received
        self.ssrc = ssrc

    def close(self) -> None:
        self.file.close()


class TimelineSinkBase:
    def __init__(self, session_dir: Path, clock=time.monotonic) -> None:
        self.session_dir = session_dir
        self.raw_dir = session_dir / "audio" / "raw"
        self.speakers_dir = session_dir / "audio" / "speakers"
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.speakers_dir.mkdir(parents=True, exist_ok=True)
        self.channels = 2
        self.sample_width = 2
        self.sample_rate = 48000
        self.clock = clock
        self.started_at = clock()
        self.tracks: dict[str, dict[str, Any]] = {}
        self.warnings: list[str] = []
        self._closed = False
        self._disk_checked_at = float("-inf")
        self.capture_error: str | None = None
        self._timeline_lock = threading.RLock()
        self.progress_callback = None
        self._progress_bytes = 0
        self._progress_at = float("-inf")

    def write(self, data: Any, user: Any) -> None:
        with self._timeline_lock:
            try:
                self._write(data, user)
            except Exception as error:
                self.capture_error = str(error)
                raise

    def _write(self, data: Any, user: Any) -> None:
        packet = data.packet
        pcm = data.pcm or b""
        if not pcm:
            return

        if self._closed:
            raise RuntimeError("Cannot write to a finalized audio sink.")
        received = self.clock()

        if received - self._disk_checked_at >= 1:
            self._disk_checked_at = received
            # Reserve space for speaker WAVs and both mixed PCM/WAV outputs.
            # Keep raw evidence intact on failure; never silently shorten audio.
            raw_bytes = sum(t["writer"].total_samples * 4 for t in self.tracks.values())
            timeline_bytes = max(0, round((received - self.started_at + 5) * self.sample_rate)) * 4
            required = raw_bytes + 2 * timeline_bytes + 64 * 1024 * 1024
            if shutil.disk_usage(self.session_dir).free < required:
                self.capture_error = "Insufficient disk space reserved for audio finalization; raw PCM retained."
                raise OSError(self.capture_error)

        user_id = str(getattr(user, "id", None) or f"ssrc-{packet.ssrc}")
        username = getattr(user, "display_name", None) or getattr(user, "name", None) or user_id
        safe_name = "".join(ch if ch.isalnum() or ch in ("-", "_") else "-" for ch in user_id)

        track = self.tracks.get(user_id)
        if track is None:
            pcm_path = self.raw_dir / f"{safe_name}.pcm"
            writer = AlignedTrack(pcm_path, self.channels, self.sample_width, self.sample_rate)
            track = {
                "user_id": user_id,
                "username": username,
                "pcm_path": pcm_path,
                "writer": writer,
                "offset": max(0, round((received - self.started_at) * self.sample_rate)),
            }
            self.tracks[user_id] = track

        writer = track["writer"]
        writer.write_packet(int(packet.timestamp), pcm, received, int(packet.ssrc))

    def cleanup(self) -> None:
        with self._timeline_lock:
            self._cleanup()

    def _cleanup(self) -> None:
        if self._closed:
            return
        self._closed = True
        for entry in self.tracks.values():
            entry["writer"].close()

    def finalize(self) -> list[dict[str, Any]]:
        self.cleanup()
        if self.capture_error:
            raise OSError(self.capture_error)
        if not self.tracks:
            self.warnings.append("Discord-native sidecar captured no speaker tracks.")
            return []

        speaker_tracks: list[dict[str, Any]] = []
        longest_samples = 0
        for entry in self.tracks.values():
            writer: AlignedTrack = entry["writer"]
            longest_samples = max(longest_samples, entry["offset"] + writer.total_samples)
            wav_path = self.speakers_dir / (entry["pcm_path"].stem + ".wav")
            self._pcm_to_wav(entry["pcm_path"], wav_path)
            start_seconds = entry["offset"] / self.sample_rate
            speaker_tracks.append(
                {
                    "userId": entry["user_id"],
                    "username": entry["username"],
                    "path": str(wav_path),
                    "startSeconds": start_seconds,
                    "durationSeconds": writer.total_samples / self.sample_rate,
                }
            )
            self.warnings.extend(entry["writer"].warnings)

        mixed_pcm = self.raw_dir / "mixed.pcm"
        mixed_wav = self.raw_dir / "mixed.wav"
        self._mix_tracks(mixed_pcm, [(entry["pcm_path"], entry["offset"]) for entry in self.tracks.values()], longest_samples)
        self._pcm_to_wav(mixed_pcm, mixed_wav)

        return [
            {
                "userId": "mixed",
                "username": "Discord Mixed",
                "path": str(mixed_wav),
                "startSeconds": 0,
                "durationSeconds": longest_samples / self.sample_rate,
            },
            *speaker_tracks,
        ]

    def _progress(self, count: int) -> None:
        self._progress_bytes += count
        now = time.monotonic()
        if self.progress_callback and now - self._progress_at >= 1:
            self._progress_at = now
            self.progress_callback(self._progress_bytes)

    def _pcm_to_wav(self, pcm_path: Path, wav_path: Path) -> None:
        with pcm_path.open("rb") as source, wave.open(str(wav_path), "wb") as out:
            out.setnchannels(self.channels)
            out.setsampwidth(self.sample_width)
            out.setframerate(self.sample_rate)
            # Bound working memory independently of meeting length. wave patches
            # the final RIFF sizes on close; samples and format remain identical.
            while chunk := source.read(1024 * 1024):
                out.writeframesraw(chunk)
                self._progress(len(chunk))

    def _mix_tracks(self, mixed_pcm: Path, tracks: list[tuple[Path, int]], longest_samples: int) -> None:
        frame_bytes = self.channels * self.sample_width
        chunk_samples = 960
        with ExitStack() as stack:
            handles = [(stack.enter_context(path.open("rb")), offset) for path, offset in tracks]
            out = stack.enter_context(mixed_pcm.open("wb"))
            for start in range(0, longest_samples, chunk_samples):
                count = min(chunk_samples, longest_samples - start)
                mixed = [0] * (count * self.channels)
                for handle, offset in handles:
                    leading = max(0, offset - start)
                    if leading >= count:
                        continue
                    raw = handle.read((count - leading) * frame_bytes)
                    for i, (sample,) in enumerate(struct.iter_unpack("<h", raw), leading * self.channels):
                        mixed[i] += sample
                out.write(struct.pack("<" + "h" * len(mixed),
                                      *(max(-32768, min(32767, value)) for value in mixed)))
                self._progress(count * frame_bytes)


def create_timeline_sink(session_dir: Path) -> Any:
    import discord  # type: ignore

    class TimelineSink(discord.sinks.Sink, TimelineSinkBase):  # type: ignore[misc]
        __sink_listeners__: list[tuple[str, str]] = []

        def __init__(self) -> None:
            discord.sinks.Sink.__init__(self)
            TimelineSinkBase.__init__(self, session_dir)
            self.encoding = "pcm"
            self.progress_callback = lambda count: emit("progress", bytesProcessed=count)

        def walk_children(self) -> list[Any]:
            return []

        def is_opus(self) -> bool:
            return False

        def format_audio(self, audio: Any) -> None:
            return

        def cleanup(self) -> None:
            TimelineSinkBase.cleanup(self)

        def finalize(self) -> list[dict[str, Any]]:
            return TimelineSinkBase.finalize(self)

        def write(self, data: Any, user: Any) -> None:
            TimelineSinkBase.write(self, data, user)

    return TimelineSink()


async def run_recording(args: argparse.Namespace) -> int:
    import discord  # type: ignore

    if not load_opus():
        emit("error", message="Pycord could not load libopus for Discord-native recording.")
        return 1

    intents = discord.Intents.none()
    intents.guilds = True
    intents.voice_states = True
    intents.members = True
    client = discord.Client(intents=intents)
    loop = asyncio.get_running_loop()
    sink = create_timeline_sink(Path(args.session_dir))
    state: dict[str, Any] = {"vc": None}
    stop_event = asyncio.Event()
    finalized = False

    async def finalize(exc: Exception | None) -> None:
        nonlocal finalized
        if finalized:
            return
        finalized = True
        try:
            tracks = await asyncio.to_thread(sink.finalize)
            if exc is not None:
                sink.warnings.append(str(exc))
            emit("stopped", tracks=tracks, warnings=sink.warnings)
        except Exception as error:
            emit("error", message=f"Audio finalization failed: {error}")
        vc = state.get("vc")
        if vc is not None:
            try:
                await vc.disconnect(force=True)
            except Exception:
                pass
        await client.close()
        stop_event.set()

    # The pinned DAVE receive build invokes the completion callback with the
    # sink (and any extra callback arguments), not an exception.
    def after_callback(_sink: Any, *_args: Any) -> None:
        asyncio.run_coroutine_threadsafe(finalize(None), loop)

    @client.event
    async def on_ready() -> None:
        guild = client.get_guild(int(args.guild_id))
        if guild is None:
            emit("error", message=f"Guild not found: {args.guild_id}")
            await client.close()
            stop_event.set()
            return

        channel = guild.get_channel(int(args.channel_id))
        if channel is None or not hasattr(channel, "connect"):
            emit("error", message=f"Voice channel not found: {args.channel_id}")
            await client.close()
            stop_event.set()
            return

        try:
            vc = await channel.connect()
            state["vc"] = vc
            # Pass a callback argument so Pycord schedules the completion
            # callback after its receive workers have stopped.
            sink.started_at = sink.clock()
            vc.start_recording(sink, after_callback, None)
            emit(
                "ready",
                dave=bool(getattr(vc, "is_dave_connection", lambda: False)()),
                dave_receive=True,
            )
        except Exception as exc:
            emit("error", message=f"Failed to connect or start recording: {exc}")
            await client.close()
            stop_event.set()

    def stdin_watcher() -> None:
        for line in sys.stdin:
            if line.strip().lower() == "stop":
                vc = state.get("vc")
                if vc is not None:
                    loop.call_soon_threadsafe(vc.stop_recording)
                else:
                    loop.call_soon_threadsafe(lambda: asyncio.create_task(finalize(None)))
                break

    threading.Thread(target=stdin_watcher, daemon=True).start()

    try:
        await client.start(args.token)
    except Exception as exc:
        if not stop_event.is_set():
            emit("error", message=f"Discord-native sidecar client failed: {exc}")
            stop_event.set()
            return 1

    await stop_event.wait()
    return 0


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--token")
    parser.add_argument("--guild-id")
    parser.add_argument("--channel-id")
    parser.add_argument("--session-dir")
    args = parser.parse_args()

    if args.probe:
        return probe()

    args.token = args.token or os.environ.get("RESOUND_SIDECAR_TOKEN")
    if not all([args.token, args.guild_id, args.channel_id, args.session_dir]):
        emit("error", message="Missing required arguments for Discord-native sidecar recording.")
        return 1

    return asyncio.run(run_recording(args))


if __name__ == "__main__":
    sys.exit(main())
