// Feature alignment geometry: the genomic window around a transcript, projecting
// transcript features onto alignment columns, and genomic-to-column maps. Pure functions.

export function getAlignmentWindowForTranscript(transcript, flank5 = 0, flank3 = 0) {
  if (!transcript) return null
  const txStart = Number(transcript.start)
  const txEnd = Number(transcript.end)
  if (!Number.isFinite(txStart) || !Number.isFinite(txEnd)) return null
  const strand = String(transcript.strand || '+')
  const safeFlank5 = Math.max(0, Number(flank5) || 0)
  const safeFlank3 = Math.max(0, Number(flank3) || 0)
  const left = Math.min(txStart, txEnd)
  const right = Math.max(txStart, txEnd)
  if (strand === '-') {
    return {
      start: left - safeFlank3,
      end: right + safeFlank5,
      strand,
    }
  }
  return {
    start: left - safeFlank5,
    end: right + safeFlank3,
    strand,
  }
}

export function getTranscriptSpan(transcript) {
  if (!transcript) return null
  const txStart = Number(transcript.start)
  const txEnd = Number(transcript.end)
  if (!Number.isFinite(txStart) || !Number.isFinite(txEnd)) return null
  return {
    start: Math.min(txStart, txEnd),
    end: Math.max(txStart, txEnd),
    strand: String(transcript.strand || '+'),
  }
}

export function getTranscriptBoundaryStatus(transcriptSpan, alignmentStart, alignmentEnd) {
  if (!transcriptSpan) return 'unknown'
  const left = Math.min(Number(alignmentStart), Number(alignmentEnd))
  const right = Math.max(Number(alignmentStart), Number(alignmentEnd))
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 'unknown'
  if (transcriptSpan.start >= left && transcriptSpan.end <= right) return 'within'
  if (transcriptSpan.end >= left && transcriptSpan.start <= right) return 'partial'
  return 'outside'
}

