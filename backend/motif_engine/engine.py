import hashlib
import json
import math
import sqlite3
import sys
import zlib
from array import array
from pathlib import Path

import regex

VERSION = 'motifs-v2:ungapped:ignorecase:displayed-strand'
TILE = 16384
ZERO_LAST = bytes([255, *range(1, 256)])


class SearchCancelled(Exception):
    pass


def check(cancelled):
    if cancelled():
        raise SearchCancelled()


def pattern_key(pattern, kind):
    # Literal case is immaterial. Regex syntax/inline flags must remain intact.
    value = pattern.upper() if kind == 'literal' else pattern
    return hashlib.sha256(json.dumps([VERSION, kind, value]).encode()).hexdigest()


def composition_key(motifs):
    return hashlib.sha256('|'.join(pattern_key(m.pattern, m.kind) for m in motifs).encode()).hexdigest()


def pack(spans):
    if sys.byteorder != 'little':
        spans = array('I', spans); spans.byteswap()
    return zlib.compress(spans.tobytes(), 1)


def unpack(blob):
    spans = array('I'); spans.frombytes(zlib.decompress(blob))
    if sys.byteorder != 'little':
        spans.byteswap()
    return spans


def search_spans(sequence, pattern, kind='literal', cancelled=lambda: False, timeout=2):
    """Compact, disjoint aligned intervals, with overlapping occurrences included."""
    check(cancelled)
    text = sequence.replace('-', '')
    runs = array('I')
    if kind == 'literal':
        text, needle = text.upper(), pattern.upper()
        def matches():
            start = text.find(needle)
            while start >= 0:
                yield start, start + len(needle)
                start = text.find(needle, start + 1)
        iterator = matches() if needle else iter(())
    else:
        expression = regex.compile(pattern, regex.IGNORECASE | regex.VERSION1)
        iterator = (m.span() for m in expression.finditer(text, overlapped=True, timeout=timeout))
    for count, (a, z) in enumerate(iterator):
        if count % 2048 == 0:
            check(cancelled)
        if a == z:
            continue
        if runs and a <= runs[-1]:
            runs[-1] = max(z, runs[-1])
        else:
            runs.extend((a, z))
    check(cancelled)
    if '-' not in sequence or not runs:
        return runs
    aligned, index, offset = array('I'), 0, 0
    for count, segment in enumerate(regex.finditer('[^-]+', sequence)):
        if index >= len(runs):
            break
        if count % 2048 == 0:
            check(cancelled)
        start, end = segment.span()
        segment_end = offset + end - start
        while index < len(runs) and runs[index] < segment_end:
            if index % 4096 == 0:
                check(cancelled)
            a, z = runs[index:index + 2]
            aligned.extend((start + max(0, a - offset), min(end, start + z - offset)))
            if z > segment_end:
                break
            index += 2
        offset = segment_end
    check(cancelled)
    return aligned


def reduce_mask(data, factor):
    """At overview scale, the highest priority present in a bin wins. 0 is neutral."""
    ranked = data.translate(ZERO_LAST)
    return bytes(0 if (value := min(ranked[i:i + factor])) == 255 else value
                 for i in range(0, len(ranked), factor))


