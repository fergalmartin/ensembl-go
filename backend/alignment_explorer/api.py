import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from typing import Optional
from .store import AlignmentStore, detect_format, fingerprint, parse_metadata


class ImportRequest(BaseModel):
    path: str = ''
    format: str = 'auto'
    content: Optional[str] = Field(default=None, max_length=20_000_000)
    name: str = 'Alignment'
    rows: Optional[list[dict]] = None


class RegionRequest(BaseModel):
    block: int = Field(default=1, ge=1)
    start: int = Field(default=0, ge=0)
    end: Optional[int] = Field(default=None, ge=1)
    ids: Optional[list[str]] = Field(default=None, max_length=5000)
    bins: int = Field(default=256, ge=16, le=2048)
    focus: Optional[str] = None
    summary: bool = False


class ExportRequest(RegionRequest):
    format: str = 'fasta'


class MetadataRequest(BaseModel):
    entries: list[dict] = Field(default_factory=list, max_length=100000)
    content: Optional[str] = Field(default=None, max_length=10_000_000)
    suffix: str = '.json'


class NativeRegion(BaseModel):
    source: str
    start: int = Field(default=0, ge=0)
    end: int = Field(ge=1)


def create_router(cache_root=None, annotation_provider=None):
    root = Path(cache_root or os.environ.get('ENSEMBL_ALIGNMENT_CACHE', Path.home() / '.cache' / 'ensembl-go' / 'alignment-explorer'))
    router = APIRouter(prefix='/api/alignment-explorer', tags=['Alignment Explorer'])
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='alignment-explorer')
    jobs, lock = {}, threading.Lock()

    def store_for(dataset_id, ready=True):
        if not re.fullmatch(r'[a-f0-9]{32}', dataset_id): raise HTTPException(404, 'Dataset not found')
        store = AlignmentStore(root / dataset_id)
        if not store.path.exists(): raise HTTPException(404, 'Dataset not found; reopen the source alignment')
        meta = store.meta()
        if ready and meta.get('status') != 'ready': raise HTTPException(409, 'Alignment index is not ready')
        if meta.get('source'):
            try: same = fingerprint(meta['source']) == meta.get('fingerprint')
            except OSError: same = False
            if not same: raise HTTPException(409, 'Source alignment changed or moved. Reopen it to rebuild its index.')
        return store

    def update(job, **values):
        with lock: jobs[job].update(values)

    @router.get('/capabilities')
    def capabilities():
        from .adapters import native_capabilities
        return {'formats': ['maf', 'fasta', 'xmfa', 'stockholm', 'clustal', 'phylip', 'phylip-relaxed'], **native_capabilities()}

    @router.post('/datasets')
    def register(payload: ImportRequest):
        source, fp = None, None
        if payload.path:
            source = Path(payload.path).expanduser().resolve()
            if not source.is_file(): raise HTTPException(400, 'Choose an existing local alignment file')
            fp = fingerprint(source)
            dataset_id = hashlib.sha256((str(source) + json.dumps(fp) + payload.format + ':v1').encode()).hexdigest()[:32]
        else:
            if payload.content is None and not payload.rows: raise HTTPException(400, 'Choose a file or provide aligned sequences')
            dataset_id = uuid.uuid4().hex
        root.mkdir(parents=True, exist_ok=True)
        store = AlignmentStore(root / dataset_id)
        with lock:
            existing = next((dict(j) for j in jobs.values() if j['dataset_id'] == dataset_id and j['status'] in ('queued', 'running')), None)
        if existing: return existing
        if store.path.exists() and store.meta().get('status') == 'ready':
            return {'dataset_id': dataset_id, 'status': 'ready', 'id': None}
        if store.directory.exists(): shutil.rmtree(store.directory)
        store.initialize()
        store.set_meta('name', payload.name if not source else source.name)
        store.set_meta('source', str(source) if source else None)
        store.set_meta('fingerprint', fp)
        store.set_meta('status', 'indexing')
        job = uuid.uuid4().hex
        with lock:
            # Keep only a bounded history of completed jobs.
            finished = [k for k,v in jobs.items() if v['status'] in ('ready','failed','cancelled')]
            for key in finished[:-63]: jobs.pop(key, None)
            jobs[job] = {'id': job, 'dataset_id': dataset_id, 'status': 'queued', 'cancel': False}
        def run():
            update(job, status='running')
            try:
                if payload.rows is not None:
                    from .store import clean_sequence
                    rows = []
                    for i, row in enumerate(payload.rows):
                        seq = clean_sequence(row.get('aligned_sequence', row.get('sequence', '')))
                        if not seq: raise ValueError(f'Row {i+1} has no aligned sequence')
                        rows.append({'source': row.get('genome_key') or row.get('source') or f'row_{i+1}', 'sequence': seq, 'label': row.get('gene_label') or row.get('tag') or row.get('genome_key') or f'Row {i+1}', 'genome_key': row.get('genome_key'), 'chrom': row.get('chrom'), 'start': max(0, int(row.get('genomic_start', 1))-1), 'end': row.get('genomic_end', 0), 'strand': row.get('strand', '+'), 'coordinates': bool(row.get('chrom') and row.get('genomic_start')), 'transcript_id': row.get('transcript_id'), 'features': row.get('display_features') or row.get('features', [])})
                    store.add_block(rows, {'origin': 'MAFFT'})
                    store.set_meta('format', 'fasta')
                else:
                    import_path = source
                    if payload.content is not None and source is None:
                        import_path = store.directory / 'input.txt'; import_path.write_text(payload.content)
                    fmt = detect_format(import_path, payload.format)
                    if fmt in ('hal', 'taf', 'bigmaf', 'gfa'):
                        from .adapters import import_native
                        import_native(store, import_path, fmt, lambda: jobs[job]['cancel'], lambda **kw: update(job, **kw))
                    else: store.import_file(import_path, fmt, lambda: jobs[job]['cancel'], lambda **kw: update(job, **kw))
                    if source:
                        meta_path = source.with_suffix('.json')
                        if fmt == 'fasta' and meta_path.is_file():
                            try: store.update_metadata(parse_metadata(meta_path.read_text(), '.json'))
                            except (ValueError, KeyError) as exc: store.set_meta('metadata_warning', str(exc))
                if jobs[job]['cancel']: raise InterruptedError('Import cancelled')
                if source and fingerprint(source) != fp: raise ValueError('Source changed during indexing; reopen it')
                store.set_meta('status', 'ready'); update(job, status='ready')
            except Exception as exc:
                status = 'cancelled' if isinstance(exc, InterruptedError) else 'failed'
                store.set_meta('status', status); update(job, status=status, error=str(exc))
        pool.submit(run)
        return dict(jobs[job])

    @router.get('/jobs/{job_id}')
    def job_status(job_id: str):
        with lock:
            if job_id not in jobs: raise HTTPException(404, 'Job not found')
            return dict(jobs[job_id])

    @router.post('/jobs/{job_id}/cancel')
    def cancel(job_id: str):
        with lock:
            if job_id not in jobs: raise HTTPException(404, 'Job not found')
            if jobs[job_id]['status'] in ('queued', 'running'): jobs[job_id]['cancel'] = True
            return dict(jobs[job_id])

    @router.get('/datasets/{dataset_id}')
    def dataset(dataset_id: str):
        store = store_for(dataset_id)
        return {'id': dataset_id, **store.layout_info(), **store.meta(), 'sequence_count': store.inventory(limit=0)['total'], 'block_count': store.blocks(limit=0)['total']}

    @router.get('/datasets/{dataset_id}/sequences')
    def sequences(dataset_id: str, offset: int = Query(0, ge=0), limit: int = Query(1000, ge=1, le=5000), query: str = ''):
        return store_for(dataset_id).inventory(offset, limit, query)

    @router.get('/datasets/{dataset_id}/blocks')
    def blocks(dataset_id: str, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=1000), sequence_id: Optional[str] = None, coordinate: Optional[int] = None):
        return store_for(dataset_id).blocks(offset, limit, sequence_id, coordinate)

    @router.get('/datasets/{dataset_id}/layout')
    def layout(dataset_id: str, start: int = Query(0,ge=0), end: int = Query(1,ge=1), limit: int = Query(256,ge=16,le=512),
               merge: int = Query(0,ge=0), detail: int = Query(0,ge=0,le=512)):
        if end<=start: raise HTTPException(400,'Empty layout interval')
        return store_for(dataset_id).layout_region(start,end,limit,merge,detail)

    @router.post('/datasets/{dataset_id}/region')
    def region(dataset_id: str, payload: RegionRequest):
        try: return store_for(dataset_id).region(payload.block, payload.start, payload.end, payload.ids, max_cells=0 if payload.summary else 2_000_000, bins=payload.bins, focus_id=payload.focus)
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc

    @router.get('/datasets/{dataset_id}/blocks/{block_id}/rows')
    def block_rows(dataset_id: str, block_id: int):
        store = store_for(dataset_id)
        with store.connect() as db:
            block = db.execute('SELECT * FROM blocks WHERE id=?',(block_id,)).fetchone()
            if block is None: raise HTTPException(404, 'Block not found')
            rows = [dict(r) for r in db.execute('SELECT r.*,s.source,s.label,s.metadata FROM rows r JOIN sequences s ON s.id=r.id WHERE block=? ORDER BY s.rowid',(block_id,))]
        for row in rows: row['metadata'] = json.loads(row['metadata'])
        return {'block':block_id,'length':block['length'],'rows':rows,**store.layout_info(block_id)}

    @router.post('/datasets/{dataset_id}/connections')
    def connections(dataset_id: str, payload: dict):
        from .store import source_span
        pairs = payload.get('pairs', [])
        if not isinstance(pairs,list) or len(pairs)>2000: raise HTTPException(400, 'Request at most 2,000 connections')
        store = store_for(dataset_id)
        result = []
        try:
            for p in pairs:
                a,b = p['from'],p['to']
                row_id=p['rowId']
                left=source_span(store,int(a['sourceBlock']),row_id,int(a['start']),int(a['end']))
                right=source_span(store,int(b['sourceBlock']),row_id,int(b['start']),int(b['end']))
                bases=None
                if left and right:
                    if a['sourceBlock']==b['sourceBlock']: bases=right['offset_start']-left['offset_end']
                    elif left['coordinates'] and right['coordinates'] and left['strand']==right['strand']:
                        bases=right['start']-left['end'] if left['strand']=='+' else left['start']-right['end']
                result.append({'id':p['id'],'bases':bases,'left':left,'right':right})
            return {'connections':result}
        except (KeyError, ValueError, TypeError) as exc: raise HTTPException(400, 'Invalid connection coordinates') from exc

    @router.get('/datasets/{dataset_id}/summary')
    def summary(dataset_id: str, limit: int = Query(20000, ge=1, le=200000)):
        return store_for(dataset_id).summary(limit)

    @router.post('/datasets/{dataset_id}/blocks-with')
    def blocks_with(dataset_id: str, payload: dict):
        ids = payload.get('ids', [])
        if not isinstance(ids, list) or len(ids) > 5000: raise HTTPException(400, 'Request at most 5,000 sequences')
        if not all(isinstance(i, str) for i in ids): raise HTTPException(400, 'Invalid sequence identifier')
        return {'blocks': store_for(dataset_id).blocks_with(ids)}

    @router.post('/datasets/{dataset_id}/neighbours')
    def neighbours(dataset_id: str, payload: dict):
        ids = payload.get('ids', [])
        if not isinstance(ids, list) or len(ids) > 500: raise HTTPException(400, 'Request at most 500 sequences')
        if not all(isinstance(i, str) for i in ids): raise HTTPException(400, 'Invalid sequence identifier')
        try:
            lo, hi = int(payload['lo']), int(payload['hi'])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(400, 'Invalid block range') from exc
        if lo > hi: raise HTTPException(400, 'Invalid block range')
        return store_for(dataset_id).outside_neighbours(ids, lo, hi)

    @router.post('/datasets/{dataset_id}/annotations')
    def annotations(dataset_id: str, payload: RegionRequest):
        from .store import source_span
        store=store_for(dataset_id)
        data=store.region(payload.block,payload.start,payload.end,payload.ids,max_cells=2_000_000)
        if not data['detail']: raise HTTPException(400, 'Zoom in to load annotation detail')
        output, warnings = {}, []
        for row in data['rows']:
            output[row['id']]=[]
            if not row['sequence']: continue
            meta=row['metadata']
            embedded=meta.get('features') or []
            if embedded:
                output[row['id']]=[f for f in embedded if f['end']>=data['start'] and f['start']<data['end']]
            genome,chrom=meta.get('genome_key'),meta.get('chrom')
            if not genome or not chrom or not annotation_provider: continue
            span=source_span(store,payload.block,row['id'],data['start'],data['end'])
            if not span or not span['coordinates'] or not span['bases']: continue
            try:
                features=annotation_provider(genome,chrom,span['start']+1,span['end'],row['sequence'],row['strand'],meta.get('transcript_id'))
                output[row['id']]=[{**f,'start':f['start']+data['start'],'end':f['end']+data['start']} for f in features]
            except Exception as exc:
                warnings.append({'id':row['id'],'message':str(getattr(exc,'detail',exc))})
        return {'rows':output,'warnings':warnings}

    @router.post('/datasets/{dataset_id}/locate')
    def locate(dataset_id: str, payload: dict):
        from .store import locate_column
        try: return {'column': locate_column(store_for(dataset_id), int(payload['block']), payload['id'], int(payload['coordinate']))}
        except (ValueError, KeyError) as exc: raise HTTPException(400, str(exc)) from exc

    @router.get('/datasets/{dataset_id}/structure')
    def structure(dataset_id: str):
        with store_for(dataset_id).connect() as db:
            segments = [dict(r) for r in db.execute('SELECT block,id,start,end,strand,source_length FROM rows WHERE coordinates=1 ORDER BY id,start LIMIT 10001')]
        return {'segments': segments[:10000], 'truncated': len(segments)>10000}

    @router.get('/datasets/{dataset_id}/graph')
    def graph(dataset_id: str):
        from .adapters import graph_preview
        try: return graph_preview(store_for(dataset_id))
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc

    @router.post('/datasets/{dataset_id}/graph-project')
    def graph_project(dataset_id: str, payload: dict):
        from .adapters import project_graph
        try: return project_graph(store_for(dataset_id), payload.get('source', ''))
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc

    @router.post('/datasets/{dataset_id}/native-region')
    def native_region(dataset_id: str, payload: NativeRegion):
        from .adapters import extract_native_region
        try: return extract_native_region(store_for(dataset_id), payload.source, payload.start, payload.end)
        except (ValueError, RuntimeError) as exc: raise HTTPException(400, str(exc)) from exc

    @router.post('/datasets/{dataset_id}/metadata')
    def metadata(dataset_id: str, payload: MetadataRequest):
        try:
            entries = parse_metadata(payload.content, payload.suffix) if payload.content is not None else payload.entries
            store_for(dataset_id).update_metadata(entries)
            return {'updated': len(entries)}
        except (ValueError, KeyError) as exc: raise HTTPException(400, str(exc)) from exc

    @router.post('/datasets/{dataset_id}/export')
    def export(dataset_id: str, payload: ExportRequest):
        if payload.format not in ('fasta', 'maf'): raise HTTPException(400, 'Choose FASTA or MAF')
        try:
            text = store_for(dataset_id).export(payload.block, payload.start, payload.end, payload.ids, payload.format)
            return PlainTextResponse(text, headers={'Content-Disposition': f'attachment; filename="alignment.{payload.format}"'})
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc

    @router.put('/datasets/{dataset_id}/workspace')
    def save_workspace(dataset_id: str, payload: dict):
        if payload.get('version') not in (1, 2): raise HTTPException(400, 'Unsupported workspace version')
        if len(json.dumps(payload)) > 10_000_000: raise HTTPException(413, 'Workspace exceeds 10 MB')
        store = store_for(dataset_id)
        # Atomic replace; original alignment is never touched.
        fd, path = tempfile.mkstemp(dir=store.directory, suffix='.json')
        with os.fdopen(fd, 'w') as handle: json.dump(payload, handle)
        os.replace(path, store.directory / ('layers-workspace.json' if payload.get('version') == 2 else 'workspace.json'))
        return {'saved': True}

    @router.get('/datasets/{dataset_id}/workspace')
    def workspace(dataset_id: str, version: int = 1):
        path = store_for(dataset_id).directory / ('layers-workspace.json' if version == 2 else 'workspace.json')
        return json.loads(path.read_text()) if path.is_file() else None

    return router
