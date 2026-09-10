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
from pathlib import Path
from collections import Counter
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


def detect_format(path, requested='auto'):
    aliases = {'fa': 'fasta', 'fas': 'fasta', 'aln': 'clustal', 'phy': 'phylip', 'sto': 'stockholm', 'bigmaf': 'bigmaf', 'taf': 'taf', 'hal': 'hal'}
    if requested != 'auto':
        return aliases.get(requested.lower(), requested.lower())
    name = str(path).lower().removesuffix('.gz').removesuffix('.bgz')
    suffix = name.rsplit('.', 1)[-1]
    if suffix in ('hal', 'taf', 'bigmaf', 'bb', 'gfa'):
        return 'bigmaf' if suffix == 'bb' else suffix
    with open_text(path) as handle:
        head = handle.read(8192).lstrip()
    if head.startswith('##maf') or re.search(r'^a(?:\s|$)', head, re.M): return 'maf'
    if head.startswith('# STOCKHOLM'): return 'stockholm'
    if head.upper().startswith(('CLUSTAL', 'MUSCLE')): return 'clustal'
    if head.startswith('#FormatVersion Mauve') or re.search(r'^>\s*\d+:\d+-\d+\s+[+-]', head, re.M): return 'xmfa'
    if head.startswith('>'): return 'fasta'
    if re.match(r'\d+\s+\d+', head): return 'phylip-relaxed'
    if suffix in aliases: return aliases[suffix]
    raise ValueError('Unrecognised alignment format. Choose its format explicitly.')


