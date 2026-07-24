#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import threading
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

        if not load_opus():
            emit("error", message="Pycord could not load libopus for Discord-native recording.")
            return 1

        emit(
            "ready",
            dave=bool(getattr(davey, "DAVE_PROTOCOL_VERSION", 0) > 0),
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
        self.first_ts: int | None = None
        self.last_end_ts: int | None = None
        self.total_samples = 0

    def write_packet(self, packet_ts: int, pcm: bytes, global_start_ts: int) -> None:
        frame_samples = len(pcm) // (self.channels * self.sample_width)
        if self.first_ts is None:
            self.first_ts = packet_ts
        expected_ts = self.last_end_ts if self.last_end_ts is not None else global_start_ts
        gap_samples = max(0, packet_ts - expected_ts)
        if gap_samples:
            self.file.write(b"\x00" * gap_samples * self.channels * self.sample_width)
            self.total_samples += gap_samples
        self.file.write(pcm)
        self.total_samples += frame_samples
        self.last_end_ts = packet_ts + frame_samples

    def close(self) -> None:
        self.file.close()


class TimelineSinkBase:
    def __init__(self, session_dir: Path) -> None:
        self.session_dir = session_dir
        self.raw_dir = session_dir / "audio" / "raw"
        self.speakers_dir = session_dir / "audio" / "speakers"
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.speakers_dir.mkdir(parents=True, exist_ok=True)
        self.channels = 2
        self.sample_width = 2
        self.sample_rate = 48000
        self.global_start_ts: int | None = None
        self.tracks: dict[str, dict[str, Any]] = {}
        self.warnings: list[str] = []
        self._closed = False

    def write(self, data: Any, user: Any) -> None:
        packet = data.packet
        pcm = data.pcm or b""
        if not pcm:
            return

        if self.global_start_ts is None:
            self.global_start_ts = int(packet.timestamp)

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
            }
            self.tracks[user_id] = track

        writer = track["writer"]
        writer.write_packet(int(packet.timestamp), pcm, self.global_start_ts)

    def cleanup(self) -> None:
        if self._closed:
            return
        self._closed = True
        for entry in self.tracks.values():
            entry["writer"].close()

    def finalize(self) -> list[dict[str, Any]]:
        self.cleanup()
        if not self.tracks:
            self.warnings.append("Discord-native sidecar captured no speaker tracks.")
            return []

        speaker_tracks: list[dict[str, Any]] = []
        longest_samples = 0
        for entry in self.tracks.values():
            writer: AlignedTrack = entry["writer"]
            longest_samples = max(longest_samples, writer.total_samples)
            wav_path = self.speakers_dir / f"{entry['user_id']}.wav"
            self._pcm_to_wav(entry["pcm_path"], wav_path)
            start_seconds = 0.0
            if self.global_start_ts is not None and writer.first_ts is not None:
                start_seconds = max(0.0, (writer.first_ts - self.global_start_ts) / self.sample_rate)
            speaker_tracks.append(
                {
                    "userId": entry["user_id"],
                    "username": entry["username"],
                    "path": str(wav_path),
                    "startSeconds": start_seconds,
                    "durationSeconds": writer.total_samples / self.sample_rate,
                }
            )

        mixed_pcm = self.raw_dir / "mixed.pcm"
        mixed_wav = self.raw_dir / "mixed.wav"
        self._mix_tracks(mixed_pcm, [entry["pcm_path"] for entry in self.tracks.values()], longest_samples)
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

    def _pcm_to_wav(self, pcm_path: Path, wav_path: Path) -> None:
        with pcm_path.open("rb") as source, wave.open(str(wav_path), "wb") as out:
            out.setnchannels(self.channels)
            out.setsampwidth(self.sample_width)
            out.setframerate(self.sample_rate)
            out.writeframes(source.read())

    def _mix_tracks(self, mixed_pcm: Path, pcm_paths: list[Path], longest_samples: int) -> None:
        frame_bytes = self.channels * self.sample_width
        chunk_samples = 960
        chunk_bytes = chunk_samples * frame_bytes
        handles = [pcm_path.open("rb") for pcm_path in pcm_paths]
        try:
            with mixed_pcm.open("wb") as out:
                written_samples = 0
                while written_samples < longest_samples:
                    buffers = [handle.read(chunk_bytes) for handle in handles]
                    if not any(buffers):
                        break
                    arrays: list[list[int]] = []
                    max_len = 0
                    for raw in buffers:
                        if not raw:
                            arrays.append([])
                            continue
                        ints = list(struct.unpack("<" + "h" * (len(raw) // 2), raw))
                        arrays.append(ints)
                        max_len = max(max_len, len(ints))

                    if max_len == 0:
                        break

                    mixed: list[int] = []
                    for i in range(max_len):
                        total = 0
                        for ints in arrays:
                            if i < len(ints):
                                total += ints[i]
                        mixed.append(max(-32768, min(32767, total)))

                    out.write(struct.pack("<" + "h" * len(mixed), *mixed))
                    written_samples += len(mixed) // self.channels
        finally:
            for handle in handles:
                handle.close()


def create_timeline_sink(session_dir: Path) -> Any:
    import discord  # type: ignore

    class TimelineSink(discord.sinks.Sink, TimelineSinkBase):  # type: ignore[misc]
        __sink_listeners__: list[tuple[str, str]] = []

        def __init__(self) -> None:
            discord.sinks.Sink.__init__(self)
            TimelineSinkBase.__init__(self, session_dir)

        def walk_children(self) -> list[Any]:
            return []

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
        tracks = sink.finalize()
        if exc is not None:
            sink.warnings.append(str(exc))
        emit("stopped", tracks=tracks, warnings=sink.warnings)
        vc = state.get("vc")
        if vc is not None:
            try:
                await vc.disconnect(force=True)
            except Exception:
                pass
        await client.close()
        stop_event.set()

    def after_callback(exc: Exception | None) -> None:
        asyncio.run_coroutine_threadsafe(finalize(exc), loop)

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
            vc.start_recording(sink, after_callback)
            emit("ready", dave=bool(getattr(vc, "is_dave_connection", lambda: False)()))
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--token")
    parser.add_argument("--guild-id")
    parser.add_argument("--channel-id")
    parser.add_argument("--session-dir")
    args = parser.parse_args()

    if args.probe:
        return probe()

    if not all([args.token, args.guild_id, args.channel_id, args.session_dir]):
        emit("error", message="Missing required arguments for Discord-native sidecar recording.")
        return 1

    return asyncio.run(run_recording(args))


if __name__ == "__main__":
    sys.exit(main())
