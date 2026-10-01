"""From transcripts to a stored, annotated alignment.

``prepare_row`` cuts a transcript's region and reads its sequence; ``estimate`` says how
big a job a set of prepared rows makes; ``align`` runs them through the aligner handed
in (MAFFT, from the app) and maps each row's features onto its aligned row.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .features import map_features
from .project import summarise
from .regions import fetch_sequence, normalise_transcript, params_of, plan_region, structure_hash
from .store import row_signature, sequence_hash

# Beyond these, a run gets a warning before it starts (roughly: a minute or more with MAFFT).
LARGE_ROWS, LARGE_TOTAL_BP, LARGE_MAX_BP = 80, 1_000_000, 50_000
VERY_LARGE_ROWS, VERY_LARGE_TOTAL_BP, VERY_LARGE_MAX_BP = 300, 5_000_000, 200_000

Fetch = Callable[[str, int, int], Tuple[str, int, int]]
Progress = Callable[[Dict[str, Any]], None]


def settings_params(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Region parameters from a request's settings (``region``, ``flank``/``flank_5``/``flank_3``, ``intron_edge``)."""
    mode = 'genomic' if str(settings.get('region') or settings.get('mode') or '') == 'genomic' else 'exons'
    flank = settings.get('flank')
    flank_5 = settings.get('flank_5', flank if flank is not None else 100)
    flank_3 = settings.get('flank_3', flank if flank is not None else 100)
    edge = settings.get('intron_edge', 10)
    clamp = lambda v, hi: max(0, min(hi, int(v or 0)))  # noqa: E731
    return {'mode': mode, 'flank_5': clamp(flank_5, 5000), 'flank_3': clamp(flank_3, 5000),
            'intron_edge': clamp(edge, 500) if mode == 'exons' else 0}


def prepare_row(row_key: str, transcript: Any, fetch: Fetch, params: Dict[str, Any],
                extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """One row, ready to align: its region, sequence and signature, plus ``extra`` metadata."""
    tx = normalise_transcript(transcript)
    # A whole-gene region spans the gene, as the MSA view's default window does.
    gene = (transcript.get('gene_start'), transcript.get('gene_end')) if isinstance(transcript, dict) else None
    planned = plan_region(tx, params['mode'], params['flank_5'], params['flank_3'], params['intron_edge'],
                          bounds=gene if gene and all(gene) else None)
    region, sequence = fetch_sequence(planned, fetch)
    if not sequence:
        raise ValueError('no sequence could be read for this transcript')
    input_hash, structure = sequence_hash(sequence), structure_hash(tx)
    return {
        **(extra or {}),
        'row_key': row_key,
        'transcript_id': tx['id'],
        'chrom': tx['chrom'],
        'strand': tx['strand'],
        'genomic_start': min(s['start'] for s in region['segments']),
        'genomic_end': max(s['end'] for s in region['segments']),
        'flank_5_bp': params['flank_5'],
        'flank_3_bp': params['flank_3'],
        'raw_length': len(sequence),
        'region': region,
        'input_hash': input_hash,
        'structure': structure,
        'signature': row_signature(row_key, params_of(region), input_hash, structure),
        '_transcript': tx,
        '_sequence': sequence,
    }


def estimate(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """How big an alignment job is: sizes, a rough time, and 'ok' / 'large' / 'very_large'."""
    lengths = [int(r.get('raw_length') or 0) for r in rows]
    n, total, longest = len(lengths), sum(lengths), max(lengths) if lengths else 0
    # A rough fit for MAFFT FFT-NS-2 on a laptop: distances grow with n², alignment with total length.
    seconds = round(1 + total / 60_000 + (n * n) * max(1, longest) / 4e8, 1)
    if n > VERY_LARGE_ROWS or total > VERY_LARGE_TOTAL_BP or longest > VERY_LARGE_MAX_BP:
        level = 'very_large'
    elif n > LARGE_ROWS or total > LARGE_TOTAL_BP or longest > LARGE_MAX_BP:
        level = 'large'
    else:
        level = 'ok'
    return {'rows': n, 'total_bp': total, 'max_bp': longest, 'seconds': seconds, 'level': level}


def align(rows: Sequence[Dict[str, Any]], params: Dict[str, Any],
          align_fn: Callable[[List[Tuple[str, str]], Progress, Callable[[], bool]], Tuple[Dict[str, str], str]],
          on_progress: Progress = lambda p: None, cancelled: Callable[[], bool] = lambda: False) -> Dict[str, Any]:
    """Align prepared rows and annotate them: ``{params, strategy, consensus, rows}``.

    ``align_fn(ordered, on_progress, cancelled)`` returns ``({id: aligned}, strategy)``.
    Each returned row keeps its metadata and gains ``aligned`` and ``features``; the
    private ``_transcript`` / ``_sequence`` are dropped.
    """
    unique: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        unique.setdefault(row['row_key'], row)
    ordered = [(f'r{i}', row['_sequence']) for i, row in enumerate(unique.values())]
    if len(ordered) < 2:
        raise ValueError('at least two sequences are needed to align')
    aligned, strategy = align_fn(ordered, on_progress, cancelled)
    if cancelled():
        raise InterruptedError('cancelled')
    on_progress({'phase': 'mapping', 'fraction': 0.97})
    out = []
    for (seq_id, _), row in zip(ordered, unique.values()):
        gapped = str(aligned.get(seq_id) or '').upper()
        if not gapped:
            raise RuntimeError(f"the aligner returned nothing for {row['row_key']}")
        features = map_features(row['_transcript'], row['region'], gapped, row['_sequence'])
        out.append({**{k: v for k, v in row.items() if not k.startswith('_')}, 'aligned': gapped, 'features': features})
    stats = summarise(out)
    return {'params': params, 'strategy': strategy, 'rows': out, **stats}
