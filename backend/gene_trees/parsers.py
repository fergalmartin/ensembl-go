"""Readers for gene-tree files.

Every reader returns :class:`ParsedTree` objects in one flat shape, so the rest of
the package never cares whether a tree arrived as Newick, NHX, an Ensembl REST
JSON document or an EMF dump. Nodes are a list indexed by ``id``; the root is
always node 0. Nothing here recurses: Compara and OrthoFinder trees can be
thousands of nodes deep on a caterpillar-shaped branch, well past Python's stack.
"""
from __future__ import annotations

import gzip
import io
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

EVENT_SPECIATION = 'speciation'
EVENT_DUPLICATION = 'duplication'
EVENT_DUBIOUS = 'dubious'
EVENT_GENE_SPLIT = 'gene_split'
EVENTS = (EVENT_SPECIATION, EVENT_DUPLICATION, EVENT_DUBIOUS, EVENT_GENE_SPLIT)

TREE_FILE_SUFFIXES = ('.nwk', '.newick', '.nh', '.nhx', '.tree', '.tre', '.treefile', '.txt', '.emf', '.json')

FORMAT_LABELS = {
    'newick': 'Newick',
    'nhx': 'NHX (Ensembl Compara)',
    'ensembl_json': 'Ensembl gene tree JSON',
    'emf': 'Ensembl EMF gene trees',
}


class TreeParseError(ValueError):
    pass


@dataclass
class ParsedTree:
    name: str
    nodes: List[Dict[str, Any]]
    rooted: bool = True
    source_format: str = 'newick'
    external_id: str = ''
    # Leaf node id -> sequence, when the source carried them (Ensembl JSON).
    sequences: Dict[int, Dict[str, Any]] = field(default_factory=dict)


def new_node(nodes: List[Dict[str, Any]], parent: int) -> int:
    node_id = len(nodes)
    nodes.append({
        'id': node_id, 'parent': parent, 'children': [], 'name': None,
        'branch_length': None, 'support': None, 'event': None, 'taxon': None, 'leaf': None,
    })
    if parent >= 0:
        nodes[parent]['children'].append(node_id)
    return node_id


# ── Newick / NHX ──────────────────────────────────────────────────────────────

