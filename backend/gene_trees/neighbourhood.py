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
