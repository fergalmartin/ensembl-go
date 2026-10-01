"""The genes around a leaf's gene in its local genome, for the tree's Neighbourhood column.

The window is the Neighbourhood view's (the genes on the same chromosome in start order),
cut down to the centre gene and the nearest protein-coding genes on each side, and turned
so the centre gene always points right: a row whose centre gene is on the minus strand is
reversed, every strand swapped. Rows from different genomes then read the same way.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from . import model

WINDOW = 30          # genes fetched each side before filtering to protein-coding
CACHE_TTL = 600      # seconds
CACHE_LIMIT = 4000

_SMALL_RNA = ('mirna', 'snrna', 'snorna', 'rrna', 'trna', 'srp', 'scrna', 'misc_rna', 'ncrna', 'ribozyme', 'vault_rna')


def biotype_class(biotype: Optional[str]) -> str:
    """The Neighbourhood view's four classes (NeighbourhoodView.jsx, classifyGeneBiotypeClass)."""
    value = str(biotype or '').strip().lower().replace('-', '_')
    if not value or value == 'protein_coding':
        return 'protein_coding'
    if 'pseudogene' in value:
        return 'pseudogene'
    if ('lnc' in value or 'linc' in value or 'long_non' in value
            or value in ('antisense', 'sense_intronic', 'sense_overlapping', 'processed_transcript')):
        return 'long_non_coding'
    if any(token in value for token in _SMALL_RNA) or 'rna' in value:
        return 'small_non_coding'
    return 'protein_coding'


def window(rows: List[Dict[str, Any]], center_id: str, flank: int) -> Optional[Dict[str, Any]]:
    """The centre gene with `flank` protein-coding genes each side, turned to point right."""
    ordered = sorted(rows, key=lambda g: (int(g.get('start') or 0), str(g.get('id') or '')))
    at = next((i for i, g in enumerate(ordered) if g.get('id') == center_id), -1)
    if at < 0:
        return None
    coding = lambda g: biotype_class(g.get('biotype')) == 'protein_coding'  # noqa: E731
    left = [g for g in reversed(ordered[:at]) if coding(g)][:flank][::-1]
    right = [g for g in ordered[at + 1:] if coding(g)][:flank]
    genes = [_row(g) for g in left + [ordered[at]] + right]
    flipped = str(ordered[at].get('strand') or '+') == '-'
    if flipped:
        genes = [{**g, 'strand': '+' if g['strand'] == '-' else '-'} for g in reversed(genes)]
    return {'center': center_id, 'chrom': ordered[at].get('chrom'), 'flipped': flipped, 'genes': genes}


def _row(gene: Dict[str, Any]) -> Dict[str, Any]:
    return {'id': gene.get('id'), 'name': gene.get('name') or '', 'start': int(gene.get('start') or 0),
            'end': int(gene.get('end') or 0), 'strand': str(gene.get('strand') or '+'), 'biotype': gene.get('biotype') or ''}


class Neighbourhoods:
    """Look up windows for many (assembly, gene) pairs at once, remembering recent answers.

    `genomes_provider` is the linker's list of local genomes (assembly → index_path);
    `lookup(index_path, gene_id, window_size)` returns (gene dicts, centre id) — the app's
    own index neighbourhood query, handed in so this package never imports the app.
    """

    def __init__(self, genomes_provider: Callable[[], List[Dict[str, Any]]],
                 lookup: Callable[[str, str, int], Tuple[List[Dict[str, Any]], Optional[str]]]):
        self.genomes_provider = genomes_provider
        self.lookup = lookup
        self.cache: 'OrderedDict[tuple, Tuple[float, Dict[str, Any]]]' = OrderedDict()

    def get(self, pairs: Iterable[Tuple[str, str]], flank: int) -> Dict[str, Dict[str, Any]]:
        indexes = {g.get('assembly'): g.get('index_path') for g in self.genomes_provider()}
        out: Dict[str, Dict[str, Any]] = {}
        now = time.time()
        for assembly, gene_id in pairs:
            key = f'{assembly}:{gene_id}'
            cached = self.cache.get((assembly, gene_id, flank))
            if cached and now - cached[0] < CACHE_TTL:
                out[key] = cached[1]
                continue
            index = indexes.get(assembly)
            if assembly not in indexes:
                result: Dict[str, Any] = {'error': 'not local'}
            elif not index:
                result = {'error': 'not indexed'}
            else:
                try:
                    rows, center = self.lookup(index, gene_id, WINDOW)
                    result = window(rows, center or gene_id, flank) or {'error': 'not found'}
                except Exception as exc:  # a broken index should not sink the whole batch
                    result = {'error': f'lookup failed: {exc}'}
            self.cache[(assembly, gene_id, flank)] = (now, result)
            while len(self.cache) > CACHE_LIMIT:
                self.cache.popitem(last=False)
            out[key] = result
        return out


def annotate_families(results: Dict[str, Dict[str, Any]], store: Any, genomes: List[Dict[str, Any]],
                      protein_map: Callable[[Dict[str, Any]], Any]) -> Dict[str, Any]:
    """Each window's genes with the gene families (library trees) they are in, for linking rows.

    A gene is looked for by its ID (Compara leaves carry gene IDs) and, failing that, by the
    proteins its genome's protein map knows for it (trees built on proteins: RefSeq,
    OrthoFinder). Maps are only read, never built here: a genome without one is matched on
    symbols by the view instead. Returns ``{results, families: {tid: name…}}`` with fresh
    dicts, so the windows cached by ``Neighbourhoods`` are never changed.
    """
    by_assembly: Dict[str, set] = {}
    for key, entry in results.items():
        if entry.get('genes'):
            by_assembly.setdefault(key.split(':', 1)[0], set()).update(g['id'] for g in entry['genes'] if g.get('id'))

    # gene ID (as the window has it) -> tids, per assembly
    found: Dict[str, Dict[str, List[int]]] = {}
    variants = lambda gene: list(dict.fromkeys(v for v in (gene, model.strip_version(gene)) if v))  # noqa: E731
    all_ids = {v for ids in by_assembly.values() for gene in ids for v in variants(gene)}
    hits = store.families('gene_id', all_ids) if all_ids else {}
    genomes_by_assembly = {g.get('assembly'): g for g in genomes}
    for assembly, ids in by_assembly.items():
        mine = found.setdefault(assembly, {})
        for gene in ids:
            tids = sorted({t for v in variants(gene) for t in hits.get(v, ())})
            if tids:
                mine[gene] = tids
        missing = [g for g in ids if g not in mine]
        genome = genomes_by_assembly.get(assembly)
        if not missing or not genome:
            continue
        pmap = protein_map(genome)
        proteins = pmap.proteins_for_genes(missing) if pmap is not None else {}
        protein_hits = store.families('protein_id', [p for ps in proteins.values() for p in ps]) if proteins else {}
        for gene, ps in proteins.items():
            tids = sorted({t for p in ps for t in protein_hits.get(p, ())})
            if tids:
                mine[gene] = tids

    out: Dict[str, Dict[str, Any]] = {}
    used: set = set()
    for key, entry in results.items():
        if not entry.get('genes'):
            out[key] = entry
            continue
        mine = found.get(key.split(':', 1)[0], {})
        genes = []
        for gene in entry['genes']:
            tids = mine.get(gene.get('id'), [])
            used.update(tids)
            genes.append({**gene, 'families': tids})
        out[key] = {**entry, 'genes': genes}
    names = store.family_names(used) if used else {}
    return {'results': out, 'families': {str(tid): info for tid, info in names.items()}}
