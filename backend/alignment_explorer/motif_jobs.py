"""Alignment adapter for the portable motif engine. One background search worker.

HTTP rendering only reads prepared tiles. It can never trigger a motif search.
"""
import hashlib
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import regex
from motif_engine import MotifCache, SearchCancelled, composition_key


class MotifJobs:
    def __init__(self):
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='motif-prepare')
        self.lock = threading.Lock()
        self.jobs = {}

    def start(self, dataset, store, motifs):
        for motif in motifs:
            if motif.kind == 'regex':
                try:
                    regex.compile(motif.pattern, regex.IGNORECASE | regex.VERSION1)
                except regex.error as exc:
                    raise ValueError(f'Invalid motif {motif.pattern!r}: {exc}') from exc
        job_id = uuid.uuid4().hex
        job = dict(id=job_id, dataset=dataset, status='queued', phase='queued', completed=0,
                   total=0, searched=0, cached=0, prepared_cached=0, motif_total=len(motifs),
                   motif_index=0, motif='', sequence='', matched_blocks=0,
                   _cancel=threading.Event(), _store=store, _motifs=motifs)
        with self.lock:
            # The client cancels its superseded Apply. Other views' jobs remain
            # queued on the single worker instead of cancelling each other.
            finished = [key for key, value in self.jobs.items() if value['status'] not in ('queued', 'running')]
            for key in finished[:-7]:
                self.jobs.pop(key, None)
            self.jobs[job_id] = job
        self.pool.submit(self.run, job_id)
        return self.status(job_id)

    def update(self, job_id, **values):
        with self.lock:
            self.jobs[job_id].update(values)

    def status(self, job_id):
        with self.lock:
            return {key: value for key, value in self.jobs[job_id].items() if not key.startswith('_')}

    def cancel(self, job_id):
        with self.lock:
            self.jobs[job_id]['_cancel'].set()
        return self.status(job_id)

    def run(self, job_id):
        job = self.jobs[job_id]; store = job['_store']; cancelled = job['_cancel'].is_set
        try:
            if cancelled():
                raise SearchCancelled()
            store.ensure_layout()
            stat = store.path.stat()
            revision = hashlib.sha256(f'{store.path}:{stat.st_mtime_ns}:{stat.st_size}'.encode()).hexdigest()
            cache = MotifCache(store.directory / 'motif-cache-v2.sqlite')
            composition = composition_key(job['_motifs'])
            with store.connect() as db:
                total = db.execute('SELECT count(*) FROM rows').fetchone()[0]
                self.update(job_id, status='running', total=total, composition=composition,
                            revision=revision, _cache=cache, _matched=set(), started=time.monotonic())
                # Cursor iteration keeps the inventory off the Python/JS heaps.
                records = db.execute('SELECT r.block,r.id,b.length FROM rows r JOIN blocks b ON b.id=r.block ORDER BY r.block,r.id')
                for row in records:
                    if cancelled():
                        raise SearchCancelled()
                    if row['length'] > 50_000_000:
                        raise ValueError('Motif search supports source blocks up to 50 million columns.')
                    block, row_id = row['block'], row['id']
                    self.update(job_id, sequence=f'Block {block} · {row_id}', phase='cached', motif_index=0)
                    key = f'{revision}:{block}:{row_id}'
                    def load():
                        return ''.join(chunk['bases'] for chunk in db.execute(
                            'SELECT bases FROM chunks WHERE block=? AND id=? ORDER BY offset', (block, row_id)))
                    result = cache.prepare(key, load, job['_motifs'], cancelled,
                                           lambda **values: self.update(job_id, **values))
                    with self.lock:
                        job['completed'] += 1
                        job['searched'] += result['searched']; job['cached'] += result['cached']
                        job['prepared_cached'] += int(result['prepared_cached'])
                        if result['matched']:
                            job['_matched'].add(block)
                        job['matched_blocks'] = len(job['_matched'])
            if cancelled():
                raise SearchCancelled()
            self.update(job_id, status='ready', phase='ready', elapsed=time.monotonic() - job['started'])
        except (SearchCancelled, TimeoutError) as exc:
            if cancelled() or isinstance(exc, SearchCancelled):
                self.update(job_id, status='cancelled', phase='cancelled')
            else:
                self.update(job_id, status='failed', error=f'Regex search timed out in {job.get("sequence", "sequence")}. Simplify the expression. Completed sequences remain cached.')
        except Exception as exc:
            self.update(job_id, status='failed', error=str(exc))

    def blocks(self, job_id, after):
        job = self.jobs[job_id]
        if job['status'] != 'ready':
            raise ValueError('Motif results are not ready')
        ids = sorted(block for block in job['_matched'] if block > after)[:1001]
        blocks = job['_store'].blocks_layout(ids[:1000])['blocks']
        return {'blocks': blocks, 'next': ids[999] if len(ids) > 1000 else None}

    def region(self, job_id, block, ids, start, end, step):
        job = self.jobs[job_id]
        if job['status'] != 'ready':
            raise ValueError('Motif results are not ready')
        # Fixed aligned windows, power-of-two bins, and a hard response budget.
        if step < 1 or step & (step - 1) or start % step or (end - start) / step > 2048:
            raise ValueError('Request an aligned motif tile of at most 2,048 bins')
        rows = []
        for row in ids:
            key = f'{job["revision"]}:{block}:{row}'
            runs = job['_cache'].region(key, job['composition'], start, end, step)
            rows.append({'id': row, 'runs': runs or []})
        return {'block': block, 'start': start, 'end': end, 'step': step, 'rows': rows}
