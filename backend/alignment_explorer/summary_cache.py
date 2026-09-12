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

# Cohort leaves carry five running totals: the summed majority base count, the
# summed canonical count, the number of columns where a comparison was possible
# at all, the summed non-gap count, and the number of columns. Identity is a
# ratio of sums, never a mean of per-column ratios, so an arbitrary bin edge
# still divides exactly once.
#
# A column carrying fewer than two canonical bases has nothing to agree or
# disagree with, so it enters neither the numerator nor the denominator of
# identity. Left in, every such column would have reported perfect agreement
# with itself and dragged the whole bin upward. It still counts toward
# representation, which is precisely the fact that it is thin.
COHORT_WIDTH = 5

try:
    import numpy as _np
except ImportError:  # numpy arrives transitively and is not a declared dependency.
    _np = None


def cohort_hash(ids):
    """Sorted, so the same set of sequences shares one cache entry whatever order it arrives in."""
    return hashlib.sha256('\0'.join(sorted(set(ids))).encode()).hexdigest()[:16]


def cohort_counts(texts, width):
    """Per column: majority and canonical totals over comparable columns only,
    whether the column was comparable, and the non-gap total over all of them."""
    if _np is not None and texts:
        table = _np.frombuffer(b''.join(text.ljust(width, '-').encode() for text in texts), dtype=_np.uint8)
        table = table.reshape(len(texts), width)
        acgt = _np.stack([(table == base).sum(axis=0) for base in b'ACGT'])
        canonical = acgt.sum(axis=0)
        comparable = canonical >= 2
        return ((acgt.max(axis=0) * comparable).tolist(), (canonical * comparable).tolist(),
                comparable.astype('uint32').tolist(), (table != ord('-')).sum(axis=0).tolist())
    majority, canonical, comparable, occupied = [0] * width, [0] * width, [0] * width, [0] * width
    for text in texts:
        for i, base in enumerate(text):
            if base != '-': occupied[i] += 1
    for i in range(width):
        column = Counter(text[i] for text in texts if i < len(text))
        counts_acgt = [column.get(base, 0) for base in 'ACGT']
        if sum(counts_acgt) >= 2:
            majority[i], canonical[i], comparable[i] = max(counts_acgt), sum(counts_acgt), 1
    return majority, canonical, comparable, occupied


def build_cohort_prefix(texts, cancelled=lambda: False):
    width = max((len(text) for text in texts), default=0)
    result = array('I', [0] * COHORT_WIDTH)
    running = [0] * COHORT_WIDTH
    if not width: return result
    columns = cohort_counts(texts, width)
    for start in range(0, width, LEAF):
        if start % 1024 == 0 and cancelled(): raise InterruptedError('Navigation changed')
        stop = min(width, start + LEAF)
        running = [running[i] + sum(values[start:stop]) for i, values in enumerate(columns)] + [running[4] + stop - start]
        result.extend(running)
    return result


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
        def build():
            text = raw(row_id, offset)
            if text is None: return None
            reference = raw(focus, offset) if focus and focus != row_id else ''
            return build_prefix(text, reference or '', row_id == focus, self.cancelled)
        key = f'{self.identity}:{block}:{row_id}:{focus or ""}:{offset}'
        return self._cached(key, WIDTH, build)

    def cohort_prefix(self, block, digest, offset, texts):
        """One entry per block chunk rather than per row, so a cohort costs a
        fraction of what its members already cost individually."""
        key = f'{self.identity}:{block}:cohort:{digest}:{offset}'
        return self._cached(key, COHORT_WIDTH, lambda: build_cohort_prefix(texts(), self.cancelled))

    def _cached(self, key, width, build):
        if not self.disabled:
            try: return self._store(key, width, build)
            except InterruptedError: raise
            except (sqlite3.DatabaseError, OSError):
                # A disposable cache must never make a valid source unreadable.
                # Fall back to exact in-memory preparation for this request.
                self.disabled = True
        return build()

    def _store(self, key, width, build):
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
                        if len(result) < width or len(result) % width: raise ValueError('Invalid summary')
                        if time.time() - found[1] > 60:
                            cache.execute('UPDATE tiles SET used=? WHERE key=?', (time.time(), key))
                        return result
                    except (ValueError, zlib.error):
                        cache.execute('DELETE FROM tiles WHERE key=?', (key,))
            result = build()
            if result is None: return None
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


def cohort_summarize(db, block, ids, start, end, step, cache):
    """Per-bin column identity over a cohort, as sums that are divided exactly once.

    The denominator the caller divides by is the cohort, not the block's own
    membership, so a block holding three of ten sequences cannot read as well
    represented however well those three agree.
    """
    members = [row[0] for row in db.execute(
        'SELECT id FROM rows WHERE block=? AND empty_status IS NULL', (block,)).fetchall() if row[0] in set(ids)]
    digest = cohort_hash(members)
    raw_chunks = {}
    def raw(row_id, offset):
        key = (row_id, offset)
        if key not in raw_chunks:
            record = db.execute('SELECT bases FROM chunks WHERE block=? AND id=? AND offset=?', (block, row_id, offset)).fetchone()
            raw_chunks[key] = record[0] if record else None
        return raw_chunks[key]
    def texts_at(offset):
        return lambda: [text for text in (raw(row_id, offset) for row_id in members) if text]
    prefixes = {}
    fields = {name: [] for name in ('majority', 'canonical', 'comparable', 'occupied', 'columns')}
    for a in range(start, end, step):
        z = min(end, a + step)
        total = [0] * COHORT_WIDTH
        pos = a
        while pos < z:
            offset = pos // CHUNK * CHUNK
            stop = min(z, offset + CHUNK)
            if offset not in prefixes:
                prefixes[offset] = cache.cohort_prefix(block, digest, offset, texts_at(offset)) if members else None
            prefix = prefixes[offset]
            left, right = pos - offset, stop - offset
            lo, hi = (left + LEAF - 1) // LEAF, right // LEAF
            edges = [(left, right)]
            if prefix is not None and hi > lo and hi * COHORT_WIDTH < len(prefix):
                for i in range(COHORT_WIDTH): total[i] += prefix[hi * COHORT_WIDTH + i] - prefix[lo * COHORT_WIDTH + i]
                edges = [(left, lo * LEAF), (hi * LEAF, right)]
            for x, y in edges:
                if y <= x: continue
                slice_texts = [(raw(row_id, offset) or '')[x:y] for row_id in members]
                width = max((len(text) for text in slice_texts), default=0)
                if width:
                    for i, values in enumerate(cohort_counts([text for text in slice_texts if text], width)):
                        total[i] += sum(values)
                total[4] += y - x
            pos = stop
        for i, name in enumerate(fields): fields[name].append(total[i])
    return fields
