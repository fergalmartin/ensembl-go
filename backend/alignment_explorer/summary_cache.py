"""Disposable, bounded, persistent additive summaries of immutable source chunks.

64-column prefix counts represent every coarser level exactly. Arbitrary bin
edges read at most two partial leaves; warm zoom-out never compares a whole
block again. Focus comparisons are built lazily, never for all sequence pairs.
"""
from array import array
from collections import Counter
from contextlib import contextmanager
import hashlib
import os
import sqlite3
import sys
import threading
import time
import zlib

LEAF = 64
CHUNK = 65536
ALPHABET = 'ACGTRYSWKMBDHVN-?'
WIDTH = len(ALPHABET) + 2
VERSION = 1
_LOCKS = [threading.Lock() for _ in range(32)]


def counts(text, reference, same=False):
    bases = Counter(text)
    result = [bases.get(base, 0) for base in ALPHABET]
    comparable = different = 0
    if same:
        comparable = sum(bases.get(base, 0) for base in 'ACGT')
    else:
        for a, b in zip(text, reference):
            if a in 'ACGT' and b in 'ACGT':
                comparable += 1
                different += a != b
    return result + [comparable, different]


def build_prefix(text, reference, same, cancelled=lambda: False):
    result = array('I', [0] * WIDTH)
    running = [0] * WIDTH
    for start in range(0, len(text), LEAF):
        if start % 1024 == 0 and cancelled(): raise InterruptedError('Navigation changed')
        values = counts(text[start:start + LEAF], reference[start:start + LEAF], same)
        running = [a + b for a, b in zip(running, values)]
        result.extend(running)
    return result


class SummaryCache:
    def __init__(self, store, cancelled=lambda: False):
        self.store = store
        self.cancelled = cancelled
        self.disabled = False
        self.path = store.directory / 'render-summaries.sqlite'
        self.budget = max(1024 * 1024, int(os.environ.get('ENSEMBL_ALIGNMENT_SUMMARY_BYTES', 128 * 1024 * 1024)))
        # Reimporting/replacing a source DB must not reuse its old sidecar. Label
        # and annotation writes leave the inode unchanged and keep base counts.
        stat = store.path.stat()
        self.identity = f'{VERSION}:{stat.st_dev}:{stat.st_ino}'
        self.db = None

    def __enter__(self): return self

    def __exit__(self, *_exc):
        if self.db is not None: self.db.close()

    @contextmanager
    def connect(self):
        if self.db is None:
            self.db = sqlite3.connect(self.path, timeout=30)
            self.db.execute('PRAGMA auto_vacuum=INCREMENTAL')
            self.db.execute('CREATE TABLE IF NOT EXISTS tiles (key TEXT PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL, used REAL NOT NULL)')
            self.db.execute('CREATE INDEX IF NOT EXISTS tiles_used ON tiles(used)')
        try:
            yield self.db
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def prefix(self, block, row_id, focus, offset, raw):
        if not self.disabled:
            try: return self._prefix(block, row_id, focus, offset, raw)
            except InterruptedError: raise
            except (sqlite3.DatabaseError, OSError):
                # A disposable cache must never make a valid source unreadable.
                # Fall back to exact in-memory preparation for this request.
                self.disabled = True
        text = raw(row_id, offset)
        if text is None: return None
        reference = raw(focus, offset) if focus and focus != row_id else ''
        return build_prefix(text, reference or '', row_id == focus, self.cancelled)

    def _prefix(self, block, row_id, focus, offset, raw):
        key = f'{self.identity}:{block}:{row_id}:{focus or ""}:{offset}'
        # Stripe locks coalesce concurrent misses without serialising all rows.
        lock = _LOCKS[int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % len(_LOCKS)]
        with lock:
            with self.connect() as cache:
                found = cache.execute('SELECT data,used FROM tiles WHERE key=?', (key,)).fetchone()
                if found:
                    try:
                        result = array('I')
                        result.frombytes(zlib.decompress(found[0]))
                        if sys.byteorder != 'little': result.byteswap()
                        if len(result) < WIDTH or len(result) % WIDTH: raise ValueError('Invalid summary')
                        if time.time() - found[1] > 60:
                            cache.execute('UPDATE tiles SET used=? WHERE key=?', (time.time(), key))
                        return result
                    except (ValueError, zlib.error):
                        cache.execute('DELETE FROM tiles WHERE key=?', (key,))
            text = raw(row_id, offset)
            if text is None: return None
            reference = raw(focus, offset) if focus and focus != row_id else ''
            result = build_prefix(text, reference or '', row_id == focus, self.cancelled)
            stored = array('I', result)
            if sys.byteorder != 'little': stored.byteswap()
            payload = zlib.compress(stored.tobytes(), 1)
            with self.connect() as cache:
                cache.execute('INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)', (key, payload, len(payload), time.time()))
                size = cache.execute('SELECT coalesce(sum(size),0) FROM tiles').fetchone()[0]
                if size > self.budget:
                    for old, amount in cache.execute('SELECT key,size FROM tiles ORDER BY used').fetchall():
                        if size <= self.budget * .9: break
                        cache.execute('DELETE FROM tiles WHERE key=?', (old,)); size -= amount
                    cache.execute('PRAGMA incremental_vacuum(256)')
            return result