def open_text(path):
    with open(path, 'rb') as handle:
        gz = handle.read(2) == b'\x1f\x8b'
    return gzip.open(path, 'rt', encoding='utf-8-sig') if gz else open(path, encoding='utf-8-sig')


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
                    source = line[1:].strip()
                    if not source: raise ValueError('Empty FASTA identifier')
                    row_id = self._add_row(db, 1, {'source': source, 'sequence': None}, seen[source]); seen[source] += 1
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
        with open_text(path) as handle:
            if fmt == 'fasta': self.import_fasta(handle, cancelled, progress)
            else:
                if fmt == 'maf': blocks = maf_blocks(handle)
                elif fmt == 'xmfa': blocks = xmfa_blocks(handle)
                else:
                    from Bio import AlignIO
                    def text_blocks():
                        for alignment in AlignIO.parse(handle, fmt):
                            yield [{'source': record.id, 'label': record.description, 'sequence': clean_sequence(str(record.seq))} for record in alignment], {}
                    blocks = text_blocks()
                count = 0
                for rows, metadata in blocks:
                    if cancelled(): raise InterruptedError('Import cancelled')
                    self.add_block(rows, metadata); count += 1; progress(blocks=count)
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
                row['genome_key'] = metadata.get('genome_key')
                row['chrom'] = metadata.get('chrom')
                row['assembly'] = metadata.get('assembly')
            blocks = [dict(r) for r in db.execute(
                '''SELECT b.id, b.length,
                          count(r.id) AS rows,
                          coalesce(sum(r.empty_status IS NULL), 0) AS available
                   FROM blocks b LEFT JOIN rows r ON r.block = b.id
                   GROUP BY b.id ORDER BY b.id LIMIT ?''', (limit,))]
        return {'sequences': sequences, 'blocks': blocks,
                'truncated': {'sequences': total_sequences > len(sequences), 'blocks': total_blocks > len(blocks)},
                'total': {'sequences': total_sequences, 'blocks': total_blocks}}

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

    def region(self, block, start=0, end=None, ids=None, max_cells=2_000_000, bins=256, focus_id=None):
        with self.connect() as db:
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
            reference_cache={}
            for row in rows:
                row['metadata'] = json.loads(row['metadata'])
                chunks = db.execute('SELECT * FROM chunks WHERE block=? AND id=? AND offset>=? AND offset<? ORDER BY offset', (block, row['id'], (start // CHUNK) * CHUNK, end))
                counts, sequence, before, divergence = [], [], 0, []
                for chunk in chunks:
                    a, z = max(start, chunk['offset']), min(end, chunk['offset'] + len(chunk['bases']))
                    if a == start: before = chunk['ungapped_before'] + len(chunk['bases'][:a - chunk['offset']].replace('-', ''))
                    text = chunk['bases'][a - chunk['offset']:z - chunk['offset']]
                    if detail: sequence.append(text)
                    else:
                        offset=chunk['offset']
                        if focus_id and offset not in reference_cache:
                            ref=db.execute('SELECT bases FROM chunks WHERE block=? AND id=? AND offset=?',(block,focus_id,offset)).fetchone()
                            reference_cache[offset]=ref['bases'] if ref else ''
                            if len(reference_cache)>16: reference_cache.pop(next(iter(reference_cache)))
                        reference=reference_cache.get(offset,'')
                        # Counter's C loop processes slices rather than updating
                        # Python dictionaries once per base. Reference chunks are
                        # reused across rows instead of queried for every bin.
                        pos=a
                        while pos<z:
                            index=(pos-start)//step
                            stop=min(z,start+(index+1)*step)
                            while len(counts)<=index: counts.append(Counter())
                            counts[index].update(chunk['bases'][pos-offset:stop-offset])
                            while len(divergence)<=index: divergence.append({'different':0,'comparable':0})
                            d=divergence[index]
                            text_slice=chunk['bases'][pos-offset:stop-offset]
                            ref_slice=reference[pos-offset:stop-offset]
                            if row['id']==focus_id:
                                d['comparable']+=sum(text_slice.count(c) for c in 'ACGT')
                            elif ref_slice:
                                for base,ref in zip(text_slice,ref_slice):
                                    if base in CANONICAL and ref in CANONICAL:
                                        d['comparable']+=1;d['different']+=base!=ref
                            pos=stop
                row['divergence_bins'] = [{**d, 'fraction': d['different']/d['comparable'] if d['comparable'] else None} for d in divergence]
                row['offset_bases'] = before
                row['missing'] = not sequence and not counts
                row['sequence'] = ''.join(sequence) if detail and not row['missing'] else None
                row['bins'] = [dict(c) for c in counts] if not detail else None
            return {'block': block, 'start': start, 'end': end, 'length': b['length'], 'rows': rows, 'detail': detail, 'bin_size': step, 'metadata': json.loads(b['metadata']), 'focus':focus_id}

    def update_metadata(self, entries):
        with self.connect() as db:
            for entry in entries:
                if entry.get('id'):
                    matches = db.execute('SELECT * FROM sequences WHERE id=?', (entry['id'],)).fetchall()
                else: matches = db.execute('SELECT * FROM sequences WHERE source=?', (entry.get('source', ''),)).fetchall()
                if not matches: raise ValueError('Metadata source not found: ' + str(entry.get('source', entry.get('id'))))
                for row in matches:
                    data = json.loads(row['metadata']); data.update({k: v for k, v in entry.items() if k not in ('id', 'source')})
                    db.execute('UPDATE sequences SET metadata=?,label=? WHERE id=?', (json.dumps(data), entry.get('label') or row['label'], row['id']))
                    # FASTA coordinates are opt-in and must account for every ungapped
                    # base. Never replace the coordinates carried by a MAF block.
                    if entry.get('genomic_start'):
                        occurrences=db.execute('SELECT r.*,b.length FROM rows r JOIN blocks b ON b.id=r.block WHERE r.id=?',(row['id'],)).fetchall()
                        unplaced=[r for r in occurrences if not r['coordinates']]
                        if len(occurrences)!=1 and unplaced:
                            raise ValueError('Source-coordinate metadata is ambiguous across multiple blocks')
                        for occurrence in unplaced:
                            start=int(entry['genomic_start'])-1
                            size=sequence_prefix(db,occurrence['block'],row['id'],occurrence['length'])
                            if size is None: continue
                            end=int(entry.get('genomic_end') or start+size)
                            strand=entry.get('strand','+')
                            if start<0 or end-start!=size or strand not in ('+','-'):
                                raise ValueError('FASTA genomic coordinates must match the ungapped sequence length and use + or - strand')
                            db.execute('UPDATE rows SET start=?,end=?,strand=?,coordinates=1 WHERE block=? AND id=?',(start,end,strand,occurrence['block'],row['id']))

    def export(self, block, start, end, ids, fmt):
        data = self.region(block, start, end, ids, max_cells=20_000_000)
        if not data['detail']: raise ValueError('Export at most 20 million alignment cells per region')
        output = ['##maf version=1\n\na\n'] if fmt == 'maf' else []
        for row in data['rows']:
            seq = row['sequence']
            if seq is None: continue
            if fmt == 'maf':
                if not row['coordinates'] or row['source_length'] is None: raise ValueError('MAF export needs known source coordinates and lengths for every selected row')
                size = len(seq.replace('-', ''))
                maf_start = row['start'] + row['offset_bases'] if row['strand'] == '+' else row['source_length'] - row['end'] + row['offset_bases']
                output.append(f"s {row['source']} {maf_start} {size} {row['strand']} {row['source_length']} {seq}\n")
            else:
                output.append(f">{row['id']} source={row['source']} block={block} columns={start+1}-{end}\n")
                output.extend(seq[i:i+80] + '\n' for i in range(0, len(seq), 80))
        return ''.join(output)


def parse_metadata(text, suffix):
    if suffix.lower() == '.tsv': return list(csv.DictReader(io.StringIO(text), delimiter='\t'))
    value = json.loads(text)
    if isinstance(value, list): return value
    if 'genomes' in value:  # Existing Ensembl Go FASTA/JSON pair.
        return [{'source': g['genome_key'], 'genome_key': g['genome_key'], 'label': g.get('gene_symbol') or g['genome_key'], 'chrom': g.get('chrom'), 'assembly': g.get('assembly'), 'genomic_start': g.get('genomic_start'), 'genomic_end': g.get('genomic_end'), 'strand': g.get('strand','+'), 'transcript_id': g.get('transcript_id'), 'features': g.get('features', [])} for g in value['genomes']]
    return value.get('sequences', [])


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
