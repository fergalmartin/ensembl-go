"""What two aligned rows actually differ by, counted rather than interpreted.

The vocabulary here is deliberately observational and deliberately directional.
There is no "insertion" and no "deletion": which of those a column is depends on
a history neither row records, and a pairwise alignment is not evidence for it.
What can be said is that one row has a base where the other has a gap, and which
row is which — so every count names the row it is about, relative to the row it
is being read against.

Columns where both rows are gapped are excluded from every comparable total.
They are an artefact of the other rows in the block and say nothing about these
two. Unknown sequence (``N`` and the rest of IUPAC) and absent coverage are
likewise never counted as difference: not knowing is not the same as differing.
"""
from collections import Counter

CANONICAL = set('ACGTacgt')

#: The kinds a column of a pair can be. Each is a statement about what is there,
#: never about what happened.
KINDS = ('match', 'substitution', 'target_gap', 'reference_gap', 'unknown', 'unavailable')


def column_kind(reference, target):
    """What one column says about a target row relative to its reference.

    ``None`` for either side means that row has no coverage here at all, which
    is a different thing from a gap: a gap is the alignment saying there is
    nothing, absence is the alignment not saying anything.
    """
    if reference is None or target is None:
        return 'unavailable'
    reference_gap, target_gap = reference == '-', target == '-'
    if reference_gap and target_gap:
        return None
    if target_gap:
        return 'target_gap'
    if reference_gap:
        return 'reference_gap'
    if reference not in CANONICAL or target not in CANONICAL:
        return 'unknown'
    return 'match' if reference.upper() == target.upper() else 'substitution'


def compare_columns(reference, target, start=0):
    """Per-column kinds for two aligned strings, and their totals.

    ``reference`` and ``target`` are the two rows over the same columns, or
    ``None`` where a row has no coverage. Returns ``(kinds, totals)`` where
    ``kinds`` is one entry per column (``None`` for a double gap) and ``totals``
    counts each kind.
    """
    width = max(len(reference or ''), len(target or ''))
    kinds, totals = [], Counter()
    for index in range(width):
        a = reference[index] if reference is not None and index < len(reference) else None
        b = target[index] if target is not None and index < len(target) else None
        kind = column_kind(a, b)
        kinds.append(kind)
        if kind:
            totals[kind] += 1
    return kinds, {kind: totals.get(kind, 0) for kind in KINDS}


def bin_kinds(kinds, bins):
    """Kinds summarised into at most ``bins`` buckets for drawing.

    Each bucket keeps every count rather than a single winner, so a band can
    show a handful of substitutions inside a long run of matches instead of
    rounding them away.
    """
    if not kinds:
        return []
    size = max(1, (len(kinds) + bins - 1) // bins)
    output = []
    for offset in range(0, len(kinds), size):
        bucket = Counter(kind for kind in kinds[offset:offset + size] if kind)
        output.append({'start': offset, 'end': min(len(kinds), offset + size),
                       **{kind: bucket.get(kind, 0) for kind in KINDS}})
    return output


def comparable(totals):
    """Columns where two canonical bases actually met.

    The denominator for identity. Gaps, unknown bases and absent coverage are
    all excluded, because none of them is evidence of agreement or of
    difference.
    """
    return totals['match'] + totals['substitution']


def measure_feature(kinds, pieces):
    """What a reference feature's columns look like on the target row.

    ``pieces`` are the feature's base-bearing column ranges on the reference.
    The counts are over exactly those columns, so "opposite" means opposite this
    feature and not merely nearby.
    """
    totals = Counter()
    for piece in pieces:
        for column in range(piece['start'], piece['end']):
            if 0 <= column < len(kinds) and kinds[column]:
                totals[kinds[column]] += 1
    counts = {kind: totals.get(kind, 0) for kind in KINDS}
    columns = sum(piece['end'] - piece['start'] for piece in pieces)
    return {
        'columns': columns,
        **counts,
        'comparable': comparable(counts),
        # Every column of the feature is a gap on the target row. Worth saying
        # plainly, and worth not calling exon loss: a target may carry the exon
        # somewhere this block does not reach, and an alignment gap is not a
        # search of the genome.
        'entirely_gapped': columns > 0 and counts['target_gap'] == columns,
    }


def describe(totals, target_label, reference_label, feature=None):
    """The counts as a sentence, with the direction always in it.

    "12 target gap columns opposite reference CDS bases" rather than "12 bp
    deletion": the first is what was measured, the second is a claim about what
    happened to whom.
    """
    def columns(count, kind):
        return f"{count:,} {kind} column" + ('' if count == 1 else 's')
    parts = []
    what = f' opposite {reference_label} {feature} bases' if feature else f' against {reference_label}'
    if totals['substitution']:
        parts.append(columns(totals['substitution'], 'substituted') + what)
    if totals['target_gap']:
        parts.append(columns(totals['target_gap'], f'{target_label} gap') + what)
    if totals['reference_gap']:
        parts.append(columns(totals['reference_gap'], f'{reference_label} gap') + f' opposite {target_label} bases')
    if totals['unknown']:
        parts.append(columns(totals['unknown'], 'unknown-base') + ', neither agreement nor difference')
    if totals['unavailable']:
        parts.append(columns(totals['unavailable'], 'uncovered') + ', where one row has no alignment')
    if not parts:
        return f'No comparable difference between {target_label} and {reference_label} here.'
    return '; '.join(parts) + '.'
