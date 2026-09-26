"""Offline audio regressions: no Discord dependencies or credentials required."""
import io
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


if __name__ == "__main__":
    unittest.main()