_NUMBER = re.compile(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')
_LABEL_STOP = set('(),:;[')


def _parse_number(text: str) -> Optional[float]:
    match = _NUMBER.fullmatch(text.strip())
    return float(match.group(0)) if match else None


def parse_nhx_tags(comment: str) -> Dict[str, str]:
    """``&&NHX:D=N:S=Homininae:T=207598`` -> ``{'D': 'N', 'S': 'Homininae', 'T': '207598'}``."""
    body = comment[5:] if comment.startswith('&&NHX') else comment.lstrip('&')
    tags: Dict[str, str] = {}
    for part in re.split(r'[:,]', body):
        if '=' in part:
            key, value = part.split('=', 1)
            key = key.strip()
            if key:
                tags[key] = value.strip().strip('"')
    return tags


def _apply_nhx(node: Dict[str, Any], tags: Dict[str, str]) -> None:
    node.setdefault('nhx', {}).update(tags)
    duplication = tags.get('D', '').upper()
    if tags.get('DD', '').upper() in ('Y', 'T', 'TRUE'):
        node['event'] = EVENT_DUBIOUS
    elif duplication in ('Y', 'T', 'TRUE'):
        node['event'] = EVENT_DUPLICATION
    elif duplication in ('N', 'F', 'FALSE'):
        node['event'] = EVENT_SPECIATION
    if 'split' in tags.get('E', '').lower():
        node['event'] = EVENT_GENE_SPLIT
    support = tags.get('B')
    if support is not None and _parse_number(support) is not None:
        node['support'] = _parse_number(support)


def parse_newick(text: str, default_name: str = 'tree') -> List[ParsedTree]:
    """Every tree in ``text``. Files with one tree per line (or per ``;``) are common."""
    trees: List[ParsedTree] = []
    i, n = 0, len(text)
    while i < n:
        while i < n and text[i].isspace():
            i += 1
        if i >= n:
            break
        nodes: List[Dict[str, Any]] = []
        current = new_node(nodes, -1)
        has_nhx = False
        ended = False
        while i < n:
            ch = text[i]
            if ch.isspace():
                i += 1
            elif ch == '(':
                current = new_node(nodes, current)
                i += 1
            elif ch == ',':
                parent = nodes[current]['parent']
                if parent < 0:
                    raise TreeParseError(f'Unexpected "," at character {i + 1}')
                current = new_node(nodes, parent)
                i += 1
            elif ch == ')':
                parent = nodes[current]['parent']
                if parent < 0:
                    raise TreeParseError(f'Unbalanced ")" at character {i + 1}')
                current = parent
                i += 1
            elif ch == ':':
                i += 1
                start = i
                while i < n and text[i] not in _LABEL_STOP and not text[i].isspace():
                    i += 1
                value = _parse_number(text[start:i])
                if value is None and text[start:i].strip():
                    raise TreeParseError(f'Bad branch length "{text[start:i]}" at character {start + 1}')
                nodes[current]['branch_length'] = value
            elif ch == '[':
                end = text.find(']', i)
                if end < 0:
                    raise TreeParseError(f'Unclosed comment at character {i + 1}')
                comment = text[i + 1:end]
                if comment.startswith('&'):
                    has_nhx = has_nhx or comment.startswith('&&NHX')
                    _apply_nhx(nodes[current], parse_nhx_tags(comment))
                i = end + 1
            elif ch == ';':
                i += 1
                ended = True
                break
            elif ch == "'" or ch == '"':
                quote = ch
                i += 1
                label = []
                while i < n:
                    if text[i] == quote:
                        if i + 1 < n and text[i + 1] == quote:
                            label.append(quote)
                            i += 2
                            continue
                        break
                    label.append(text[i])
                    i += 1
                if i >= n:
                    raise TreeParseError('Unclosed quoted label')
                i += 1
                nodes[current]['name'] = ''.join(label)
            else:
                start = i
                while i < n and text[i] not in _LABEL_STOP and not text[i].isspace():
                    i += 1
                nodes[current]['name'] = text[start:i]
        if not ended and len(nodes) == 1 and not nodes[0]['name']:
            break
        if nodes[0]['parent'] != -1:
            raise TreeParseError('Tree has no root')
        # A dangling "(" leaves `current` inside the tree; a complete tree returns to the root.
        if current != 0:
            raise TreeParseError('Unbalanced parentheses: a "(" is never closed')
        _finish_newick_nodes(nodes)
        name = default_name if not trees else f'{default_name} {len(trees) + 1}'
        trees.append(ParsedTree(name=name, nodes=nodes, source_format='nhx' if has_nhx else 'newick',
                                rooted=len(nodes[0]['children']) != 3))
    if len(trees) > 1:
        # Name the first one to match its siblings.
        trees[0].name = f'{default_name} 1'
    if not trees:
        raise TreeParseError('No tree found')
    return trees


def _finish_newick_nodes(nodes: List[Dict[str, Any]]) -> None:
    for node in nodes:
        name = node['name']
        tags = node.get('nhx') or {}
        if node['children']:
            # Internal labels are either support values or clade names.
            if name is not None:
                value = _parse_number(name.split('/')[-1]) if name else None
                if value is not None and node['support'] is None:
                    node['support'] = value
                    node['name'] = None
            taxon_name = tags.get('S')
            taxid = _int_or_none(tags.get('T'))
            if taxon_name or taxid or (node['name'] and not re.fullmatch(r'n\d+', node['name'])):
                node['taxon'] = {'id': taxid, 'name': (taxon_name or node['name'] or '').replace('_', ' ') or None,
                                 'common_name': None, 'mya': None}
        else:
            node['leaf'] = {
                'label': name or '',
                'species': (tags.get('S') or '').replace('_', ' ') or None,
                'taxid': _int_or_none(tags.get('T')),
                'gene_id': tags.get('G') or None,
                'protein_id': tags.get('PR') or None,
                'transcript_id': tags.get('TR') or None,
                'symbol': tags.get('GN') or None,
                'location': None,
            }


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


# ── Ensembl REST JSON ─────────────────────────────────────────────────────────

_JSON_EVENTS = {'speciation': EVENT_SPECIATION, 'duplication': EVENT_DUPLICATION,
                'dubious': EVENT_DUBIOUS, 'gene_split': EVENT_GENE_SPLIT}


def parse_ensembl_json(document: Any, default_name: str = 'tree') -> List[ParsedTree]:
    documents = document if isinstance(document, list) else [document]
    trees = []
    for doc in documents:
        if not isinstance(doc, dict):
            raise TreeParseError('Not an Ensembl gene tree document')
        root = doc.get('tree') if isinstance(doc.get('tree'), dict) else doc
        if 'children' not in root and 'taxonomy' not in root:
            raise TreeParseError('The JSON has no "tree" object')
        nodes: List[Dict[str, Any]] = []
        sequences: Dict[int, Dict[str, Any]] = {}
        stack: List[Tuple[Dict[str, Any], int]] = [(root, -1)]
        while stack:
            source, parent = stack.pop()
            node_id = new_node(nodes, parent)
            node = nodes[node_id]
            node['branch_length'] = source.get('branch_length')
            taxonomy = source.get('taxonomy') or {}
            confidence = source.get('confidence') or {}
            if isinstance(confidence, dict) and confidence.get('bootstrap') is not None:
                node['support'] = confidence.get('bootstrap')
            children = source.get('children') or []
            if children:
                node['event'] = _JSON_EVENTS.get(str((source.get('events') or {}).get('type') or '').lower())
                if taxonomy:
                    node['taxon'] = {'id': taxonomy.get('id'), 'name': taxonomy.get('scientific_name'),
                                     'common_name': taxonomy.get('common_name'), 'mya': taxonomy.get('timetree_mya')}
                # Reversed so the first child is popped (and numbered) first.
                for child in reversed(children):
                    stack.append((child, node_id))
                continue
            sequence = source.get('sequence') or {}
            seq_ids = sequence.get('id') or []
            protein_id = seq_ids[0].get('accession') if seq_ids and isinstance(seq_ids[0], dict) else None
            gene_id = (source.get('id') or {}).get('accession')
            display = sequence.get('name') or ''
            symbol = re.sub(r'-\d+$', '', display) if display else None
            node['leaf'] = {
                'label': gene_id or protein_id or display or '',
                'species': taxonomy.get('scientific_name'),
                'common_name': taxonomy.get('common_name'),
                'taxid': taxonomy.get('id'),
                'gene_id': gene_id,
                'protein_id': protein_id,
                'transcript_id': None,
                'symbol': symbol if symbol and not symbol.startswith(('ENS', 'MGP_')) else None,
                'transcript_name': display or None,
                'location': sequence.get('location'),
            }
            mol_seq = sequence.get('mol_seq')
            if isinstance(mol_seq, dict) and mol_seq.get('seq'):
                sequences[node_id] = {'seq': mol_seq['seq'], 'aligned': bool(mol_seq.get('is_aligned')),
                                      'cigar': mol_seq.get('cigar_line')}
        # Stack order gives parents before children, but children lists were appended in
        # pop order; that already matches the source order because of the reversal above.
        tree_id = str(doc.get('id') or '')
        trees.append(ParsedTree(name=tree_id or default_name, nodes=nodes, rooted=bool(doc.get('rooted', 1)),
                                source_format='ensembl_json', external_id=tree_id, sequences=sequences))
    return trees


# ── EMF (Ensembl Compara flat-file dumps) ─────────────────────────────────────

def parse_emf(text: str, default_name: str = 'tree') -> List[ParsedTree]:
    """``SEQ species id chr start end strand gene_id label`` lines, ``DATA``, the tree, ``//``."""
    trees: List[ParsedTree] = []
    seqs: Dict[str, Dict[str, Any]] = {}
    data: List[str] = []
    in_data = False
    tree_name = ''
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith('#'):
            continue
        if line == '//':
            if data:
                for tree in parse_newick('\n'.join(data), tree_name or f'{default_name} {len(trees) + 1}'):
                    _attach_emf_members(tree, seqs)
                    tree.source_format = 'emf'
                    trees.append(tree)
            seqs, data, in_data, tree_name = {}, [], False, ''
            continue
        if in_data:
            data.append(line)
        elif line.startswith('SEQ '):
            parts = line.split()
            if len(parts) >= 3:
                member = {'species': parts[1].replace('_', ' ').capitalize(), 'id': parts[2]}
                if len(parts) >= 7:
                    member['location'] = f'{parts[3]}:{parts[4]}-{parts[5]}'
                if len(parts) >= 8 and parts[7] not in ('NULL', 'NA'):
                    member['gene_id'] = parts[7]
                if len(parts) >= 9 and parts[8] not in ('NULL', 'NA'):
                    member['symbol'] = parts[8]
                seqs[parts[2]] = member
        elif line.startswith('ID ') or line.startswith('TREE '):
            tree_name = line.split(None, 1)[1].strip()
        elif line == 'DATA':
            in_data = True
    if data:
        for tree in parse_newick('\n'.join(data), tree_name or default_name):
            _attach_emf_members(tree, seqs)
            tree.source_format = 'emf'
            trees.append(tree)
    if not trees:
        raise TreeParseError('No DATA sections found in the EMF file')
    return trees


def _attach_emf_members(tree: ParsedTree, seqs: Dict[str, Dict[str, Any]]) -> None:
    for node in tree.nodes:
        leaf = node.get('leaf')
        if not leaf:
            continue
        member = seqs.get(leaf['label'])
        if not member:
            continue
        leaf['species'] = leaf.get('species') or member['species']
        leaf['protein_id'] = leaf.get('protein_id') or member['id']
        leaf['gene_id'] = leaf.get('gene_id') or member.get('gene_id')
        leaf['symbol'] = leaf.get('symbol') or member.get('symbol')
        leaf['location'] = member.get('location')


# ── Dispatch ──────────────────────────────────────────────────────────────────

def detect_format(text: str) -> str:
    head = text.lstrip()[:4096]
    if head.startswith('{') or head.startswith('['):
        return 'ensembl_json'
    if head.startswith('<'):
        raise TreeParseError('PhyloXML is not supported yet; export the tree as Newick or NHX')
    if re.search(r'^SEQ\s', text[:200000], re.M) and re.search(r'^DATA\s*$', text[:2000000], re.M):
        return 'emf'
    if '&&NHX' in head or '&&NHX' in text[:200000]:
        return 'nhx'
    return 'newick'


def parse_text(text: str, name: str = 'tree', fmt: str = 'auto') -> Tuple[str, List[ParsedTree]]:
    fmt = detect_format(text) if fmt in ('', 'auto', None) else fmt
    if fmt == 'ensembl_json':
        try:
            document = json.loads(text)
        except json.JSONDecodeError as exc:
            raise TreeParseError(f'Invalid JSON: {exc}') from exc
        return fmt, parse_ensembl_json(document, name)
    if fmt == 'emf':
        return fmt, parse_emf(text, name)
    if fmt in ('newick', 'nhx'):
        trees = parse_newick(text, name)
        return ('nhx' if any(t.source_format == 'nhx' for t in trees) else 'newick'), trees
    raise TreeParseError(f'Unknown tree format "{fmt}"')


def tree_files_in(directory: Path) -> List[Path]:
    """Tree files in a directory such as OrthoFinder's ``Gene_Trees/``, in name order."""
    return sorted(p for p in directory.iterdir()
                  if p.is_file() and not p.name.startswith('.') and p.suffix.lower() in TREE_FILE_SUFFIXES)


def tree_name_for_file(path: Path) -> str:
    stem = path.name
    for suffix in ('.gz',) + TREE_FILE_SUFFIXES:
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
    return re.sub(r'_tree$', '', stem) or path.name


def read_tree_file(path: Path) -> str:
    if path.name.endswith('.gz'):
        import gzip
        with gzip.open(path, 'rt', encoding='utf-8', errors='replace') as handle:
            return handle.read()
    return path.read_text(encoding='utf-8', errors='replace')


def iter_source_trees(path: Path, fmt: str = 'auto') -> Iterable[Tuple[str, ParsedTree]]:
    """Every tree under ``path`` (a file or a directory of files), with the format each came in."""
    files = tree_files_in(path) if path.is_dir() else [path]
    if path.is_dir() and not files:
        raise TreeParseError('The folder has no tree files (.nwk, .newick, .nh, .nhx, .tree, .txt, .emf, .json)')
    for file in files:
        detected, trees = parse_text(read_tree_file(file), tree_name_for_file(file), fmt)
        for tree in trees:
            yield detected, tree


# ── Streaming, for files too big to hold ──────────────────────────────────────
#
# A whole Compara release is 54,000 trees and 1.5 GB of text once unzipped. These
# read it one tree at a time and report how far through the file they are, in the
# bytes of the file on disk (compressed bytes, for a .gz), which is the only honest
# measure of progress before the end is reached.

class SourceReader:
    """A text stream over a tree file, plain or gzip, that knows how far it has got."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.total = os.path.getsize(self.path)
        self._raw = open(self.path, 'rb')
        magic = self._raw.read(2)
        self._raw.seek(0)
        self.compressed = magic == b'\x1f\x8b'
        stream = gzip.GzipFile(fileobj=self._raw) if self.compressed else self._raw
        self.text = io.TextIOWrapper(stream, encoding='utf-8', errors='replace', newline=None)

    def position(self) -> int:
        try:
            return self._raw.tell()
        except (OSError, ValueError):
            return 0

    def peek(self, size: int = 262144) -> str:
        """The start of the file, without disturbing the stream."""
        opener = gzip.open if self.compressed else open
        with opener(self.path, 'rt', encoding='utf-8', errors='replace') as handle:
            return handle.read(size)

    def close(self) -> None:
        try:
            self.text.close()
        finally:
            self._raw.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


_SPECIALS = re.compile(r"[;\[\]'\"]")


def stream_newick_texts(text) -> Iterable[str]:
    """Each tree's text in a multi-tree Newick/NHX stream, split at the ``;`` that ends it."""
    buffer: List[str] = []
    in_comment = False
    quote = ''
    while True:
        chunk = text.read(1 << 20)
        if not chunk:
            break
        start = 0
        for match in _SPECIALS.finditer(chunk):
            ch = match.group(0)
            if quote:
                if ch == quote:
                    quote = ''
            elif in_comment:
                if ch == ']':
                    in_comment = False
            elif ch == '[':
                in_comment = True
            elif ch in ('"', "'"):
                quote = ch
            elif ch == ';':
                buffer.append(chunk[start:match.end()])
                tree = ''.join(buffer).strip()
                buffer = []
                start = match.end()
                if tree and tree != ';':
                    yield tree
        buffer.append(chunk[start:])
    tail = ''.join(buffer).strip()
    if tail:
        yield tail


def stream_emf_blocks(text) -> Iterable[Tuple[List[Dict[str, Any]], str, str]]:
    """(members from the SEQ lines, the tree text, the tree's name if given) per EMF block."""
    seqs: List[Dict[str, Any]] = []
    data: List[str] = []
    in_data = False
    name = ''
    for raw in text:
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line == '//':
            if data:
                yield seqs, '\n'.join(data), name
            seqs, data, in_data, name = [], [], False, ''
        elif in_data:
            data.append(line)
        elif line.startswith('SEQ '):
            member = emf_member(line)
            if member:
                seqs.append(member)
        elif line == 'DATA':
            in_data = True
        elif line.startswith('ID ') or line.startswith('TREE '):
            name = line.split(None, 1)[1].strip()
    if data:
        yield seqs, '\n'.join(data), name


def emf_member(line: str) -> Optional[Dict[str, Any]]:
    """``SEQ species id region start end strand gene_id label`` -> a leaf's details."""
    parts = line.split()
    if len(parts) < 3:
        return None
    member = {'label': parts[2], 'species': parts[1].replace('_', ' ').capitalize(), 'protein_id': parts[2]}
    if len(parts) >= 7:
        member['location'] = f'{parts[3]}:{parts[4]}-{parts[5]}'
    if len(parts) >= 8 and parts[7] not in ('NULL', 'NA'):
        member['gene_id'] = parts[7]
    if len(parts) >= 9 and parts[8] not in ('NULL', 'NA'):
        member['symbol'] = parts[8]
    return member


def attach_members(tree: ParsedTree, members: List[Dict[str, Any]]) -> None:
    """Give an EMF tree's leaves the details its SEQ lines carried."""
    by_label = {m['label']: m for m in members}
    for node in tree.nodes:
        leaf = node.get('leaf')
        member = by_label.get(leaf['label']) if leaf else None
        if not member:
            continue
        leaf['species'] = leaf.get('species') or member['species']
        leaf['protein_id'] = leaf.get('protein_id') or member['protein_id']
        leaf['gene_id'] = leaf.get('gene_id') or member.get('gene_id')
        leaf['symbol'] = leaf.get('symbol') or member.get('symbol')
        leaf['location'] = member.get('location')
