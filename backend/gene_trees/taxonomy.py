"""Taxon labels and events for trees that arrive without them.

Ensembl trees name every internal node's taxon and mark duplications. A plain
Newick from OrthoFinder or IQ-TREE has neither, which leaves the view nothing to
put on a collapsed clade. Here each internal node gets the last common ancestor
of the species beneath it (from the NCBI lineages the app already ships in
``data/taxonomy_classification.json``), and — only when the tree carries no events
at all — speciation/duplication by the species-overlap rule. Both are marked as
inferred so the view can say so.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .parsers import EVENT_DUPLICATION, EVENT_SPECIATION

TAXONOMY_PATH = Path(__file__).resolve().parents[1] / 'data' / 'taxonomy_classification.json'
# taxid -> [scientific name, common name?] for every taxon in those lineages; written by
# backend/scripts/generate_taxon_names.py from the NCBI taxonomy dump.
TAXON_NAMES_PATH = Path(__file__).resolve().parents[1] / 'data' / 'taxon_names.json'

# Names for common internal clades. The shipped lineage file only names the taxa it
# was generated for (mostly species), so the clades between them need a fallback.
CLADE_NAMES: Dict[int, str] = {
    1: 'root', 131567: 'Cellular organisms', 2759: 'Eukaryota', 33154: 'Opisthokonta', 33208: 'Metazoa',
    6072: 'Eumetazoa', 33213: 'Bilateria', 33511: 'Deuterostomia', 33317: 'Protostomia', 1206794: 'Ecdysozoa',
    7711: 'Chordata', 89593: 'Craniata', 7742: 'Vertebrata', 7776: 'Gnathostomata', 117570: 'Teleostomi',
    117571: 'Euteleostomi', 8287: 'Sarcopterygii', 32523: 'Tetrapoda', 32524: 'Amniota', 8457: 'Sauropsida',
    32561: 'Sauria', 8782: 'Aves', 40674: 'Mammalia', 32525: 'Theria', 9263: 'Marsupialia', 9347: 'Eutheria',
    1437010: 'Boreoeutheria', 314146: 'Euarchontoglires', 314147: 'Glires', 9989: 'Rodentia', 10066: 'Muridae',
    39107: 'Murinae', 9443: 'Primates', 376913: 'Haplorrhini', 314293: 'Simiiformes', 9526: 'Catarrhini',
    314295: 'Hominoidea', 9604: 'Hominidae', 207598: 'Homininae', 314145: 'Laurasiatheria', 9397: 'Chiroptera',
    33554: 'Carnivora', 91561: 'Artiodactyla', 9362: 'Eulipotyphla', 311790: 'Afrotheria', 9348: 'Xenarthra',
    7898: 'Actinopterygii', 32443: 'Teleostei', 6656: 'Arthropoda', 50557: 'Insecta', 7147: 'Diptera',
    6231: 'Nematoda', 4751: 'Fungi', 33090: 'Viridiplantae', 3193: 'Embryophyta', 3398: 'Magnoliopsida',
}


@lru_cache(maxsize=1)
def _taxonomy() -> Dict[str, Any]:
    try:
        data = json.loads(TAXONOMY_PATH.read_text())
    except (OSError, ValueError):
        return {'by_name': {}, 'by_id': {}}
    by_id: Dict[int, Dict[str, Any]] = {}
    by_name: Dict[str, int] = {}
    for key, entry in (data.get('taxids') or {}).items():
        try:
            taxid = int(key)
        except ValueError:
            continue
        by_id[taxid] = entry
        name = entry.get('scientific_name')
        if name:
            by_name.setdefault(species_key(name), taxid)
    return {'by_name': by_name, 'by_id': by_id}


def species_key(name: Optional[str]) -> str:
    """Comparable form of a species name: ``Homo_sapiens`` and ``homo sapiens`` agree."""
    return re.sub(r'[\s_]+', ' ', str(name or '')).strip().lower()


def taxid_for_species(name: Optional[str]) -> Optional[int]:
    key = species_key(name)
    if not key:
        return None
    by_name = _taxonomy()['by_name']
    if key in by_name:
        return by_name[key]
    # "Mus musculus reference strain" -> "Mus musculus"
    words = key.split()
    return by_name.get(' '.join(words[:2])) if len(words) > 2 else None


def lineage(taxid: Optional[int]) -> Sequence[int]:
    entry = _taxonomy()['by_id'].get(int(taxid)) if taxid else None
    return tuple(entry.get('lineage') or ()) if entry else ()


@lru_cache(maxsize=1)
def _taxon_names() -> Dict[int, List[str]]:
    try:
        data = json.loads(TAXON_NAMES_PATH.read_text())
    except (OSError, ValueError):
        return {}
    return {int(k): v for k, v in (data.get('names') or {}).items()}


def taxon_name(taxid: int) -> Optional[str]:
    names = _taxon_names().get(int(taxid))
    if names:
        return names[0]
    entry = _taxonomy()['by_id'].get(int(taxid))
    return (entry or {}).get('scientific_name') or CLADE_NAMES.get(int(taxid))


def taxon_common_name(taxid: int) -> Optional[str]:
    names = _taxon_names().get(int(taxid))
    return names[1] if names and len(names) > 1 else None


def _common_prefix(lineages: List[Sequence[int]]) -> Sequence[int]:
    prefix = list(lineages[0])
    for other in lineages[1:]:
        limit = min(len(prefix), len(other))
        cut = next((i for i in range(limit) if prefix[i] != other[i]), limit)
        del prefix[cut:]
    return prefix


def _postorder(nodes: List[Dict[str, Any]]) -> List[int]:
    order, stack = [], [0]
    while stack:
        node_id = stack.pop()
        order.append(node_id)
        stack.extend(nodes[node_id]['children'])
    return list(reversed(order))


def annotate(nodes: List[Dict[str, Any]]) -> None:
    """Fill leaf taxids, internal LCA taxa and (if the tree has none) inferred events."""
    for node in nodes:
        leaf = node.get('leaf')
        if leaf and not leaf.get('taxid') and leaf.get('species'):
            leaf['taxid'] = taxid_for_species(leaf['species'])
        if leaf and leaf.get('taxid') and not leaf.get('common_name'):
            # EMF dumps name species only scientifically; NCBI's common names are lower case.
            common = taxon_common_name(int(leaf['taxid']))
            if common:
                leaf['common_name'] = common[:1].upper() + common[1:]

    has_events = any(n.get('event') for n in nodes if n['children'])
    taxids_under: Dict[int, set] = {}
    species_under: Dict[int, set] = {}
    unknown_under: Dict[int, int] = {}
    for node_id in _postorder(nodes):
        node = nodes[node_id]
        leaf = node.get('leaf')
        if leaf:
            taxids_under[node_id] = {leaf['taxid']} if leaf.get('taxid') else set()
            species_under[node_id] = {species_key(leaf['species'])} if leaf.get('species') else set()
            unknown_under[node_id] = 0 if leaf.get('taxid') else 1
            continue
        children = node['children']
        taxids_under[node_id] = set().union(*(taxids_under[c] for c in children)) if children else set()
        species_under[node_id] = set().union(*(species_under[c] for c in children)) if children else set()
        unknown_under[node_id] = sum(unknown_under[c] for c in children)

        if not has_events and children and all(species_under[c] for c in children):
            overlap = any(species_under[a] & species_under[b]
                          for i, a in enumerate(children) for b in children[i + 1:])
            node['event'] = EVENT_DUPLICATION if overlap else EVENT_SPECIATION
            node['event_inferred'] = True

        taxon = node.get('taxon')
        if taxon and taxon.get('id') and not taxon.get('name'):
            # Compara's NHX dumps give internal nodes a taxid and nothing else.
            taxon['name'] = taxon_name(int(taxon['id']))
            taxon['common_name'] = taxon.get('common_name') or taxon_common_name(int(taxon['id']))
        if taxon and taxon.get('name'):
            continue
        lineages = [lineage(t) for t in taxids_under[node_id]]
        lineages = [line for line in lineages if line]
        if not lineages:
            continue
        # A clade holding a species the taxonomy does not know cannot be named from
        # the others alone: "Oryzias latipes" for medaka plus an unknown fish is wrong.
        partial = unknown_under[node_id] > 0
        if partial and len(lineages) < 2:
            continue
        prefix = _common_prefix(lineages)
        # Walk up until a named taxon: an unnamed intermediate rank is no label at all.
        for taxid in reversed(prefix):
            name = taxon_name(taxid)
            if name and taxid not in (1, 131567):
                node['taxon'] = {'id': taxid, 'name': name, 'common_name': taxon_common_name(taxid), 'mya': None, 'inferred': True,
                                 **({'partial': True} if partial else {})}
                break
