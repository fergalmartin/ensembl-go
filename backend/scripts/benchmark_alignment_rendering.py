"""Benchmark cold and reopened summary reads without modifying the user's index.

Example: python backend/scripts/benchmark_alignment_rendering.py /path/to/alignment.sqlite --block 16
Copies only the selected block into a temporary source index.
"""
import argparse
import json
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alignment_explorer.store import AlignmentStore, stable_id

parser=argparse.ArgumentParser()
parser.add_argument('index',type=Path)
parser.add_argument('--block',type=int,default=16)
parser.add_argument('--rows',type=int,default=19)
args=parser.parse_args()
with sqlite3.connect(args.index.resolve().as_uri()+'?mode=ro',uri=True) as db:
    records=db.execute('SELECT r.id,s.source FROM rows r JOIN sequences s ON s.id=r.id WHERE r.block=? AND r.empty_status IS NULL ORDER BY s.rowid LIMIT ?', (args.block,args.rows)).fetchall()
    sequences=[{'source':source,'sequence':''.join(c[0] for c in db.execute('SELECT bases FROM chunks WHERE block=? AND id=? ORDER BY offset',(args.block,row_id)))} for row_id,source in records]
with tempfile.TemporaryDirectory(prefix='alignment-render-benchmark-') as directory:
    store=AlignmentStore(Path(directory));store.initialize();store.add_block(sequences)
    length=len(sequences[0]['sequence']);focus=stable_id(sequences[0]['source'])
    for bins in (128,2048):
        for iteration in range(3):
            store=AlignmentStore(Path(directory))
            before=time.perf_counter();data=store.region(1,0,length,max_cells=0,bins=bins,focus_id=focus);elapsed=(time.perf_counter()-before)*1000
            size=(Path(directory)/'render-summaries.sqlite').stat().st_size
            print(json.dumps({'bins':bins,'iteration':iteration,'ms':round(elapsed,1),'rows':len(data['rows']),'columns':length,'cache_bytes':size}),flush=True)
