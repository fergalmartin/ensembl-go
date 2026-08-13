/**
 * Which sequence features a transcript can offer, and what to call them.
 *
 * The backend decides the same thing in `_available_feature_types` before it
 * extracts anything; this exists so a viewer can grey out the options it cannot
 * show without waiting on a request. The two follow the same rules — explicit
 * UTR annotation first, exon-versus-CDS extent as the fallback.
 *
 * Keys match the `feature_types` vocabulary of /api/feature_explorer/export and
 * /api/feature_explorer/transcript_sequences.
 */

/**
 * What the sequence viewer offers, in the order a reader wants them.
 *
 * `utr` is one entry rather than two: the transcript's UTRs come back together,
 * 5' first where both exist. The export panel still addresses `utr5`/`utr3`
 * separately, and availability reports all three.
 */
export const SEQUENCE_FEATURE_TYPES = Object.freeze([
    { key: 'genomic', label: 'Genomic', unit: 'bp' },
    // "transcript" on the wire; cDNA is what a biologist calls it.
    { key: 'transcript', label: 'cDNA', unit: 'bp' },
    { key: 'cds', label: 'CDS', unit: 'bp' },
    { key: 'protein', label: 'Protein', unit: 'aa' },
    { key: 'utr', label: 'UTR', unit: 'bp' },
    { key: 'exons', label: 'Exons', unit: 'bp' },
    { key: 'introns', label: 'Introns', unit: 'bp' },
])

export const SEQUENCE_FEATURE_KEYS = Object.freeze([
    'genomic', 'transcript', 'cds', 'protein', 'utr5', 'utr3', 'utr', 'exons', 'introns',
])

/** Amino acids have no complement, so the toggle has to stand down for these. */
export const COMPLEMENTABLE_FEATURE_KEYS = Object.freeze(
    SEQUENCE_FEATURE_KEYS.filter((key) => key !== 'protein')
)

const isFivePrimeUtr = (utr) => {
    const type = String(utr?.feature_type || '').toLowerCase()
    return type.includes('five') || type.includes('5_prime') || type.includes('5prime')
}

const isThreePrimeUtr = (utr) => {
    const type = String(utr?.feature_type || '').toLowerCase()
    return type.includes('three') || type.includes('3_prime') || type.includes('3prime')
}

const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0

function emptyAvailability() {
    const out = {}
    for (const key of SEQUENCE_FEATURE_KEYS) out[key] = false
    return out
}

/**
 * What one transcript can offer.
 *
 * @param transcript a record from /api/browse/transcripts — exons, cds_list and
 *   utrs are all that matter here.
 */
export function getTranscriptFeatureAvailability(transcript) {
    const result = emptyAvailability()
    if (!transcript) return result

    const exons = Array.isArray(transcript.exons) ? transcript.exons : []
    const cdsList = Array.isArray(transcript.cds_list) ? transcript.cds_list : []
    const utrs = Array.isArray(transcript.utrs) ? transcript.utrs : []

    const start = Number(transcript.start)
    const end = Number(transcript.end)
    if ((Number.isFinite(start) && Number.isFinite(end)) || exons.length > 0) result.genomic = true

    if (exons.length > 0) {
        result.transcript = true
        result.exons = true
    }
    if (exons.length >= 2) result.introns = true
    if (cdsList.length > 0) {
        result.cds = true
        result.protein = true
    }

    for (const utr of utrs) {
        if (isFivePrimeUtr(utr)) result.utr5 = true
        if (isThreePrimeUtr(utr)) result.utr3 = true
    }

    // No explicit UTR records: infer from where the exons overhang the CDS.
    if ((!result.utr5 || !result.utr3) && cdsList.length > 0 && exons.length > 0) {
        const cdsCoords = cdsList.flatMap((c) => [Number(c.start), Number(c.end)]).filter(finitePositive)
        const exonCoords = exons.flatMap((e) => [Number(e.start), Number(e.end)]).filter(finitePositive)
        if (cdsCoords.length > 0 && exonCoords.length > 0) {
            const cdsMin = Math.min(...cdsCoords)
            const cdsMax = Math.max(...cdsCoords)
            const exonMin = Math.min(...exonCoords)
            const exonMax = Math.max(...exonCoords)
            const forward = String(transcript.strand || '+') === '+'
            const leadingUtr = exonMin < cdsMin
            const trailingUtr = exonMax > cdsMax
            if (leadingUtr) { if (forward) result.utr5 = true; else result.utr3 = true }
            if (trailingUtr) { if (forward) result.utr3 = true; else result.utr5 = true }
        }
    }

    // The combined entry only needs one end to be worth offering.
    result.utr = result.utr5 || result.utr3

    return result
}

