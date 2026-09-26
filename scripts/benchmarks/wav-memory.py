#!/usr/bin/env python3
"""Compare the audited whole-file baseline with current streaming WAV conversion."""
import hashlib
import json
import statistics
import sys
import tempfile
import time
import tracemalloc
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/audio/python"))
from discord_native_sidecar import TimelineSinkBase


def baseline(sink, source_path, output_path):
    with source_path.open("rb") as source, wave.open(str(output_path), "wb") as output:
        output.setnchannels(sink.channels)
        output.setsampwidth(sink.sample_width)
        output.setframerate(sink.sample_rate)
        output.writeframes(source.read())


def digest(path):
    with path.open("rb") as source:
        result = hashlib.sha256()
        while chunk := source.read(1024 * 1024):
            result.update(chunk)
        return result.hexdigest()


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    sink = TimelineSinkBase(root)
    pcm = root / "input.pcm"
    with pcm.open("wb") as source:
        for _ in range(128):
            source.write(bytes(range(256)) * 4096)
    results = {}
    for name, convert in [("baseline", lambda: baseline(sink, pcm, root / "baseline.wav")),
                          ("streaming", lambda: sink._pcm_to_wav(pcm, root / "streaming.wav"))]:
        times, peaks = [], []
        for _ in range(3):
            tracemalloc.start()
            start = time.perf_counter()
            convert()
            times.append(time.perf_counter() - start)
            peaks.append(tracemalloc.get_traced_memory()[1])
            tracemalloc.stop()
        results[name] = {"median_seconds": statistics.median(times), "peak_traced_bytes": max(peaks)}
    assert digest(root / "baseline.wav") == digest(root / "streaming.wav")
    print(json.dumps({"input_bytes": pcm.stat().st_size, "repetitions": 3, "byte_identical": True, "results": results}, indent=2))