def summarize(store, db, block, length, row, start, end, step, focus, cache):
    # The per-row raw cache is bounded to the chunks touched by the request and
    # shared with its focus. Cached prefixes need no sequence read except edges.
    raw_chunks = {}
    def raw(row_id, offset):
        key = (row_id, offset)
        if key not in raw_chunks:
            record = db.execute('SELECT bases FROM chunks WHERE block=? AND id=? AND offset=?', (block, row_id, offset)).fetchone()
            raw_chunks[key] = record[0] if record else None
        return raw_chunks[key]
    prefixes = {}
    totals = []
    for a in range(start, end, step):
        z = min(end, a + step)
        total = [0] * WIDTH
        pos = a
        while pos < z:
            offset = pos // CHUNK * CHUNK
            stop = min(z, offset + CHUNK)
            if offset not in prefixes:
                prefixes[offset] = cache.prefix(block, row['id'], focus, offset, raw)
            prefix = prefixes[offset]
            if prefix is not None:
                left, right = pos - offset, stop - offset
                lo, hi = (left + LEAF - 1) // LEAF, right // LEAF
                if hi > lo:
                    for i in range(WIDTH): total[i] += prefix[hi * WIDTH + i] - prefix[lo * WIDTH + i]
                    edges = [(left, lo * LEAF), (hi * LEAF, right)]
                else:
                    edges = [(left, right)]
                for x, y in edges:
                    if y <= x: continue
                    text = (raw(row['id'], offset) or '')[x:y]
                    reference = (raw(focus, offset) or '')[x:y] if focus and focus != row['id'] else ''
                    for i, value in enumerate(counts(text, reference, row['id'] == focus)): total[i] += value
            pos = stop
        totals.append(total)
    # Empty components have no chunk: retain the API's explicit missing state.
    missing = not any(sum(value[:len(ALPHABET)]) for value in totals)
    row['bins'] = [] if missing else [{base: value[i] for i, base in enumerate(ALPHABET) if value[i]} for value in totals]
    row['divergence_bins'] = [] if missing else [{'comparable': v[-2], 'different': v[-1], 'fraction': v[-1] / v[-2] if v[-2] else None} for v in totals]
    row['missing'] = missing
    row['sequence'] = None
    first = db.execute('SELECT bases,ungapped_before FROM chunks WHERE block=? AND id=? AND offset=?', (block, row['id'], start // CHUNK * CHUNK)).fetchone()
    row['offset_bases'] = first['ungapped_before'] + len(first['bases'][:start % CHUNK].replace('-', '')) if first else 0
