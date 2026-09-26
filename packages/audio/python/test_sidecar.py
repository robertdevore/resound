"""Offline audio regressions: no Discord dependencies or credentials required."""
import io
import struct
from types import SimpleNamespace
import tempfile
import tracemalloc
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from discord_native_sidecar import TimelineSinkBase


class WavConversionTests(unittest.TestCase):
    def test_streaming_conversion_preserves_every_sample_and_header(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = TimelineSinkBase(Path(directory))
            pcm = Path(directory) / "input.pcm"
            output = Path(directory) / "output.wav"
            samples = bytes(range(256)) * 8193  # crosses the 1 MiB read boundary
            pcm.write_bytes(samples)
            sink._pcm_to_wav(pcm, output)
            with wave.open(str(output), "rb") as result:
                self.assertEqual(result.getparams()[:4], (2, 2, 48000, len(samples) // 4))
                self.assertEqual(result.readframes(result.getnframes()), samples)

    def test_conversion_memory_is_bounded_for_large_recordings(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = TimelineSinkBase(Path(directory))
            pcm = Path(directory) / "large.pcm"
            output = Path(directory) / "large.wav"
            with pcm.open("wb") as source:
                source.truncate(32 * 1024 * 1024)
            tracemalloc.start()
            try:
                sink._pcm_to_wav(pcm, output)
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
            self.assertLess(peak, 4 * 1024 * 1024)
            self.assertEqual(output.stat().st_size, pcm.stat().st_size + 44)

    def test_conversion_does_not_swallow_read_failures(self):
        class BrokenReader(io.BytesIO):
            def read(self, size=-1):
                raise OSError("read failed")
        with tempfile.TemporaryDirectory() as directory:
            sink = TimelineSinkBase(Path(directory))
            with patch.object(Path, "open", return_value=BrokenReader()):
                with self.assertRaisesRegex(OSError, "read failed"):
                    sink._pcm_to_wav(Path("input.pcm"), Path(directory) / "out.wav")


class TimelineTests(unittest.TestCase):
    def test_independent_clocks_and_late_speaker_mix_at_session_offsets(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = [10.0]
            sink = TimelineSinkBase(Path(directory), clock=lambda: clock[0])
            def write(user, timestamp, value):
                sink.write(SimpleNamespace(packet=SimpleNamespace(timestamp=timestamp, ssrc=user),
                           pcm=struct.pack("<hh", value, value) * 960),
                           SimpleNamespace(id=user, display_name=str(user)))
            write(1, 1000, 100)
            clock[0] += 0.03  # deliberately not a mixer chunk boundary
            write(2, 4000000000, 200)
            tracks = sink.finalize()
            self.assertEqual([t["startSeconds"] for t in tracks], [0, 0, 0.03])
            self.assertEqual(tracks[0]["durationSeconds"], 0.05)
            with wave.open(tracks[0]["path"], "rb") as audio:
                self.assertEqual(audio.readframes(2400),
                    struct.pack("<hh", 100, 100) * 960 + bytes(480 * 4) +
                    struct.pack("<hh", 200, 200) * 960)

    def test_wrap_duplicates_overlap_long_silence_and_new_ssrc(self):
        from discord_native_sidecar import AlignedTrack
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "track.pcm"
            track = AlignedTrack(path, 2, 2, 48000)
            pcm = struct.pack("<hh", 1, 1) * 960
            track.write_packet(2**32 - 960, pcm, 0, 1)
            track.write_packet(0, pcm, 0.02, 1)
            track.write_packet(0, pcm, 0.021, 1)  # duplicate
            track.write_packet(480, pcm, 0.03, 1)  # partial overlap
            self.assertEqual(track.total_samples, 2400)
            track.write_packet(480000, pcm, 10.02, 1)  # legitimate 10s silence
            self.assertEqual(track.total_samples, 481920)
            track.write_packet(3000000000, pcm, 11.02, 2)
            self.assertEqual(track.total_samples, 529920)
            self.assertEqual(len(track.warnings), 1)
            track.close()
            self.assertEqual(path.stat().st_size, track.total_samples * 4)

    def test_low_disk_fails_explicitly_and_retains_raw_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = TimelineSinkBase(Path(directory), clock=lambda: 0)
            with patch("discord_native_sidecar.shutil.disk_usage", return_value=SimpleNamespace(free=1)):
                with self.assertRaisesRegex(OSError, "Insufficient disk"):
                    sink.write(SimpleNamespace(packet=SimpleNamespace(timestamp=0, ssrc=1), pcm=bytes(4)), SimpleNamespace(id=1))
            with self.assertRaisesRegex(OSError, "raw PCM retained"):
                sink.finalize()

    def test_wav_limit_fails_before_unrepresentable_samples_are_written(self):
        from discord_native_sidecar import AlignedTrack
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "track.pcm"
            track = AlignedTrack(path, 2, 2, 48000)
            track.total_samples = (0xFFFFFFFF - 36) // 4
            try:
                with self.assertRaisesRegex(OSError, "WAV 4 GiB"):
                    track.write_packet(0, bytes(4), 0, 1)
            finally:
                track.close()
            self.assertEqual(path.stat().st_size, 0)

    def test_mix_clips_without_overflow(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = TimelineSinkBase(Path(directory), clock=lambda: 0)
            for user in [1, 2]:
                sink.write(SimpleNamespace(packet=SimpleNamespace(timestamp=user, ssrc=user),
                    pcm=struct.pack("<hh", 30000, -30000)), SimpleNamespace(id=user))
            tracks = sink.finalize()
            with wave.open(tracks[0]["path"], "rb") as audio:
                self.assertEqual(audio.readframes(1), struct.pack("<hh", 32767, -32768))


if __name__ == "__main__":
    unittest.main()
