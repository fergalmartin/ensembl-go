"""Which tree leaves are genes the user has locally.

A genome is identified by its assembly accession, exactly as the Alignment Explorer
does. A leaf reaches one in this order: a manual link, the collection's species map,
an accession in its label, its species (exact name, taxid, then binomial), and — for
a leaf with no species at all — its identifier probed in every local genome. The
gene itself is then confirmed in that genome's annotation index by gene, transcript
or protein ID, falling back to the symbol. A species that matches a local genome
whose annotation lacks the gene is reported as such (``genome``), never as linked.

Protein IDs (OrthoFinder labels) are not in the annotation index. The first time a
genome is asked for one, a protein -> transcript -> gene map is built from its GFF in
the background and cached; until it exists those leaves are ``pending``.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

from . import model, taxonomy

logger = logging.getLogger(__name__)

STATUS_LINKED = 'linked'
STATUS_GENOME = 'genome'          # the species is local but the gene is not in its annotation
STATUS_PENDING = 'pending'        # waiting on a protein map
STATUS_NO_INDEX = 'no_index'      # the species is local, but no genome of it has an indexed annotation to look in
STATUS_UNRESOLVED = 'unresolved'

_ACCESSION = re.compile(r'(GC[AF]_\d{9}\.\d+)')
_PARENT_PREFIX = re.compile(r'^(?:transcript|mapped_transcript|rna|gene)[:\-]')
_CHUNK = 500
# BRCA2, Brca2, tp53a, Hoxb13: a gene symbol, not worth a whole-GFF protein scan.
_SYMBOL_LIKE = re.compile(r'^[A-Za-z][A-Za-z-]{0,7}\d{0,3}[A-Za-z]?$')


def _may_be_protein(identifier: Optional[str]) -> bool:
    if not identifier:
        return False
    kind = model.classify_identifier(identifier)[1]
    if kind:
        return kind == 'protein'
    return not _SYMBOL_LIKE.match(identifier)


def _chunks(items: List[str], size: int = _CHUNK) -> Iterable[List[str]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _open_index(path: str) -> Optional[sqlite3.Connection]:
    if not path or not os.path.exists(path):
        return None
    try:
        conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error:
        return None


def _gene_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {'id': row['id'], 'name': row['name'] or None, 'chrom': row['chrom'], 'start': row['start'],
            'end': row['end'], 'strand': row['strand'], 'biotype': row['biotype'] or None}


class ProteinMap:
    """One genome's protein -> (transcript, gene) table, read from the shared cache database."""

    def __init__(self, db_path: Path, key: Optional[int]):
        self.db_path, self.key = db_path, key

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.db_path), timeout=30)

    def lookup(self, proteins: Iterable[str]) -> Dict[str, Tuple[str, str]]:
        wanted = [p for p in dict.fromkeys(proteins) if p]
        wanted += [b for b in (model.strip_version(p) for p in wanted) if b and b not in wanted]
        out: Dict[str, Tuple[str, str]] = {}
        conn = self._connect()
        try:
            for chunk in _chunks(wanted):
                marks = ','.join('?' * len(chunk))
                for protein, tx, gene in conn.execute(
                        f'SELECT protein, transcript, gene FROM proteins WHERE map = ? AND protein IN ({marks})', (self.key, *chunk)):
                    out[protein] = (tx, gene)
        finally:
            conn.close()
        return out

    def proteins_for_gene(self, gene_id: str) -> List[str]:
        conn = self._connect()
        try:
            return [r[0] for r in conn.execute('SELECT protein FROM proteins WHERE map = ? AND gene = ?', (self.key, gene_id))]
        finally:
            conn.close()

    def proteins_for_genes(self, gene_ids: Iterable[str]) -> Dict[str, List[str]]:
        """gene ID -> its proteins, for many genes at once. Empty when the map was never built."""
        out: Dict[str, List[str]] = {}
        if self.key is None:
            return out
        conn = self._connect()
        try:
            for chunk in _chunks([g for g in dict.fromkeys(gene_ids) if g]):
                marks = ','.join('?' * len(chunk))
                for protein, gene in conn.execute(
                        f'SELECT protein, gene FROM proteins WHERE map = ? AND gene IN ({marks})', (self.key, *chunk)):
                    out.setdefault(gene, []).append(protein)
        finally:
            conn.close()
        return out


