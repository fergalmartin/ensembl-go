"""HTTP routes for the Gene Trees view, under ``/api/gene-trees``.

Built like the Alignment Explorer's router: a factory handed what it needs from the
application (where the library lives, which genomes are local) so this package
never imports ``main``.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from . import model
from .indexer import index_path, index_text, materialize, members_for_pattern
from .linking import Linker
from .neighbourhood import Neighbourhoods
from .parsers import FORMAT_LABELS, TreeParseError
from .store import GeneTreeStore

MAX_INLINE_BYTES = 50 * 1024 * 1024
MAX_NEIGHBOURHOOD_GENES = 500
MAX_WORKSPACE_BYTES = 10 * 1024 * 1024
LEGACY_FILENAME = 'gene_trees.sqlite'


class ImportRequest(BaseModel):
    path: Optional[str] = None
    content: Optional[str] = None
    name: Optional[str] = None
    format: str = 'auto'
    description: str = ''
    method: str = ''
    tags: List[str] = Field(default_factory=list)
    label_pattern: Optional[str] = None


class CollectionUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    method: Optional[str] = None
    tags: Optional[List[str]] = None


class MappingUpdate(BaseModel):
    label_pattern: Optional[str] = None
    species_map: Optional[Dict[str, str]] = None


class LinksUpdate(BaseModel):
    entries: List[Dict[str, Any]] = Field(default_factory=list)
    content: Optional[str] = None
    replace: bool = False


def _check_pattern(pattern: Optional[str]) -> Optional[str]:
    if not pattern:
        return None
    try:
        re.compile(pattern)
    except re.error as exc:
        raise HTTPException(400, f'Invalid label pattern: {exc}')
    return pattern


def parse_link_table(content: str) -> List[Dict[str, str]]:
    """TSV/CSV with ``label, assembly[, gene_id]`` (a header row is optional)."""
    text = content.strip()
    if not text:
        return []
    if text.startswith('[') or text.startswith('{'):
        data = json.loads(text)
        data = data.get('entries', []) if isinstance(data, dict) else data
        return [{k: str(v) for k, v in row.items() if v is not None} for row in data if isinstance(row, dict)]
    dialect = '\t' if '\t' in text.splitlines()[0] else ','
    rows = list(csv.reader(io.StringIO(text), delimiter=dialect))
    header = [c.strip().lower() for c in rows[0]]
    if 'label' in header or 'leaf' in header:
        columns = ['label' if c == 'leaf' else c for c in header]
        rows = rows[1:]
    else:
        columns = ['label', 'assembly', 'gene_id'][:len(header)]
    return [{columns[i]: cell.strip() for i, cell in enumerate(row) if i < len(columns) and cell.strip()}
            for row in rows if row]


def legacy_library(library_path: Path) -> Optional[Path]:
    """The library file an earlier version wrote beside this one, if it is still there."""
    legacy = library_path.parent / LEGACY_FILENAME
    if legacy == library_path or not legacy.exists():
        return None
    try:
        conn = sqlite3.connect(f'file:{legacy}?mode=ro', uri=True)
        try:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(trees)')}
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    return legacy if 'tree' in columns else None


def create_router(library_path_provider: Callable[[], Path], genomes_provider: Callable[[], List[Dict[str, Any]]],
                  cache_dir: Path, neighbourhood_lookup: Optional[Callable[..., Any]] = None) -> APIRouter:
    router = APIRouter(prefix='/api/gene-trees', tags=['Gene Trees'])
    linker = Linker(genomes_provider, Path(cache_dir))
    neighbourhoods = Neighbourhoods(genomes_provider, neighbourhood_lookup) if neighbourhood_lookup else None
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='gene-tree-import')
    jobs: 'OrderedDict[str, Dict[str, Any]]' = OrderedDict()
    lock = threading.Lock()
    stores: Dict[str, GeneTreeStore] = {}
    link_cache: 'OrderedDict[tuple, Dict[str, Any]]' = OrderedDict()

    def store() -> GeneTreeStore:
        path = Path(library_path_provider())
        with lock:
            if str(path) not in stores:
                stores[str(path)] = GeneTreeStore(path)
            return stores[str(path)]

    def collection_or_404(collection_id: str) -> Dict[str, Any]:
        if not re.fullmatch(r'[a-f0-9]{32}', collection_id):
            raise HTTPException(404, 'Collection not found')
        collection = store().collection(collection_id)
        if not collection:
            raise HTTPException(404, 'Collection not found')
        return collection

    def update(job_id: str, **values: Any) -> None:
        with lock:
            jobs[job_id].update(values)

    def public(job: Dict[str, Any]) -> Dict[str, Any]:
        return {k: v for k, v in job.items() if k != 'cancel'}

    def start_import(payload: ImportRequest) -> Dict[str, Any]:
        pattern = _check_pattern(payload.label_pattern)
        source: Optional[Path] = None
        if payload.path:
            source = Path(payload.path).expanduser().resolve()
            if not source.exists():
                raise HTTPException(400, 'Choose an existing tree file or folder')
        elif payload.content is None or not payload.content.strip():
            raise HTTPException(400, 'Choose a tree file or paste a tree')
        elif len(payload.content.encode('utf-8', errors='ignore')) > MAX_INLINE_BYTES:
            raise HTTPException(413, 'The pasted tree is too large; open it as a file instead')
        default_name = (source.name if source else None) or 'Pasted tree'
        name = (payload.name or '').strip() or re.sub(r'\.gz$', '', default_name)
        name = re.sub(r'\.(nwk|newick|nhx?|tree|tre|treefile|txt|emf|json)$', '', name, flags=re.I) or default_name
        library = store()
        job_id = uuid.uuid4().hex
        with lock:
            finished = [k for k, v in jobs.items() if v['status'] in ('ready', 'failed', 'cancelled')]
            for key in finished[:-20]:
                jobs.pop(key, None)
            jobs[job_id] = {'id': job_id, 'status': 'queued', 'name': name, 'collection_id': None, 'phase': 'queued',
                            'trees': 0, 'leaves': 0, 'bytes_done': 0, 'bytes_total': 0, 'fraction': 0, 'eta': None,
                            'created': time.time(), 'cancel': False}

        def run() -> None:
            if jobs[job_id]['cancel']:
                update(job_id, status='cancelled', phase='done')
                return
            update(job_id, status='running', phase='starting')
            collection_id = None
            try:
                collection_id = library.create_collection(
                    name, str(source) if source else None, payload.format or 'auto', payload.description, payload.method,
                    payload.tags, 'file' if source else 'pasted', status='indexing')
                update(job_id, collection_id=collection_id)
                with library.writer(collection_id) as writer:
                    if source is not None:
                        fmt = index_path(source, payload.format, pattern, writer.add,
                                         report=lambda p: update(job_id, **p), cancelled=lambda: jobs[job_id]['cancel'])
                    else:
                        fmt = index_text(payload.content or '', name, payload.format, pattern, writer.add)
                    update(job_id, phase='finishing', trees=writer.trees, leaves=writer.leaves)
                library.update_collection(collection_id, format=fmt, status='ready', label_pattern=pattern)
                update(job_id, status='ready', phase='ready', fraction=1.0)
            except (TreeParseError, InterruptedError, OSError, UnicodeError, EOFError) as exc:
                cancelled = isinstance(exc, InterruptedError)
                update(job_id, phase='removing' if collection_id else 'done')
                if collection_id:
                    library.delete_collection(collection_id)
                update(job_id, status='cancelled' if cancelled else 'failed', phase='done',
                       error=None if cancelled else str(exc))
            except Exception as exc:  # pragma: no cover - surfaced to the user
                if collection_id:
                    library.delete_collection(collection_id)
                update(job_id, status='failed', phase='done', error=f'Import failed: {exc}')

        pool.submit(run)
        return {'job': job_id, 'status': 'queued'}

    @router.get('/capabilities')
    def capabilities():
        return {'formats': FORMAT_LABELS, 'directory_import': True}

    @router.get('/datasets')
    def list_collections():
        return {'collections': store().collections()}

    @router.post('/datasets')
    def import_collection(payload: ImportRequest):
        return start_import(payload)

    @router.get('/jobs')
    def list_jobs():
        with lock:
            return {'jobs': [public(j) for j in jobs.values()]}

    @router.get('/jobs/{job_id}')
    def job_status(job_id: str):
        with lock:
            job = jobs.get(job_id)
            if not job:
                raise HTTPException(404, 'Job not found')
            return public(job)

    @router.post('/jobs/{job_id}/cancel')
    def cancel_job(job_id: str):
        with lock:
            if job_id in jobs:
                jobs[job_id]['cancel'] = True
        return {'ok': True}

    @router.get('/datasets/{collection_id}')
    def get_collection(collection_id: str):
        return collection_or_404(collection_id)

    @router.patch('/datasets/{collection_id}')
    def update_collection(collection_id: str, payload: CollectionUpdate):
        collection_or_404(collection_id)
        values = {k: v for k, v in payload.model_dump().items() if v is not None}
        if 'name' in values and not str(values['name']).strip():
            raise HTTPException(400, 'A collection needs a title')
        if 'tags' in values:
            values['tags'] = [t.strip() for t in values['tags'] if t and t.strip()]
        store().update_collection(collection_id, **values)
        return store().collection(collection_id)

    @router.delete('/datasets/{collection_id}')
    def delete_collection(collection_id: str):
        collection_or_404(collection_id)
        store().delete_collection(collection_id)
        return {'ok': True}

    @router.get('/datasets/{collection_id}/trees')
    def list_trees(collection_id: str, query: str = '', offset: int = 0, limit: int = 200):
        collection_or_404(collection_id)
        return store().list_trees(collection_id, query.strip(), max(0, offset), max(1, min(limit, 1000)))

    def open_tree(collection: Dict[str, Any], tree_id: str) -> Dict[str, Any]:
        record = store().tree_record(collection['id'], tree_id)
        if not record:
            raise HTTPException(404, 'Tree not found')
        try:
            tree = materialize(record, collection.get('label_pattern'))
        except TreeParseError as exc:
            raise HTTPException(422, f'This tree could not be read: {exc}')
        tree['tree_id'] = tree_id
        return tree

    @router.get('/datasets/{collection_id}/trees/{tree_id}')
    def get_tree(collection_id: str, tree_id: str):
        collection = collection_or_404(collection_id)
        tree = open_tree(collection, tree_id)
        genomes = linker.genomes()
        signature = (collection_id, tree_id, json.dumps(collection['species_map'], sort_keys=True),
                     json.dumps(collection['links'], sort_keys=True), collection.get('label_pattern'),
                     tuple((g['assembly'], g.get('index_path')) for g in genomes))
        with lock:
            cached = link_cache.get(signature)
        if cached is None:
            cached = linker.link_tree(tree['nodes'], collection['species_map'], collection['links'])
            if not cached['pending']:
                with lock:
                    link_cache[signature] = cached
                    while len(link_cache) > 32:
                        link_cache.popitem(last=False)
        return {**tree, 'collection': {k: collection[k] for k in ('id', 'name', 'description', 'method', 'tags', 'origin', 'format')},
                'links': cached['links'], 'link_summary': cached['summary'], 'links_pending': cached['pending'],
                'local_genomes': cached['genomes']}

    @router.get('/datasets/{collection_id}/labels')
    def preview_labels(collection_id: str, pattern: Optional[str] = None):
        collection = collection_or_404(collection_id)
        stored_pattern = collection.get('label_pattern')
        pattern = _check_pattern(pattern) if pattern is not None else stored_pattern
        members = store().sample_members(collection_id, 40)
        if (pattern or None) == (stored_pattern or None):
            # What the collection reads now, including species the file itself supplied
            # (NHX tags, Ensembl JSON, EMF), which a label alone would not show.
            samples = [{'label': m['label'], 'species': m['species'], 'id': m['id'],
                        'kind': model.classify_identifier(m['id'] or '')[1]} for m in members]
        else:
            samples = [{'label': m['label'], **model.interpret_leaf_label(m['label'], pattern)} for m in members]
        return {
            'pattern': pattern,
            'samples': samples,
            'species': store().species_tokens(collection_id),
            'species_map': collection['species_map'],
            'genomes': [{'assembly': g['assembly'], 'species_key': g.get('species_key'), 'provider': g.get('provider'),
                         'genome_name': g.get('display_name') or g.get('scientific_name'),
                         'scientific_name': g.get('scientific_name')} for g in linker.genomes()],
        }

    @router.put('/datasets/{collection_id}/mapping')
    def update_mapping(collection_id: str, payload: MappingUpdate):
        collection = collection_or_404(collection_id)
        if payload.label_pattern is not None:
            pattern = _check_pattern(payload.label_pattern) or None
            if pattern != (collection.get('label_pattern') or None):
                library = store()
                batch = []
                for item in library.iter_payloads(collection_id):
                    members = members_for_pattern(item['payload'], pattern)
                    if members is not None:
                        batch.append((item['tid'], members))
                    if len(batch) >= 200:
                        library.replace_members(batch)
                        batch = []
                if batch:
                    library.replace_members(batch)
                library.update_collection(collection_id, label_pattern=pattern)
        if payload.species_map is not None:
            clean = {str(k): str(v) for k, v in payload.species_map.items() if k}
            store().update_collection(collection_id, species_map=clean)
        return store().collection(collection_id)

    @router.post('/datasets/{collection_id}/links')
    def update_links(collection_id: str, payload: LinksUpdate):
        collection = collection_or_404(collection_id)
        entries = list(payload.entries)
        if payload.content:
            try:
                entries += parse_link_table(payload.content)
            except (ValueError, csv.Error) as exc:
                raise HTTPException(400, f'Could not read the link table: {exc}')
        links = {} if payload.replace else dict(collection['links'])
        applied = 0
        for entry in entries:
            label = str(entry.get('label') or entry.get('leaf') or '').strip()
            if not label:
                continue
            assembly = str(entry.get('assembly') or '').strip()
            if not assembly:
                links.pop(label, None)
                continue
            links[label] = {'assembly': assembly, **({'gene_id': str(entry['gene_id']).strip()} if entry.get('gene_id') else {})}
            applied += 1
        store().update_collection(collection_id, links=links)
        return {'applied': applied, 'links': links}

    @router.get('/search')
    def search(q: str = '', genome: Optional[str] = None, gene: Optional[str] = None, prefer: str = ''):
        """Every tree context holding a gene, best first.

        ``prefer`` lists assemblies (the top bar, in order): a symbol is resolved in
        those genomes first, and trees holding the user's own copy of the gene lead.
        """
        started = time.time()
        tokens = [t for t in re.split(r'[\s,;]+', q or '') if t]
        preferred = [a for a in (prefer or '').split(',') if a]
        ranks: Dict[str, Dict[str, Any]] = {}
        if gene:
            clean = model.strip_version(gene) or gene
            info = {'rank': 0, 'assembly': genome, 'genome_name': None}
            for alias in (linker.gene_aliases(genome, clean) if genome else [clean]):
                ranks.setdefault(alias, info)
            tokens.append(clean)
        symbols = [t for t in tokens if not model.classify_identifier(t)[0]]
        if symbols and preferred:
            for key, info in linker.genes_by_symbol(preferred, symbols).items():
                ranks.setdefault(key, info)
        results = store().search(tokens, ranks)
        return {'query': q, 'results': results, 'elapsed': round(time.time() - started, 3)}

    @router.get('/datasets/{collection_id}/trees/{tree_id}/export')
    def export_tree(collection_id: str, tree_id: str, format: str = 'newick', node: Optional[int] = None):
        collection = collection_or_404(collection_id)
        nodes = open_tree(collection, tree_id)['nodes']
        if node is not None:
            if node < 0 or node >= len(nodes):
                raise HTTPException(400, 'No such node')
            nodes = model.subtree(nodes, node)
        return PlainTextResponse(model.to_newick(nodes, 0, nhx=format == 'nhx') + '\n', media_type='text/plain')

    # ── the subtree-layer workspace ──

    # ── data beside the leaves ──

    @router.post('/neighbourhood')
    async def neighbourhood(request: Request):
        """The genes around each linked leaf's gene: `{genes: [{assembly, gene_id}], flank}`."""
        if not neighbourhoods:
            raise HTTPException(501, 'Neighbourhoods are not available')
        try:
            data = json.loads(await request.body() or b'{}')
        except ValueError:
            raise HTTPException(400, 'The request is not valid JSON')
        genes = data.get('genes') if isinstance(data, dict) else None
        if not isinstance(genes, list):
            raise HTTPException(400, 'Send a list of genes')
        if len(genes) > MAX_NEIGHBOURHOOD_GENES:
            raise HTTPException(400, f'At most {MAX_NEIGHBOURHOOD_GENES} genes at a time')
        flank = max(1, min(8, int(data.get('flank') or 4)))
        pairs = [(str(g.get('assembly') or ''), str(g.get('gene_id') or '')) for g in genes if isinstance(g, dict)]
        pairs = [(a, g) for a, g in pairs if a and g]
        return {'results': await run_in_threadpool(neighbourhoods.get, pairs, flank)}

    @router.get('/workspace')
    def get_workspace():
        return store().workspace() or {'workspace': None, 'updated': None}

    @router.put('/workspace')
    async def put_workspace(request: Request):
        body = await request.body()
        if len(body) > MAX_WORKSPACE_BYTES:
            raise HTTPException(413, 'The layers are too large to save (over 10 MB)')
        try:
            data = json.loads(body or b'{}')
        except ValueError:
            raise HTTPException(400, 'The workspace is not valid JSON')
        if not isinstance(data, dict) or not isinstance(data.get('layers'), list):
            raise HTTPException(400, 'A workspace needs a list of layers')
        return {'updated': store().save_workspace(data)}

    # ── a library written by an earlier version ──

    @router.get('/legacy')
    def legacy_info():
        path = legacy_library(Path(library_path_provider()))
        if not path:
            return {'legacy': None}
        conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute('SELECT * FROM collections ORDER BY created').fetchall()
        finally:
            conn.close()
        size = sum(p.stat().st_size for p in path.parent.glob(path.name + '*') if p.is_file())

        def get(row, key, default=None):
            return row[key] if key in row.keys() and row[key] is not None else default
        return {'legacy': {'path': str(path), 'size': size, 'collections': [{
            'name': r['name'], 'source': r['source'], 'source_exists': bool(r['source'] and Path(r['source']).exists()),
            'tree_count': r['tree_count'], 'format': r['format'], 'method': get(r, 'method', ''),
            'description': get(r, 'description', ''), 'tags': json.loads(get(r, 'tags', '[]')),
            'label_pattern': get(r, 'label_pattern'),
        } for r in rows]}}

    @router.post('/legacy/reindex')
    def legacy_reindex():
        """Queue a fresh import of every earlier collection whose source file is still there."""
        info = legacy_info()['legacy']
        if not info:
            return {'jobs': []}
        started = []
        for c in info['collections']:
            if c['source_exists']:
                started.append(start_import(ImportRequest(path=c['source'], name=c['name'], method=c['method'] or '',
                                                          description=c['description'] or '', tags=c['tags'] or [],
                                                          label_pattern=c['label_pattern'])))
        return {'jobs': started}

    @router.delete('/legacy')
    def legacy_remove():
        """Delete the earlier library file. Only ever on the user's say-so, from the view."""
        path = legacy_library(Path(library_path_provider()))
        if not path:
            return {'removed': False}
        for candidate in [path, Path(str(path) + '-wal'), Path(str(path) + '-shm'), Path(str(path) + '-journal')]:
            if candidate.exists():
                candidate.unlink()
        return {'removed': True}

    router.linker = linker
    return router
