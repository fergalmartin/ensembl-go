"""Disk-backed alignment blocks. Source identifiers are never session genome keys."""
import csv
import gzip
import hashlib
import io
import json
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from collections import Counter
from .summary_cache import SummaryCache, summarize, cohort_summarize
from .gaps import (runs_of_gap, intersect, merge_adjacent, fill_uncovered,
                   gap_tally, tally_gaps, runs_at_least, rows_needed)
from contextlib import contextmanager

DNA = set('ACGTRYSWKMBDHVN-?.')
CANONICAL = set('ACGT')
CHUNK = 65536
# Nominal separation between source blocks in the stored layout, in alignment
# columns. It is a layout device, never a biological distance. Every gap is the
# same, so blocks stay evenly spaced at any camera position. The visible
# separation the reader actually sees is drawn in screen space by the renderer
# (see BLOCK_EDGE_GAP in the frontend), because block lengths span three orders
# of magnitude and no column count can look right beside both a 955-column and a
# 1,000,000-column block.
SOURCE_GAP = 32
# Bump whenever the spacing formula changes so existing datasets rebuild the
# disposable layout index instead of keeping positions from the old formula.
LAYOUT_VERSION = 3
# Individual block edges carried inside a merged descriptor, for pointing at the
# block under the cursor. Beyond this a merge is too fine-grained to point at.
EDGES_PER_MERGE = 96
_LAYOUT_LOCK = threading.Lock()