class ProteinMaps:
    """protein ID -> (transcript ID, gene ID) per genome, built from the GFF once and cached.

    Kept in one SQLite file rather than in memory: a vertebrate GFF yields a hundred
    thousand proteins, and a tree touching a dozen genomes would otherwise hold them
    all in the backend process.
    """

    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)
        self.db_path = self.cache_dir / 'protein_maps_v2.sqlite'
        self._ready: Dict[str, int] = {}
        self._building: Set[str] = set()
        self._failed: Dict[str, str] = {}
        self._lock = threading.Lock()
        self._schema = False
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='gene-tree-protein-map')

    def _connect(self) -> sqlite3.Connection:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=30)
        if not self._schema:
            # An integer map id and a WITHOUT ROWID table keyed on (map, protein): a
            # vertebrate genome is a quarter of a million rows, so per-row overhead is
            # most of the file.
            conn.executescript(
                'CREATE TABLE IF NOT EXISTS maps (id INTEGER PRIMARY KEY, key TEXT UNIQUE, gff TEXT, built REAL);'
                'CREATE TABLE IF NOT EXISTS proteins (map INTEGER, protein TEXT, transcript TEXT, gene TEXT, '
                'PRIMARY KEY (map, protein)) WITHOUT ROWID;'
                'CREATE INDEX IF NOT EXISTS idx_protein_gene ON proteins (map, gene);')
            self._schema = True
        return conn

    @staticmethod
    def _key(gff_path: str) -> str:
        stat = os.stat(gff_path)
        return hashlib.sha1(f'{gff_path}|{stat.st_size}|{stat.st_mtime_ns}|v2'.encode()).hexdigest()[:20]

    def get(self, genome: Dict[str, Any], build: bool = True) -> Optional[ProteinMap]:
        """The map; ``None`` while it is being built (starting a build if needed); an empty map if impossible."""
        gff, index = genome.get('gff_path'), genome.get('index_path')
        empty = ProteinMap(self.db_path, None)
        if not gff or not os.path.exists(gff) or not index:
            return empty
        try:
            key = self._key(gff)
        except OSError:
            return empty
        with self._lock:
            if key in self._ready:
                return ProteinMap(self.db_path, self._ready[key])
            if key in self._failed:
                return empty
            building = key in self._building
        if not building:
            with self._lock:
                conn = self._connect()
                try:
                    done = conn.execute('SELECT id FROM maps WHERE key = ? AND built IS NOT NULL', (key,)).fetchone()
                finally:
                    conn.close()
            if done:
                with self._lock:
                    self._ready[key] = done[0]
                return ProteinMap(self.db_path, done[0])
            if not build:
                return empty
            with self._lock:
                if key not in self._building:
                    self._building.add(key)
                    self._pool.submit(self._build, key, gff, index)
        return None

    def building(self) -> bool:
        with self._lock:
            return bool(self._building)

    def wait(self) -> None:
        """Block until queued builds finish (tests, shutdown)."""
        self._pool.submit(lambda: None).result()

    def _build(self, key: str, gff: str, index: str) -> None:
        try:
            rows = build_protein_map(gff, index)
            with self._lock:
                conn = self._connect()
                try:
                    conn.execute('INSERT OR IGNORE INTO maps (key, gff) VALUES (?, ?)', (key, gff))
                    map_id = conn.execute('SELECT id FROM maps WHERE key = ?', (key,)).fetchone()[0]
                    conn.execute('DELETE FROM proteins WHERE map = ?', (map_id,))
                    conn.executemany('INSERT OR IGNORE INTO proteins VALUES (?, ?, ?, ?)',
                                     ((map_id, protein, tx or None, gene) for protein, (tx, gene) in rows.items()))
                    conn.execute("UPDATE maps SET built = strftime('%s', 'now') WHERE id = ?", (map_id,))
                    conn.commit()
                finally:
                    conn.close()
                self._ready[key] = map_id
        except Exception as exc:  # pragma: no cover - logged, reported as "no proteins"
            logger.exception('Protein map build failed for %s', gff)
            with self._lock:
                self._failed[key] = str(exc)
        finally:
            with self._lock:
                self._building.discard(key)