class MotifCache:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS searches (
                    sequence TEXT, motif TEXT, data BLOB NOT NULL,
                    PRIMARY KEY(sequence,motif));
                CREATE TABLE IF NOT EXISTS prepared (
                    sequence TEXT, composition TEXT, length INTEGER, matched INTEGER,
                    PRIMARY KEY(sequence,composition));
                CREATE TABLE IF NOT EXISTS tiles (
                    sequence TEXT, composition TEXT, step INTEGER, offset INTEGER, data BLOB NOT NULL,
                    PRIMARY KEY(sequence,composition,step,offset));
            ''')

    def connect(self):
        return sqlite3.connect(self.path, timeout=30)

    def prepare(self, sequence_key, load_sequence, motifs, cancelled=lambda: False, progress=lambda **_: None):
        """Commit *all* work for this sequence together, or nothing on cancellation.

        Cached searches exclude colour, priority and motif ID. Prepared masks
        exclude colour, but include priority. A warm pass never loads sequence.
        """
        check(cancelled)
        composition = composition_key(motifs)
        with self.connect() as db:
            ready = db.execute('SELECT length,matched FROM prepared WHERE sequence=? AND composition=?',
                               (sequence_key, composition)).fetchone()
            if ready:
                return dict(length=ready[0], matched=bool(ready[1]), searched=0, cached=len(motifs), prepared_cached=True)
            pending, cached, searched, sequence, mask = {}, 0, 0, None, None
            # Paint low priority first so high priority overwrites it in C slices.
            for ordinal, (priority, motif) in enumerate(reversed(list(enumerate(motifs))), 1):
                check(cancelled)
                key = pattern_key(motif.pattern, motif.kind)
                row = db.execute('SELECT data FROM searches WHERE sequence=? AND motif=?', (sequence_key, key)).fetchone()
                blob = row[0] if row else pending.get(key)
                progress(phase='cached' if blob is not None else 'searching', motif=motif.pattern,
                         motif_index=ordinal, motif_total=len(motifs))
                if blob is not None:
                    spans = unpack(blob); cached += 1
                else:
                    if sequence is None:
                        sequence = load_sequence()
                    spans = search_spans(sequence, motif.pattern, motif.kind, cancelled)
                    blob = pack(spans); pending[key] = blob; searched += 1
                if mask is None:
                    # A cached motif still needs the source length, never its text.
                    known = db.execute('SELECT length FROM prepared WHERE sequence=? LIMIT 1', (sequence_key,)).fetchone()
                    length = known[0] if known else len(sequence if sequence is not None else load_sequence())
                    mask = bytearray(length)
                colour = bytes([priority + 1])
                for i in range(0, len(spans), 2):
                    if i % 4096 == 0:
                        check(cancelled)
                    a, z = spans[i:i + 2]
                    mask[a:z] = colour * (z - a)
            if mask is None:
                mask = bytearray(len(load_sequence()))
            progress(phase='preparing', motif='', motif_index=len(motifs), motif_total=len(motifs))
            length, matched, tiles, step = len(mask), any(mask), [], 1
            data = bytes(mask)
            while True:
                for offset in range(0, len(data), TILE):
                    check(cancelled)
                    tiles.append((sequence_key, composition, step, offset, zlib.compress(data[offset:offset + TILE], 1)))
                if len(data) <= 1:
                    break
                # Bounded slices provide cancellation checkpoints even for a
                # chromosome-length mask, and cap Python iteration at n/16.
                chunks = []
                for offset in range(0, len(data), TILE):
                    check(cancelled)
                    chunks.append(reduce_mask(data[offset:offset + TILE], 16))
                data = b''.join(chunks); step *= 16
            check(cancelled)
            with db:
                db.executemany('INSERT OR REPLACE INTO searches VALUES (?,?,?)',
                               [(sequence_key, key, blob) for key, blob in pending.items()])
                db.executemany('INSERT OR REPLACE INTO tiles VALUES (?,?,?,?,?)', tiles)
                db.execute('INSERT OR REPLACE INTO prepared VALUES (?,?,?,?)', (sequence_key, composition, length, int(matched)))
            return dict(length=length, matched=matched, searched=searched, cached=cached, prepared_cached=False)

    def region(self, sequence_key, composition, start, end, step=1):
        """Read at most a small multiple of the requested pixels, never the full mask."""
        with self.connect() as db:
            record = db.execute('SELECT length FROM prepared WHERE sequence=? AND composition=?', (sequence_key, composition)).fetchone()
            if record is None:
                return None
            length = record[0]; end = min(end, length)
            if end <= start:
                return []
            base_step = 16 ** max(0, int(math.log(max(1, step), 16)))
            a, z = start // base_step, math.ceil(end / base_step)
            data = bytearray(z - a)
            for offset, blob in db.execute('SELECT offset,data FROM tiles WHERE sequence=? AND composition=? AND step=? AND offset>=? AND offset<? ORDER BY offset',
                                           (sequence_key, composition, base_step, a // TILE * TILE, z)):
                chunk = zlib.decompress(blob)
                left, right = max(a, offset), min(z, offset + len(chunk))
                data[left - a:right - a] = chunk[left - offset:right - offset]
            if step > base_step:
                data = reduce_mask(bytes(data), step // base_step)
            runs = []
            for i, value in enumerate(data):
                if not value:
                    continue
                left, right = start + i * step, min(end, start + (i + 1) * step)
                if runs and runs[-1][2] == value and runs[-1][1] == left:
                    runs[-1][1] = right
                else:
                    runs.append([left, right, value])
            return runs
