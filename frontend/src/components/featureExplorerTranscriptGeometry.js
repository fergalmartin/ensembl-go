export function orientedBoundaries(featureStart, featureEnd, strand) {
  if (strand === '-') {
    return { fivePrime: featureEnd, threePrime: featureStart }
  }
  return { fivePrime: featureStart, threePrime: featureEnd }
}

export function getCanonicalTranscript(transcripts) {
  const txs = Array.isArray(transcripts) ? transcripts.filter(Boolean) : []
  if (!txs.length) return null
  return txs.find((tx) => Boolean(tx?.is_canonical)) || txs[0]
}

export function orderedExonsFivePrimeToThreePrime(tx) {
  const strand = String(tx?.strand || '+')
  const exons = Array.isArray(tx?.exons)
    ? tx.exons
      .map((exon) => ({ start: Number(exon?.start), end: Number(exon?.end) }))
      .filter((exon) => Number.isFinite(exon.start) && Number.isFinite(exon.end) && exon.end >= exon.start)
      .sort((a, b) => a.start - b.start)
    : []
  if (strand === '-') exons.reverse()
  return exons
}

/**
 * An exon's drawable pieces, split where coding starts and stops.
 *
 * Exons and CDS arrive 1-based and inclusive, but a segment's `start`/`end` are
 * half-open: `end` is the position just past its last base. Drawn from
 * `scale(start)` to `scale(end)`, a segment therefore covers every one of its
 * bases, the last included, and neighbouring pieces of one exon meet exactly
 * rather than overlapping by a base. `exonStart`/`exonEnd` stay inclusive, as
 * the annotation gives them, because they key the exon elsewhere.
 */
export function buildTranscriptSegments(tx) {
  const exons = Array.isArray(tx?.exons) ? tx.exons : []
  const cdsList = Array.isArray(tx?.cds_list)
    ? tx.cds_list
      .map((cds) => ({ start: Number(cds?.start), end: Number(cds?.end) }))
      .filter((cds) => Number.isFinite(cds.start) && Number.isFinite(cds.end) && cds.end >= cds.start)
      .sort((a, b) => a.start - b.start)
    : []

  const segments = []
  exons.forEach((exon, exonIndex) => {
    const exonStart = Number(exon?.start)
    const exonEnd = Number(exon?.end)
    if (!Number.isFinite(exonStart) || !Number.isFinite(exonEnd) || exonEnd < exonStart) return

    const overlaps = cdsList
      .map((cds) => {
        const overlapStart = Math.max(exonStart, cds.start)
        const overlapEnd = Math.min(exonEnd, cds.end)
        return overlapEnd >= overlapStart ? { start: overlapStart, end: overlapEnd } : null
      })
      .filter(Boolean)

    let cursor = exonStart
    let segmentIndex = 0
    const push = (start, endInclusive, coding) => {
      segments.push({
        start,
        end: endInclusive + 1,
        coding,
        exonStart,
        exonEnd,
        key: `${exonIndex}-${coding ? 'c' : 'u'}-${segmentIndex}`,
      })
      segmentIndex += 1
    }
    overlaps.forEach((coding) => {
      if (coding.end < cursor) return
      const codingStart = Math.max(cursor, coding.start)
      if (codingStart > cursor) push(cursor, codingStart - 1, false)
      push(codingStart, coding.end, true)
      cursor = coding.end + 1
    })
    if (cursor <= exonEnd) push(cursor, exonEnd, false)
  })

  return segments
}

/**
 * The intron bases either side of each exon–intron boundary, `flankBp` deep.
 *
 * Takes exonic intervals (1-based, inclusive, in any order) and returns
 * inclusive ranges. Only the gaps between exons count: the transcript's own
 * ends are not splice sites. An intron no longer than both flanks together is
 * returned whole, once.
 */
export function intronFlankRanges(exons, flankBp = 10) {
  const depth = Math.max(0, Math.floor(Number(flankBp) || 0))
  const sorted = (Array.isArray(exons) ? exons : [])
    .map((exon) => ({ start: Number(exon?.start), end: Number(exon?.end) }))
    .filter((exon) => Number.isFinite(exon.start) && Number.isFinite(exon.end) && exon.end >= exon.start)
    .sort((a, b) => a.start - b.start)
  const merged = []
  for (const exon of sorted) {
    const last = merged[merged.length - 1]
    if (last && exon.start <= last.end + 1) last.end = Math.max(last.end, exon.end)
    else merged.push({ ...exon })
  }
  const ranges = []
  if (depth === 0) return ranges
  for (let i = 0; i < merged.length - 1; i += 1) {
    const gapStart = merged[i].end + 1
    const gapEnd = merged[i + 1].start - 1
    if (gapEnd < gapStart) continue
    if ((gapEnd - gapStart) + 1 <= depth * 2) {
      ranges.push({ start: gapStart, end: gapEnd })
      continue
    }
    ranges.push({ start: gapStart, end: gapStart + depth - 1 })
    ranges.push({ start: gapEnd - depth + 1, end: gapEnd })
  }
  return ranges
}