def build_protein_map(gff_path: str, index_path: str) -> Dict[str, List[str]]:
    """Scan CDS lines for ``protein_id`` and resolve each to its transcript and gene."""
    protein_to_parent: Dict[str, str] = {}
    opener = gzip.open if gff_path.endswith('.gz') else open
    with opener(gff_path, 'rt', encoding='utf-8', errors='replace') as handle:
        for line in handle:
            if '\tCDS\t' not in line:
                continue
            attrs = line.rstrip('\n').rsplit('\t', 1)[-1]
            match = re.search(r'(?:^|;)protein_id=([^;]+)', attrs)
            if not match:
                continue
            protein = match.group(1).strip()
            if protein in protein_to_parent:
                continue
            parent = re.search(r'(?:^|;)Parent=([^;,]+)', attrs)
            tx = re.search(r'(?:^|;)transcript_id=([^;]+)', attrs)
            raw = (parent.group(1) if parent else tx.group(1) if tx else '').strip()
            protein_to_parent[protein] = _PARENT_PREFIX.sub('', raw)
    tx_to_gene: Dict[str, str] = {}
    conn = _open_index(index_path)
    if conn:
        try:
            parents = list(set(protein_to_parent.values()))
            for chunk in _chunks(parents):
                marks = ','.join('?' * len(chunk))
                for row in conn.execute(f'SELECT id, parent_gene_id FROM transcripts WHERE id IN ({marks})', chunk):
                    tx_to_gene[row['id']] = row['parent_gene_id']
                for row in conn.execute(f'SELECT id FROM genes WHERE id IN ({marks})', chunk):
                    tx_to_gene.setdefault(row['id'], row['id'])
        finally:
            conn.close()
    out: Dict[str, List[str]] = {}
    for protein, parent in protein_to_parent.items():
        gene = tx_to_gene.get(parent)
        if not gene:
            continue
        entry = [parent if parent != gene else '', gene]
        out[protein] = entry
        bare = model.strip_version(protein)
        if bare and bare != protein:
            out.setdefault(bare, entry)
    return out


