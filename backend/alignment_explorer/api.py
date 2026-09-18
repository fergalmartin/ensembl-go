import asyncio
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
from fastapi import APIRouter, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from typing import Literal, Optional
from .store import AlignmentStore, detect_format, fingerprint, normalize_metadata_entries, parse_metadata


# What one block-context read may cost, stated once. These are request bounds,
# not opinions about how much is interesting: everything held back is reported
# as held back, with a continuation, and never silently dropped.
BLOCK_CONTEXT_ROWS = 8
BLOCK_DETAIL_COLUMNS = 65_536
BLOCK_GENES_PER_ROW = 200
BLOCK_TRANSCRIPTS_PER_PAGE = 8
BLOCK_SEGMENTS_PER_RESPONSE = 20_000


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


class BlockContextRequest(BaseModel):
    block: int = Field(default=1, ge=1)
    ids: Optional[list[str]] = Field(default=None, max_length=500)
    start: Optional[int] = Field(default=None, ge=0)
    end: Optional[int] = Field(default=None, ge=1)


class BlockFeaturesRequest(BaseModel):
    """Gene models for one block, projected into its alignment columns.

    ``start``/``end`` are zero-based half-open alignment columns, as is every
    coordinate this endpoint returns for a column. Genomic coordinates it
    returns are zero-based half-open too; the one-based inclusive convention of
    the GFF3 index is converted at the provider boundary and nowhere else.
    """
    block: int = Field(default=1, ge=1)
    start: int = Field(default=0, ge=0)
    end: Optional[int] = Field(default=None, ge=1)
    ids: list[str] = Field(default_factory=list, max_length=BLOCK_CONTEXT_ROWS)
    # Which genes to open past their one representative transcript. Expansion is
    # per gene and paged, so a gene with fifty isoforms cannot be asked for whole
    # by accident.
    expand: dict[str, list[str]] = Field(default_factory=dict)
    page: int = Field(default=0, ge=0)


class BlockComparisonRequest(BaseModel):
    """Measured difference between named pairs of rows, over one column window.

    Pairs are explicit. Nothing here infers which rows should be compared: that
    is the reader's choice of reference or of adjacency, made above.
    """
    block: int = Field(default=1, ge=1)
    start: int = Field(default=0, ge=0)
    end: Optional[int] = Field(default=None, ge=1)
    pairs: list[tuple[str, str]] = Field(default_factory=list, max_length=BLOCK_CONTEXT_ROWS)
    bins: int = Field(default=512, ge=16, le=4096)
    # Column ranges of one reference feature, to be measured against each target.
    feature: Optional[dict] = None


class GapColumnsRequest(BaseModel):
    """Columns enough of the cohort is a gap in, for one block.

    The cohort is the rows on screen, so it is the caller's to state: the block's
    own membership is never the denominator. `gap_percent` is how much of the
    cohort present in the block has to be a gap for the column to count - 100,
    the default, is the whole of it and the only threshold that hides no bases.
    `min_run` is the shortest run worth hiding, applied after the threshold.
    """
    block: int = Field(default=1, ge=1)
    start: int = Field(default=0, ge=0)
    end: Optional[int] = Field(default=None, ge=1)
    ids: list[str] = Field(default_factory=list, max_length=5000)
    min_run: int = Field(default=1, ge=1, le=100000)
    gap_percent: int = Field(default=100, ge=1, le=100)


class ConservationRequest(BaseModel):
    block: int = Field(default=1, ge=1)
    start: int = Field(default=0, ge=0)
    end: Optional[int] = Field(default=None, ge=1)
    ids: list[str] = Field(max_length=5000)
    bins: int = Field(default=256, ge=16, le=2048)


class ExportRequest(RegionRequest):
    format: str = 'fasta'


