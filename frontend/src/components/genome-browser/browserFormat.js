// Coordinates and transcripts in the Genome Browser: formatting (one shared
// Intl.NumberFormat), gene coordinate ranges, transcript popup metadata, intron
// chevron layout and transcript row metrics. Pure functions.
import { resolveGeneTranscriptView } from './genomeBrowserTranscriptView.js'
import { COMPRESSED_TRANSCRIPT_EXON_HEIGHT, COMPRESSED_TRANSCRIPT_MID_OFFSET, COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT, COMPRESSED_TRANSCRIPT_ROW_GAP, COMPRESSED_TRANSCRIPT_ROW_PITCH, COMPRESSED_TRANSCRIPT_TRACK_PADDING, EXON_HEIGHT, FLATTENED_COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT, FLATTENED_COMPRESSED_TRANSCRIPT_TRACK_PADDING, FLATTENED_TRANSCRIPT_MID_OFFSET, FLATTENED_TRANSCRIPT_MIN_TRACK_HEIGHT, FLATTENED_TRANSCRIPT_ROW_GAP, FLATTENED_TRANSCRIPT_ROW_PITCH, FLATTENED_TRANSCRIPT_TRACK_PADDING, TRACK_HEIGHT } from './browserConstants.js'

// Shared for the same reason as the ruler's: this runs per label, per frame.
export const COORD_FORMAT = new Intl.NumberFormat()

export function formatCoord(n) {
    const value = Number(n)
    if (!Number.isFinite(value)) return '—'
    return COORD_FORMAT.format(Math.round(value))
}

export function formatBp(n) {
    const value = Number(n)
    if (!Number.isFinite(value)) return '—'
    const abs = Math.abs(value)
    const sign = value < 0 ? '-' : ''
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}Mb`
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}kb`
    return `${sign}${abs}bp`
}

export function hasGeneCoords(gene) {
    return Boolean(gene) && Number.isFinite(Number(gene.start)) && Number.isFinite(Number(gene.end))
}