class Linker:
    def __init__(self, genomes_provider: Callable[[], List[Dict[str, Any]]], cache_dir: Path):
        self.genomes_provider = genomes_provider
        self.proteins = ProteinMaps(cache_dir)

    def genomes(self) -> List[Dict[str, Any]]:
        try:
            genomes = self.genomes_provider() or []
        except Exception:
            logger.exception('Could not list local genomes for gene-tree linking')
            return []
        return [g for g in genomes if g.get('assembly')]

    # ── species -> genomes ──

    @staticmethod
    def _species_index(genomes: List[Dict[str, Any]]) -> Dict[str, Dict[Any, List[Dict[str, Any]]]]:
        by_name: Dict[str, List[Dict[str, Any]]] = {}
        by_taxid: Dict[int, List[Dict[str, Any]]] = {}
        for genome in genomes:
            names = {taxonomy.species_key(genome.get('scientific_name')), taxonomy.species_key(genome.get('species_key'))}
            for name in filter(None, names):
                by_name.setdefault(name, []).append(genome)
            taxid = genome.get('taxid') or taxonomy.taxid_for_species(genome.get('scientific_name') or genome.get('species_key'))
            if taxid:
                by_taxid.setdefault(int(taxid), []).append(genome)
        return {'name': by_name, 'taxid': by_taxid}

    def _genomes_for_leaf(self, leaf: Dict[str, Any], index, by_assembly, species_map) -> Tuple[List[Dict[str, Any]], str]:
        species = leaf.get('species')
        mapped = species_map.get(species) if species else None
        if mapped is not None:
            return ([by_assembly[mapped]] if mapped in by_assembly else []), 'species_map'
        accession = _ACCESSION.search(leaf.get('label') or '')
        if accession and accession.group(1) in by_assembly:
            return [by_assembly[accession.group(1)]], 'accession'
        if species:
            key = taxonomy.species_key(species)
            if key in index['name']:
                return index['name'][key], 'species'
            if leaf.get('taxid') and int(leaf['taxid']) in index['taxid']:
                return index['taxid'][int(leaf['taxid'])], 'taxid'
            binomial = ' '.join(key.split()[:2])
            if binomial != key and binomial in index['name']:
                return index['name'][binomial], 'binomial'
            return [], 'species'
        return [], 'none'

    # ── the main entry point ──

    def link_tree(self, nodes: List[Dict[str, Any]], species_map: Optional[Dict[str, str]] = None,
                  manual: Optional[Dict[str, Dict[str, str]]] = None) -> Dict[str, Any]:
        genomes = self.genomes()
        by_assembly = {g['assembly']: g for g in genomes}
        index = self._species_index(genomes)
        species_map = species_map or {}
        manual = manual or {}

        plans: Dict[int, Dict[str, Any]] = {}
        requests: Dict[str, Dict[str, Set[str]]] = {}

        def want(assembly: str, kind: str, value: Optional[str]) -> None:
            if value:
                requests.setdefault(assembly, {'genes': set(), 'transcripts': set(), 'proteins': set(), 'symbols': set()})[kind].add(value)

        for node in nodes:
            leaf = node.get('leaf')
            if not leaf:
                continue
            label = leaf.get('label') or ''
            forced = manual.get(label)
            if forced and forced.get('assembly') in by_assembly:
                candidates, via = [by_assembly[forced['assembly']]], 'manual'
                ids = {'gene': forced.get('gene_id') or leaf.get('gene_id'), 'transcript': None, 'protein': None,
                       'other': None, 'symbol': None}
            else:
                candidates, via = self._genomes_for_leaf(leaf, index, by_assembly, species_map)
                ids = {'gene': model.strip_version(leaf.get('gene_id')),
                       'transcript': model.strip_version(leaf.get('transcript_id')),
                       'protein': leaf.get('protein_id'), 'other': leaf.get('other_id'), 'symbol': leaf.get('symbol')}
            probe_all = not candidates and via == 'none' and any(ids[k] for k in ('gene', 'transcript', 'protein', 'other'))
            if probe_all:
                candidates = genomes
            plans[node['id']] = {'candidates': candidates, 'via': via, 'ids': ids, 'probe': probe_all}
            for genome in candidates:
                assembly = genome['assembly']
                want(assembly, 'genes', ids['gene'])
                want(assembly, 'genes', ids['other'])
                want(assembly, 'genes', model.strip_version(ids['other']))
                want(assembly, 'transcripts', ids['transcript'])
                want(assembly, 'transcripts', ids['other'])
                # A gene ID settles it (Compara leaves carry both); proteins mean a GFF scan.
                if not ids['gene']:
                    want(assembly, 'proteins', ids['protein'])
                    if _may_be_protein(ids['other']):
                        want(assembly, 'proteins', ids['other'])
                if not probe_all:
                    want(assembly, 'symbols', ids['symbol'])
                    if ids['other'] and not model.classify_identifier(ids['other'])[0]:
                        want(assembly, 'symbols', ids['other'])

        found, pending_assemblies = self._lookup(requests, by_assembly)

        links: Dict[str, Dict[str, Any]] = {}
        summary = {STATUS_LINKED: 0, STATUS_GENOME: 0, STATUS_NO_INDEX: 0, STATUS_PENDING: 0, STATUS_UNRESOLVED: 0}
        for node_id, plan in plans.items():
            ids = plan['ids']
            matches = []
            waiting = False
            for genome in plan['candidates']:
                result = found.get(genome['assembly'], {})
                gene, matched_by, transcript = None, None, None
                for key, source in (('gene', 'genes'), ('other', 'genes')):
                    value = ids[key]
                    hit = result.get('genes', {}).get(value) or result.get('genes', {}).get(model.strip_version(value) or '')
                    if hit:
                        gene, matched_by = hit, 'gene_id'
                        break
                if not gene:
                    for value in (ids['transcript'], ids['other']):
                        hit = result.get('transcripts', {}).get(value or '')
                        if hit:
                            gene, matched_by, transcript = hit['gene'], 'transcript_id', value
                            break
                if not gene:
                    for value in (ids['protein'], ids['other']):
                        if not value:
                            continue
                        hit = result.get('proteins', {}).get(value) or result.get('proteins', {}).get(model.strip_version(value))
                        if hit:
                            gene, matched_by, transcript = hit['gene'], 'protein_id', hit.get('transcript') or None
                            break
                    if not gene and (ids['protein'] or (ids['other'] and model.classify_identifier(ids['other'])[1] == 'protein')) \
                            and genome['assembly'] in pending_assemblies:
                        waiting = True
                if not gene and not plan['probe']:
                    for value in (ids['symbol'], ids['other']):
                        hits = result.get('symbols', {}).get((value or '').upper()) or []
                        if len(hits) == 1:
                            gene, matched_by = hits[0], 'symbol'
                            break
                if gene:
                    matches.append((genome, gene, matched_by, transcript))
            if matches:
                genome, gene, matched_by, transcript = matches[0]
                status = STATUS_LINKED
                link = {'status': status, **_genome_ref(genome), 'gene': gene, 'transcript_id': transcript,
                        'matched_by': 'manual' if plan['via'] == 'manual' else matched_by, 'via': plan['via'],
                        'candidates': [{**_genome_ref(g), 'gene_id': gn['id']} for g, gn, _, _ in matches]}
            elif waiting:
                status = STATUS_PENDING
                link = {'status': status, 'via': plan['via'],
                        'candidates': [_genome_ref(g) for g in plan['candidates'] if not plan['probe']]}
            elif plan['candidates'] and not plan['probe']:
                # Not found: in an annotation that was searched, or only because none of the
                # species' genomes has an index to search. The second is a job to do, not an answer.
                indexed = [g for g in plan['candidates'] if g.get('index_path')]
                status = STATUS_GENOME if indexed else STATUS_NO_INDEX
                first = (indexed or plan['candidates'])[0]
                link = {'status': status, **_genome_ref(first), 'via': plan['via'],
                        'candidates': [_genome_ref(g) for g in plan['candidates']]}
                if not indexed:
                    link['annotation'] = bool(first.get('gff_path'))
            else:
                status = STATUS_UNRESOLVED
                link = {'status': status, 'via': plan['via']}
            summary[status] += 1
            links[str(node_id)] = link
        return {'links': links, 'summary': summary, 'pending': bool(pending_assemblies),
                'genomes': [_genome_ref(g) for g in genomes]}

    def _lookup(self, requests: Dict[str, Dict[str, Set[str]]], by_assembly: Dict[str, Dict[str, Any]]):
        found: Dict[str, Dict[str, Dict[str, Any]]] = {}
        pending: Set[str] = set()
        for assembly, wanted in requests.items():
            genome = by_assembly.get(assembly)
            if not genome:
                continue
            result = found.setdefault(assembly, {'genes': {}, 'transcripts': {}, 'proteins': {}, 'symbols': {}})
            conn = _open_index(genome.get('index_path') or '')
            if not conn:
                continue
            try:
                gene_ids = sorted(wanted['genes'])
                for chunk in _chunks(gene_ids):
                    marks = ','.join('?' * len(chunk))
                    for row in conn.execute(f'SELECT id, name, chrom, start, end, strand, biotype FROM genes WHERE id IN ({marks})', chunk):
                        result['genes'][row['id']] = _gene_dict(row)
                tx_ids = sorted(wanted['transcripts'])
                parent_by_tx: Dict[str, str] = {}
                for chunk in _chunks(tx_ids):
                    marks = ','.join('?' * len(chunk))
                    for row in conn.execute(f'SELECT id, parent_gene_id FROM transcripts WHERE id IN ({marks})', chunk):
                        parent_by_tx[row['id']] = row['parent_gene_id']
                proteins = sorted(wanted['proteins'])
                protein_hits: Dict[str, Tuple[str, str]] = {}
                if proteins:
                    protein_map = self.proteins.get(genome)
                    if protein_map is None:
                        pending.add(assembly)
                    elif protein_map.key is not None:
                        found_proteins = protein_map.lookup(proteins)
                        for protein in proteins:
                            entry = found_proteins.get(protein) or found_proteins.get(model.strip_version(protein) or '')
                            if entry:
                                protein_hits[protein] = entry
                extra_genes = sorted(set(parent_by_tx.values()) | {g for _, g in protein_hits.values()})
                genes_by_id = dict(result['genes'])
                missing = [g for g in extra_genes if g and g not in genes_by_id]
                for chunk in _chunks(missing):
                    marks = ','.join('?' * len(chunk))
                    for row in conn.execute(f'SELECT id, name, chrom, start, end, strand, biotype FROM genes WHERE id IN ({marks})', chunk):
                        genes_by_id[row['id']] = _gene_dict(row)
                for tx, gene_id in parent_by_tx.items():
                    if gene_id in genes_by_id:
                        result['transcripts'][tx] = {'gene': genes_by_id[gene_id]}
                for protein, (tx, gene_id) in protein_hits.items():
                    if gene_id in genes_by_id:
                        result['proteins'][protein] = {'gene': genes_by_id[gene_id], 'transcript': tx}
                symbols = sorted(wanted['symbols'])
                for chunk in _chunks(symbols):
                    marks = ','.join('?' * len(chunk))
                    for row in conn.execute(f'SELECT id, name, chrom, start, end, strand, biotype FROM genes '
                                            f'WHERE name COLLATE NOCASE IN ({marks})', chunk):
                        result['symbols'].setdefault(str(row['name']).upper(), []).append(_gene_dict(row))
            except sqlite3.Error:
                logger.exception('Gene-tree lookup failed in %s', genome.get('index_path'))
            finally:
                conn.close()
        return found, pending

    def genes_by_symbol(self, assemblies: List[str], symbols: List[str], build_proteins: bool = False) -> Dict[str, Dict[str, Any]]:
        """Resolve symbols in the given local genomes: gene (and protein) ID -> where it came from.

        Tree files often leave symbols out (Compara's dumps name only some leaves), so a
        symbol is looked up in the user's own annotation instead and the resulting IDs
        are what the library is searched for. Earlier assemblies rank first.
        """
        wanted = [s for s in dict.fromkeys(symbols) if s]
        by_assembly = {g['assembly']: g for g in self.genomes()}
        out: Dict[str, Dict[str, Any]] = {}
        for rank, assembly in enumerate(a for a in dict.fromkeys(assemblies) if a in by_assembly):
            genome = by_assembly[assembly]
            conn = _open_index(genome.get('index_path') or '')
            if not conn or not wanted:
                continue
            try:
                marks = ','.join('?' * len(wanted))
                gene_ids = [r['id'] for r in conn.execute(f'SELECT id FROM genes WHERE name COLLATE NOCASE IN ({marks}) LIMIT 50', wanted)]
            except sqlite3.Error:
                gene_ids = []
            finally:
                conn.close()
            info = {'rank': rank, 'assembly': assembly, 'genome_name': genome.get('display_name') or genome.get('scientific_name')}
            for gene_id in gene_ids:
                out.setdefault(gene_id, info)
            protein_map = self.proteins.get(genome, build=build_proteins) if gene_ids else None
            if protein_map is not None and protein_map.key is not None:
                for gene_id in gene_ids:
                    for protein in protein_map.proteins_for_gene(gene_id):
                        out.setdefault(protein, info)
        return out

    def gene_aliases(self, assembly: str, gene_id: str, build_proteins: bool = True) -> List[str]:
        """Every identifier a tree might use for this gene: itself, its transcripts and proteins."""
        genome = next((g for g in self.genomes() if g['assembly'] == assembly), None)
        aliases = [gene_id]
        if not genome:
            return aliases
        conn = _open_index(genome.get('index_path') or '')
        if conn:
            try:
                aliases += [r['id'] for r in conn.execute('SELECT id FROM transcripts WHERE parent_gene_id = ?', (gene_id,))]
            finally:
                conn.close()
        protein_map = self.proteins.get(genome, build=build_proteins)
        if protein_map is not None and protein_map.key is not None:
            aliases += protein_map.proteins_for_gene(gene_id)
        return list(dict.fromkeys(aliases))


def _genome_ref(genome: Dict[str, Any]) -> Dict[str, Any]:
    return {'assembly': genome.get('assembly'), 'species_key': genome.get('species_key'),
            'provider': genome.get('provider'), 'genome_name': genome.get('display_name') or genome.get('scientific_name')}
