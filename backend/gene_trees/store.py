"""The gene-tree library: an index over imported tree collections, in one SQLite file.

One file, not a folder: ``local_data/`` is scanned for species directories, and a
``gene_trees/`` folder there would be read as a species.

A collection is whatever one import produced — a single tree, a multi-tree Newick
file, a whole Compara EMF release or an OrthoFinder ``Gene_Trees/`` folder. It is
*indexed*, not loaded: each tree is kept as its original text, compressed, and
turned into nodes only when it is opened; what is searchable up front is every
leaf's identifiers (``members``). A Compara release of 54,000 trees and four million
leaves costs about what its .gz does, and finding the trees that hold a gene is an
index lookup rather than a scan.

Rows use integer keys (``cid``, ``tid``, ``sid``) because ``members`` has millions of
them; the public identifiers are the collection's uuid and the tree's ``tree_id``.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
import uuid
import zlib
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from . import model

SCHEMA = '''
CREATE TABLE IF NOT EXISTS collections (
    cid INTEGER PRIMARY KEY, id TEXT UNIQUE, name TEXT, source TEXT, format TEXT, created REAL,
    tree_count INTEGER DEFAULT 0, leaf_count INTEGER DEFAULT 0, status TEXT DEFAULT 'ready',
    label_pattern TEXT, species_map TEXT DEFAULT '{}', links TEXT DEFAULT '{}',
    description TEXT DEFAULT '', method TEXT DEFAULT '', tags TEXT DEFAULT '[]', origin TEXT DEFAULT 'file'
);
CREATE TABLE IF NOT EXISTS trees (
    tid INTEGER PRIMARY KEY, cid INTEGER, tree_id TEXT, position INTEGER, name TEXT, external_id TEXT,
    leaf_count INTEGER, species_count INTEGER, stats TEXT, payload BLOB
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trees_id ON trees (cid, tree_id);
CREATE INDEX IF NOT EXISTS idx_trees_position ON trees (cid, position);
CREATE INDEX IF NOT EXISTS idx_trees_external ON trees (external_id);
CREATE INDEX IF NOT EXISTS idx_trees_name ON trees (name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS species (sid INTEGER PRIMARY KEY, name TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS members (
    tid INTEGER, label TEXT, sid INTEGER, gene_id TEXT, protein_id TEXT, transcript_id TEXT, symbol TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_tid ON members (tid);
CREATE INDEX IF NOT EXISTS idx_members_gene ON members (gene_id);
CREATE INDEX IF NOT EXISTS idx_members_protein ON members (protein_id);
-- Partial: in a Compara dump almost every leaf has no transcript, no separate label
-- and no symbol, and indexing four million NULLs costs 150 MB for nothing.
CREATE INDEX IF NOT EXISTS idx_members_transcript ON members (transcript_id) WHERE transcript_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_members_symbol ON members (symbol COLLATE NOCASE) WHERE symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_members_label ON members (label) WHERE label IS NOT NULL;
-- The subtree-layer workspace: layers can mix trees from any collection, so it belongs
-- to the library rather than to one tree.
CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, json TEXT, updated REAL);
'''

COLLECTION_COLUMNS = ('id', 'name', 'source', 'format', 'created', 'tree_count', 'leaf_count', 'status', 'label_pattern',
                      'species_map', 'links', 'description', 'method', 'tags', 'origin')
JSON_COLUMNS = ('species_map', 'links', 'tags')
_CHUNK = 500


def encode_payload(payload: Dict[str, Any]) -> bytes:
    return zlib.compress(json.dumps(payload, separators=(',', ':')).encode('utf-8'), 6)


def decode_payload(blob: bytes) -> Dict[str, Any]:
    return json.loads(zlib.decompress(blob).decode('utf-8'))


def _chunks(items: List[Any], size: int = _CHUNK) -> Iterable[List[Any]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


class GeneTreeStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._schema_lock = threading.Lock()
        self._ready = False

    def _open(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path), timeout=60)
        conn.row_factory = sqlite3.Row
        if not self._ready:
            with self._schema_lock:
                if not self._ready:
                    # WAL: searches and opening trees carry on while a long import writes.
                    conn.execute('PRAGMA journal_mode=WAL')
                    conn.executescript(SCHEMA)
                    conn.commit()
                    self._ready = True
        conn.execute('PRAGMA synchronous=NORMAL')
        return conn

    @contextmanager
    def connect(self):
        conn = self._open()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    # ── collections ──

    def create_collection(self, name: str, source: Optional[str], fmt: str, description: str = '', method: str = '',
                          tags: Optional[List[str]] = None, origin: str = 'file', status: str = 'indexing') -> str:
        collection_id = uuid.uuid4().hex
        with self.connect() as conn:
            conn.execute('INSERT INTO collections (id, name, source, format, created, description, method, tags, origin, status) '
                         'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                         (collection_id, name, source, fmt, time.time(), description or '', method or '',
                          json.dumps(list(tags or [])), origin, status))
        return collection_id

    @staticmethod
    def _collection_dict(row: sqlite3.Row) -> Dict[str, Any]:
        out = {k: row[k] for k in COLLECTION_COLUMNS}
        for key in JSON_COLUMNS:
            out[key] = json.loads(out.get(key) or ('[]' if key == 'tags' else '{}'))
        return out

    def collections(self) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute('SELECT * FROM collections ORDER BY created DESC').fetchall()
        return [self._collection_dict(r) for r in rows]

    def collection(self, collection_id: str) -> Optional[Dict[str, Any]]:
        with self.connect() as conn:
            row = conn.execute('SELECT * FROM collections WHERE id = ?', (collection_id,)).fetchone()
        return self._collection_dict(row) if row else None

    @staticmethod
    def _cid(conn: sqlite3.Connection, collection_id: str) -> Optional[int]:
        row = conn.execute('SELECT cid FROM collections WHERE id = ?', (collection_id,)).fetchone()
        return row['cid'] if row else None

    def update_collection(self, collection_id: str, **values: Any) -> None:
        values = {k: v for k, v in values.items() if k in COLLECTION_COLUMNS and k != 'id'}
        if not values:
            return
        encoded = {k: (json.dumps(v) if k in JSON_COLUMNS else v) for k, v in values.items()}
        assignments = ', '.join(f'{k} = ?' for k in encoded)
        with self.connect() as conn:
            conn.execute(f'UPDATE collections SET {assignments} WHERE id = ?', (*encoded.values(), collection_id))

    def delete_collection(self, collection_id: str) -> None:
        with self.connect() as conn:
            cid = self._cid(conn, collection_id)
            if cid is None:
                return
            conn.execute('DELETE FROM members WHERE tid IN (SELECT tid FROM trees WHERE cid = ?)', (cid,))
            conn.execute('DELETE FROM trees WHERE cid = ?', (cid,))
            conn.execute('DELETE FROM collections WHERE cid = ?', (cid,))

    # ── writing an index ──

    @contextmanager
    def writer(self, collection_id: str, batch: int = 400):
        """Add trees to a collection, committing every ``batch`` so readers see progress and are not blocked."""
        conn = self._open()
        writer = _Writer(conn, collection_id, batch)
        try:
            yield writer
            writer.flush()
        finally:
            conn.close()

    # ── reading ──

    def list_trees(self, collection_id: str, query: str = '', offset: int = 0, limit: int = 200) -> Dict[str, Any]:
        columns = 'tid, tree_id, name, external_id, leaf_count, species_count, stats, position'
        with self.connect() as conn:
            cid = self._cid(conn, collection_id)
            if cid is None:
                return {'total': 0, 'trees': []}
            if query:
                hits = {r['tid'] for r in self._member_hits(conn, [query, model.strip_version(query)],
                                                            [] if model.classify_identifier(query)[0] else [query])}
                like = f'%{query}%'
                rows = conn.execute(f'SELECT {columns} FROM trees WHERE cid = ? AND (name LIKE ? OR external_id LIKE ? '
                                    f'OR tree_id LIKE ?) LIMIT 5000', (cid, like, like, like)).fetchall()
                for chunk in _chunks(sorted(hits)):
                    marks = ','.join('?' * len(chunk))
                    rows += conn.execute(f'SELECT {columns} FROM trees WHERE cid = ? AND tid IN ({marks})', (cid, *chunk)).fetchall()
                unique = sorted({r['tid']: r for r in rows}.values(), key=lambda r: r['position'])
                total, rows = len(unique), unique[offset:offset + limit]
            else:
                total = conn.execute('SELECT COUNT(*) FROM trees WHERE cid = ?', (cid,)).fetchone()[0]
                rows = conn.execute(f'SELECT {columns} FROM trees WHERE cid = ? ORDER BY position LIMIT ? OFFSET ?',
                                    (cid, limit, offset)).fetchall()
        return {'total': total, 'trees': [{'tree_id': r['tree_id'], 'name': r['name'], 'external_id': r['external_id'],
                                           'leaf_count': r['leaf_count'], 'species_count': r['species_count'],
                                           'stats': json.loads(r['stats'] or '{}')} for r in rows]}

    def tree_record(self, collection_id: str, tree_id: str) -> Optional[Dict[str, Any]]:
        with self.connect() as conn:
            row = conn.execute('SELECT t.tid, t.tree_id, t.name, t.external_id, t.stats, t.payload FROM trees t '
                               'JOIN collections c ON c.cid = t.cid WHERE c.id = ? AND t.tree_id = ?',
                               (collection_id, tree_id)).fetchone()
            if not row:
                return None
            members = [dict(r) for r in conn.execute(
                'SELECT COALESCE(m.label, m.protein_id, m.gene_id) AS label, s.name AS species, m.gene_id, m.protein_id, '
                'm.transcript_id, m.symbol FROM members m LEFT JOIN species s ON s.sid = m.sid WHERE m.tid = ?', (row['tid'],))]
        return {'tid': row['tid'], 'tree_id': row['tree_id'], 'name': row['name'], 'external_id': row['external_id'],
                'stats': json.loads(row['stats'] or '{}'), 'payload': decode_payload(row['payload']), 'members': members}

    def iter_payloads(self, collection_id: str) -> Iterable[Dict[str, Any]]:
        last = -1
        while True:
            with self.connect() as conn:
                cid = self._cid(conn, collection_id)
                rows = [] if cid is None else conn.execute(
                    'SELECT tid, payload FROM trees WHERE cid = ? AND tid > ? ORDER BY tid LIMIT 200', (cid, last)).fetchall()
            if not rows:
                return
            for row in rows:
                last = row['tid']
                yield {'tid': row['tid'], 'payload': decode_payload(row['payload'])}

    def replace_members(self, rows: List[tuple]) -> None:
        """``rows`` of (tid, [member dicts]) — members re-read with a new label pattern."""
        with self.connect() as conn:
            species_ids: Dict[str, int] = {}
            for tid, members in rows:
                conn.execute('DELETE FROM members WHERE tid = ?', (tid,))
                conn.executemany('INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?)',
                                 [_member_row(conn, tid, m, species_ids) for m in members])

    def sample_members(self, collection_id: str, limit: int = 40) -> List[Dict[str, Any]]:
        """Some leaves, with what the collection currently reads from them."""
        with self.connect() as conn:
            cid = self._cid(conn, collection_id)
            rows = conn.execute('SELECT COALESCE(m.label, m.protein_id, m.gene_id) AS label, s.name AS species, '
                                'COALESCE(m.gene_id, m.protein_id, m.transcript_id) AS id FROM members m '
                                'LEFT JOIN species s ON s.sid = m.sid WHERE m.tid IN '
                                '(SELECT tid FROM trees WHERE cid = ? ORDER BY position LIMIT 20) LIMIT ?',
                                (cid, limit)).fetchall()
        return [dict(r) for r in rows]

    def species_tokens(self, collection_id: str) -> List[Dict[str, Any]]:
        with self.connect() as conn:
            cid = self._cid(conn, collection_id)
            rows = conn.execute('SELECT s.name AS species, COUNT(*) AS n FROM trees t JOIN members m ON m.tid = t.tid '
                                'LEFT JOIN species s ON s.sid = m.sid WHERE t.cid = ? GROUP BY m.sid ORDER BY n DESC',
                                (cid,)).fetchall()
        return [{'species': r['species'], 'leaves': r['n']} for r in rows]

    # ── the subtree-layer workspace ──

    def workspace(self, workspace_id: str = 'default') -> Optional[Dict[str, Any]]:
        with self.connect() as conn:
            row = conn.execute('SELECT json, updated FROM workspace WHERE id = ?', (workspace_id,)).fetchone()
        if not row:
            return None
        return {'workspace': json.loads(row['json']), 'updated': row['updated']}

    def save_workspace(self, data: Dict[str, Any], workspace_id: str = 'default') -> float:
        updated = time.time()
        with self.connect() as conn:
            conn.execute('INSERT INTO workspace (id, json, updated) VALUES (?, ?, ?) '
                         'ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated = excluded.updated',
                         (workspace_id, json.dumps(data, separators=(',', ':')), updated))
        return updated

    # ── search ──

    @staticmethod
    def _member_hits(conn, identifiers: List[str], symbols: List[str], gene_ids: Iterable[str] = ()) -> List[sqlite3.Row]:
        """Leaves whose gene, protein, transcript, label or symbol matches — one indexed lookup per column."""
        select = ('SELECT m.tid, COALESCE(m.label, m.protein_id, m.gene_id) AS label, s.name AS species, m.gene_id, '
                  'm.protein_id, m.symbol FROM members m LEFT JOIN species s ON s.sid = m.sid ')
        ids = list(dict.fromkeys(i for i in identifiers if i))
        genes = list(dict.fromkeys(ids + [g for g in gene_ids if g]))
        hits: List[sqlite3.Row] = []
        for column, values in (('gene_id', genes), ('protein_id', genes), ('transcript_id', ids), ('label', ids)):
            for chunk in _chunks(values):
                marks = ','.join('?' * len(chunk))
                hits += conn.execute(select + f'WHERE m.{column} IN ({marks}) AND m.{column} IS NOT NULL LIMIT 5000', chunk).fetchall()
        for symbol in dict.fromkeys(s for s in symbols if s):
            hits += conn.execute(select + 'WHERE m.symbol = ? COLLATE NOCASE AND m.symbol IS NOT NULL LIMIT 5000', (symbol,)).fetchall()
        return hits

    def search(self, tokens: List[str], gene_ranks: Optional[Dict[str, Dict[str, Any]]] = None,
               limit: int = 50) -> List[Dict[str, Any]]:
        """Trees (across every ready collection) holding a gene, best first.

        ``gene_ranks`` maps gene IDs the caller already knows — a symbol resolved in the
        user's own genomes — to ``{rank, assembly, genome_name}``: those leaves, and the
        trees that hold them, come first, whatever the tree file itself says about
        symbols (Compara's dumps leave most of them out).
        """
        gene_ranks = gene_ranks or {}
        tokens = [t.strip() for t in tokens if t and t.strip()]
        identifiers = list(dict.fromkeys(tokens + [model.strip_version(t) for t in tokens]))
        symbols = [t for t in tokens if not model.classify_identifier(t)[0]]
        with self.connect() as conn:
            hits = self._member_hits(conn, identifiers, symbols, gene_ranks.keys())
            tree_hits = set()
            for chunk in _chunks(identifiers):
                marks = ','.join('?' * len(chunk))
                tree_hits |= {r['tid'] for r in conn.execute(
                    f'SELECT tid FROM trees WHERE external_id IN ({marks}) OR tree_id IN ({marks}) LIMIT 500', chunk * 2)}
            for symbol in symbols:
                tree_hits |= {r['tid'] for r in conn.execute('SELECT tid FROM trees WHERE name = ? COLLATE NOCASE LIMIT 500', (symbol,))}
            grouped: Dict[int, List[Dict[str, Any]]] = {}
            seen = set()
            for row in hits:
                key = (row['tid'], row['label'])
                if key in seen:
                    continue
                seen.add(key)
                known = next((gene_ranks[k] for k in (row['gene_id'], model.strip_version(row['gene_id']), row['protein_id'],
                                                     model.strip_version(row['protein_id'])) if k and k in gene_ranks), None)
                match = {'label': row['label'], 'species': row['species'], 'gene_id': row['gene_id'],
                         'protein_id': row['protein_id'], 'symbol': row['symbol'], 'rank': known['rank'] if known else 9}
                if known:
                    match.update(assembly=known.get('assembly'), genome_name=known.get('genome_name'))
                grouped.setdefault(row['tid'], []).append(match)
            for tid in tree_hits:
                grouped.setdefault(tid, [])
            info: Dict[int, sqlite3.Row] = {}
            for chunk in _chunks(list(grouped)):
                marks = ','.join('?' * len(chunk))
                for row in conn.execute(
                        f'SELECT t.tid, t.tree_id, t.name, t.external_id, t.leaf_count, t.species_count, c.id AS collection_id, '
                        f'c.name AS collection_name, c.method, c.origin, c.tags FROM trees t JOIN collections c ON c.cid = t.cid '
                        f"WHERE t.tid IN ({marks}) AND c.status = 'ready'", chunk):
                    info[row['tid']] = row
        results = []
        for tid, matches in grouped.items():
            row = info.get(tid)
            if row is None:
                continue
            matches.sort(key=lambda m: (m['rank'], m['species'] or ''))
            results.append({
                'collection_id': row['collection_id'], 'collection_name': row['collection_name'], 'method': row['method'],
                'origin': row['origin'], 'tags': json.loads(row['tags'] or '[]'), 'tree_id': row['tree_id'],
                'tree_name': row['name'], 'external_id': row['external_id'], 'leaf_count': row['leaf_count'],
                'species_count': row['species_count'], 'matches': matches[:20], 'match_count': len(matches),
                'best_rank': matches[0]['rank'] if matches else 9,
            })
        results.sort(key=lambda r: (r['best_rank'], -sum(1 for m in r['matches'] if m['rank'] < 9), -r['match_count'],
                                    r['collection_name'] or '', r['tree_name'] or ''))
        return results[:limit]


def _member_row(conn: sqlite3.Connection, tid: int, member: Dict[str, Any], species_ids: Dict[str, int]) -> tuple:
    species = member.get('species')
    sid = None
    if species:
        sid = species_ids.get(species)
        if sid is None:
            conn.execute('INSERT OR IGNORE INTO species (name) VALUES (?)', (species,))
            sid = conn.execute('SELECT sid FROM species WHERE name = ?', (species,)).fetchone()[0]
            species_ids[species] = sid
    label = member.get('label') or None
    gene_id, protein_id = member.get('gene_id'), member.get('protein_id')
    # Compara labels its leaves with the protein ID: keep the label only when it adds something.
    if label in (gene_id, protein_id):
        label = None
    return (tid, label, sid, gene_id, protein_id, member.get('transcript_id'), member.get('symbol'))


class _Writer:
    def __init__(self, conn: sqlite3.Connection, collection_id: str, batch: int):
        self.conn = conn
        row = conn.execute('SELECT cid FROM collections WHERE id = ?', (collection_id,)).fetchone()
        if not row:
            raise KeyError(collection_id)
        self.cid = row['cid']
        self.batch = batch
        self.trees = 0
        self.leaves = 0
        self._pending = 0
        self._used = set()
        self._species: Dict[str, int] = {}

    def add(self, record: Dict[str, Any]) -> str:
        """Store one tree: {name, tree_id?, external_id?, stats, payload, members}. Returns its tree_id."""
        tree_id = _unique_tree_id(record.get('tree_id') or record.get('external_id') or f't{self.trees + 1:05d}', self._used)
        members = record.get('members') or []
        stats = record.get('stats') or {}
        cursor = self.conn.execute(
            'INSERT INTO trees (cid, tree_id, position, name, external_id, leaf_count, species_count, stats, payload) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (self.cid, tree_id, self.trees, record.get('name') or tree_id, record.get('external_id') or None,
             stats.get('genes', len(members)), stats.get('species', 0), json.dumps(stats), encode_payload(record['payload'])))
        tid = cursor.lastrowid
        self.conn.executemany('INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?)',
                              [_member_row(self.conn, tid, m, self._species) for m in members])
        self.trees += 1
        self.leaves += len(members)
        self._pending += 1
        if self._pending >= self.batch:
            self.flush()
        return tree_id

    def flush(self) -> None:
        self.conn.execute('UPDATE collections SET tree_count = ?, leaf_count = ? WHERE cid = ?',
                          (self.trees, self.leaves, self.cid))
        self.conn.commit()
        self._pending = 0


def _unique_tree_id(base: str, used: set) -> str:
    slug = re.sub(r'[^A-Za-z0-9_.-]+', '_', base).strip('_')[:80] or 'tree'
    candidate, n = slug, 2
    while candidate in used:
        candidate, n = f'{slug}_{n}', n + 1
    used.add(candidate)
    return candidate
