"""Reproducible dense ATG/GC benchmark; uses only a temporary disk cache."""
import argparse
import json
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from motif_engine import MotifCache, composition_key

parser = argparse.ArgumentParser()
parser.add_argument('--sequences', type=int, default=32)
parser.add_argument('--columns', type=int, default=1_000_000)
args = parser.parse_args()
seq = ('ATGCGC' * ((args.columns + 5) // 6))[:args.columns]
motifs = [SimpleNamespace(pattern=p, kind='literal') for p in ('ATG', 'GC')]
with tempfile.TemporaryDirectory() as root:
    cache = MotifCache(Path(root) / 'cache.sqlite')
    times = {}
    for label in ('cold', 'cached'):
        start = time.perf_counter()
        searched = reused = 0
        for i in range(args.sequences):
            result = cache.prepare(str(i), lambda: seq, motifs)
            searched += result['searched']; reused += result['cached']
        times[label] = dict(seconds=round(time.perf_counter() - start, 4), searched=searched, reused=reused)
    step = 2 ** max(0, (args.columns // 1024).bit_length())
    start = time.perf_counter()
    responses = [cache.region(str(i), composition_key(motifs), 0, step * 1024, step) for i in range(args.sequences)]
    times['render'] = dict(seconds=round(time.perf_counter() - start, 4),
                           json_bytes=len(json.dumps(responses)), maximum_runs_per_row=max(map(len, responses)))
    times['disk_bytes'] = sum(path.stat().st_size for path in Path(root).iterdir())
    print(json.dumps(dict(sequences=args.sequences, columns=args.columns, **times), indent=2))
