"""Offline mixer comparison against the previous committed implementation."""
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = 'packages/audio/python/discord_native_sidecar.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    baseline = root / 'baseline.py'
    baseline.write_bytes(subprocess.check_output(['git', 'show', f'528a39c:{SOURCE}'], cwd=ROOT))
    modules = [load('baseline', baseline), load('current', ROOT / SOURCE)]
    paths = []
    for i in range(8):
        path = root / f'{i}.pcm'
        path.write_bytes(bytes(range(256)) * (48000 * 4 * 10 // 256))
        paths.append(path)
    results = []
    for label, module in zip(['baseline', 'current'], modules):
        sink = module.TimelineSinkBase(root / label)
        samples = []
        output = root / f'{label}.pcm'
        for _ in range(3):
            start = time.perf_counter()
            tracks = paths if label == 'baseline' else [(p, 0) for p in paths]
            sink._mix_tracks(output, tracks, 480000)
            samples.append(time.perf_counter() - start)
        results.append(dict(implementation=label, seconds=samples,
                            median_seconds=sorted(samples)[1],
                            sha256=hashlib.sha256(output.read_bytes()).hexdigest()))
    assert results[0]['sha256'] == results[1]['sha256']
    print(json.dumps(dict(speakers=8, duration_seconds=10, results=results), indent=2))
