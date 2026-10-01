"""The alignments folder shared by the MSA view and the Gene Trees view.

Alignments live in ``<output_dir>/local_data/alignments/`` as ``<stem>.fasta`` (the gapped
rows) beside ``<stem>.json`` (everything else), as the MSA view has always saved them.
This module writes version 2 of that pair and keeps ``index.sqlite`` beside them so an
alignment holding a given set of rows can be found without reading every file.

Version 2, a superset of version 1:
- ``genomes`` is still the per-row list (so the MSA view's list still reads it), but a
  row is one transcript, not one genome: several rows may share a genome. Each has a
  ``row_key`` (``assembly:transcript``), its ``region`` (segments, cuts) and features.
- FASTA headers are row keys.
- ``source`` ('gene_trees' | 'multi_alignment') and ``auto`` (saved without being asked,
  as a cache) say where it came from; ``mode``/``params`` how its regions were cut.

A row's *signature* is its row key, region parameters, a hash of the sequence aligned and
a hash of the transcript model. An alignment is reused only for rows whose signatures it
holds, so a changed assembly or annotation never brings back a stale alignment. Version 1
files carry no sequence hash and are left out of the index.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

VERSION = '2'
INDEX_NAME = 'index.sqlite'
_LOADED_LIMIT = 4


def sequence_hash(sequence: str) -> str:
    return hashlib.sha256(str(sequence or '').upper().encode('ascii', 'replace')).hexdigest()[:24]


def row_signature(row_key: str, params: Dict[str, Any], input_hash: str, structure: str = '') -> str:
    blob = json.dumps([row_key, params.get('mode'), int(params.get('flank_5') or 0), int(params.get('flank_3') or 0),
                       int(params.get('intron_edge') or 0), input_hash, structure], separators=(',', ':'))
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()[:32]


def safe_stem(name: str) -> str:
    cleaned = re.sub(r'[^\w\-.]', '_', str(name or '').strip())
    return cleaned[:120].strip('._') or 'alignment'


class AlignmentStore:
    """One alignments folder. Safe to share between threads."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.lock = threading.RLock()
        self.loaded: 'OrderedDict[str, tuple]' = OrderedDict()

    # ── the index ──

    def _connect(self) -> sqlite3.Connection:
        self.root.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.root / INDEX_NAME), timeout=10)
        conn.execute('CREATE TABLE IF NOT EXISTS alignments (stem TEXT PRIMARY KEY, mtime REAL, name TEXT, source TEXT, '
                     'auto INTEGER, mode TEXT, params TEXT, n_rows INTEGER, created TEXT)')
        conn.execute('CREATE TABLE IF NOT EXISTS rows (stem TEXT, sig TEXT, row_key TEXT)')
        conn.execute('CREATE INDEX IF NOT EXISTS rows_sig ON rows (sig)')
        conn.execute('CREATE INDEX IF NOT EXISTS rows_stem ON rows (stem)')
        return conn

    def refresh(self) -> None:
        """Bring the index up to date with the folder: new, changed and removed files."""
        if not self.root.exists():
            return
        with self.lock:
            conn = self._connect()
            try:
                known = {stem: mtime for stem, mtime in conn.execute('SELECT stem, mtime FROM alignments')}
                present = {}
                for path in self.root.glob('*.json'):
                    try:
                        present[path.stem] = path.stat().st_mtime
                    except OSError:
                        continue
                for stem in set(known) - set(present):
                    conn.execute('DELETE FROM alignments WHERE stem = ?', (stem,))
                    conn.execute('DELETE FROM rows WHERE stem = ?', (stem,))
                for stem, mtime in present.items():
                    if known.get(stem) == mtime:
                        continue
                    self._index_file(conn, stem, mtime)
                conn.commit()
            finally:
                conn.close()

    def _index_file(self, conn: sqlite3.Connection, stem: str, mtime: float) -> None:
        conn.execute('DELETE FROM alignments WHERE stem = ?', (stem,))
        conn.execute('DELETE FROM rows WHERE stem = ?', (stem,))
        try:
            meta = json.loads((self.root / f'{stem}.json').read_text())
        except (OSError, ValueError):
            meta = None
        if not isinstance(meta, dict) or str(meta.get('version')) != VERSION:
            # Unreadable, or version 1: recorded so it isn't read again until it changes.
            conn.execute('INSERT INTO alignments (stem, mtime, n_rows) VALUES (?, ?, 0)', (stem, mtime))
            return
        rows = meta.get('genomes') or []
        conn.execute('INSERT INTO alignments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                     (stem, mtime, meta.get('name') or stem, meta.get('source') or '', 1 if meta.get('auto') else 0,
                      (meta.get('params') or {}).get('mode') or '', json.dumps(meta.get('params') or {}), len(rows),
                      meta.get('created') or ''))
        conn.executemany('INSERT INTO rows VALUES (?, ?, ?)',
                         [(stem, r.get('signature'), r.get('row_key')) for r in rows if r.get('signature')])

    def find_covering(self, signatures: Iterable[str]) -> Optional[str]:
        """The smallest stored alignment holding every one of these rows, newest first on a tie."""
        wanted = sorted(set(s for s in signatures if s))
        if not wanted:
            return None
        self.refresh()
        with self.lock:
            conn = self._connect()
            try:
                conn.execute('CREATE TEMP TABLE wanted (sig TEXT PRIMARY KEY)')
                conn.executemany('INSERT INTO wanted VALUES (?)', [(s,) for s in wanted])
                row = conn.execute(
                    'SELECT a.stem FROM rows r JOIN wanted w ON w.sig = r.sig JOIN alignments a ON a.stem = r.stem '
                    'GROUP BY a.stem HAVING COUNT(DISTINCT r.sig) = ? ORDER BY a.n_rows ASC, a.created DESC LIMIT 1',
                    (len(wanted),)).fetchone()
                return row[0] if row else None
            finally:
                conn.close()

    # ── files ──

    def save(self, alignment: Dict[str, Any], name: str, *, source: str, auto: bool) -> str:
        """Write an alignment; returns its stem. The same rows saved twice land in one file.

        ``alignment`` has ``rows`` (each with ``row_key``, ``signature``, ``aligned`` and any
        other metadata), ``params``, and optional ``strategy``/``consensus``/stats.
        """
        rows = alignment['rows']
        digest = hashlib.sha256('|'.join(sorted(r['signature'] for r in rows)).encode()).hexdigest()[:10]
        stem = f'{safe_stem(name)}_{digest}'
        with self.lock:
            self.root.mkdir(parents=True, exist_ok=True)
            fasta, meta_path = self.root / f'{stem}.fasta', self.root / f'{stem}.json'
            if meta_path.exists() and fasta.exists():
                return stem
            with open(fasta, 'w') as fh:
                for row in rows:
                    fh.write(f">{row['row_key']}\n")
                    seq = row['aligned']
                    for i in range(0, len(seq), 60):
                        fh.write(seq[i:i + 60] + '\n')
            meta = {
                'version': VERSION, 'name': name, 'created': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'fasta_file': fasta.name, 'source': source, 'auto': bool(auto), 'params': alignment.get('params') or {},
                'strategy': alignment.get('strategy') or '', 'alignment_length': len(rows[0]['aligned']) if rows else 0,
                'consensus': alignment.get('consensus') or '',
                'stats': {'alignment_length': len(rows[0]['aligned']) if rows else 0, 'included_count': len(rows),
                          'average_identity': alignment.get('average_identity') or 0, 'strategy': alignment.get('strategy') or ''},
                'genomes': [{k: v for k, v in r.items() if k != 'aligned'} for r in rows],
            }
            tmp = meta_path.with_suffix('.json.tmp')
            tmp.write_text(json.dumps(meta))
            tmp.replace(meta_path)
        self.refresh()
        return stem

    def load(self, stem: str) -> Dict[str, Any]:
        """A stored alignment: its metadata with ``rows``, each with its ``aligned`` sequence."""
        if not self.exists(stem):
            raise FileNotFoundError(stem)
        meta_path, fasta = self.root / f'{stem}.json', self.root / f'{stem}.fasta'
        mtime = meta_path.stat().st_mtime
        with self.lock:
            hit = self.loaded.get(stem)
            if hit and hit[0] == mtime:
                self.loaded.move_to_end(stem)
                return hit[1]
        meta = json.loads(meta_path.read_text())
        sequences: Dict[str, List[str]] = {}
        current = None
        with open(fasta) as fh:
            for line in fh:
                line = line.rstrip('\n')
                if line.startswith('>'):
                    current = line[1:].strip()
                    sequences[current] = []
                elif current is not None:
                    sequences[current].append(line)
        rows = []
        for row in meta.get('genomes') or []:
            key = row.get('row_key') or row.get('genome_key')
            if key in sequences:
                rows.append({**row, 'aligned': ''.join(sequences[key])})
        alignment = {**{k: v for k, v in meta.items() if k != 'genomes'}, 'id': stem, 'rows': rows}
        with self.lock:
            self.loaded[stem] = (mtime, alignment)
            while len(self.loaded) > _LOADED_LIMIT:
                self.loaded.popitem(last=False)
        return alignment

    def exists(self, stem: str) -> bool:
        return bool(stem) and safe_stem(stem) == stem and (self.root / f'{stem}.json').exists()