export function getTranscriptIntrons(transcript) {
  const exons = (Array.isArray(transcript?.exons) ? transcript.exons : [])
    .map((exon) => ({
      start: Number(exon?.start),
      end: Number(exon?.end),
    }))
    .filter((exon) => Number.isFinite(exon.start) && Number.isFinite(exon.end) && exon.end > exon.start)
    .sort((a, b) => a.start - b.start)

  if (exons.length < 2) return []

  const introns = []
  for (let i = 0; i < exons.length - 1; i += 1) {
    const start = exons[i].end
    const end = exons[i + 1].start
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      introns.push({ start, end })
    }
  }
  return introns
}

export function getDefaultChevronPositions(start, end, spacing) {
  const usableStart = Number(start)
  const usableEnd = Number(end)
  const safeSpacing = Math.max(1, Number(spacing) || 1)
  if (!Number.isFinite(usableStart) || !Number.isFinite(usableEnd) || usableEnd <= usableStart) {
    return []
  }

  const usableLength = usableEnd - usableStart
  if (usableLength <= safeSpacing * 0.7) {
    return [(usableStart + usableEnd) / 2]
  }

  const count = Math.max(1, Math.floor(usableLength / safeSpacing))
  const step = usableLength / (count + 1)
  return Array.from({ length: count }, (_, idx) => usableStart + ((idx + 1) * step))
}

export function mergeChevronPositions(alignedPositions, defaultPositions, spacing) {
  const minGap = Math.max(4, (Number(spacing) || 1) * 0.55)
  const merged = []

  const addPosition = (position) => {
    if (!Number.isFinite(position)) return
    const alreadyPresent = merged.some((existing) => Math.abs(existing - position) < 0.5)
    if (alreadyPresent) return
    const tooClose = merged.some((existing) => Math.abs(existing - position) < minGap)
    if (tooClose) return
    merged.push(position)
  }

  ;[...(alignedPositions || []), ...(defaultPositions || [])]
    .sort((a, b) => a - b)
    .forEach(addPosition)

  return merged.sort((a, b) => a - b)
}

export function buildAlignedIntronChevronLayout(displayTxs, spacingPx, edgePaddingPx, genomicToScreen) {
  const safeSpacing = Math.max(1, Number(spacingPx) || 1)
  const safeEdgePadding = Math.max(0, Number(edgePaddingPx) || 0)
  const projectToScreen = typeof genomicToScreen === 'function' ? genomicToScreen : null
  if (!projectToScreen) return []
  const priorIntrons = []

  return (Array.isArray(displayTxs) ? displayTxs : []).map((tx) => {
    const txPositions = []
    const introns = getTranscriptIntrons(tx)

    for (const intron of introns) {
      const rawStart = projectToScreen(intron.start)
      const rawEnd = projectToScreen(intron.end)
      const usableStart = Math.min(rawStart, rawEnd) + safeEdgePadding
      const usableEnd = Math.max(rawStart, rawEnd) - safeEdgePadding
      if (!(usableEnd > usableStart)) continue

      const overlappingPriorIntrons = priorIntrons.filter((prior) => prior.end > usableStart && prior.start < usableEnd)
      const alignedPositions = overlappingPriorIntrons.flatMap((prior) =>
        prior.positions.filter((position) => position >= usableStart && position <= usableEnd)
      )
      if (alignedPositions.length === 0) {
        for (const prior of overlappingPriorIntrons) {
          const overlapStart = Math.max(prior.start, usableStart)
          const overlapEnd = Math.min(prior.end, usableEnd)
          if (overlapEnd <= overlapStart) continue
          alignedPositions.push((overlapStart + overlapEnd) / 2)
        }
      }
      const defaultPositions = getDefaultChevronPositions(usableStart, usableEnd, safeSpacing)
      const mergedPositions = mergeChevronPositions(alignedPositions, defaultPositions, safeSpacing)

      txPositions.push(...mergedPositions)
      priorIntrons.push({
        start: usableStart,
        end: usableEnd,
        positions: mergedPositions,
      })
    }

    return txPositions.sort((a, b) => a - b)
  })
}

export function packTranscriptRows(entries, minGapBp = 0) {
  const safeEntries = Array.isArray(entries) ? [...entries] : []
  const sorted = safeEntries.sort((a, b) => {
    const aStart = Number(a?.transcript?.start ?? a?.gene?.start ?? 0)
    const bStart = Number(b?.transcript?.start ?? b?.gene?.start ?? 0)
    if (aStart !== bStart) return aStart - bStart
    const aEnd = Number(a?.transcript?.end ?? a?.gene?.end ?? 0)
    const bEnd = Number(b?.transcript?.end ?? b?.gene?.end ?? 0)
    return aEnd - bEnd
  })

  const rowEnds = []
  const rowMap = new Map()
  for (const entry of sorted) {
    const start = Number(entry?.transcript?.start ?? entry?.gene?.start ?? 0)
    const end = Number(entry?.transcript?.end ?? entry?.gene?.end ?? start)
    let row = 0
    while (row < rowEnds.length && start < (rowEnds[row] + minGapBp)) {
      row += 1
    }
    rowEnds[row] = Math.max(rowEnds[row] || 0, end)
    rowMap.set(String(entry?.gene?.id || entry?.transcript?.id || rowMap.size), row)
  }

  return {
    rowMap,
    rowCount: Math.max(1, rowEnds.length || (sorted.length ? 1 : 0)),
  }
}