class MotifDefinition(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    pattern: str = Field(min_length=1, max_length=500)
    kind: Literal['literal', 'regex'] = 'literal'


class MotifRequest(BaseModel):
    block: int = Field(ge=1)
    row: str = Field(min_length=1, max_length=500)
    motifs: list[MotifDefinition] = Field(max_length=100)


class MotifBlocksRequest(BaseModel):
    motifs: list[MotifDefinition] = Field(min_length=1, max_length=100)
    after: int = Field(default=0, ge=0)


class MotifJobRequest(BaseModel):
    motifs: list[MotifDefinition] = Field(min_length=1, max_length=100)


class MotifTileRequest(BaseModel):
    block: int = Field(ge=1)
    ids: list[str] = Field(max_length=16)
    start: int = Field(ge=0)
    end: int = Field(ge=1)
    step: int = Field(default=1, ge=1)


class MetadataRequest(BaseModel):
    entries: list[dict] = Field(default_factory=list, max_length=100000)
    content: Optional[str] = Field(default=None, max_length=10_000_000)
    suffix: str = '.json'


class NativeRegion(BaseModel):
    source: str
    start: int = Field(default=0, ge=0)
    end: int = Field(ge=1)


def create_router(cache_root=None, annotation_provider=None, gene_provider=None, availability_provider=None):
    from .motif_jobs import MotifJobs
    motif_jobs = MotifJobs()
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
        from .store import TEXT_FORMATS, AlignmentStore
        return {'formats': list(TEXT_FORMATS), 'format_labels': TEXT_FORMATS,
                'export_formats': AlignmentStore.EXPORT_FORMATS, **native_capabilities()}

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
                        region=row.get('region') or row.get('chrom')
                        rows.append({'source': row.get('source') or row.get('genome_key') or f'row_{i+1}', 'sequence': seq, 'label': row.get('gene_label') or row.get('tag') or row.get('source') or row.get('genome_key') or f'Row {i+1}', 'assembly': row.get('assembly') or row.get('gca'), 'region': region, 'start': max(0, int(row.get('genomic_start', 1))-1), 'end': row.get('genomic_end', 0), 'strand': row.get('strand', '+'), 'coordinates': bool(region and row.get('genomic_start')), 'transcript_id': row.get('transcript_id'), 'features': row.get('display_features') or row.get('features', [])})
                    store.add_block(rows, {'origin': 'MAFFT'})
                    store.set_meta('format', 'fasta')
                    store.set_meta('format_chosen', True)
                else:
                    import_path = source
                    if payload.content is not None and source is None:
                        import_path = store.directory / 'input.txt'; import_path.write_text(payload.content)
                    fmt = detect_format(import_path, payload.format)
                    # Record the reader before using it, so a failed or wrong
                    # read can say which format was tried and be reopened as
                    # another one. `chosen` distinguishes a guess from a
                    # deliberate override.
                    store.set_meta('format', fmt)
                    store.set_meta('format_chosen', payload.format != 'auto')
                    update(job, format=fmt, format_chosen=payload.format != 'auto')
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
               merge: int = Query(0,ge=0), detail: int = Query(0,ge=0,le=512), individual: bool = False, after: int = Query(0,ge=0)):
        if end<=start: raise HTTPException(400,'Empty layout interval')
        store = store_for(dataset_id)
        if individual: return store.individual_layout_region(start,end,limit,after)
        return store.layout_region(start,end,limit,merge,detail)

    @router.post('/datasets/{dataset_id}/region')
    async def region(dataset_id: str, payload: RegionRequest, request: Request):
        cancelled = threading.Event()
        def read():
            return store_for(dataset_id).region(payload.block, payload.start, payload.end, payload.ids,
                max_cells=0 if payload.summary else 2_000_000, bins=payload.bins, focus_id=payload.focus, cancelled=cancelled.is_set)
        worker = asyncio.create_task(run_in_threadpool(read))
        try:
            while not worker.done():
                done, _ = await asyncio.wait({worker}, timeout=.05)
                if done: break
                if await request.is_disconnected(): cancelled.set()
            return await worker
        except InterruptedError as exc: raise HTTPException(499, 'Navigation changed') from exc
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc
        finally:
            cancelled.set()
            # Retrieve exceptions if the ASGI task itself was cancelled. The
            # bounded row/chunk work will observe the event and leave the pool.
            if not worker.done(): worker.add_done_callback(lambda future: future.exception() if not future.cancelled() else None)

    @router.post('/datasets/{dataset_id}/conservation')
    async def conservation(dataset_id: str, payload: ConservationRequest, request: Request):
        cancelled = threading.Event()
        def read():
            return store_for(dataset_id).conservation(payload.block, payload.start, payload.end,
                payload.ids, bins=payload.bins, cancelled=cancelled.is_set)
        worker = asyncio.create_task(run_in_threadpool(read))
        try:
            while not worker.done():
                done, _ = await asyncio.wait({worker}, timeout=.05)
                if done: break
                if await request.is_disconnected(): cancelled.set()
            return await worker
        except InterruptedError as exc: raise HTTPException(499, 'Navigation changed') from exc
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc
        finally:
            cancelled.set()
            if not worker.done(): worker.add_done_callback(lambda future: future.exception() if not future.cancelled() else None)

    @router.post('/datasets/{dataset_id}/gap-columns')
    async def gap_columns(dataset_id: str, payload: GapColumnsRequest, request: Request):
        cancelled = threading.Event()
        def read():
            return store_for(dataset_id).gap_columns(payload.block, payload.start, payload.end,
                payload.ids, min_run=payload.min_run, percent=payload.gap_percent, cancelled=cancelled.is_set)
        worker = asyncio.create_task(run_in_threadpool(read))
        try:
            while not worker.done():
                done, _ = await asyncio.wait({worker}, timeout=.05)
                if done: break
                if await request.is_disconnected(): cancelled.set()
            return await worker
        except InterruptedError as exc: raise HTTPException(499, 'Navigation changed') from exc
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc
        finally:
            cancelled.set()
            if not worker.done(): worker.add_done_callback(lambda future: future.exception() if not future.cancelled() else None)

    @router.get('/datasets/{dataset_id}/blocks/{block_id}/rows')
    def block_rows(dataset_id: str, block_id: int):
        store = store_for(dataset_id)
        with store.connect() as db:
            block = db.execute('SELECT * FROM blocks WHERE id=?',(block_id,)).fetchone()
            if block is None: raise HTTPException(404, 'Block not found')
            rows = [dict(r) for r in db.execute('SELECT r.*,s.source,s.label,s.metadata FROM rows r JOIN sequences s ON s.id=r.id WHERE block=? ORDER BY s.rowid',(block_id,))]
        for row in rows: row['metadata'] = json.loads(row['metadata'])
        return {'block':block_id,'length':block['length'],'rows':rows,**store.layout_info(block_id)}

    @router.post('/datasets/{dataset_id}/motifs')
    def motifs(dataset_id: str, payload: MotifRequest):
        from .motifs import search_row
        try:
            return search_row(store_for(dataset_id), payload.block, payload.row, payload.motifs)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.post('/datasets/{dataset_id}/motif-jobs')
    def start_motif_job(dataset_id: str, payload: MotifJobRequest):
        try:
            return motif_jobs.start(dataset_id, store_for(dataset_id), payload.motifs)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @router.get('/motif-jobs/{job_id}')
    def motif_job_status(job_id: str):
        try: return motif_jobs.status(job_id)
        except KeyError: raise HTTPException(404, 'Motif preparation expired. Apply the motifs again; searches remain cached.')

    @router.post('/motif-jobs/{job_id}/cancel')
    def cancel_motif_job(job_id: str):
        try: return motif_jobs.cancel(job_id)
        except KeyError: raise HTTPException(404, 'Motif job not found')

    @router.get('/motif-jobs/{job_id}/blocks')
    def motif_job_blocks(job_id: str, after: int = Query(0, ge=0)):
        try: return motif_jobs.blocks(job_id, after)
        except KeyError: raise HTTPException(404, 'Motif job not found')
        except ValueError as exc: raise HTTPException(409, str(exc)) from exc

    @router.post('/motif-jobs/{job_id}/region')
    def motif_job_region(job_id: str, payload: MotifTileRequest):
        try:
            if payload.end <= payload.start: raise ValueError('Empty motif interval')
            return motif_jobs.region(job_id, payload.block, payload.ids, payload.start, payload.end, payload.step)
        except KeyError: raise HTTPException(404, 'Motif preparation expired. Apply again to reuse cached searches.')
        except ValueError as exc: raise HTTPException(400, str(exc)) from exc

    @router.post('/datasets/{dataset_id}/motif-blocks')
    def motif_blocks(dataset_id: str, payload: MotifBlocksRequest):
        from .motifs import matching_blocks_page
        try:
            return matching_blocks_page(store_for(dataset_id), payload.motifs, payload.after)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

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

    @router.post('/datasets/{dataset_id}/blocks-layout')
    def blocks_layout(dataset_id: str, payload: dict):
        blocks = payload.get('blocks', [])
        if not isinstance(blocks, list) or len(blocks) > 4000: raise HTTPException(400, 'Request at most 4,000 blocks')
        if not all(isinstance(b, int) and b > 0 for b in blocks): raise HTTPException(400, 'Invalid block number')
        return store_for(dataset_id).blocks_layout(blocks)

    @router.post('/datasets/{dataset_id}/blocks-with')
    def blocks_with(dataset_id: str, payload: dict):
        ids = payload.get('ids', [])
        if not isinstance(ids, list) or len(ids) > 5000: raise HTTPException(400, 'Request at most 5,000 sequences')
        if not all(isinstance(i, str) for i in ids): raise HTTPException(400, 'Invalid sequence identifier')
        return {'blocks': store_for(dataset_id).blocks_with(ids)}

    @router.post('/datasets/{dataset_id}/row-fragments')
    def row_fragments(dataset_id: str, payload: dict):
        ids = payload.get('ids', [])
        if not isinstance(ids, list) or not 0 < len(ids) <= 5000: raise HTTPException(400, 'Choose between 1 and 5,000 sequences')
        if not all(isinstance(i, str) for i in ids): raise HTTPException(400, 'Invalid sequence identifier')
        return {'fragments': store_for(dataset_id).row_fragments(ids)}

    @router.post('/datasets/{dataset_id}/genomic-loci')
    def genomic_loci(dataset_id: str, payload: dict):
        ranges=payload.get('ranges',[])
        if not isinstance(ranges,list) or not 0 < len(ranges) <= 5000: raise HTTPException(400,'Choose between 1 and 5,000 selected sequence ranges')
        try: block=int(payload['block'])
        except (KeyError,TypeError,ValueError) as exc: raise HTTPException(400,'Invalid source block') from exc
        cleaned=[]
        for item in ranges:
            if not isinstance(item,dict) or not isinstance(item.get('id'),str): raise HTTPException(400,'Invalid selected sequence range')
            try: start,end=int(item['start']),int(item['end'])
            except (KeyError,TypeError,ValueError) as exc: raise HTTPException(400,'Invalid selected sequence range') from exc
            if start < 0 or end <= start: raise HTTPException(400,'Invalid selected sequence range')
            cleaned.append({'id':item['id'],'start':start,'end':end})
        return store_for(dataset_id).genomic_loci(block,cleaned)

    @router.post('/datasets/{dataset_id}/blocks-in-range')
    def blocks_in_range(dataset_id: str, payload: dict):
        ids = payload.get('ids', [])
        if not isinstance(ids, list) or not 0 < len(ids) <= 200: raise HTTPException(400, 'Choose between 1 and 200 sequences')
        if not all(isinstance(i, str) for i in ids): raise HTTPException(400, 'Invalid sequence identifier')
        try:
            start, end = int(payload['start']), int(payload['end'])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(400, 'Invalid genomic interval') from exc
        if end <= start or start < 0: raise HTTPException(400, 'Invalid genomic interval')
        return {'matches': store_for(dataset_id).blocks_in_range(ids, start, end)}

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
            assembly,region=meta.get('assembly'),meta.get('region')
            if not assembly or not region or not annotation_provider: continue
            span=source_span(store,payload.block,row['id'],data['start'],data['end'])
            if not span or not span['coordinates'] or not span['bases']: continue
            try:
                features=annotation_provider(assembly,region,span['start']+1,span['end'],row['sequence'],row['strand'],meta.get('transcript_id'))
                output[row['id']]=[{**f,'start':f['start']+data['start'],'end':f['end']+data['start']} for f in features]
            except Exception as exc:
                warnings.append({'id':row['id'],'message':str(getattr(exc,'detail',exc))})
        return {'rows':output,'warnings':warnings}

    @router.post('/datasets/{dataset_id}/block-context')
    def block_context(dataset_id: str, payload: BlockContextRequest):
        """What one block holds, and what can be said about each of its rows.

        Identity, orientation, the genomic interval the row occupies and whether
        a local genome can answer for it at all. Availability is reported as
        several distinct states rather than one boolean, because "no genes here"
        and "no annotation for this genome" are different facts and a track that
        conflated them would read as biological absence.
        """
        from .store import source_span
        store = store_for(dataset_id)
        with store.connect() as db:
            block = db.execute('SELECT * FROM blocks WHERE id=?', (payload.block,)).fetchone()
            if block is None: raise HTTPException(404, 'Block not found')
            sql = 'SELECT r.*,s.source,s.label,s.metadata FROM rows r JOIN sequences s ON s.id=r.id WHERE block=?'
            args = [payload.block]
            if payload.ids:
                sql += ' AND r.id IN (' + ','.join('?' for _ in payload.ids) + ')'; args.extend(payload.ids)
            records = [dict(r) for r in db.execute(sql + ' ORDER BY s.rowid', args)]
        if (payload.start is None) != (payload.end is None):
            raise HTTPException(400, 'Provide both selection boundaries')
        if payload.start is not None and not payload.start < payload.end <= block['length']:
            raise HTTPException(400, 'Selection must be inside this block')
        rows = []
        for record in records:
            meta = json.loads(record['metadata'] or '{}')
            assembly, region = meta.get('assembly'), meta.get('region')
            span = None if record['empty_status'] else source_span(store, payload.block, record['id'], 0, block['length'])
            placed = bool(span and span.get('coordinates') and span.get('bases'))
            entry = {
                'id': record['id'], 'source': record['source'], 'label': record['label'],
                'strand': record['strand'], 'coordinates': bool(record['coordinates']),
                'empty_status': record['empty_status'], 'assembly': assembly, 'region': region,
                'bases': (span or {}).get('bases', 0),
                'source_length': record['source_length'],
                # Zero-based half-open, like every coordinate this endpoint emits.
                'genomic': {'start': span['start'], 'end': span['end']} if placed else None,
            }
            if payload.start is not None:
                selected = source_span(store, payload.block, record['id'], payload.start, payload.end)
                entry['selection'] = ({'start': selected['start'], 'end': selected['end']}
                                      if selected and selected.get('coordinates') and selected.get('bases') else None)
            if record['empty_status']: entry['availability'] = 'no-coverage'
            elif not assembly or not region: entry['availability'] = 'unresolved'
            elif not placed: entry['availability'] = 'unplaced'
            else: entry['availability'] = (availability_provider(assembly, region) if availability_provider else 'unknown')
            rows.append(entry)
        return {'block': payload.block, 'length': block['length'], 'rows': rows,
                'limits': {'rows': BLOCK_CONTEXT_ROWS, 'columns': BLOCK_DETAIL_COLUMNS,
                           'genes': BLOCK_GENES_PER_ROW, 'transcripts': BLOCK_TRANSCRIPTS_PER_PAGE,
                           'segments': BLOCK_SEGMENTS_PER_RESPONSE}}

    @router.post('/datasets/{dataset_id}/block-features')
    def block_features(dataset_id: str, payload: BlockFeaturesRequest):
        """Gene models for the rows of one block, over one column window.

        Each transcript is returned twice over: once in genomic coordinates,
        which is what it actually is, and once as the columns it occupies, which
        is what the alignment makes of it. The column form is an envelope plus
        the base-bearing pieces inside it, because mapping only the two
        boundaries would fill this row's gaps with another row's insertions and
        draw them as exon.
        """
        from .projection import row_segments, RowProjection
        if not gene_provider: raise HTTPException(400, 'Local annotation is not available in this session')
        store = store_for(dataset_id)
        ids = list(dict.fromkeys(payload.ids))[:BLOCK_CONTEXT_ROWS]
        if not ids: raise HTTPException(400, 'Name at least one sequence')
        with store.connect() as db:
            block = db.execute('SELECT * FROM blocks WHERE id=?', (payload.block,)).fetchone()
            if block is None: raise HTTPException(404, 'Block not found')
            start = max(0, payload.start)
            end = min(block['length'], payload.end if payload.end is not None else block['length'])
            if end <= start: raise HTTPException(400, 'Empty alignment interval')
            detail = (end - start) <= BLOCK_DETAIL_COLUMNS
            records = {r['id']: dict(r) for r in db.execute(
                'SELECT r.*,s.metadata FROM rows r JOIN sequences s ON s.id=r.id WHERE block=? AND r.id IN (%s)'
                % ','.join('?' * len(ids)), [payload.block, *ids])}
            segments = {row_id: row_segments(db, payload.block, row_id, start, end) for row_id in ids if row_id in records}
        output, warnings, truncated, budget = {}, [], False, BLOCK_SEGMENTS_PER_RESPONSE
        for row_id in ids:
            record = records.get(row_id)
            if record is None:
                warnings.append({'id': row_id, 'message': 'This sequence is not in this block.'}); continue
            meta = json.loads(record['metadata'] or '{}')
            assembly, region = meta.get('assembly'), meta.get('region')
            entry = {'genes': [], 'complete': True}
            output[row_id] = entry
            if record['empty_status'] or not record['coordinates']:
                entry['reason'] = 'no-coverage' if record['empty_status'] else 'unplaced'; continue
            if not assembly or not region:
                entry['reason'] = 'unresolved'; continue
            projection = RowProjection(record, segments.get(row_id) or [], (start, end))
            window = projection.window_coordinates()
            if window is None:
                entry['reason'] = 'no-coverage'; continue
            try:
                # One-based inclusive on the way in; nothing else in this module
                # ever sees that convention.
                genes = gene_provider(assembly, region, window[0] + 1, window[1],
                                      expand=list(payload.expand.get(row_id) or []),
                                      gene_limit=BLOCK_GENES_PER_ROW,
                                      transcript_limit=BLOCK_TRANSCRIPTS_PER_PAGE,
                                      page=payload.page)
            except Exception as exc:
                entry['reason'] = 'failed'
                warnings.append({'id': row_id, 'message': str(getattr(exc, 'detail', exc))}); continue
            entry['complete'] = bool(genes.get('complete', True))
            if not entry['complete']: truncated = True
            entry['window'] = {'start': window[0], 'end': window[1]}
            for gene in genes.get('genes', []):
                transcripts = []
                for transcript in gene.get('transcripts', []):
                    features = []
                    for feature in transcript.get('features', []):
                        if budget <= 0:
                            truncated = True; entry['complete'] = False; break
                        projected = projection.project(feature['start'], feature['end'])
                        if projected is None: continue
                        # An intron is the statement that two exons are joined,
                        # and it is drawn as one line for exactly that reason.
                        # Its pieces are of no use to a reader and there can be
                        # thousands of them - one per insertion any other row
                        # made anywhere inside it - so the envelope stands for
                        # the whole. Exons keep their pieces, where the
                        # distinction is the difference between drawing this
                        # row's bases and drawing another row's insertion.
                        if feature['type'] == 'intron':
                            projected['pieces'] = [{'start': projected['start'], 'end': projected['end']}]
                        budget -= len(projected['pieces'])
                        features.append({'type': feature['type'],
                                         'genomic': {'start': feature['start'], 'end': feature['end']},
                                         **projected})
                    if features: transcripts.append({**{k: v for k, v in transcript.items() if k != 'features'}, 'features': features})
                if transcripts: entry['genes'].append({**{k: v for k, v in gene.items() if k != 'transcripts'}, 'transcripts': transcripts})
        return {'block': payload.block, 'start': start, 'end': end, 'detail': detail,
                'rows': output, 'warnings': warnings, 'truncated': truncated,
                'next_page': payload.page + 1 if truncated else None}

    @router.post('/datasets/{dataset_id}/block-comparison')
    def block_comparison(dataset_id: str, payload: BlockComparisonRequest):
        """What each named pair actually differs by, counted.

        Observations only. Relative orientation is reported because it is a fact
        the rows carry; it is never called an inversion, which would be a claim
        about breakpoints this block cannot support on its own.
        """
        from .comparison import compare_columns, bin_kinds, comparable, measure_feature, describe
        store = store_for(dataset_id)
        pairs = [tuple(pair) for pair in payload.pairs][:BLOCK_CONTEXT_ROWS]
        if not pairs: raise HTTPException(400, 'Name at least one pair of sequences')
        wanted = list(dict.fromkeys([row for pair in pairs for row in pair]))
        with store.connect() as db:
            block = db.execute('SELECT * FROM blocks WHERE id=?', (payload.block,)).fetchone()
            if block is None: raise HTTPException(404, 'Block not found')
            start = max(0, payload.start)
            end = min(block['length'], payload.end if payload.end is not None else block['length'])
            if end <= start: raise HTTPException(400, 'Empty alignment interval')
            if end - start > BLOCK_DETAIL_COLUMNS:
                raise HTTPException(400, f'Compare at most {BLOCK_DETAIL_COLUMNS:,} columns at a time')
        data = store.region(payload.block, start, end, wanted, max_cells=BLOCK_DETAIL_COLUMNS * BLOCK_CONTEXT_ROWS * 2)
        if not data['detail']: raise HTTPException(400, 'Narrow the window to compare these rows')
        by_id = {row['id']: row for row in data['rows']}
        results = []
        for reference_id, target_id in pairs:
            reference, target = by_id.get(reference_id), by_id.get(target_id)
            if reference is None or target is None:
                results.append({'reference': reference_id, 'target': target_id, 'reason': 'missing'}); continue
            kinds, totals = compare_columns(reference.get('sequence'), target.get('sequence'), start)
            entry = {
                'reference': reference_id, 'target': target_id,
                'start': start, 'end': end,
                'bins': bin_kinds(kinds, payload.bins),
                'totals': totals, 'comparable': comparable(totals),
                # A fact the rows carry, not an event they evidence.
                'same_orientation': (reference['strand'] or '+') == (target['strand'] or '+'),
            }
            if payload.feature and payload.feature.get('pieces'):
                pieces = [{'start': int(p['start']) - start, 'end': int(p['end']) - start}
                          for p in payload.feature['pieces']]
                measured = measure_feature(kinds, pieces)
                measured['type'] = str(payload.feature.get('type') or '')
                measured['description'] = describe(measured, target.get('label') or target.get('source') or target_id,
                                                   reference.get('label') or reference.get('source') or reference_id,
                                                   measured['type'] or None)
                entry['feature'] = measured
            entry['description'] = describe(totals, target.get('label') or target.get('source') or target_id,
                                            reference.get('label') or reference.get('source') or reference_id)
            results.append(entry)
        return {'block': payload.block, 'start': start, 'end': end, 'pairs': results}

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
            entries = parse_metadata(payload.content, payload.suffix) if payload.content is not None else normalize_metadata_entries(payload.entries, public=True)
            return store_for(dataset_id).update_metadata(entries)
        except (ValueError, KeyError) as exc: raise HTTPException(400, str(exc)) from exc

    @router.post('/datasets/{dataset_id}/export')
    def export(dataset_id: str, payload: ExportRequest):
        from .store import AlignmentStore
        if payload.format not in AlignmentStore.EXPORT_FORMATS:
            raise HTTPException(400, 'Choose one of: ' + ', '.join(AlignmentStore.EXPORT_FORMATS))
        suffix = {'fasta': 'fa', 'clustal': 'aln', 'phylip-relaxed': 'phy', 'maf': 'maf'}[payload.format]
        try:
            text = store_for(dataset_id).export(payload.block, payload.start, payload.end, payload.ids, payload.format)
            return PlainTextResponse(text, headers={'Content-Disposition': f'attachment; filename="alignment.{suffix}"'})
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