export function normalizeResolvedTranscriptSegments(segments, type) {
  if (!Array.isArray(segments)) return []
  return segments
    .map((segment) => {
      const start = Math.min(Number(segment?.start), Number(segment?.end))
      const end = Math.max(Number(segment?.start), Number(segment?.end))
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null
      return { type, start, end }
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

export function classifyResolvedUtrType(utr, cdsSegments, strand) {
  const rawType = String(
    utr?.feature_type
    || utr?.featureType
    || utr?.type
    || ''
  ).trim().toLowerCase()
  if (rawType.includes('five')) return 'utr5'
  if (rawType.includes('three')) return 'utr3'
  if (rawType.includes('5')) return 'utr5'
  if (rawType.includes('3')) return 'utr3'

  const normalizedCds = normalizeResolvedTranscriptSegments(cdsSegments, 'cds')
  if (!normalizedCds.length) return 'utr'
  const cdsMin = Math.min(...normalizedCds.map((segment) => segment.start))
  const cdsMax = Math.max(...normalizedCds.map((segment) => segment.end))
  const utrStart = Math.min(Number(utr?.start), Number(utr?.end))
  const utrEnd = Math.max(Number(utr?.start), Number(utr?.end))
  if (!Number.isFinite(utrStart) || !Number.isFinite(utrEnd)) return 'utr'

  if (String(strand || '+') === '-') {
    if (utrStart > cdsMax) return 'utr5'
    if (utrEnd < cdsMin) return 'utr3'
  } else {
    if (utrEnd < cdsMin) return 'utr5'
    if (utrStart > cdsMax) return 'utr3'
  }
  return 'utr'
}

export function projectedFeaturePriority(type) {
  const t = String(type || '').trim().toLowerCase()
  if (t === 'start_codon' || t === 'stop_codon' || t === 'donor' || t === 'acceptor' || t === 'splice_site') return 3
  if (t === 'cds' || t === 'utr' || t === 'utr5' || t === 'utr3') return 2
  return 1 // exon / intron / fallback
}

export function buildProjectedTranscriptFeatures(transcript, genomicToAlign) {
  if (!transcript || !(genomicToAlign instanceof Map) || genomicToAlign.size === 0) return []

  const mapRange = (features) => {
    const projected = []
    for (const feature of features) {
      let projectedStart = null
      let projectedEnd = null
      for (let pos = feature.start; pos <= feature.end; pos += 1) {
        const mapped = genomicToAlign.get(pos)
        if (mapped == null) continue
        if (projectedStart == null) projectedStart = mapped
        projectedEnd = mapped
      }
      if (projectedStart == null || projectedEnd == null) continue
      projected.push({
        ...feature,
        start: Math.min(projectedStart, projectedEnd),
        end: Math.max(projectedStart, projectedEnd),
      })
    }
    return projected
  }

  const strand = String(transcript.strand || '+')
  const genomicExons = normalizeResolvedTranscriptSegments(transcript.exons, 'exon')
  const genomicCds = normalizeResolvedTranscriptSegments(transcript.cds_list, 'cds')
  const genomicUtrs = (Array.isArray(transcript.utrs) ? transcript.utrs : [])
    .map((utr) => {
      const start = Math.min(Number(utr?.start), Number(utr?.end))
      const end = Math.max(Number(utr?.start), Number(utr?.end))
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null
      return {
        type: classifyResolvedUtrType(utr, transcript.cds_list, strand),
        start,
        end,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const genomicIntrons = []
  for (let i = 0; i < genomicExons.length - 1; i += 1) {
    const start = Number(genomicExons[i].end) + 1
    const end = Number(genomicExons[i + 1].start) - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    genomicIntrons.push({ type: 'intron', start, end })
  }

  const biologicalExons = [...genomicExons].sort((a, b) => (
    strand === '-'
      ? (b.start - a.start || b.end - a.end)
      : (a.start - b.start || a.end - b.end)
  ))
  const genomicSpliceSites = []
  for (let i = 0; i < biologicalExons.length; i += 1) {
    const exon = biologicalExons[i]
    if (i < biologicalExons.length - 1) {
      if (strand === '-') genomicSpliceSites.push({ type: 'donor', start: exon.start - 2, end: exon.start - 1 })
      else genomicSpliceSites.push({ type: 'donor', start: exon.end + 1, end: exon.end + 2 })
    }
    if (i > 0) {
      if (strand === '-') genomicSpliceSites.push({ type: 'acceptor', start: exon.end + 1, end: exon.end + 2 })
      else genomicSpliceSites.push({ type: 'acceptor', start: exon.start - 2, end: exon.start - 1 })
    }
  }

  const genomicCodons = []
  if (genomicCds.length > 0) {
    const sortedCds = [...genomicCds].sort((a, b) => a.start - b.start || a.end - b.end)
    if (strand === '-') {
      const firstBiologicalCds = sortedCds[sortedCds.length - 1]
      const lastBiologicalCds = sortedCds[0]
      genomicCodons.push({ type: 'start_codon', start: firstBiologicalCds.end - 2, end: firstBiologicalCds.end })
      genomicCodons.push({ type: 'stop_codon', start: lastBiologicalCds.start, end: lastBiologicalCds.start + 2 })
    } else {
      const firstBiologicalCds = sortedCds[0]
      const lastBiologicalCds = sortedCds[sortedCds.length - 1]
      genomicCodons.push({ type: 'start_codon', start: firstBiologicalCds.start, end: firstBiologicalCds.start + 2 })
      genomicCodons.push({ type: 'stop_codon', start: lastBiologicalCds.end - 2, end: lastBiologicalCds.end })
    }
  }

  const exons = mapRange(genomicExons)
  const introns = mapRange(genomicIntrons)
  const cds = mapRange(genomicCds)
  const utrs = mapRange(genomicUtrs)
  const spliceSites = mapRange(genomicSpliceSites.filter((feature) => Number.isFinite(feature.start) && Number.isFinite(feature.end) && feature.end >= feature.start))
  const codons = mapRange(genomicCodons.filter((feature) => Number.isFinite(feature.start) && Number.isFinite(feature.end) && feature.end >= feature.start))

  return [...exons, ...introns, ...cds, ...utrs, ...spliceSites, ...codons]
    .sort((a, b) => {
      const pa = projectedFeaturePriority(a?.type)
      const pb = projectedFeaturePriority(b?.type)
      // Keep low-priority features first; viewer picks highest priority from the end.
      if (pa !== pb) return pa - pb
      return a.start - b.start || a.end - b.end
    })
}

export function buildAlignmentGenomicToColumnMap(alignedSequence, genomicStart, genomicEnd, strand) {
  const sequence = String(alignedSequence || '')
  const left = Math.min(Number(genomicStart), Number(genomicEnd))
  const right = Math.max(Number(genomicStart), Number(genomicEnd))
  if (!sequence || !Number.isFinite(left) || !Number.isFinite(right)) return new Map()

  const genomicToAlign = new Map()
  let genomicPos = String(strand || '+') === '-' ? right : left
  const step = String(strand || '+') === '-' ? -1 : 1
  for (let col = 0; col < sequence.length; col += 1) {
    const base = sequence[col]
    if (!base || base === '-') continue
    genomicToAlign.set(genomicPos, col)
    genomicPos += step
  }
  return genomicToAlign
}

export function getCoveredAlignmentColumnRange(genomicToAlign, requestedWindow) {
  if (!(genomicToAlign instanceof Map) || genomicToAlign.size === 0 || !requestedWindow) return null
  let minCol = null
  let maxCol = null
  const left = Math.min(Number(requestedWindow.start), Number(requestedWindow.end))
  const right = Math.max(Number(requestedWindow.start), Number(requestedWindow.end))
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null

  for (const [genomicPos, col] of genomicToAlign.entries()) {
    if (!Number.isFinite(Number(genomicPos)) || !Number.isFinite(Number(col))) continue
    if (genomicPos < left || genomicPos > right) continue
    if (minCol == null || col < minCol) minCol = col
    if (maxCol == null || col > maxCol) maxCol = col
  }

  if (minCol == null || maxCol == null) return null
  return { start: minCol, end: maxCol }
}
