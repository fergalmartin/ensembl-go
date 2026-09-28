"""The normalised tree: leaf-label interpretation, statistics and export.

A leaf's label is all a plain Newick file gives us, and tools write very different
things there: ``ENSP00000369497_Hsap`` (Ensembl web), ``Homo_sapiens_ENSP00000369497``
(OrthoFinder, prefixed by the proteome file name), ``Homo_sapiens.GRCh38.pep.all_ENSP…``,
``sp|P51587|BRCA2_HUMAN``. :func:`interpret_leaf_label` pulls a species token and an
identifier out of those; a collection can override it with its own pattern when the
guess is wrong.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .parsers import EVENT_DUBIOUS, EVENT_DUPLICATION, EVENT_GENE_SPLIT, EVENT_SPECIATION

# (pattern, kind) — the first capture group is the identifier. Ordered most to least specific.
_ID_PATTERNS: List[Tuple[re.Pattern, Optional[str]]] = [
    (re.compile(r'(ENS[A-Z]{0,8}([GTPE])\d{11}(?:\.\d+)?)'), None),        # kind from the letter
    (re.compile(r'(MGP_[A-Za-z0-9]+_([GTP])\d{7,}(?:\.\d+)?)'), None),      # mouse strain projects
    (re.compile(r'((?:NP|XP|YP|WP|AP)_\d+(?:\.\d+)?)'), 'protein'),         # RefSeq protein
    (re.compile(r'((?:NM|XM|NR|XR)_\d+(?:\.\d+)?)'), 'transcript'),         # RefSeq transcript
    (re.compile(r'(FBgn\d{7})'), 'gene'),
    (re.compile(r'(FBpp\d{7})'), 'protein'),
    (re.compile(r'(FBtr\d{7})'), 'transcript'),
    (re.compile(r'(WBGene\d{8})'), 'gene'),
]
_KIND_LETTERS = {'G': 'gene', 'T': 'transcript', 'P': 'protein', 'E': 'exon'}
_VERSION_SUFFIX = re.compile(r'^(.+?)\.\d+$')
_BINOMIAL_PREFIX = re.compile(r'^([A-Z][a-z]+[_ ][a-z]+(?:[_ ][a-z]+)?)[_|](.+)$')

# Fields interpretation may fill; anything the source itself supplied is left alone.
LEAF_ID_FIELDS = ('gene_id', 'protein_id', 'transcript_id', 'other_id')


def strip_version(identifier: Optional[str]) -> Optional[str]:
    if not identifier:
        return identifier
    match = _VERSION_SUFFIX.match(identifier)
    # Only strip a numeric suffix from a stable-ID-looking token, never from "F55A12.1".
    if match and re.search(r'\d{5,}$', match.group(1)):
        return match.group(1)
    return identifier


def classify_identifier(token: str) -> Tuple[Optional[str], Optional[str]]:
    """(identifier, kind) for the first recognisable ID in ``token``; kind may be None."""
    for pattern, kind in _ID_PATTERNS:
        match = pattern.search(token or '')
        if match:
            found_kind = kind or _KIND_LETTERS.get(match.group(2))
            return match.group(1), found_kind
    return None, None


def normalise_species_token(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    token = token.strip().strip('_|.:- ')
    # "Homo_sapiens.GRCh38.pep.all" -> "Homo_sapiens"
    if '.' in token:
        token = token.split('.', 1)[0]
    token = re.sub(r'[_\s]+', ' ', token).strip()
    return token or None


def interpret_leaf_label(label: str, pattern: Optional[str] = None) -> Dict[str, Optional[str]]:
    """Split a leaf label into ``species`` and ``id`` (plus the id's ``kind``)."""
    label = (label or '').strip()
    if pattern:
        try:
            match = re.search(pattern, label)
        except re.error:
            match = None
        if match:
            groups = match.groupdict()
            identifier = groups.get('id') or (match.group(1) if match.groups() and 'id' not in groups else None)
            _, kind = classify_identifier(identifier or '')
            return {'species': normalise_species_token(groups.get('species')), 'id': identifier or None, 'kind': kind}
        return {'species': None, 'id': label or None, 'kind': None}
    identifier, kind = classify_identifier(label)
    if identifier:
        start = label.find(identifier)
        before = label[:start].strip('_|.: ')
        after = label[start + len(identifier):].strip('_|.: ')
        species_part = before or after
        if '|' in label and not before:
            species_part = after
        return {'species': normalise_species_token(species_part) if species_part else None, 'id': identifier, 'kind': kind}
    match = _BINOMIAL_PREFIX.match(label)
    if match:
        return {'species': normalise_species_token(match.group(1)), 'id': match.group(2), 'kind': None}
    return {'species': None, 'id': label or None, 'kind': None}


def interpret_leaves(nodes: List[Dict[str, Any]], pattern: Optional[str] = None) -> None:
    """Fill each leaf's species and ID fields from its label, where the source left them empty."""
    for node in nodes:
        leaf = node.get('leaf')
        if not leaf:
            continue
        for key in leaf.pop('derived', []) or []:
            leaf[key] = None
        derived = []
        has_source_id = any(leaf.get(k) for k in ('gene_id', 'protein_id', 'transcript_id'))
        parsed = interpret_leaf_label(leaf.get('label') or '', pattern)
        if not leaf.get('species') and parsed['species']:
            leaf['species'] = parsed['species']
            derived.append('species')
        if not has_source_id and parsed['id']:
            field = {'gene': 'gene_id', 'protein': 'protein_id', 'transcript': 'transcript_id'}.get(parsed['kind'] or '', 'other_id')
            leaf[field] = parsed['id']
            derived.append(field)
        leaf['derived'] = derived


def tree_stats(nodes: List[Dict[str, Any]]) -> Dict[str, Any]:
    stats = {'genes': 0, 'species': 0, 'speciation': 0, 'duplication': 0, 'dubious': 0, 'gene_split': 0,
             'internal': 0, 'has_branch_lengths': False, 'has_events': False, 'events_inferred': False}
    species = set()
    for node in nodes:
        if node.get('leaf'):
            stats['genes'] += 1
            if node['leaf'].get('species'):
                species.add(node['leaf']['species'])
        else:
            stats['internal'] += 1
            event = node.get('event')
            if event in (EVENT_SPECIATION, EVENT_DUPLICATION, EVENT_DUBIOUS, EVENT_GENE_SPLIT):
                stats[event] += 1
                stats['has_events'] = True
                if node.get('event_inferred'):
                    stats['events_inferred'] = True
        if node.get('parent', -1) >= 0 and node.get('branch_length'):
            stats['has_branch_lengths'] = True
    stats['species'] = len(species)
    return stats


def leaf_members(nodes: List[Dict[str, Any]]) -> Iterable[Dict[str, Any]]:
    for node in nodes:
        leaf = node.get('leaf')
        if leaf:
            yield {'node_id': node['id'], 'label': leaf.get('label') or '', 'species': leaf.get('species'),
                   'gene_id': strip_version(leaf.get('gene_id') or leaf.get('other_id')),
                   'protein_id': strip_version(leaf.get('protein_id')),
                   'transcript_id': strip_version(leaf.get('transcript_id')), 'symbol': leaf.get('symbol')}


def subtree(nodes: List[Dict[str, Any]], root_id: int) -> List[Dict[str, Any]]:
    """The subtree under ``root_id``, renumbered so its root is node 0."""
    order: List[int] = []
    stack = [root_id]
    while stack:
        node_id = stack.pop()
        order.append(node_id)
        stack.extend(reversed(nodes[node_id]['children']))
    remap = {old: new for new, old in enumerate(order)}
    out = []
    for old in order:
        node = dict(nodes[old])
        node['id'] = remap[old]
        node['parent'] = remap.get(node['parent'], -1) if old != root_id else -1
        node['children'] = [remap[c] for c in nodes[old]['children']]
        if old == root_id:
            node['branch_length'] = None
        out.append(node)
    return out


_NEEDS_QUOTES = re.compile(r"[\s(),:;\[\]']")


def _newick_label(text: Optional[str]) -> str:
    if not text:
        return ''
    if _NEEDS_QUOTES.search(text):
        return "'" + text.replace("'", "''") + "'"
    return text


def _nhx_comment(node: Dict[str, Any]) -> str:
    tags = []
    event = node.get('event')
    if node.get('children'):
        if event == EVENT_DUPLICATION:
            tags.append('D=Y')
        elif event == EVENT_DUBIOUS:
            tags += ['D=Y', 'DD=Y']
        elif event in (EVENT_SPECIATION, EVENT_GENE_SPLIT):
            tags.append('D=N')
        if event == EVENT_GENE_SPLIT:
            tags.append('E=gene_split')
        taxon = node.get('taxon') or {}
        if taxon.get('name'):
            tags.append('S=' + re.sub(r'[\s:=\[\]]+', '_', taxon['name']))
        if taxon.get('id'):
            tags.append(f"T={taxon['id']}")
        if node.get('support') is not None:
            tags.append(f"B={node['support']:g}")
    else:
        leaf = node.get('leaf') or {}
        if leaf.get('species'):
            tags.append('S=' + re.sub(r'[\s:=\[\]]+', '_', leaf['species']))
        if leaf.get('taxid'):
            tags.append(f"T={leaf['taxid']}")
        if leaf.get('gene_id'):
            tags.append(f"G={leaf['gene_id']}")
    return '[&&NHX:' + ':'.join(tags) + ']' if tags else ''


def to_newick(nodes: List[Dict[str, Any]], root_id: int = 0, nhx: bool = False) -> str:
    """Iterative Newick (or NHX) writer for the tree under ``root_id``."""
    parts: List[str] = []
    # (node_id, stage): stage 0 = open, 1 = close
    stack: List[Tuple[int, int, int]] = [(root_id, 0, 0)]
    while stack:
        node_id, stage, index = stack.pop()
        node = nodes[node_id]
        children = node['children']
        if stage == 0 and children:
            parts.append('(')
            stack.append((node_id, 1, 0))
            stack.append((children[0], 0, 0))
            continue
        if stage == 1 and index + 1 < len(children):
            parts.append(',')
            stack.append((node_id, 1, index + 1))
            stack.append((children[index + 1], 0, 0))
            continue
        if stage == 1:
            parts.append(')')
        leaf = node.get('leaf')
        parts.append(_newick_label(leaf.get('label') if leaf else (node.get('taxon') or {}).get('name') if not nhx else None))
        if node_id != root_id and node.get('branch_length') is not None:
            parts.append(f":{node['branch_length']:g}")
        if nhx:
            parts.append(_nhx_comment(node))
    return ''.join(parts) + ';'