export function normalizeGeneCoord(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

export function getGeneCoordRange(gene) {
    if (!hasGeneCoords(gene)) return null
    return {
        start: normalizeGeneCoord(gene.start),
        end: normalizeGeneCoord(gene.end),
    }
}

export function formatGeneStrand(strand) {
    if (strand === '+') return 'Forward strand'
    if (strand === '-') return 'Reverse strand'
    return 'Unknown strand'
}

export function versionedStableId(id, version) {
    const stableId = String(id || '').trim()
    const stableVersion = String(version || '').trim()
    if (!stableId) return '—'
    if (!stableVersion || /\.\d+$/.test(stableId)) return stableId
    return `${stableId}.${stableVersion}`
}

export function intervalListLength(intervals) {
    return (Array.isArray(intervals) ? intervals : []).reduce((sum, interval) => {
        const start = Number(interval?.start)
        const end = Number(interval?.end)
        if (!Number.isFinite(start) || !Number.isFinite(end)) return sum
        return sum + Math.max(0, Math.abs(Math.round(end) - Math.round(start)) + 1)
    }, 0)
}

export function genomicSpanLength(start, end) {
    const s = Number(start)
    const e = Number(end)
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 0
    return Math.max(0, Math.abs(Math.round(e) - Math.round(s)) + 1)
}

export function countCdsExons(exons, cdsList) {
    const safeExons = Array.isArray(exons) ? exons : []
    const safeCdsList = Array.isArray(cdsList) ? cdsList : []
    return safeExons.filter((exon) => {
        const exonStart = Number(exon?.start)
        const exonEnd = Number(exon?.end)
        if (!Number.isFinite(exonStart) || !Number.isFinite(exonEnd)) return false
        return safeCdsList.some((cds) => {
            const cdsStart = Number(cds?.start)
            const cdsEnd = Number(cds?.end)
            if (!Number.isFinite(cdsStart) || !Number.isFinite(cdsEnd)) return false
            return Math.max(exonStart, cdsStart) <= Math.min(exonEnd, cdsEnd)
        })
    }).length
}

export function getTranscriptPopupMetadata(transcript) {
    const tx = transcript || {}
    const exons = Array.isArray(tx?.exons) ? tx.exons : []
    const cdsList = Array.isArray(tx?.cds_list) ? tx.cds_list : []
    return {
        stableId: versionedStableId(tx?.id, tx?.version),
        biotype: String(tx?.biotype || '').trim() || '—',
        genomicSpanBp: genomicSpanLength(tx?.start, tx?.end),
        transcriptLength: exons.length > 0 ? intervalListLength(exons) : genomicSpanLength(tx?.start, tx?.end),
        exonCount: exons.length,
        hasCds: cdsList.length > 0,
        cdsExonCount: countCdsExons(exons, cdsList),
        cdsLength: intervalListLength(cdsList),
    }
}

export function formatSignalDisplayValue(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return null
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return null
    return numeric
}

export function formatSignalValueForTooltip(value) {
    const numeric = formatSignalDisplayValue(value)
    if (numeric === null) return 'NA'
    if (Number.isInteger(numeric)) return numeric.toLocaleString()
    return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

export function formatSignalValueForTrack(value) {
    const numeric = formatSignalDisplayValue(value)
    if (numeric === null) return 'NA'
    const abs = Math.abs(numeric)
    if (abs >= 1000) return numeric.toFixed(0)
    if (abs >= 10) return numeric.toFixed(1)
    return numeric.toFixed(2)
}

export function getSelectedGeneCoordsForView(gene, isAligned, alignData, genomicToOverlay, options = {}) {
    const range = getGeneCoordRange(gene)
    if (!range) return null

    let start = range.start
    let end = range.end

    if (isAligned && alignData) {
        const o1 = genomicToOverlay(start)
        const o2 = genomicToOverlay(end)
        start = Math.min(o1, o2)
        end = Math.max(o1, o2)
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    if (end <= start) end = start + 1

    const targetFillFractionRaw = Number(options?.targetFillFraction)
    const targetFillFraction = Number.isFinite(targetFillFractionRaw) && targetFillFractionRaw > 0 && targetFillFractionRaw < 1
        ? targetFillFractionRaw
        : 0.8
    const span = Math.max(1, end - start)
    const paddedSpan = span / targetFillFraction
    const flank = Math.max(0, (paddedSpan - span) / 2)

    start -= flank
    end += flank
    return { start, end }
}

export function getTranscriptDisplayList(transcripts, limit) {
    return resolveGeneTranscriptView({
        transcripts,
        limit: Math.max(1, Math.floor(Number(limit) || 1)),
    }).transcripts
}

export function getFeatureCoordsForView(start, end, isAligned, alignData, genomicToOverlay) {
    let normalizedStart = Number(start)
    let normalizedEnd = Number(end)
    if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return null

    if (isAligned && alignData) {
        const o1 = genomicToOverlay(normalizedStart)
        const o2 = genomicToOverlay(normalizedEnd)
        normalizedStart = Math.min(o1, o2)
        normalizedEnd = Math.max(o1, o2)
    } else if (normalizedEnd < normalizedStart) {
        const swap = normalizedStart
        normalizedStart = normalizedEnd
        normalizedEnd = swap
    }

    if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return null
    if (normalizedEnd <= normalizedStart) normalizedEnd = normalizedStart + 1
    return { start: normalizedStart, end: normalizedEnd }
}

export function getTranscriptLayoutMetrics(isCompressed, isFlattened = false) {
    if (isCompressed) {
        return {
            rowPitch: COMPRESSED_TRANSCRIPT_ROW_PITCH,
            rowGap: COMPRESSED_TRANSCRIPT_ROW_GAP,
            exonHeight: COMPRESSED_TRANSCRIPT_EXON_HEIGHT,
            trackPadding: isFlattened ? FLATTENED_COMPRESSED_TRANSCRIPT_TRACK_PADDING : COMPRESSED_TRANSCRIPT_TRACK_PADDING,
            midOffset: COMPRESSED_TRANSCRIPT_MID_OFFSET,
            minTrackHeight: isFlattened ? FLATTENED_COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT : COMPRESSED_TRANSCRIPT_MIN_TRACK_HEIGHT,
            flattened: isFlattened,
        }
    }

    if (isFlattened) {
        return {
            rowPitch: FLATTENED_TRANSCRIPT_ROW_PITCH,
            rowGap: FLATTENED_TRANSCRIPT_ROW_GAP,
            exonHeight: EXON_HEIGHT,
            trackPadding: FLATTENED_TRANSCRIPT_TRACK_PADDING,
            midOffset: FLATTENED_TRANSCRIPT_MID_OFFSET,
            minTrackHeight: FLATTENED_TRANSCRIPT_MIN_TRACK_HEIGHT,
            flattened: true,
        }
    }

    return {
        rowPitch: TRACK_HEIGHT + 2,
        rowGap: 2,
        exonHeight: EXON_HEIGHT,
        trackPadding: 16,
        midOffset: (TRACK_HEIGHT - 14) / 2,
        minTrackHeight: 36,
        flattened: false,
    }
}

export function formatRegionCoord(chrom, start, end) {
    if (!chrom) return '—'
    const formattedStart = formatCoord(start)
    const formattedEnd = formatCoord(end)
    if (formattedStart === '—' || formattedEnd === '—') return chrom
    return `${chrom}:${formattedStart}-${formattedEnd}`
}
