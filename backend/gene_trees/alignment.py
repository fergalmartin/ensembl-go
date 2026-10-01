"""Alignments of the linked leaves' transcripts, for the tree's Structure and Sequence columns.

A leaf linked to a local gene becomes a row: the gene's canonical transcript (or the
tree's own transcript, when the tree names one and asked for), cut into a region and read
from its genome's FASTA by ``transcript_msa``. Rows are looked for in the alignments folder
the MSA view shares; only a run the user asks for calls MAFFT, and what it makes is saved
there for both views.

The app's own lookups are handed in (as the Neighbourhood column's are), so this package
never imports the app:

``transcript_lookup(index_path, gene_id, transcript_id|None)``
    the transcript as a dict (``SimpleTranscript`` fields), or None.
``fetcher_for(genome)``
    ``fetch(chrom, start, end) -> (forward sequence, start, end)`` for a genome record.
``align_fn(ordered, on_progress, cancelled)``
    ``({id: aligned}, strategy)``.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from transcript_msa import AlignmentStore, align, estimate, prepare_row, project, settings_params

PREPARED_BP_LIMIT = 60_000_000  # sequence kept between planning and running


def gene_key(assembly: str, gene_id: str) -> str:
    return f'{assembly}:{gene_id}'


class TreeAlignments:
    def __init__(self, genomes_provider: Callable[[], List[Dict[str, Any]]], store_root: Callable[[], Optional[Path]],
                 transcript_lookup: Callable[..., Optional[Dict[str, Any]]], fetcher_for: Callable[[Dict[str, Any]], Any],
                 align_fn: Callable[..., Tuple[Dict[str, str], str]]):
        self.genomes_provider = genomes_provider
        self.store_root = store_root
        self.transcript_lookup = transcript_lookup
        self.fetcher_for = fetcher_for
        self.align_fn = align_fn
        self.lock = threading.Lock()
        self.stores: Dict[str, AlignmentStore] = {}
        self.prepared: 'OrderedDict[tuple, Dict[str, Any]]' = OrderedDict()
        self.prepared_bp = 0

    def store(self) -> AlignmentStore:
        root = self.store_root()
        if root is None:
            raise LookupError('Set an output folder to keep alignments')
        with self.lock:
            if str(root) not in self.stores:
                self.stores[str(root)] = AlignmentStore(Path(root))
            return self.stores[str(root)]

    # ── rows ──

    def _prepare_one(self, genome: Dict[str, Any], gene_id: str, transcript_id: Optional[str],
                     params: Dict[str, Any]) -> Dict[str, Any]:
        assembly = genome['assembly']
        key = (assembly, genome.get('index_path'), genome.get('fasta_path'), gene_id, transcript_id or '',
               tuple(sorted(params.items())))
        with self.lock:
            hit = self.prepared.get(key)
            if hit is not None:
                self.prepared.move_to_end(key)
                return hit
        tx = self.transcript_lookup(genome['index_path'], gene_id, transcript_id)
        if not tx:
            raise LookupError('no transcript for this gene in the annotation')
        tx_id = str(tx.get('id') or tx.get('feature_id') or '')
        extra = {'assembly': assembly, 'gene_id': gene_id, 'gene_symbol': tx.get('gene_name') or '',
                 'genome_key': genome.get('genome_key') or assembly, 'species_key': genome.get('species_key') or '',
                 'genome_name': genome.get('display_name') or genome.get('scientific_name') or assembly,
                 'tag': tx.get('gene_name') or gene_id}
        row = prepare_row(f'{assembly}:{tx_id}', tx, self.fetcher_for(genome), params, extra)
        with self.lock:
            self.prepared[key] = row
            self.prepared_bp += row['raw_length']
            while self.prepared_bp > PREPARED_BP_LIMIT and len(self.prepared) > 1:
                _, old = self.prepared.popitem(last=False)
                self.prepared_bp -= old['raw_length']
        return row

    def prepare(self, genes: List[Dict[str, Any]], settings: Dict[str, Any],
                on_progress: Callable[[int, int], None] = lambda done, total: None,
                cancelled: Callable[[], bool] = lambda: False) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
        """``({gene key: prepared row}, [{gene, reason}])`` for ``[{assembly, gene_id, transcript_id?}]``."""
        params = settings_params(settings)
        use_tree = settings.get('transcript') == 'tree'
        genomes = {g.get('assembly'): g for g in self.genomes_provider()}
        rows: Dict[str, Dict[str, Any]] = {}
        failed: List[Dict[str, Any]] = []
        wanted = list({gene_key(g['assembly'], g['gene_id']): g for g in genes}.values())
        for i, gene in enumerate(wanted):
            if cancelled():
                raise InterruptedError('cancelled')
            key = gene_key(gene['assembly'], gene['gene_id'])
            genome = genomes.get(gene['assembly'])
            reason = None
            if not genome:
                reason = 'Its genome is not local'
            elif not genome.get('index_path'):
                reason = 'Its genome’s annotation is not indexed'
            elif not genome.get('fasta_path'):
                reason = 'Its genome has no sequence (FASTA) downloaded'
            if reason is None:
                try:
                    rows[key] = self._prepare_one(genome, gene['gene_id'], gene.get('transcript_id') if use_tree else None, params)
                except Exception as exc:  # one bad gene should not sink the rest
                    reason = str(exc) or exc.__class__.__name__
            if reason:
                failed.append({'gene': key, 'reason': reason})
            on_progress(i + 1, len(wanted))
        return rows, failed

    @staticmethod
    def _row_summary(key: str, row: Dict[str, Any]) -> Dict[str, Any]:
        return {'gene': key, 'row_key': row['row_key'], 'transcript_id': row['transcript_id'], 'raw_length': row['raw_length']}

    # ── the three steps the view takes ──

    def plan(self, genes: List[Dict[str, Any]], settings: Dict[str, Any]) -> Dict[str, Any]:
        """What aligning these genes involves, and the stored alignment that already covers them, if any."""
        rows, failed = self.prepare(genes, settings)
        covered = None
        if len({r['row_key'] for r in rows.values()}) >= 2:
            try:
                covered = self.store().find_covering(r['signature'] for r in rows.values())
            except LookupError:
                covered = None
        return {'covered': covered, 'rows': [self._row_summary(k, r) for k, r in rows.items()], 'failed': failed,
                'params': settings_params(settings), 'estimate': estimate(list({r['row_key']: r for r in rows.values()}.values()))}

    def run(self, genes: List[Dict[str, Any]], settings: Dict[str, Any], name: str,
            report: Callable[..., None], cancelled: Callable[[], bool]) -> Dict[str, Any]:
        """Align the genes (reusing a covering alignment if one appeared meanwhile) and save it."""
        store = self.store()
        report(phase='extracting', fraction=0.0)
        rows, failed = self.prepare(genes, settings, lambda done, total: report(phase='extracting', done=done, total=total,
                                                                                 fraction=0.1 * done / max(1, total)), cancelled)
        unique = list({r['row_key']: r for r in rows.values()}.values())
        if len(unique) < 2:
            raise ValueError('At least two genes with local sequence are needed to align')
        covered = store.find_covering(r['signature'] for r in unique)
        if covered:
            return {'alignment': covered, 'failed': failed, 'reused': True}

        def aligning(progress: Dict[str, Any]) -> None:
            # MAFFT's own progress (stage, pass/passes, done/total) as the middle of the job.
            if progress.get('phase') == 'mapping':
                report(phase='mapping', fraction=0.97)
            else:
                report(**{**progress, 'phase': 'aligning', 'fraction': 0.1 + 0.85 * float(progress.get('fraction') or 0)})
        result = align(unique, settings_params(settings), self.align_fn, aligning, cancelled)
        report(phase='saving', fraction=0.98)
        stem = store.save(result, name or 'gene tree', source='gene_trees', auto=True)
        return {'alignment': stem, 'failed': failed, 'reused': False}

    def rows(self, stem: str, row_keys: List[str]) -> Dict[str, Any]:
        """A stored alignment, cut down to these rows."""
        store = self.store()
        if not store.exists(stem):
            raise FileNotFoundError(stem)
        out = project(store.load(stem), row_keys)
        keep = ('row_key', 'assembly', 'gene_id', 'gene_symbol', 'transcript_id', 'chrom', 'strand', 'aligned', 'features',
                'region', 'identity', 'gap_fraction', 'raw_length', 'genome_name')
        return {'id': stem, 'name': out.get('name'), 'params': out.get('params'), 'strategy': out.get('strategy'),
                'alignment_length': out['alignment_length'], 'consensus': out['consensus'], 'missing': out['missing'],
                'rows': [{k: r.get(k) for k in keep} for r in out['rows']]}
