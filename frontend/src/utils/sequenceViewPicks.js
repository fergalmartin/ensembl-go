// What the reader has ticked off the list, and what it becomes.
//
// A tick makes a *record*: a named range that the view draws as its own entry,
// headed by its name. Genes are ticked off a location, transcripts off a gene,
// exons and introns off a transcript -- the same act at every level.
//
// **Picks belong to the thing they were picked from.** Tick two transcripts of
// one gene, open another gene, and they are gone: they described the first gene
// and mean nothing under the second. That is what `scope` is for. It is the
// identity of the parent, and a pick set carries the scope it was made in, so a
// stale set is recognised rather than remembered.

import {
    LEVEL_FEATURE,
    LEVEL_GENE,
    LEVEL_LOCATION,
    LEVEL_TRANSCRIPT,
} from './sequenceViewFocus.js'

export const EMPTY_PICKS = Object.freeze({ scope: '', items: Object.freeze([]) })

/**
 * The identity of the thing whose children are being ticked.
 *
 * Deliberately the parent rather than the level: moving along a chromosome does
 * not change which genes are on offer, but opening a different gene does change
 * which transcripts are.
 */
export function pickScope(focus) {
    if (!focus?.genomeKey) return ''
    switch (focus.level) {
        case LEVEL_LOCATION:
            if (!focus.location) return ''
            return `loc:${focus.genomeKey}:${focus.chrom}:${focus.location.start}-${focus.location.end}`
        case LEVEL_GENE:
            return focus.gene?.id ? `gene:${focus.genomeKey}:${focus.gene.id}` : ''
        case LEVEL_TRANSCRIPT:
            return focus.transcript?.id ? `tx:${focus.genomeKey}:${focus.transcript.id}` : ''
        default:
            // A feature and an ad-hoc selection have nothing below them to tick.
            return ''
    }
}

/** A gene as a record: its own span, named by symbol where it has one. */
export function geneRecord(gene, chrom) {
    if (!gene?.id) return null
    const start = Number(gene.s ?? gene.start)
    const end = Number(gene.e ?? gene.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    return {
        key: `gene:${gene.id}`,
        kind: 'gene',
        label: gene.name || gene.id,
        // The identifier alongside the symbol, but never the same string twice:
        // a gene with no symbol comes back named by its identifier, and the
        // heading would then carry it once as a name and again as a detail.
        detail: gene.name && gene.name !== gene.id ? gene.id : '',
        level: LEVEL_GENE,
        chrom,
        start: Math.min(start, end),
        end: Math.max(start, end),
        strand: gene.strand || '+',
        geneId: gene.id,
        transcriptId: '',
    }
}

export function transcriptRecord(transcript, chrom, geneId = '') {
    if (!transcript?.id) return null
    const start = Number(transcript.s ?? transcript.start)
    const end = Number(transcript.e ?? transcript.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    return {
        key: `tx:${transcript.id}`,
        kind: 'transcript',
        label: transcript.id,
        detail: transcript.biotype || '',
        level: LEVEL_TRANSCRIPT,
        chrom,
        start: Math.min(start, end),
        end: Math.max(start, end),
        strand: transcript.strand || '+',
        geneId,
        transcriptId: transcript.id,
    }
}

/**
 * An exon or an intron as a record.
 *
 * Its classes come from its transcript, windowed to the feature -- which is
 * exactly what the `feature` level means, so the record carries the transcript
 * it belongs to as well as its own extent.
 */
export function featureRecord(feature, chrom, transcriptId = '') {
    if (!feature?.kind) return null
    const start = Number(feature.s ?? feature.start)
    const end = Number(feature.e ?? feature.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    return {
        key: `${feature.kind}:${transcriptId}:${feature.index}`,
        kind: feature.kind,
        label: `${feature.kind} ${feature.index}`,
        detail: transcriptId,
        level: LEVEL_FEATURE,
        chrom,
        start: Math.min(start, end),
        end: Math.max(start, end),
        strand: feature.strand || '+',
        geneId: '',
        transcriptId,
    }
}

/** The picks that still apply, which is none once the parent has changed. */
export function picksFor(picks, scope) {
    if (!scope || picks?.scope !== scope) return EMPTY_PICKS.items
    return picks.items || EMPTY_PICKS.items
}

/**
 * Tick or untick one record.
 *
 * Order is the order they were ticked, which is the order they are drawn: the
 * reader built the list, so the list is theirs to have in the order they made
 * it rather than sorted back into coordinate order behind their back.
 */
export function togglePick(picks, scope, record) {
    if (!scope || !record?.key) return picks || EMPTY_PICKS
    const current = picksFor(picks, scope)
    const without = current.filter((item) => item.key !== record.key)
    if (without.length !== current.length) return { scope, items: without }
    return { scope, items: [...current, record] }
}

export function clearPicks() {
    return EMPTY_PICKS
}

export function isPicked(picks, scope, key) {
    return picksFor(picks, scope).some((item) => item.key === key)
}