/**
 * What a set of transcripts can offer between them — a feature counts as
 * available if any one of them has it. This is what a bulk export wants: the
 * option stays selectable as long as some transcript will produce records.
 */
export function mergeTranscriptFeatureAvailability(transcripts) {
    const result = emptyAvailability()
    for (const transcript of (Array.isArray(transcripts) ? transcripts : [])) {
        const one = getTranscriptFeatureAvailability(transcript)
        for (const key of SEQUENCE_FEATURE_KEYS) {
            if (one[key]) result[key] = true
        }
    }
    return result
}

// ---------------------------------------------------------------------------
// Transcript measurements
// ---------------------------------------------------------------------------

export function featureLength(feature) {
    const start = Number(feature?.start)
    const end = Number(feature?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
    if (end < start) return 0
    return (end - start) + 1
}

export function sumFeatureLengths(features) {
    return (Array.isArray(features) ? features : [])
        .reduce((sum, feature) => sum + featureLength(feature), 0)
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart <= bEnd && bStart <= aEnd

export function isProteinCodingBiotype(biotype) {
    return String(biotype || '').toLowerCase().includes('protein_coding')
}

/**
 * The numbers a transcript summary shows: lengths, exon counts, UTR extents and
 * translation length. UTRs fall back to exon-versus-CDS overhang exactly as
 * availability does, so a transcript that reports a 5' UTR always has a length
 * to go with it.
 */
export function computeTranscriptMetadata(tx) {
    const exons = Array.isArray(tx?.exons) ? tx.exons : []
    const cdsList = Array.isArray(tx?.cds_list) ? tx.cds_list : []
    const utrs = Array.isArray(tx?.utrs) ? tx.utrs : []
    const strand = String(tx?.strand || '+')

    const transcriptLength = sumFeatureLengths(exons)
    const cdsLength = sumFeatureLengths(cdsList)

    let fivePrimeUtrLength = 0
    let threePrimeUtrLength = 0
    for (const utr of utrs) {
        const ftype = String(utr?.feature_type || '').toLowerCase()
        const len = featureLength(utr)
        if (ftype.includes('five') || ftype.includes('5_prime')) fivePrimeUtrLength += len
        else if (ftype.includes('three') || ftype.includes('3_prime')) threePrimeUtrLength += len
    }

    if ((fivePrimeUtrLength + threePrimeUtrLength) === 0 && cdsList.length > 0 && exons.length > 0) {
        const cdsStart = Math.min(...cdsList.map((cds) => Number(cds.start)).filter(Number.isFinite))
        const cdsEnd = Math.max(...cdsList.map((cds) => Number(cds.end)).filter(Number.isFinite))
        if (Number.isFinite(cdsStart) && Number.isFinite(cdsEnd)) {
            for (const exon of exons) {
                const exonStart = Number(exon?.start)
                const exonEnd = Number(exon?.end)
                if (!Number.isFinite(exonStart) || !Number.isFinite(exonEnd) || exonEnd < exonStart) continue
                const leftLen = exonStart < cdsStart ? Math.max(0, (Math.min(exonEnd, cdsStart - 1) - exonStart) + 1) : 0
                const rightLen = exonEnd > cdsEnd ? Math.max(0, (exonEnd - Math.max(exonStart, cdsEnd + 1)) + 1) : 0
                if (strand === '-') {
                    fivePrimeUtrLength += rightLen
                    threePrimeUtrLength += leftLen
                } else {
                    fivePrimeUtrLength += leftLen
                    threePrimeUtrLength += rightLen
                }
            }
        }
    }

    const cdsExonCount = exons.filter((exon) => {
        const exonStart = Number(exon?.start)
        const exonEnd = Number(exon?.end)
        if (!Number.isFinite(exonStart) || !Number.isFinite(exonEnd)) return false
        return cdsList.some((cds) => {
            const cdsStart = Number(cds?.start)
            const cdsEnd = Number(cds?.end)
            if (!Number.isFinite(cdsStart) || !Number.isFinite(cdsEnd)) return false
            return overlaps(exonStart, exonEnd, cdsStart, cdsEnd)
        })
    }).length

    // The stop codon is translated but not carried in the peptide.
    const translationLength = cdsLength >= 3 ? Math.max(Math.floor(cdsLength / 3) - 1, 0) : 0

    return {
        id: String(tx?.id || ''),
        version: String(tx?.version || ''),
        biotype: String(tx?.biotype || ''),
        transcriptLength,
        exonCount: exons.length,
        cdsLength,
        translationLength,
        cdsExonCount,
        fivePrimeUtrLength,
        threePrimeUtrLength,
        hasCds: cdsList.length > 0,
        isProteinCoding: isProteinCodingBiotype(tx?.biotype),
    }
}
