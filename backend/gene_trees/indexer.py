"""Turning a tree source into index records, and a record back into a tree.

Indexing reads the source once, a tree at a time, and stores for each tree its
original text (compressed) and the identifiers of its leaves. It deliberately does
as little else as it can: an EMF block's leaves are all in its ``SEQ`` lines, so a
Compara release is indexed without parsing a single Newick string. Parsing, label
interpretation and taxon naming happen in :func:`materialize`, when a tree is
opened — one tree, not fifty thousand.
"""
from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

from . import model, taxonomy
from .parsers import (ParsedTree, SourceReader, TreeParseError, attach_members, detect_format, parse_ensembl_json,
                      parse_newick, stream_emf_blocks, stream_newick_texts, tree_files_in, tree_name_for_file)

ProgressFn = Callable[[Dict[str, Any]], None]


def _text_stats(text: str, members: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Counts read off NHX text without parsing it (exact counts come when the tree is opened)."""
    duplications = text.count('D=Y')
    dubious = text.count('DD=Y')
    internal = text.count(')')
    return {'genes': len(members), 'species': len({m.get('species') for m in members if m.get('species')}),
            'duplication': max(0, duplications - dubious), 'dubious': dubious,
            'speciation': max(0, internal - duplications), 'approximate': True}


def _emf_name(members: List[Dict[str, Any]], fallback: str) -> str:
    """Name an EMF tree after its commonest gene symbol; the dumps carry no tree IDs."""
    symbols = Counter(m['symbol'].upper() for m in members if m.get('symbol'))
    if not symbols:
        return fallback
    top = symbols.most_common(1)[0][0]
    # Human-style capitals where any leaf writes it so ("SAMD11", not zebrafish "samd11").
    forms = Counter(m['symbol'] for m in members if (m.get('symbol') or '').upper() == top)
    shown = top if top in forms else forms.most_common(1)[0][0]
    return shown if len(symbols) == 1 else f'{shown} family'


def _emf_payload(text: str, members: List[Dict[str, Any]]) -> Dict[str, Any]:
    """An EMF tree as stored: its text and each leaf's location. Species, gene and symbol are
    in the members index already, and are read back from there when the tree is opened."""
    return {'k': 'text', 'f': 'nhx' if '&&NHX' in text else 'newick', 't': text, 'emf': True,
            'loc': {m['label']: m['location'] for m in members if m.get('location')}}


def _members_from_nodes(nodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [{'label': m['label'], 'species': m['species'], 'gene_id': m['gene_id'], 'protein_id': m['protein_id'],
             'transcript_id': m['transcript_id'], 'symbol': m['symbol']} for m in model.leaf_members(nodes)]


def _newick_record(text: str, name: str, pattern: Optional[str]) -> Dict[str, Any]:
    trees = parse_newick(text, name)
    tree = trees[0]
    model.interpret_leaves(tree.nodes, pattern)
    stats = model.tree_stats(tree.nodes)
    return {'name': name, 'stats': stats, 'members': _members_from_nodes(tree.nodes),
            'payload': {'k': 'text', 'f': tree.source_format, 't': text.strip()}}


def _json_records(trees: List[ParsedTree]) -> Iterable[Dict[str, Any]]:
    for tree in trees:
        model.interpret_leaves(tree.nodes)
        stats = model.tree_stats(tree.nodes)
        payload = {'k': 'nodes', 'nodes': tree.nodes, 'rooted': tree.rooted, 'f': 'ensembl_json'}
        if tree.sequences:
            payload['seqs'] = {str(k): v for k, v in tree.sequences.items()}
        yield {'name': tree.name, 'external_id': tree.external_id, 'tree_id': tree.external_id or None,
               'stats': stats, 'members': _members_from_nodes(tree.nodes), 'payload': payload}


class Progress:
    """Throttled progress reports: bytes of the source read, trees and leaves indexed."""

    def __init__(self, report: Optional[ProgressFn], total_bytes: int, cancelled: Optional[Callable[[], bool]]):
        self.report = report
        self.total = total_bytes
        self.done_before = 0
        self.cancelled = cancelled
        self.trees = 0
        self.leaves = 0
        self.started = time.time()
        self._last = 0.0
        self._samples: List[tuple] = []

    def tick(self, position: int, leaves: int, force: bool = False) -> None:
        self.trees += 1
        self.leaves += leaves
        if self.cancelled and self.cancelled():
            raise InterruptedError('Import cancelled')
        now = time.time()
        if self.report and (force or now - self._last > 0.4):
            self._last = now
            self.emit(self.done_before + position)

    def emit(self, done: int, phase: str = 'indexing') -> None:
        if not self.report:
            return
        now = time.time()
        elapsed = now - self.started
        fraction = min(1.0, done / self.total) if self.total else None
        # From the last half minute's rate, not the average since the start: writing slows as
        # the index grows, so an all-time average promises too early a finish.
        self._samples.append((now, done))
        self._samples = [s for s in self._samples if now - s[0] <= 30] or [(now, done)]
        span = now - self._samples[0][0]
        rate = (done - self._samples[0][1]) / span if span >= 3 else (done / elapsed if elapsed else 0)
        eta = (self.total - done) / rate if rate > 0 and fraction and fraction > 0.02 else None
        self.report({'phase': phase, 'bytes_done': done, 'bytes_total': self.total, 'fraction': fraction,
                     'trees': self.trees, 'leaves': self.leaves, 'elapsed': elapsed, 'eta': eta})


def index_path(path: Path, fmt: str, pattern: Optional[str], add: Callable[[Dict[str, Any]], Any],
               report: Optional[ProgressFn] = None, cancelled: Optional[Callable[[], bool]] = None) -> str:
    """Index a file or a folder of tree files, calling ``add`` per tree. Returns the format read."""
    files = tree_files_in(path) if path.is_dir() else [path]
    if path.is_dir() and not files:
        raise TreeParseError('The folder has no tree files (.nwk, .newick, .nh, .nhx, .tree, .txt, .emf, .json)')
    total = sum(f.stat().st_size for f in files)
    progress = Progress(report, total, cancelled)
    progress.emit(0, 'starting')
    detected_formats = []
    for file in files:
        with SourceReader(file) as reader:
            head = reader.peek()
            detected = detect_format(head) if fmt in ('', 'auto', None) else fmt
            detected_formats.append(detected)
            base = tree_name_for_file(file)
            if detected == 'emf':
                for n, (members, text, name) in enumerate(stream_emf_blocks(reader.text), start=1):
                    stats = _text_stats(text, members)
                    add({'name': name or _emf_name(members, f'{base} {n}'), 'stats': stats, 'members': members,
                         'payload': _emf_payload(text, members)})
                    progress.tick(reader.position(), len(members))
            elif detected == 'ensembl_json':
                try:
                    document = json.loads(reader.text.read())
                except json.JSONDecodeError as exc:
                    raise TreeParseError(f'Invalid JSON: {exc}') from exc
                for record in _json_records(parse_ensembl_json(document, base)):
                    add(record)
                    progress.tick(reader.position(), len(record['members']))
            else:
                single = len(files) > 1
                for n, text in enumerate(stream_newick_texts(reader.text), start=1):
                    name = base if single or n == 1 else f'{base} {n}'
                    record = _newick_record(text, name, pattern)
                    add(record)
                    progress.tick(reader.position(), len(record['members']))
            progress.done_before += file.stat().st_size
    progress.emit(total, 'finishing')
    if not progress.trees:
        raise TreeParseError('No trees were found')
    return detected_formats[0] if len(set(detected_formats)) == 1 else 'mixed'


def index_text(text: str, name: str, fmt: str, pattern: Optional[str], add: Callable[[Dict[str, Any]], Any]) -> str:
    """Index pasted text (small by construction), through the same records as a file."""
    import io
    detected = detect_format(text) if fmt in ('', 'auto', None) else fmt
    count = 0
    if detected == 'emf':
        for n, (members, block, block_name) in enumerate(stream_emf_blocks(io.StringIO(text)), start=1):
            add({'name': block_name or _emf_name(members, f'{name} {n}'), 'stats': _text_stats(block, members),
                 'members': members, 'payload': _emf_payload(block, members)})
            count += 1
    elif detected == 'ensembl_json':
        try:
            document = json.loads(text)
        except json.JSONDecodeError as exc:
            raise TreeParseError(f'Invalid JSON: {exc}') from exc
        for record in _json_records(parse_ensembl_json(document, name)):
            add(record)
            count += 1
    else:
        texts = list(stream_newick_texts(io.StringIO(text)))
        for n, tree_text in enumerate(texts, start=1):
            add(_newick_record(tree_text, name if len(texts) == 1 else f'{name} {n}', pattern))
            count += 1
    if not count:
        raise TreeParseError('No tree found')
    return detected


def materialize(record: Dict[str, Any], pattern: Optional[str]) -> Dict[str, Any]:
    """A stored tree as the view needs it: nodes with leaf details, taxa and events filled in."""
    payload = record['payload']
    sequences = None
    if payload.get('k') == 'nodes':
        nodes = payload['nodes']
        rooted, fmt = payload.get('rooted', True), payload.get('f', 'ensembl_json')
        sequences = payload.get('seqs')
    else:
        tree = parse_newick(payload['t'], record.get('name') or 'tree')[0]
        if payload.get('emf'):
            locations = payload.get('loc') or {}
            attach_members(tree, [{**m, 'protein_id': m.get('protein_id') or m['label'], 'location': locations.get(m['label'])}
                                  for m in record.get('members') or []])
        nodes, rooted, fmt = tree.nodes, tree.rooted, payload.get('f', tree.source_format)
    model.interpret_leaves(nodes, pattern)
    taxonomy.annotate(nodes)
    return {'name': record.get('name'), 'external_id': record.get('external_id') or '', 'rooted': rooted, 'format': fmt,
            'nodes': nodes, 'stats': model.tree_stats(nodes), 'has_sequences': bool(sequences)}


def members_for_pattern(record_payload: Dict[str, Any], pattern: Optional[str]) -> Optional[List[Dict[str, Any]]]:
    """Leaves re-read with a new label pattern, or None when the source named them itself."""
    if record_payload.get('k') != 'text' or record_payload.get('emf'):
        return None
    tree = parse_newick(record_payload['t'])[0]
    model.interpret_leaves(tree.nodes, pattern)
    return _members_from_nodes(tree.nodes)
