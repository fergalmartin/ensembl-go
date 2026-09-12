"""Search whole source rows, independently of the viewport and sequence tiles."""
import time

import regex


MAX_RUNS = 50_000
MAX_SEQUENCE = 50_000_000


def motif_spans(sequence, pattern, kind='literal', timeout=0.5):
    """Return disjoint aligned spans; gaps never acquire a motif colour.

    Overlapping occurrences count. Anchors/lookarounds see the complete ungapped
    block, including sequence outside a cropped layer or a viewport tile.
    """
    expression = regex.compile(regex.escape(pattern) if kind == 'literal' else pattern,
                               regex.IGNORECASE | regex.VERSION1)
    deadline = time.monotonic() + timeout
    text = sequence.replace('-', '')
    runs = []
    for match in expression.finditer(text, overlapped=True, timeout=timeout):
        if time.monotonic() > deadline:
            raise TimeoutError()
        a, z = match.span()
        if a == z:
            continue  # Assertions alone have no bases to colour.
        if runs and a <= runs[-1][1]:
            runs[-1][1] = max(z, runs[-1][1])
        else:
            runs.append([a, z])
        if len(runs) > MAX_RUNS:
            raise ValueError('Too many matches. Use a more specific motif.')
    # Stream gap mapping instead of allocating one coordinate per base or gap.
    aligned, index, offset = [], 0, 0
    for segment in regex.finditer('[^-]+', sequence):
        if index >= len(runs):
            break
        if time.monotonic() > deadline:
            raise TimeoutError()
        start, end = segment.span()
        segment_end = offset + end - start
        while index < len(runs) and runs[index][0] < segment_end:
            a, z = runs[index]
            aligned.append([start + max(0, a - offset), min(end, start + z - offset)])
            if len(aligned) > MAX_RUNS:
                raise ValueError('Too many match spans. Use a more specific motif.')
            if z > segment_end:
                break
            index += 1
        offset = segment_end
    return aligned


def search_row(store, block, row_id, motifs):
    with store.connect() as db:
        record = db.execute('SELECT length FROM blocks WHERE id=?', (block,)).fetchone()
        if record is None:
            raise ValueError('Alignment block not found')
        if record['length'] > MAX_SEQUENCE:
            raise ValueError('Motif search supports source blocks up to 50 million columns.')
        sequence = ''.join(row['bases'] for row in db.execute(
            'SELECT bases FROM chunks WHERE block=? AND id=? ORDER BY offset', (block, row_id)))
    spans, errors = {}, {}
    deadline = time.monotonic() + 4
    total = 0
    for motif in motifs:
        key = motif.id
        try:
            if time.monotonic() >= deadline:
                raise TimeoutError()
            found = motif_spans(sequence, motif.pattern, motif.kind)
            if total + len(found) > MAX_RUNS:
                raise ValueError('Too many match spans in this row. Use more specific motifs.')
            spans[key] = found
            total += len(found)
        except regex.error as exc:
            errors[key] = f'Invalid regular expression: {exc}'
        except TimeoutError:
            errors[key] = 'Search timed out. Simplify this motif or enable fewer motifs.'
        except ValueError as exc:
            errors[key] = str(exc)
    return {'block': block, 'row': row_id, 'spans': spans, 'errors': errors}


def matching_blocks_page(store, motifs, after=0, limit=16):
    """Bounded pages for a cancellable client scan of the entire alignment.

    Failure is explicit: an invalid or timed-out expression must never silently
    classify an unsearched block as having no matches.
    """
    expressions = []
    for motif in motifs:
        try:
            expressions.append(regex.compile(regex.escape(motif.pattern) if motif.kind == 'literal' else motif.pattern,
                                             regex.IGNORECASE | regex.VERSION1))
        except regex.error as exc:
            raise ValueError(f'Fix the invalid motif {motif.pattern!r} before hiding blocks: {exc}') from exc
    matched = []
    deadline = time.monotonic() + 10
    with store.connect() as db:
        blocks = db.execute('SELECT id,length FROM blocks WHERE id>? ORDER BY id LIMIT ?', (after, limit + 1)).fetchall()
        for block in blocks[:limit]:
            if block['length'] > MAX_SEQUENCE:
                raise ValueError('Cannot filter source blocks larger than 50 million columns by motif.')
            rows = db.execute('SELECT id FROM rows WHERE block=?', (block['id'],)).fetchall()
            found = False
            for row in rows:
                if time.monotonic() > deadline:
                    raise ValueError('Block search timed out. Simplify the motifs before hiding blocks.')
                text = ''.join(chunk['bases'] for chunk in db.execute(
                    'SELECT bases FROM chunks WHERE block=? AND id=? ORDER BY offset', (block['id'], row['id']))).replace('-', '')
                try:
                    found = any(any(m.end() > m.start() for m in expression.finditer(text, timeout=.5)) for expression in expressions)
                except TimeoutError as exc:
                    raise ValueError('Block search timed out. Simplify the motifs before hiding blocks.') from exc
                if found:
                    break
            if found:
                matched.append(block['id'])
    return {'blocks': store.blocks_layout(matched)['blocks'] if matched else [],
            'scanned': len(blocks[:limit]), 'next': blocks[limit - 1]['id'] if len(blocks) > limit else None}