def fingerprint(path):
    stat = Path(path).stat()
    return {'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns}


def stable_id(source):
    return 's' + hashlib.sha256(source.encode()).hexdigest()[:20]


def clean_sequence(seq):
    seq = ''.join(seq.split()).upper().replace('U', 'T').replace('.', '-')
    bad = set(seq) - DNA
    if bad:
        raise ValueError('Not a nucleotide alignment: invalid characters ' + ', '.join(sorted(bad)))
    return seq


# Every format a reader can be asked for by name, with the label the chooser
# shows. Detection may pick any of these; a reader may also be named explicitly
# when a file's own signature is missing or misleading.
TEXT_FORMATS = {
    'maf': 'MAF',
    'fasta': 'Aligned FASTA',
    'clustal': 'Clustal',
    'stockholm': 'Stockholm',
    'phylip-relaxed': 'PHYLIP (relaxed names)',
    'phylip': 'PHYLIP (strict 10-character names)',
    'nexus': 'NEXUS',
    'msf': 'GCG MSF',
    'xmfa': 'XMFA / Mauve',
}
NATIVE_FORMATS = {'hal': 'HAL', 'taf': 'TAF', 'bigmaf': 'bigMaf', 'gfa': 'GFA graph'}
# Suffixes that name a reader on their own. Only consulted once no signature in
# the file itself matched, so a misnamed file still reads by its content.
SUFFIX_FORMATS = {'fa': 'fasta', 'fas': 'fasta', 'fna': 'fasta', 'mfa': 'fasta', 'afa': 'fasta', 'fsa': 'fasta',
                  'aln': 'clustal', 'clw': 'clustal', 'phy': 'phylip-relaxed', 'phylip': 'phylip-relaxed',
                  'sto': 'stockholm', 'stk': 'stockholm', 'stockholm': 'stockholm',
                  'nex': 'nexus', 'nexus': 'nexus', 'nxs': 'nexus', 'msf': 'msf',
                  'maf': 'maf', 'xmfa': 'xmfa', 'fasta': 'fasta'}


def format_label(fmt):
    return TEXT_FORMATS.get(fmt) or NATIVE_FORMATS.get(fmt) or fmt


def detect_format(path, requested='auto'):
    """Name the reader for a file, by explicit request or by its own content.

    An explicit request always wins: detection reads signatures, and a signature
    can be absent (a bare FASTA) or shadowed by another format's (a Clustal
    alignment whose first sequence is named `a` looks like a MAF `a` line). The
    caller is told which reader was chosen so a wrong guess is visible and can
    be overridden rather than silently mis-parsing the file.
    """
    if requested != 'auto':
        # A reader's own name always wins over the suffix map, which shares
        # spellings with it: `phylip` names the strict reader, while a file
        # *named* `.phylip` is read by the relaxed one.
        name = requested.lower()
        fmt = name if name in TEXT_FORMATS or name in NATIVE_FORMATS else SUFFIX_FORMATS.get(name, name)
        if fmt not in TEXT_FORMATS and fmt not in NATIVE_FORMATS:
            raise ValueError('Unknown alignment format: ' + requested)
        return fmt
    name = str(path).lower().removesuffix('.gz').removesuffix('.bgz')
    suffix = name.rsplit('.', 1)[-1]
    if suffix in ('hal', 'taf', 'bigmaf', 'bb', 'gfa'):
        return 'bigmaf' if suffix == 'bb' else suffix
    with open_text(path) as handle:
        head = handle.read(8192).lstrip()
    # Unambiguous signatures first. The MAF `a` line is a weak signal that any
    # format can produce from a sequence named `a`, so it is tried last of all.
    if head.startswith('##maf'): return 'maf'
    if head.startswith('# STOCKHOLM'): return 'stockholm'
    if head.upper().startswith(('CLUSTAL', 'MUSCLE')): return 'clustal'
    if head.upper().startswith('#NEXUS'): return 'nexus'
    if head.startswith('!!') and 'MULTIPLE_ALIGNMENT' in head[:64].upper(): return 'msf'
    if re.search(r'^\s*MSF:\s*\d+', head, re.M) and re.search(r'^\s*Name:\s', head, re.M): return 'msf'
    if head.startswith('#FormatVersion Mauve') or re.search(r'^>\s*\d+:\d+-\d+\s+[+-]', head, re.M): return 'xmfa'
    if head.startswith('>'): return 'fasta'
    # A PHYLIP header is a line holding exactly the taxon and column counts.
    if re.match(r'\d+\s+\d+$', head.split('\n', 1)[0].strip()): return 'phylip-relaxed'
    # A MAF without its header line: an `a` line must be followed by an `s`
    # record for this to be a MAF rather than a sequence that happens to be
    # named `a`.
    if re.search(r'^a(?:\s|$)', head, re.M) and re.search(r'^s\s+\S+\s+\d+\s+\d+\s+[+-]\s+\d+\s+\S', head, re.M): return 'maf'
    if suffix in SUFFIX_FORMATS: return SUFFIX_FORMATS[suffix]
    raise ValueError('Unrecognised alignment format. Choose the format explicitly when reopening this file.')


def open_text(path):
    with open(path, 'rb') as handle:
        gz = handle.read(2) == b'\x1f\x8b'
    return gzip.open(path, 'rt', encoding='utf-8-sig') if gz else open(path, encoding='utf-8-sig')


def open_tracked(path):
    """The text handle, plus how far through the file on disk it has read.

    Row and block counts alone cannot say how much is left, so an import can
    only be reported as a spinner. Compressed bytes consumed is a denominator
    that exists before anything is parsed, and it is the same denominator
    whether the file holds one block or a hundred thousand.
    """
    raw = open(path, 'rb')
    try:
        gz = raw.read(2) == b'\x1f\x8b'
        raw.seek(0)
        total = os.fstat(raw.fileno()).st_size
        handle = io.TextIOWrapper(gzip.GzipFile(fileobj=raw), encoding='utf-8-sig') if gz \
            else io.TextIOWrapper(raw, encoding='utf-8-sig')
    except Exception:
        raw.close(); raise
    # Reading the raw handle's own position works for both: the gzip reader
    # pulls from it, and the text wrapper buffers ahead of it. Either way it
    # moves monotonically from 0 to the size on disk.
    return handle, (lambda: min(total, raw.tell())), total


def maf_blocks(handle):
    rows, score, extras = [], '', []
    for line in handle:
        parts = line.split()
        if not parts or parts[0].startswith('#'): continue
        if parts[0] == 'a':
            if rows: yield rows, {'score': score, 'records': extras}
            rows, extras = [], []
            score = ' '.join(parts[1:])
        elif parts[0] == 's':
            if len(parts) != 7: raise ValueError('Malformed MAF sequence record')
            _, source, start, size, strand, length, sequence = parts
            start, size, length = int(start), int(size), int(length)
            sequence = clean_sequence(sequence)
            if strand not in ('+', '-') or start < 0 or size < 0 or start + size > length:
                raise ValueError('Invalid MAF source coordinates')
            if len(sequence.replace('-', '')) != size: raise ValueError('MAF size does not match sequence')
            forward = start if strand == '+' else length - start - size
            rows.append({'source': source, 'sequence': sequence, 'start': forward, 'end': forward + size, 'strand': strand, 'source_length': length, 'coordinates': True})
        elif parts[0] == 'e':
            if len(parts) != 7: raise ValueError('Malformed MAF empty component')
            _, source, start, size, strand, length, status = parts
            start, size, length = int(start), int(size), int(length)
            if strand not in ('+', '-') or start < 0 or size < 0 or start + size > length: raise ValueError('Invalid MAF empty component coordinates')
            forward = start if strand == '+' else length - start - size
            rows.append({'source': source, 'sequence': None, 'start': forward, 'end': forward + size, 'strand': strand, 'source_length': length, 'coordinates': True, 'empty_status': status})
        elif parts[0] in ('i', 'q'): extras.append(line.strip())
    if rows: yield rows, {'score': score, 'records': extras}


def xmfa_blocks(handle):
    rows, current, buf = [], None, []
    def finish():
        if current is not None: rows.append({**current, 'sequence': clean_sequence(''.join(buf))})
    for line in handle:
        if line.startswith('>'):
            finish(); buf = []
            match = re.match(r'>\s*(\d+):(\d+)-(\d+)\s+([+-])(?:\s+(.*))?', line.strip())
            if not match: raise ValueError('Invalid XMFA sequence header')
            source, start, end, strand, label = match.groups()
            start, end = int(start), int(end)
            current = {'source': source, 'label': label or source, 'start': max(0, start - 1), 'end': end, 'strand': strand, 'coordinates': start > 0, 'source_length': None}
        elif line.startswith('='):
            finish()
            if rows: yield rows, {}
            rows, current, buf = [], None, []
        elif not line.startswith('#') and current is not None: buf.append(line.strip())
    finish()
    if rows: yield rows, {}


class AlignmentStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory / 'alignment.sqlite'

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA cache_size=-8192')
        try:
            yield db
            db.commit()
        finally: db.close()

    def initialize(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
            CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE sequences(id TEXT PRIMARY KEY, source TEXT, label TEXT, metadata TEXT NOT NULL);
            CREATE TABLE blocks(id INTEGER PRIMARY KEY, length INTEGER NOT NULL, metadata TEXT NOT NULL);
            CREATE TABLE rows(block INTEGER, id TEXT, start INTEGER, end INTEGER, strand TEXT, source_length INTEGER, coordinates INTEGER, empty_status TEXT, PRIMARY KEY(block,id));
            CREATE INDEX region_lookup ON rows(id,start,end);
            CREATE TABLE chunks(block INTEGER, id TEXT, offset INTEGER, bases TEXT, ungapped_before INTEGER, PRIMARY KEY(block,id,offset));
            ''')

    def set_meta(self, key, value):
        with self.connect() as db: db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, json.dumps(value)))

    def meta(self):
        with self.connect() as db: return {r['key']: json.loads(r['value']) for r in db.execute('SELECT * FROM meta')}

    def inventory(self, offset=0, limit=1000, query=''):
        with self.connect() as db:
            args = ('%' + query + '%', '%' + query + '%')
            total = db.execute('SELECT count(*) FROM sequences WHERE source LIKE ? OR label LIKE ?', args).fetchone()[0]
            rows = [dict(r) for r in db.execute('SELECT * FROM sequences WHERE source LIKE ? OR label LIKE ? ORDER BY rowid LIMIT ? OFFSET ?', (*args, limit, offset))]
        for row in rows: row['metadata'] = json.loads(row['metadata'])
        return {'rows': rows, 'total': total, 'offset': offset}

    def _add_row(self, db, block, row, duplicate=0):
        source = row['source']
        # Copies within a block have independent identities. Do not infer continuity across blocks.
        row_id = stable_id(source if not duplicate else f'{source}\0block:{block}\0copy:{duplicate}')
        metadata = {k: v for k, v in row.items() if k not in ('sequence', 'source')}
        metadata['copy'] = duplicate
        db.execute('INSERT OR IGNORE INTO sequences VALUES (?,?,?,?)', (row_id, source, row.get('label') or source, json.dumps(metadata)))
        db.execute('INSERT INTO rows VALUES (?,?,?,?,?,?,?,?)', (block, row_id, row.get('start', 0), row.get('end', 0), row.get('strand', '+'), row.get('source_length'), bool(row.get('coordinates')), row.get('empty_status')))
        seq, ungapped = row.get('sequence'), 0
        if seq is not None:
            for offset in range(0, len(seq), CHUNK):
                chunk = seq[offset:offset + CHUNK]
                db.execute('INSERT INTO chunks VALUES (?,?,?,?,?)', (block, row_id, offset, chunk, ungapped))
                ungapped += len(chunk.replace('-', ''))
        return row_id

    def add_block(self, rows, metadata=None):
        sizes = {len(r['sequence']) for r in rows if r.get('sequence') is not None}
        if len(sizes) != 1 or not next(iter(sizes)): raise ValueError('Alignment rows must have the same nonzero column count within each block')
        with self.connect() as db:
            db.execute('DROP TABLE IF EXISTS source_layout')
            block = db.execute('INSERT INTO blocks(length,metadata) VALUES (?,?)', (next(iter(sizes)), json.dumps(metadata or {}))).lastrowid
            seen = Counter()
            for row in rows:
                self._add_row(db, block, row, seen[row['source']]); seen[row['source']] += 1
        return block

    def import_fasta(self, handle, cancelled, progress):
        # Stream every row into fixed-size chunks; even a chromosome-wide rectangular
        # FASTA does not require materialising the whole alignment or sequence.
        with self.connect() as db:
            db.execute('INSERT INTO blocks VALUES (1,0,?)', ('{}',))
            row_id, buffer, offset, ungapped, length, seen = None, '', 0, 0, None, Counter()
            def finish():
                nonlocal length, buffer, offset, ungapped
                if row_id is None: return
                if buffer:
                    db.execute('INSERT INTO chunks VALUES (?,?,?,?,?)', (1, row_id, offset, buffer, ungapped))
                    offset += len(buffer); ungapped += len(buffer.replace('-', ''))
                if not offset or (length is not None and length != offset): raise ValueError('FASTA rows are not an equal-length alignment')
                length = offset
                db.execute('UPDATE rows SET end=? WHERE block=1 AND id=?', (ungapped, row_id))
            for line in handle:
                if cancelled(): raise InterruptedError('Import cancelled')
                if line.startswith('>'):
                    finish()
                    header = line[1:].strip()
                    if not header: raise ValueError('Empty FASTA identifier')
                    # Conventionally the identifier is the first whitespace-delimited
                    # token and the remainder is free-text description, which is how
                    # every other reader here splits a record. Keeping the whole line
                    # as the identifier would make `>ENSG001 BRCA2 [Homo sapiens]`
                    # unmatchable against any metadata keyed by accession.
                    source = header.split(None, 1)[0]
                    row_id = self._add_row(db, 1, {'source': source, 'label': header, 'sequence': None}, seen[source]); seen[source] += 1
                    buffer, offset, ungapped = '', 0, 0
                    progress(rows=sum(seen.values()))
                elif line.strip():
                    if row_id is None: raise ValueError('Sequence before FASTA header')
                    buffer += clean_sequence(line)
                    while len(buffer) >= CHUNK:
                        chunk, buffer = buffer[:CHUNK], buffer[CHUNK:]
                        db.execute('INSERT INTO chunks VALUES (?,?,?,?,?)', (1, row_id, offset, chunk, ungapped))
                        offset += len(chunk); ungapped += len(chunk.replace('-', ''))
            finish()
            if length is None: raise ValueError('No aligned sequences found')
            db.execute('UPDATE blocks SET length=? WHERE id=1', (length,))

    def import_file(self, path, fmt, cancelled=lambda: False, progress=lambda **kw: None):
        handle, position, total = open_tracked(path)
        # Reported on a bounded schedule rather than per block: a file of small
        # blocks would otherwise spend its time writing progress.
        last = [0.0]
        def report(**values):
            now = time.monotonic()
            if now - last[0] >= 0.2 or 'rows' not in values and 'blocks' not in values:
                last[0] = now
                values['bytes'], values['total_bytes'] = position(), total
            progress(**values)
        with handle:
            if fmt == 'fasta': self.import_fasta(handle, cancelled, report)
            else:
                if fmt == 'maf': blocks = maf_blocks(handle)
                elif fmt == 'xmfa': blocks = xmfa_blocks(handle)
                else:
                    from Bio import AlignIO
                    def text_blocks():
                        for alignment in AlignIO.parse(handle, fmt):
                            rows = []
                            for record in alignment:
                                sequence = clean_sequence(str(record.seq))
                                # `end` is the row's ungapped length, as the FASTA reader
                                # records. `coordinates` stays false: these formats carry
                                # no source placement, so nothing may read it as one.
                                rows.append({'source': record.id, 'label': record.description or record.id,
                                             'sequence': sequence, 'end': len(sequence.replace('-', ''))})
                            yield rows, {}
                    blocks = text_blocks()
                count = 0
                for rows, metadata in blocks:
                    if cancelled(): raise InterruptedError('Import cancelled')
                    self.add_block(rows, metadata); count += 1; report(blocks=count)
                if not count: raise ValueError('No alignment blocks found')
        self.set_meta('format', fmt)

    def blocks(self, offset=0, limit=100, sequence_id=None, coordinate=None):
        with self.connect() as db:
            where, args = '', []
            if sequence_id:
                where = ' WHERE b.id IN (SELECT block FROM rows WHERE id=?'
                args.append(sequence_id)
                if coordinate is not None:
                    where += ' AND coordinates=1 AND start<=? AND end>?'; args += [coordinate, coordinate]
                where += ')'
            total = db.execute('SELECT count(*) FROM blocks b' + where, args).fetchone()[0]
            rows = [dict(r) for r in db.execute('SELECT b.*, (SELECT count(*) FROM rows r WHERE r.block=b.id) AS row_count FROM blocks b' + where + ' ORDER BY b.id LIMIT ? OFFSET ?', (*args, limit, offset))]
        for row in rows: row['metadata'] = json.loads(row['metadata'])
        return {'blocks': rows, 'total': total}

    def ensure_layout(self):
        # Disposable index upgrade for existing datasets. SQLite computes the
        # prefix sum on disk; no all-block inventory is sent to the browser.
        if self._layout_current(): return
        with _LAYOUT_LOCK, self.connect() as db:
            if self._layout_current(db): return
            db.execute('DROP TABLE IF EXISTS source_layout')
            db.execute('CREATE TABLE source_layout(block INTEGER PRIMARY KEY, x INTEGER NOT NULL, end_x INTEGER NOT NULL, row_count INTEGER NOT NULL)')
            prefix = 'coalesce(sum(b.length+?) OVER (ORDER BY b.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)'
            db.execute(f'INSERT INTO source_layout SELECT b.id, {prefix}, {prefix}+b.length, (SELECT count(*) FROM rows r WHERE r.block=b.id) FROM blocks b',
                       (SOURCE_GAP, SOURCE_GAP))
            db.execute('CREATE INDEX source_layout_x ON source_layout(x)')
            db.execute('CREATE INDEX source_layout_rows ON source_layout(row_count)')
            db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('layout_version', json.dumps(LAYOUT_VERSION)))

    def _layout_current(self, db=None):
        """A layout index built by this version of the spacing formula."""
        if db is None:
            with self.connect() as handle: return self._layout_current(handle)
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='source_layout'").fetchone(): return False
        row = db.execute("SELECT value FROM meta WHERE key='layout_version'").fetchone()
        return bool(row) and json.loads(row['value']) == LAYOUT_VERSION

    def layout_info(self, block=None):
        self.ensure_layout()
        with self.connect() as db:
            last=db.execute('SELECT block,end_x FROM source_layout ORDER BY block DESC LIMIT 1').fetchone()
            max_rows=db.execute('SELECT max(row_count) FROM source_layout').fetchone()[0] or 0
            item=db.execute('SELECT x FROM source_layout WHERE block=?',(block,)).fetchone() if block else None
        return {'max_source_rows':max_rows,'layout_end':last['end_x'] if last else 0,'layout_start':item['x'] if item else 0}

    def summary(self, limit=20000):
        """Per-sequence and per-block figures for the filter panel.

        Both inventories are aggregated in the database rather than by walking
        chunks: `rows` already carries each sequence's span in each block, so a
        sequence's block count and aligned bases are one grouped scan. Nothing
        here reads sequence text.

        `columns` counts the alignment columns of the blocks a sequence appears
        in, and is always known. `bases` counts ungapped bases, which is only
        derivable where the row carries source coordinates: MAF start/size are
        ungapped, while a plain FASTA row has none. `placed` says how many blocks
        contributed, so a caller can tell no bases from none counted rather than
        showing an alignment 0 bases everywhere.
        """
        self.ensure_layout()
        with self.connect() as db:
            total_sequences = db.execute('SELECT count(*) FROM sequences').fetchone()[0]
            total_blocks = db.execute('SELECT count(*) FROM blocks').fetchone()[0]
            sequences = [dict(r) for r in db.execute(
                '''SELECT s.id, s.source, s.label, s.metadata,
                          count(r.block) AS blocks,
                          coalesce(sum(CASE WHEN r.empty_status IS NULL AND r.coordinates THEN r.end - r.start END), 0) AS bases,
                          coalesce(sum(CASE WHEN r.empty_status IS NULL AND r.coordinates THEN 1 END), 0) AS placed,
                          coalesce(sum(CASE WHEN r.empty_status IS NULL THEN b.length END), 0) AS columns,
                          coalesce(sum(r.empty_status IS NOT NULL), 0) AS empty
                   FROM sequences s
                   LEFT JOIN rows r ON r.id = s.id
                   LEFT JOIN blocks b ON b.id = r.block
                   GROUP BY s.id ORDER BY s.rowid LIMIT ?''', (limit,))]
            for row in sequences:
                metadata = json.loads(row.pop('metadata') or '{}')
                row['assembly'] = metadata.get('assembly')
                row['assembly_name'] = metadata.get('assembly_name')
                row['region'] = metadata.get('region')
            blocks = [dict(r) for r in db.execute(
                '''SELECT b.id, b.length,
                          count(r.id) AS rows,
                          coalesce(sum(r.empty_status IS NULL), 0) AS available
                   FROM blocks b LEFT JOIN rows r ON r.block = b.id
                   GROUP BY b.id ORDER BY b.id LIMIT ?''', (limit,))]
        return {'sequences': sequences, 'blocks': blocks,
                'truncated': {'sequences': total_sequences > len(sequences), 'blocks': total_blocks > len(blocks)},
                'total': {'sequences': total_sequences, 'blocks': total_blocks}}

    def blocks_layout(self, blocks, limit=4000):
        """Descriptors for a named set of blocks, in block order.

        The layout endpoints answer "what is in this stretch of the file". Hiding
        asks the other question — "where are exactly these blocks" — and the
        answer cannot be a range: the blocks that survive a selection are
        scattered through the file, and asking for the ranges between them would
        fetch the very blocks being hidden. Each descriptor keeps its true `x`
        and `end_x`, so the caller can pack them and still name every block by
        the number it has in the file.
        """
        self.ensure_layout()
        wanted = sorted({int(b) for b in blocks})[:limit]
        if not wanted: return {'blocks': [], **self.layout_info()}
        marks = ','.join('?' * len(wanted))
        with self.connect() as db:
            records = [dict(r) for r in db.execute(
                f'SELECT * FROM source_layout WHERE block IN ({marks}) ORDER BY block', wanted)]
            by_block = {r['block']: r for r in records}
            for item in records: item.update(row_ids=[], available_row_ids=[])
            for row in db.execute(
                    f'SELECT r.block,r.id,r.empty_status FROM rows r JOIN sequences s ON s.id=r.id'
                    f' WHERE r.block IN ({marks}) ORDER BY r.block,s.rowid', wanted):
                entry = by_block.get(row['block'])
                if entry is None: continue
                entry['row_ids'].append(row['id'])
                if not row['empty_status']: entry['available_row_ids'].append(row['id'])
        return {'blocks': records, **self.layout_info()}

    def blocks_with(self, ids, limit=200000):
        """Blocks holding any of these sequences, and which of them each holds.

        Narrowing one list by the other needs the block numbers; building a layer
        from the result needs the membership too, because a selected sequence is
        not in every selected block and inventing rows for the ones it misses
        would put cells in a layer that are not in the alignment.
        """
        if not ids: return []
        marks = ','.join('?' * len(ids))
        found = {}
        with self.connect() as db:
            for row in db.execute(
                f'SELECT block, id FROM rows WHERE id IN ({marks}) AND empty_status IS NULL ORDER BY block LIMIT ?',
                (*ids, limit)):
                found.setdefault(row['block'], []).append(row['id'])
        return [{'block': block, 'ids': members} for block, members in sorted(found.items())]

    def row_fragments(self, ids):
        """Whole-block descriptors for every real occurrence of named rows.

        Original is loaded through a sliding layout window, but choosing a row
        by name means its file-wide path rather than the part of that path whose
        descriptors happen to be in the browser.  Resolve that path directly
        from the row-membership index and carry only the requested membership;
        returning every row of every matching block would make a small name
        selection grow with the total alignment size.

        Empty MAF components describe absence and therefore do not become layer
        cells, consistently with ``blocks_with`` and the regional readers.
        """
        if not ids: return []
        self.ensure_layout()
        marks = ','.join('?' * len(ids))
        fragments = []
        with self.connect() as db:
            rows = db.execute(
                f'''SELECT l.block,l.x,l.end_x,r.id
                    FROM rows r
                    JOIN source_layout l ON l.block=r.block
                    JOIN sequences s ON s.id=r.id
                    WHERE r.id IN ({marks}) AND r.empty_status IS NULL
                    ORDER BY l.block,s.rowid''', ids)
            current = None
            for row in rows:
                if current is None or current['block'] != row['block']:
                    current = {'block': row['block'], 'x': row['x'],
                               'end_x': row['end_x'], 'row_ids': []}
                    fragments.append(current)
                current['row_ids'].append(row['id'])
        return fragments

    def blocks_in_range(self, ids, start, end, limit=2000):
        """Blocks where any of these sequences covers a genomic interval.

        The importer stores forward-strand source coordinates, converting MAF's
        reverse-strand start/size on the way in, so one interval finds a row
        whichever strand it is aligned on. `region_lookup(id,start,end)` carries
        the lookup; no sequence text is read to find the blocks.

        Alignment columns are resolved as well, so a layer built from a
        coordinate filter holds the requested region rather than whole blocks.
        A column pair comes back reversed on the minus strand, so it is ordered
        here rather than leaving the caller to know that.
        """
        if not ids or end <= start: return []
        marks = ','.join('?' * len(ids))
        with self.connect() as db:
            rows = db.execute(
                f'SELECT block, id, start, end, strand FROM rows WHERE id IN ({marks}) '
                'AND coordinates AND empty_status IS NULL AND end > ? AND start < ? ORDER BY block LIMIT ?',
                (*ids, start, end, limit)).fetchall()
        found = []
        for row in rows:
            overlap_start, overlap_end = max(start, row['start']), min(end, row['end'])
            entry = {'block': row['block'], 'id': row['id'], 'start': overlap_start, 'end': overlap_end, 'columns': None}
            try:
                first = locate_column(self, row['block'], row['id'], overlap_start)
                last = locate_column(self, row['block'], row['id'], overlap_end - 1)
                entry['columns'] = [min(first, last), max(first, last) + 1]
            except ValueError:
                # The interval falls in a part of the row with no aligned bases.
                # The block still overlaps, so it is reported without columns
                # rather than dropped.
                pass
            found.append(entry)
        return found

    def outside_neighbours(self, ids, lo, hi):
        """Nearest block holding each sequence outside the block range [lo, hi].

        A string is only drawn between blocks the view has loaded, so a sequence
        continuing beyond the loaded window looks like it simply stops. The whole
        membership of a sequence is unbounded, but what the view needs is not:
        just the closest occurrence off each end. Two indexed lookups answer that
        whatever the dataset's size.

        Empty MAF components are excluded: an 'e' record states the sequence is
        absent there, so it cannot be the next place the path continues.
        """
        if not ids: return {'before': {}, 'after': {}}
        marks = ','.join('?' * len(ids))
        with self.connect() as db:
            before = db.execute(
                f'SELECT id, max(block) AS block FROM rows WHERE id IN ({marks}) AND block<? AND empty_status IS NULL GROUP BY id',
                (*ids, lo)).fetchall()
            after = db.execute(
                f'SELECT id, min(block) AS block FROM rows WHERE id IN ({marks}) AND block>? AND empty_status IS NULL GROUP BY id',
                (*ids, hi)).fetchall()
        return {'before': {r['id']: r['block'] for r in before},
                'after': {r['id']: r['block'] for r in after}}

    def layout_region(self, start, end, limit=256, merge=0, detail=0):
        """Descriptors for the blocks across a display interval.

        `merge` is a column budget: blocks are bucketed onto a fixed grid of that
        width and each bucket returned as one merged descriptor. Bucketing by
        width rather than by block count matters because block lengths span three
        orders of magnitude, so equal-count groups come out wildly uneven and the
        overview reads as a jumble. A fixed grid also keeps a merged block's
        identity and position stable while panning, instead of regrouping around
        whichever block happens to be leftmost.

        merge=0 asks for individual blocks; `limit` still caps the response, and a
        range holding more than that falls back to a grid coarse enough to fit.
        `detail` keeps individual blocks whenever the range holds no more than
        that many, whatever merge was asked for.
        """
        self.ensure_layout()
        with self.connect() as db:
            first=db.execute('SELECT block FROM source_layout WHERE x<=? ORDER BY x DESC LIMIT 1',(start,)).fetchone()
            last=db.execute('SELECT block FROM source_layout WHERE x<? ORDER BY x DESC LIMIT 1',(end,)).fetchone()
            if not last: return {'blocks':[],**self.layout_info()}
            lo=first['block'] if first else 1
            hi=last['block']
            merge=max(0,int(merge))
            # Merging only pays once blocks are too many and too thin to read.
            # Below that a merge holds one or two blocks, which says less than the
            # blocks themselves and costs their headers, rulers and connections.
            if detail and hi-lo+1<=detail: merge=0
            if not merge and hi-lo+1>limit:
                # More blocks than the response may carry: coarsen rather than truncate,
                # so every block stays represented by something.
                merge=max(1,(end-start)//max(1,limit))
            result=[]
            if merge:
                for row in db.execute('SELECT min(block) AS block,max(block) AS last_block,min(x) AS x,max(end_x) AS end_x,max(row_count) AS row_count,count(*) AS count FROM source_layout WHERE block BETWEEN ? AND ? GROUP BY (x/?) ORDER BY block',(lo,hi,merge)):
                    result.append({**dict(row),'aggregate':True,'row_ids':[]})
                presence={}
                for row in db.execute('SELECT (l.x/?) AS bucket,r.id,count(*) AS n FROM rows r JOIN source_layout l ON l.block=r.block WHERE r.block BETWEEN ? AND ? AND r.empty_status IS NULL GROUP BY bucket,r.id',(merge,lo,hi)):
                    presence.setdefault(row['bucket'],{})[row['id']]=row['n']
                # Individual block edges inside a merged descriptor, so the view can
                # point at the block under the cursor. Omitted when a merge holds too
                # many to be worth sending or pointing at.
                edges={}
                for item in result:
                    if item['count']<=EDGES_PER_MERGE:
                        edges[item['x']//merge]=[dict(r) for r in db.execute(
                            'SELECT block,x,end_x FROM source_layout WHERE block BETWEEN ? AND ? ORDER BY block',
                            (item['block'],item['last_block']))]
                for item in result:
                    bucket=item['x']//merge
                    item['presence']=presence.get(bucket,{})
                    item['row_ids']=list(item['presence'])
                    item['edges']=edges.get(bucket,[])
            else:
                records=db.execute('SELECT * FROM source_layout WHERE block BETWEEN ? AND ? ORDER BY block',(lo,hi)).fetchall()
                memberships={r['block']:[] for r in records}
                available={r['block']:[] for r in records}
                for row in db.execute('SELECT r.block,r.id,r.empty_status FROM rows r JOIN sequences s ON s.id=r.id WHERE r.block BETWEEN ? AND ? ORDER BY r.block,s.rowid',(lo,hi)):
                    memberships[row['block']].append(row['id'])
                    if not row['empty_status']:available[row['block']].append(row['id'])
                result=[{**dict(r),'row_ids':memberships[r['block']],'available_row_ids':available[r['block']]} for r in records]
        return {'blocks':result,**self.layout_info()}

    def individual_layout_region(self, start, end, limit=256, after=0):
        """A bounded page of individual blocks. Panel zoom never changes meaning
        to grouped presence merely because more than 256 blocks are visible."""
        self.ensure_layout()
        with self.connect() as db:
            first = db.execute('SELECT block FROM source_layout WHERE x<=? ORDER BY x DESC LIMIT 1', (start,)).fetchone()
            lo = max(first['block'] if first else 1, after + 1)
            records = [dict(r) for r in db.execute('SELECT * FROM source_layout WHERE block>=? AND x<? ORDER BY block LIMIT ?', (lo, end, limit + 1))]
            following = records[limit] if len(records) > limit else None
            records = records[:limit]
            if records:
                by_block = {r['block']: r for r in records}
                for item in records: item.update(row_ids=[], available_row_ids=[])
                for row in db.execute('SELECT r.block,r.id,r.empty_status FROM rows r JOIN sequences s ON s.id=r.id WHERE r.block BETWEEN ? AND ? ORDER BY r.block,s.rowid', (records[0]['block'], records[-1]['block'])):
                    by_block[row['block']]['row_ids'].append(row['id'])
                    if not row['empty_status']: by_block[row['block']]['available_row_ids'].append(row['id'])
        return {'blocks': records, 'next': records[-1]['block'] if following else None,
                'cover_start': records[0]['x'] if after and records else start,
                'cover_end': following['x'] if following else end}

    def region(self, block, start=0, end=None, ids=None, max_cells=2_000_000, bins=256, focus_id=None, cancelled=lambda: False):
        with self.connect() as db, SummaryCache(self, cancelled) as summary_cache:
            b = db.execute('SELECT * FROM blocks WHERE id=?', (block,)).fetchone()
            if b is None: raise ValueError('Alignment block not found')
            start, end = max(0, int(start)), min(b['length'], int(end if end is not None else b['length']))
            if end <= start: raise ValueError('Empty alignment interval')
            sql, args = 'SELECT r.*, s.source,s.label,s.metadata FROM rows r JOIN sequences s ON s.id=r.id WHERE block=?', [block]
            if ids is not None:
                if not ids: return {'block': block, 'start': start, 'end': end, 'length': b['length'], 'rows': [], 'detail': True}
                sql += ' AND r.id IN (' + ','.join('?' for _ in ids) + ')'; args.extend(ids)
            rows = [dict(r) for r in db.execute(sql + ' ORDER BY s.rowid', args)]
            detail = (end - start) * max(1, len(rows)) <= max_cells
            step = max(1, (end - start + bins - 1) // bins)
            for row in rows:
                if cancelled(): raise InterruptedError('Navigation changed')
                row['metadata'] = json.loads(row['metadata'])
                if not detail:
                    summarize(self, db, block, b['length'], row, start, end, step, focus_id, summary_cache)
                    continue
                chunks = db.execute('SELECT * FROM chunks WHERE block=? AND id=? AND offset>=? AND offset<? ORDER BY offset', (block, row['id'], (start // CHUNK) * CHUNK, end))
                sequence, before = [], 0
                for chunk in chunks:
                    a, z = max(start, chunk['offset']), min(end, chunk['offset'] + len(chunk['bases']))
                    if a == start: before = chunk['ungapped_before'] + len(chunk['bases'][:a - chunk['offset']].replace('-', ''))
                    text = chunk['bases'][a - chunk['offset']:z - chunk['offset']]
                    sequence.append(text)
                row['divergence_bins'] = []
                row['offset_bases'] = before
                row['missing'] = not sequence
                row['sequence'] = ''.join(sequence) if detail and not row['missing'] else None
                row['bins'] = None
            return {'block': block, 'start': start, 'end': end, 'length': b['length'], 'rows': rows, 'detail': detail, 'bin_size': step, 'metadata': json.loads(b['metadata']), 'focus':focus_id}

    def conservation(self, block, start=0, end=None, ids=(), bins=256, cancelled=lambda: False):
        """Column identity among a cohort of sequences, binned.

        Observed agreement between the sequences asked for. It is not an
        evolutionary constraint score, and the block's own membership never
        becomes the denominator: that is the whole point of asking.
        """
        with self.connect() as db, SummaryCache(self, cancelled) as summary_cache:
            b = db.execute('SELECT * FROM blocks WHERE id=?', (block,)).fetchone()
            if b is None: raise ValueError('Alignment block not found')
            start, end = max(0, int(start)), min(b['length'], int(end if end is not None else b['length']))
            if end <= start: raise ValueError('Empty alignment interval')
            cohort = sorted(set(ids))
            step = max(1, (end - start + bins - 1) // bins)
            counts = cohort_summarize(db, block, cohort, start, end, step, summary_cache)
            return {'block': block, 'start': start, 'end': end, 'length': b['length'],
                    'bin_size': step, 'cohort': len(cohort), 'bins': counts}

    def gap_columns(self, block, start=0, end=None, ids=(), min_run=1, percent=100, max_runs=4000, cancelled=lambda: False):
        """Column runs at least `percent` of the cohort is a gap in.

        The cohort is whatever the reader is looking at, so the answer is
        computed per call rather than stored: hiding a sequence can empty a
        column and showing it again can fill it, and a cached answer would
        outlive the view that made it true.

        Rows the block does not hold are skipped rather than counted as gap,
        and they are out of the denominator too - `rows_needed` says why.

        At 100% the answer is the intersection of the rows' gap runs, folded a
        row at a time: each row can only ever narrow what is left, so a cohort
        whose first row is dense finishes almost immediately and a sheet with
        nothing closable in it costs one or two rows rather than all of them.
        Below 100% there is no such early answer - a column can still cross the
        threshold after any number of rows that have a base there - so every row
        is read and counted into a tally four bytes a column wide. That is the
        price of the question, and it is why the fold is kept for the case that
        can avoid it.

        `min_run` is applied last, to the surviving runs. Filtering each row's
        runs first would be a different and wrong question: three rows whose
        long gaps overlap in a short stretch share that stretch and nothing
        else, and a per-row filter would keep it while dropping the long runs
        that produced it.
        """
        with self.connect() as db:
            b = db.execute('SELECT * FROM blocks WHERE id=?', (block,)).fetchone()
            if b is None: raise ValueError('Alignment block not found')
            start = max(0, int(start))
            end = min(b['length'], int(end if end is not None else b['length']))
            if end <= start: raise ValueError('Empty alignment interval')
            cohort = sorted(set(ids))
            percent = min(100, max(1, int(percent)))
            if not cohort: return {'block': block, 'start': start, 'end': end, 'runs': [], 'cohort': 0,
                                   'present': 0, 'percent': percent, 'needed': 0, 'truncated': False}
            whole = percent >= 100
            found = None
            tally = None if whole else gap_tally(end - start)
            present = 0
            settled = False
            for row_id in cohort:
                if cancelled(): raise InterruptedError('Navigation changed')
                if settled:
                    # The answer is already known - the intersection emptied -
                    # but how many rows the block holds is part of what is
                    # reported, and stopping the loop outright reported one. An
                    # index probe that never touches the bases is what the rest
                    # of this row costs now, rather than reading and scanning it.
                    if db.execute('SELECT 1 FROM chunks WHERE block=? AND id=? AND offset<? AND offset+length(bases)>? LIMIT 1',
                                  (block, row_id, end, start)).fetchone(): present += 1
                    continue
                chunks = db.execute(
                    'SELECT offset,bases FROM chunks WHERE block=? AND id=? AND offset<? AND offset+length(bases)>? ORDER BY offset',
                    (block, row_id, end, start)).fetchall()
                if not chunks: continue
                present += 1
                gaps = []
                covered = 0
                for chunk in chunks:
                    if cancelled(): raise InterruptedError('Navigation changed')
                    a = max(start, chunk['offset'])
                    z = min(end, chunk['offset'] + len(chunk['bases']))
                    if z <= a: continue
                    covered += z - a
                    gaps.extend(runs_of_gap(chunk['bases'][a - chunk['offset']:z - chunk['offset']], a))
                # Columns this row does not reach are columns it has no base in.
                # A row ending early leaves the tail empty exactly as a run of
                # '-' would, and reading it any other way would keep a tail no
                # sequence in the cohort occupies.
                gaps = fill_uncovered(gaps, [(c['offset'], c['offset'] + len(c['bases'])) for c in chunks], start, end)
                if whole:
                    found = gaps if found is None else intersect(found, gaps)
                    # Nothing shared so far is nothing shared at the end: the
                    # intersection only ever shrinks, so the rows not yet read
                    # cannot put anything back.
                    if not found: settled = True
                else:
                    tally_gaps(tally, gaps, start)
            needed = rows_needed(present, percent)
            if not whole:
                found = runs_at_least(tally, needed, start)
            elif found is None:
                found = []
            if not found:
                return {'block': block, 'start': start, 'end': end, 'runs': [], 'cohort': len(cohort),
                        'present': present, 'percent': percent, 'needed': needed, 'truncated': False}
            runs = [[a, z] for a, z in found if z - a >= max(1, int(min_run))]
            truncated = len(runs) > max_runs
            if truncated:
                # Keep the widest runs: they are what a collapse is for, and a
                # bounded answer that keeps the small ones would collapse almost
                # nothing while still costing the reader their coordinates.
                runs = sorted(sorted(runs, key=lambda r: r[1] - r[0], reverse=True)[:max_runs])
            return {'block': block, 'start': start, 'end': end, 'runs': runs, 'cohort': len(cohort),
                    'present': present, 'percent': percent, 'needed': needed, 'truncated': truncated}

    def update_metadata(self, entries):
        entries = normalize_metadata_entries(entries)
        report = {'requested': len(entries), 'updated': 0, 'sequence_ids': [], 'unresolved': [], 'warnings': []}
        with self.connect() as db:
            for entry in entries:
                if entry.get('id'):
                    matches = db.execute('SELECT * FROM sequences WHERE id=?', (entry['id'],)).fetchall()
                else: matches = db.execute('SELECT * FROM sequences WHERE source=?', (entry.get('source', ''),)).fetchall()
                if not matches:
                    report['unresolved'].append(str(entry.get('source') or entry.get('id') or ''))
                    continue
                for row in matches:
                    data = json.loads(row['metadata'])
                    linked_coordinates=bool(data.get('link_coordinates'))
                    data.update({k: v for k, v in entry.items() if k not in ('id', 'source', 'declared_region')})
                    # A sequence-only alignment has no intrinsic placement. A bare
                    # region means the supplied sequence starts at base 1; a ranged
                    # region supplies its 1-based start. In either case the observed
                    # ungapped sequence length determines the effective end. That
                    # lets a slightly stale/rounded declared range remain useful
                    # without claiming bases that the alignment does not contain.
                    occurrences=db.execute('SELECT r.*,b.length FROM rows r JOIN blocks b ON b.id=r.block WHERE r.id=?',(row['id'],)).fetchall()
                    unplaced=[r for r in occurrences if linked_coordinates or not r['coordinates']]
                    if len(occurrences)!=1 and unplaced:
                        raise ValueError('Genome-link coordinates are ambiguous for a sequence repeated across multiple blocks')
                    if not unplaced:
                        # MAF/XMFA placement lives on each block occurrence and
                        # wins over sequence-level link hints, including strand.
                        for key in ('genomic_start','genomic_end','declared_genomic_end','coordinate_adjusted','strand','link_coordinates'):
                            data.pop(key, None)
                    for occurrence in unplaced:
                        start=int(entry.get('genomic_start') or 1)-1
                        size=sequence_prefix(db,occurrence['block'],row['id'],occurrence['length'])
                        if size is None: continue
                        end=start+size
                        declared_end=entry.get('genomic_end')
                        if declared_end is not None and int(declared_end) != end:
                            data['declared_genomic_end']=int(declared_end)
                            data['coordinate_adjusted']=True
                            report['warnings'].append({
                                'id': row['id'], 'source': row['source'],
                                'message': f"Declared end {int(declared_end):,} was adjusted to {end:,} from the ungapped sequence length.",
                            })
                        else:
                            data.pop('declared_genomic_end', None)
                            data.pop('coordinate_adjusted', None)
                        data['genomic_start']=start+1
                        data['genomic_end']=end
                        data['link_coordinates']=True
                        db.execute('UPDATE rows SET start=?,end=?,strand=?,coordinates=1 WHERE block=? AND id=?',(start,end,entry.get('strand','+'),occurrence['block'],row['id']))
                    db.execute('UPDATE sequences SET metadata=?,label=? WHERE id=?', (json.dumps(data), entry.get('label') or row['label'], row['id']))
                    report['updated'] += 1
                    report['sequence_ids'].append(row['id'])
        return report

    def genomic_loci(self, block, ranges):
        """Project selected alignment columns into at most one locus per assembly."""
        projected=[];warnings=[]
        ids=list(dict.fromkeys(item['id'] for item in ranges))
        with self.connect() as db:
            metadata={row['id']:(row['source'],json.loads(row['metadata'] or '{}')) for row in db.execute(
                'SELECT id,source,metadata FROM sequences WHERE id IN (%s)' % ','.join('?'*len(ids)),ids)} if ids else {}
        for item in ranges:
            source,meta=metadata.get(item['id'],(item['id'],{}))
            assembly,region=meta.get('assembly'),meta.get('region')
            if not assembly or not region:
                warnings.append({'id':item['id'],'message':'The selected sequence has no genome link.'});continue
            span=source_span(self,block,item['id'],item['start'],item['end'])
            if not span or not span.get('coordinates') or not span.get('bases'):
                warnings.append({'id':item['id'],'message':'The selected columns contain no placed genomic bases.'});continue
            projected.append({'assembly':assembly,'region':region,'start':span['start']+1,'end':span['end'],
                              'strand':span['strand'],'bases':span['bases'],'source':source})
        groups={}
        for locus in projected:
            key=(str(locus['assembly']).upper(),locus['region'])
            if key not in groups: groups[key]={**locus}
            else:
                groups[key]['start']=min(groups[key]['start'],locus['start'])
                groups[key]['end']=max(groups[key]['end'],locus['end'])
                groups[key]['bases']+=locus['bases']
        by_assembly={}
        for locus in groups.values():
            key=str(locus['assembly']).upper()
            current=by_assembly.get(key)
            if current is None or locus['bases']>current['bases']: by_assembly[key]=locus
        for assembly in {str(item['assembly']).upper() for item in groups.values()}:
            regions={item['region'] for item in groups.values() if str(item['assembly']).upper()==assembly}
            if len(regions)>1:
                kept=by_assembly[assembly]['region']
                warnings.append({'assembly':by_assembly[assembly]['assembly'],'message':f'Multiple regions were selected; opened {kept}, which contains the most selected bases.'})
        return {'loci':list(by_assembly.values()),'warnings':warnings}

    EXPORT_FORMATS = {'fasta': 'Aligned FASTA', 'clustal': 'Clustal', 'phylip-relaxed': 'PHYLIP (relaxed names)', 'maf': 'MAF'}

    def export(self, block, start, end, ids, fmt):
        if fmt not in self.EXPORT_FORMATS: raise ValueError('Unknown export format: ' + str(fmt))
        data = self.region(block, start, end, ids, max_cells=20_000_000)
        if not data['detail']: raise ValueError('Export at most 20 million alignment cells per region')
        rows = [row for row in data['rows'] if row['sequence'] is not None]
        if not rows: raise ValueError('No aligned sequence in this region to export')
        if fmt == 'maf':
            output = ['##maf version=1\n\na\n']
            for row in rows:
                seq = row['sequence']
                if not row['coordinates'] or row['source_length'] is None: raise ValueError('MAF export needs known source coordinates and lengths for every selected row')
                size = len(seq.replace('-', ''))
                maf_start = row['start'] + row['offset_bases'] if row['strand'] == '+' else row['source_length'] - row['end'] + row['offset_bases']
                output.append(f"s {row['source']} {maf_start} {size} {row['strand']} {row['source_length']} {seq}\n")
            return ''.join(output)
        # Names are what another tool reads the file by, so each row is written
        # under its own source name, not the internal row identifier. Copies of
        # one source within a block are suffixed to keep names unique, which
        # Clustal and PHYLIP both require.
        names, seen = [], Counter()
        for row in rows:
            name = row['source']
            if seen[name]: name = f"{name}/copy{seen[name] + 1}"
            seen[row['source']] += 1
            names.append(name)
        if fmt == 'fasta':
            output = []
            for name, row in zip(names, rows):
                seq = row['sequence']
                output.append(f">{name} block={block} columns={start + 1}-{end}\n")
                output.extend(seq[i:i + 80] + '\n' for i in range(0, len(seq), 80))
            return ''.join(output)
        width = end - start
        if fmt == 'phylip-relaxed':
            pad = max(len(n) for n in names) + 2
            return f' {len(rows)} {width}\n' + ''.join(f'{n.ljust(pad)}{row["sequence"]}\n' for n, row in zip(names, rows))
        pad = max(max(len(n) for n in names) + 6, 16)
        output = ['CLUSTAL W (1.81) multiple sequence alignment\n\n\n']
        for offset in range(0, width, 60):
            for name, row in zip(names, rows):
                output.append(f'{name.ljust(pad)}{row["sequence"][offset:offset + 60]}\n')
            column = [''.join(row['sequence'][offset + i] for row in rows) for i in range(min(60, width - offset))]
            output.append(''.ljust(pad) + ''.join('*' if len(set(c)) == 1 and c[0] != '-' else ' ' for c in column) + '\n\n')
        return ''.join(output)


GENOME_LINK_FIELDS = {'source', 'id', 'assembly', 'assembly_name', 'region', 'label', 'strand'}
_CANONICAL_LINK_FIELDS = GENOME_LINK_FIELDS | {'genomic_start', 'genomic_end', 'declared_region'}
_REGION_RANGE = re.compile(r'^(.+?):\s*([0-9][0-9,]*)\s*[-–]\s*([0-9][0-9,]*)$')


def normalize_metadata_entries(entries, public=False):
    """Validate and canonicalise genome links.

    The public file format deliberately has one genome identity (`assembly`) and
    one location (`region`). Coordinates are encoded in the region as
    ``name:start-end``. Internal start/end fields exist only after parsing so the
    store can place sequence-only alignments without perpetuating another file
    schema.
    """
    if not isinstance(entries, list):
        raise ValueError('Genome links must be a list of rows')
    output=[]
    allowed=GENOME_LINK_FIELDS if public else _CANONICAL_LINK_FIELDS
    for index, raw in enumerate(entries, 1):
        if not isinstance(raw, dict): raise ValueError(f'Genome-link row {index} is not an object')
        entry={str(k).strip(): (v.strip() if isinstance(v,str) else v) for k,v in raw.items() if v is not None and (not isinstance(v,str) or v.strip())}
        unknown=sorted(set(entry)-allowed)
        if unknown: raise ValueError('Unknown genome-link field' + ('s' if len(unknown)>1 else '') + ': ' + ', '.join(unknown))
        locator=entry.get('source') or entry.get('id')
        if not locator: raise ValueError(f'Genome-link row {index} needs source')
        if not entry.get('assembly'): raise ValueError(f'Genome-link row {index} needs assembly')
        region=str(entry.get('region') or '').strip()
        if not region: raise ValueError(f'Genome-link row {index} needs region')
        strand=str(entry.get('strand') or '+').strip()
        strand={'+1':'+','1':'+','-1':'-'}.get(strand,strand)
        if strand not in ('+','-'): raise ValueError(f'Genome-link row {index} strand must be + or -')
        normalized={k:v for k,v in entry.items() if k in allowed}
        normalized['strand']=strand
        match=_REGION_RANGE.match(region)
        if match:
            name=match.group(1).strip();start=int(match.group(2).replace(',',''));end=int(match.group(3).replace(',',''))
            if not name or start < 1 or end < start: raise ValueError(f'Genome-link row {index} has an invalid region range')
            normalized.update({'region':name,'genomic_start':start,'genomic_end':end,'declared_region':region})
        else:
            normalized['region']=region
        output.append(normalized)
    return output


def parse_metadata(text, suffix):
    if suffix.lower() == '.tsv':
        reader=csv.DictReader(io.StringIO(text), delimiter='\t')
        if not reader.fieldnames: raise ValueError('Genome-link TSV needs a header row')
        if 'source' not in reader.fieldnames: raise ValueError('Genome-link TSV needs a source column')
        unknown=sorted(set(reader.fieldnames)-GENOME_LINK_FIELDS)
        if unknown: raise ValueError('Unknown genome-link field' + ('s' if len(unknown)>1 else '') + ': ' + ', '.join(unknown))
        return normalize_metadata_entries(list(reader), public=True)
    value=json.loads(text)
    if isinstance(value,dict): value=value.get('sequences')
    if value is None: raise ValueError('Genome-link JSON must be a list or contain a sequences list')
    return normalize_metadata_entries(value, public=True)


def locate_column(store, block, row_id, coordinate):
    with store.connect() as db:
        row = db.execute('SELECT * FROM rows WHERE block=? AND id=?', (block, row_id)).fetchone()
        if row is None or not row['coordinates'] or not row['start'] <= coordinate < row['end']:
            raise ValueError('Coordinate is not mapped in this block')
        target = coordinate - row['start'] if row['strand'] == '+' else row['end'] - coordinate - 1
        chunk = db.execute('SELECT * FROM chunks WHERE block=? AND id=? AND ungapped_before<=? ORDER BY offset DESC LIMIT 1', (block, row_id, target)).fetchone()
        if not chunk: raise ValueError('No aligned bases cover this source coordinate')
        count = chunk['ungapped_before']
        for i,c in enumerate(chunk['bases']):
            if c != '-':
                if count == target: return chunk['offset']+i
                count += 1
    raise ValueError('Source coordinate is not present in the alignment')


def sequence_prefix(db, block, row_id, column):
    """Count non-gap sequence characters strictly before an alignment column."""
    if column <= 0: return 0
    chunk = db.execute('SELECT offset,bases,ungapped_before FROM chunks WHERE block=? AND id=? AND offset<? ORDER BY offset DESC LIMIT 1', (block,row_id,column)).fetchone()
    if chunk is None: return None
    return chunk['ungapped_before'] + len(chunk['bases'][:column-chunk['offset']].replace('-', ''))


def source_span(store, block, row_id, start, end):
    with store.connect() as db:
        row = db.execute('SELECT * FROM rows WHERE block=? AND id=?', (block,row_id)).fetchone()
        if row is None: return None
        before, after = sequence_prefix(db,block,row_id,start),sequence_prefix(db,block,row_id,end)
        if before is None or after is None or row['empty_status']: return None
        span = {'bases': after-before, 'offset_start':before,'offset_end':after,'coordinates':bool(row['coordinates']),'strand':row['strand']}
        if row['coordinates']:
            span['start'] = row['start']+before if row['strand']=='+' else row['end']-after
            span['end'] = row['start']+after if row['strand']=='+' else row['end']-before
        return span
