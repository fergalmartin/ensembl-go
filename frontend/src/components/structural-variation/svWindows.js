// Regions and windows in the structural-variation view: anchor regions, window
// zoom/pan/centring within chromosome limits, resolving typed regions against the
// reference's regions (fetched once and shared), and deriving the target window
// from loaded alignment buffers.
import { API_BASE } from '../../backendRuntime.js'
import { catalogGenomeMatchesSpecies } from '../../utils/svCatalog.js'
import { MAX_VIEW_SPAN, MIN_VIEW_SPAN } from './svConstants.js'
import { clamp } from './svFormat.js'

export let svReferenceRegionsPromise = null

export function getSvRegionKey(region) {
  return String(region?.id || region?.chrom || region?.label || '').trim()
}

export function compareSvRegionLabels(left, right) {
  const a = String(left || '').trim()
  const b = String(right || '').trim()
  const normalize = (value) => value.toLowerCase().replace(/^chr/, '')
  const aa = normalize(a)
  const bb = normalize(b)
  const special = { x: 23, y: 24, m: 25, mt: 25 }
  const an = /^\d+$/.test(aa) ? Number(aa) : special[aa]
  const bn = /^\d+$/.test(bb) ? Number(bb) : special[bb]
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  if (Number.isFinite(an)) return -1
  if (Number.isFinite(bn)) return 1
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

export function alignmentSupportsAnchorRegion(alignment, regionId) {
  const wanted = String(regionId || '').trim()
  if (!wanted) return true
  return (alignment?.reference_regions || []).some((region) => getSvRegionKey(region) === wanted)
}

export function svRegionsMatch(left, right) {
  const a = normalizeSvChromToken(left)
  const b = normalizeSvChromToken(right)
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

export function buildSvAnchorRegionOptions(outgoingAlignments) {
  const byKey = new Map()
  for (const alignment of outgoingAlignments || []) {
    if (!alignment?.supported) continue
    for (const region of alignment.reference_regions || []) {
      const key = getSvRegionKey(region)
      if (!key) continue
      const existing = byKey.get(key) || {
        ...region,
        id: key,
        chrom: region?.chrom || key,
        label: region?.label || region?.chrom || key,
        alignmentIds: [],
      }
      existing.alignmentIds = Array.from(new Set([...(existing.alignmentIds || []), alignment.id]))
      byKey.set(key, existing)
    }
  }
  return Array.from(byKey.values()).sort((a, b) => compareSvRegionLabels(a.label || a.chrom, b.label || b.chrom))
}

export function getSvRegionLength(region) {
  const indexed = Number(region?.indexed_length)
  if (Number.isFinite(indexed) && indexed > 0) return indexed
  const length = Number(region?.length || region?.end)
  if (Number.isFinite(length) && length > 0) return length
  const start = Number(region?.start)
  const end = Number(region?.end)
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end - start
  return 0
}

export function alignmentRegionForOption(alignment, option) {
  const key = getSvRegionKey(option)
  return (alignment?.reference_regions || []).find((region) => getSvRegionKey(region) === key) || null
}

export function formatSvRegionAvailabilityLabel(region, outgoingAlignments) {
  const supportingAlignments = (outgoingAlignments || []).filter((alignment) => (
    alignment?.supported && alignmentRegionForOption(alignment, region)
  ))
  const targetGenomes = []
  for (const alignment of supportingAlignments) {
    const genome = alignment?.target_genome
    if (!genome) continue
    if (targetGenomes.some((existing) => catalogGenomeMatchesSpecies(existing, genome))) continue
    targetGenomes.push(genome)
  }
  const alignmentCount = supportingAlignments.length
  const genomeCount = targetGenomes.length
  const alignmentLabel = alignmentCount === 1 ? 'alignment' : 'alignments'
  const genomeLabel = genomeCount === 1 ? 'genome' : 'genomes'
  return `${alignmentCount} ${alignmentLabel}, ${genomeCount} ${genomeLabel}`
}

export async function buildWindowForAnchorRegion(region, chromSizes, currentWindow, currentChromSize) {
  const rawChrom = String(region?.chrom || region?.label || region?.id || '').trim()
  if (!rawChrom) return null
  const chrom = getResolvedChromName(chromSizes || {}, rawChrom) || rawChrom
  const chromSize = getResolvedChromSize(chromSizes || {}, chrom)
    || getSvRegionLength(region)
    || (chrom === currentWindow?.chrom ? currentChromSize : null)
  const start = Number(region?.start)
  const end = Number(region?.end)
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return constrainWindowToZoomLimits({ chrom, start, end }, chromSize || currentChromSize)
  }
  let next = buildRegionIdentifierWindow(chrom, chromSize)
  if (!next) {
    next = await buildRegionIdentifierWindowFromBrowseRegions(rawChrom)
  }
  return next ? constrainWindowToZoomLimits(next, chromSize || currentChromSize) : null
}

export function normalizeAlignmentBlock(alignment) {
  const refStart = Number(alignment?.reference?.start)
  const refLength = Number(alignment?.reference?.length)
  const altStart = Number(alignment?.alt?.start)
  const altLength = Number(alignment?.alt?.length)
  if (!Number.isFinite(refStart) || !Number.isFinite(refLength) || refLength <= 0) return null
  if (!Number.isFinite(altStart) || !Number.isFinite(altLength) || altLength <= 0) return null
  return {
    refStart,
    refEnd: refStart + refLength - 1,
    refLength,
    altStart,
    altEnd: altStart + altLength - 1,
    altLength,
    isInversion: String(alignment?.reference?.strand || '+') !== String(alignment?.alt?.strand || '+'),
  }
}

export function svBlocksToFeatureBandAlignments(blocks) {
  if (!Array.isArray(blocks)) return []
  return blocks
    .map((block) => {
      const refStart = Number(block?.ref_start ?? NaN)
      const refEnd = Number(block?.ref_end ?? NaN)
      const altStart = Number(block?.tgt_start ?? NaN)
      const altEnd = Number(block?.tgt_end ?? NaN)
      if (
        !Number.isFinite(refStart) ||
        !Number.isFinite(refEnd) ||
        !Number.isFinite(altStart) ||
        !Number.isFinite(altEnd)
      ) {
        return null
      }
      const refLo = Math.min(refStart, refEnd)
      const refHi = Math.max(refStart, refEnd)
      const altLo = Math.min(altStart, altEnd)
      const altHi = Math.max(altStart, altEnd)
      return {
        id: String(block?.chain_id || `${refLo}:${altLo}`),
        type: block?.type || 'match',
        reference: {
          start: refLo,
          length: Math.max(1, refHi - refLo),
          strand: 'forward',
        },
        alt: {
          start: altLo,
          length: Math.max(1, altHi - altLo),
          strand: String(block?.strand || '+') === '-' ? 'reverse' : 'forward',
        },
      }
    })
    .filter(Boolean)
}

export function buildCenteredTargetWindow(refWindow, currentTgtWindow, alignments, tgtChromSize = null) {
  if (!refWindow?.chrom || !currentTgtWindow?.chrom || !alignments?.length) return null

  const refCenter = refWindow.start + ((refWindow.end - refWindow.start) / 2)
  const tgtCenter = currentTgtWindow.start + ((currentTgtWindow.end - currentTgtWindow.start) / 2)

  let bestMatchAlignment = null
  let bestMatchScore = Infinity
  let bestAlignment = null
  let bestScore = Infinity

  for (const alignment of alignments) {
    const block = normalizeAlignmentBlock(alignment)
    if (!block) continue

    const refDistance = refCenter < block.refStart
      ? block.refStart - refCenter
      : refCenter > block.refEnd
        ? refCenter - block.refEnd
        : 0
    const altMidpoint = (block.altStart + block.altEnd) / 2
    const tieBreaker = Math.abs(altMidpoint - tgtCenter) / 1_000_000
    const score = refDistance + tieBreaker

    if (score < bestScore) {
      bestScore = score
      bestAlignment = block
    }

    if (!block.isInversion && score < bestMatchScore) {
      bestMatchScore = score
      bestMatchAlignment = block
    }
  }

  const anchorAlignment = bestMatchAlignment || bestAlignment
  if (!anchorAlignment) return null

  const refAnchor = clamp(refCenter, anchorAlignment.refStart, anchorAlignment.refEnd)
  const fraction = anchorAlignment.refEnd > anchorAlignment.refStart
    ? (refAnchor - anchorAlignment.refStart) / (anchorAlignment.refEnd - anchorAlignment.refStart)
    : 0.5
  const altAnchor = anchorAlignment.isInversion
    ? anchorAlignment.altEnd - (fraction * (anchorAlignment.altEnd - anchorAlignment.altStart))
    : anchorAlignment.altStart + (fraction * (anchorAlignment.altEnd - anchorAlignment.altStart))

  return centerWindowOnRange(
    currentTgtWindow.chrom,
    altAnchor,
    Math.max(1, refWindow.end - refWindow.start),
    tgtChromSize,
    1,
  )
}

export function normalizeSvChromToken(value) {
  return String(value || '').replace(/^chr/i, '')
}

export function transformOuterWindowFromReferenceChange(currentRefWindow, nextRefWindow, currentOuterWindow, outerChromSize) {
  if (!currentRefWindow || !nextRefWindow || !currentOuterWindow) return currentOuterWindow
  const currentRefSpan = Math.max(1, Number(currentRefWindow.end) - Number(currentRefWindow.start))
  const nextRefSpan = Math.max(1, Number(nextRefWindow.end) - Number(nextRefWindow.start))
  const currentOuterSpan = Math.max(1, Number(currentOuterWindow.end) - Number(currentOuterWindow.start))
  const spanRatio = nextRefSpan / currentRefSpan

  if (!Number.isFinite(spanRatio) || spanRatio <= 0) return currentOuterWindow

  if (Math.abs(spanRatio - 1) < 0.0001) {
    const shift = Number(nextRefWindow.start) - Number(currentRefWindow.start)
    return constrainWindowToZoomLimits({
      chrom: currentOuterWindow.chrom,
      start: Math.round(Number(currentOuterWindow.start) + shift),
      end: Math.round(Number(currentOuterWindow.end) + shift),
    }, outerChromSize)
  }

  const denominator = currentRefSpan - nextRefSpan
  const anchorFraction = denominator
    ? clamp((Number(nextRefWindow.start) - Number(currentRefWindow.start)) / denominator, 0, 1)
    : 0.5
  const nextOuterSpan = Math.max(MIN_VIEW_SPAN, Math.round(currentOuterSpan * spanRatio))
  const outerAnchor = Number(currentOuterWindow.start) + (currentOuterSpan * anchorFraction)
  const nextOuterStart = Math.round(outerAnchor - (nextOuterSpan * anchorFraction))
  return constrainWindowToZoomLimits({
    chrom: currentOuterWindow.chrom,
    start: nextOuterStart,
    end: nextOuterStart + nextOuterSpan,
  }, outerChromSize)
}

export function quantizeFloor(value, step) {
  const s = Math.max(1, Math.round(step))
  return Math.floor(value / s) * s
}

export function quantizeCeil(value, step) {
  const s = Math.max(1, Math.round(step))
  return Math.ceil(value / s) * s
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aEnd >= bStart && aStart <= bEnd
}

export function parseRegionInput(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const cleaned = raw.replace(/\s+/g, '')
  const match = cleaned.match(/^([^:]+):([\d,]+)-([\d,]+)$/)
  if (!match) return cleaned ? { chrom: cleaned, bareChrom: true } : null
  const chrom = String(match[1] || '').trim()
  const start = Number(String(match[2] || '').replace(/,/g, ''))
  const end = Number(String(match[3] || '').replace(/,/g, ''))
  if (!chrom || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { chrom, start, end }
}

export function buildRegionIdentifierWindow(chrom, chromSize, maxSpan = 1_000_000) {
  const resolvedChrom = String(chrom || '').trim()
  const length = Math.floor(Number(chromSize) || 0)
  if (!resolvedChrom || length <= 0) return null
  if (length <= maxSpan) {
    return { chrom: resolvedChrom, start: 1, end: Math.max(2, length) }
  }
  const span = Math.min(maxSpan, length)
  const center = Math.max(1 + span / 2, Math.min(length - span / 2, length / 3))
  const start = Math.max(1, Math.round(center - span / 2))
  const end = Math.min(length, start + span)
  return { chrom: resolvedChrom, start, end: Math.max(start + 1, end) }
}

export function getMaxAllowedSpan(chromSize = null, minStart = 1) {
  if (Number.isFinite(chromSize) && chromSize > minStart) {
    return Math.min(MAX_VIEW_SPAN, Math.max(MIN_VIEW_SPAN, Math.round(chromSize) - minStart))
  }
  return MAX_VIEW_SPAN
}

export function zoomWindowAround(window, factor, anchorFraction = 0.5, minStart = 1, chromSize = null) {
  if (!window) return null
  const span = Math.max(1, (window.end || 0) - (window.start || 0))
  const frac = clamp(anchorFraction, 0, 1)
  const maxSpan = getMaxAllowedSpan(chromSize, minStart)
  const nextSpan = Math.round(clamp(span * factor, MIN_VIEW_SPAN, maxSpan))
  const anchorBp = (window.start || 0) + (span * frac)
  let start = Math.round(anchorBp - (nextSpan * frac))
  if (start < minStart) start = minStart
  let end = start + nextSpan
  if (Number.isFinite(chromSize) && chromSize > minStart && end > chromSize) {
    end = Math.round(chromSize)
    start = Math.max(minStart, end - nextSpan)
  }
  return { ...window, start, end }
}

export function panWindowByPixels(window, deltaPx, viewportWidth, minStart = 1, chromSize = null) {
  if (!window || !Number.isFinite(deltaPx)) return window
  const width = Math.max(1, Math.round(viewportWidth || 0))
  const span = Math.max(1, (window.end || 0) - (window.start || 0))
  const bpPerPx = span / width
  let start = Math.round((window.start || 0) + (deltaPx * bpPerPx))
  if (start < minStart) start = minStart
  let end = start + span
  if (Number.isFinite(chromSize) && chromSize > minStart && end > chromSize) {
    end = Math.round(chromSize)
    start = Math.max(minStart, end - span)
  }
  return { ...window, start, end }
}

export function centerWindowOnRange(chrom, center, span, chromSize = null, minStart = 1) {
  if (!chrom || !Number.isFinite(center) || !Number.isFinite(span) || span <= 0) return null
  const windowSpan = Math.round(clamp(span, MIN_VIEW_SPAN, getMaxAllowedSpan(chromSize, minStart)))
  let start = Math.round(center - (windowSpan / 2))
  if (start < minStart) start = minStart
  let end = start + windowSpan
  if (Number.isFinite(chromSize) && chromSize > 0 && end > chromSize) {
    end = Math.round(chromSize)
    start = Math.max(minStart, end - windowSpan)
  }
  return { chrom, start, end }
}

export function withWindowChrom(window, fallbackChrom = '') {
  if (!window) return null
  const minStart = 1
  const normalizedStart = Math.max(minStart, Number(window.start) || minStart)
  const normalizedEnd = Math.max(normalizedStart + 1, Number(window.end) || (normalizedStart + 1))
  if (window.chrom) {
    return {
      ...window,
      start: normalizedStart,
      end: normalizedEnd,
    }
  }
  return {
    ...window,
    chrom: fallbackChrom || '',
    start: normalizedStart,
    end: normalizedEnd,
  }
}

export function getResolvedChromSize(chromSizes, chrom) {
  if (!chromSizes || !chrom) return null
  if (chromSizes[chrom]) return Number(chromSizes[chrom]) || null

  const raw = String(chrom).trim()
  if (!raw) return null
  const canonical = raw.toLowerCase()
  const stripChr = canonical.startsWith('chr') ? canonical.slice(3) : canonical
  const addChr = canonical.startsWith('chr') ? canonical : `chr${canonical}`

  for (const [key, value] of Object.entries(chromSizes)) {
    const resolved = String(key || '').trim().toLowerCase()
    if (!resolved) continue
    const resolvedStrip = resolved.startsWith('chr') ? resolved.slice(3) : resolved
    if (resolved === canonical || resolved === stripChr || resolved === addChr || resolvedStrip === stripChr) {
      return Number(value) || null
    }
  }

  return null
}

export function getResolvedChromName(chromSizes, chrom) {
  if (!chromSizes || !chrom) return ''
  if (Object.prototype.hasOwnProperty.call(chromSizes, chrom)) return chrom

  const raw = String(chrom).trim()
  if (!raw) return ''
  const canonical = raw.toLowerCase()
  const stripChr = canonical.startsWith('chr') ? canonical.slice(3) : canonical
  const addChr = canonical.startsWith('chr') ? canonical : `chr${canonical}`

  for (const key of Object.keys(chromSizes)) {
    const resolved = String(key || '').trim().toLowerCase()
    if (!resolved) continue
    const resolvedStrip = resolved.startsWith('chr') ? resolved.slice(3) : resolved
    if (resolved === canonical || resolved === stripChr || resolved === addChr || resolvedStrip === stripChr) {
      return String(key)
    }
  }

  return raw
}

export function tokenVariants(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return new Set()
  const out = new Set([text])
  if (text.startsWith('chr') && text.length > 3) out.add(text.slice(3))
  else out.add(`chr${text}`)
  if (['m', 'mt', 'chrm', 'chrmt'].includes(text)) {
    out.add('m')
    out.add('mt')
    out.add('chrm')
    out.add('chrmt')
  }
  return out
}

export function intersectsTokenSet(left, right) {
  for (const value of left) {
    if (right.has(value)) return true
  }
  return false
}

export function resolveRegionFromBrowseRegions(regions, rawChrom) {
  const token = String(rawChrom || '').trim()
  if (!token || !Array.isArray(regions)) return null
  const canonical = token.toLowerCase()
  const stripChr = canonical.startsWith('chr') ? canonical.slice(3) : canonical
  const addChr = canonical.startsWith('chr') ? canonical : `chr${canonical}`
  let region = regions.find((r) => r.chrom === token)
  if (region) return region

  region = regions.find((r) => {
    const rc = String(r.chrom || '').toLowerCase()
    if (rc === canonical || rc === stripChr || rc === addChr) return true
    const rcStrip = rc.startsWith('chr') ? rc.slice(3) : rc
    return rcStrip === stripChr
  })
  if (region) return region

  const queryTokens = tokenVariants(token)
  const synonymCandidates = regions.filter((r) => {
    const regionTokens = tokenVariants(r.chrom)
    if (intersectsTokenSet(queryTokens, regionTokens)) return true
    const synonyms = Array.isArray(r.synonyms) ? r.synonyms : []
    return synonyms.some((synonym) => intersectsTokenSet(queryTokens, tokenVariants(synonym)))
  })
  if (synonymCandidates.length === 1) return synonymCandidates[0]

  if (['m', 'mt', 'chrm', 'chrmt'].includes(canonical)) {
    return regions.find((r) => {
      const rc = String(r.chrom || '').toLowerCase()
      const rcStrip = rc.startsWith('chr') ? rc.slice(3) : rc
      return rc === 'mt' || rc === 'm' || rc === 'chrm' || rc === 'chrmt' || rcStrip === 'mt' || rcStrip === 'm'
    }) || null
  }

  return null
}

export async function fetchSvReferenceRegions() {
  if (!svReferenceRegionsPromise) {
    svReferenceRegionsPromise = fetch(`${API_BASE}/api/browse/regions?genome=reference`)
      .then((res) => (res.ok ? res.json() : []))
      .catch(() => [])
  }
  return svReferenceRegionsPromise
}

export async function buildRegionIdentifierWindowFromBrowseRegions(chrom) {
  const regions = await fetchSvReferenceRegions()
  const region = resolveRegionFromBrowseRegions(regions, chrom)
  return buildRegionIdentifierWindow(region?.chrom, region?.end)
}

export function getWindowKey(window) {
  if (!window?.chrom) return ''
  return `${window.chrom}:${window.start}-${window.end}`
}

export function constrainWindowToZoomLimits(window, chromSize = null, minStart = 1) {
  if (!window?.chrom || !Number.isFinite(window?.start) || !Number.isFinite(window?.end)) return window
  const center = (Number(window.start) + Number(window.end)) / 2
  const span = Math.max(1, Number(window.end) - Number(window.start))
  return centerWindowOnRange(window.chrom, center, span, chromSize, minStart)
}

export function buildChromWindow(chrom, chromSize, minStart = 1) {
  if (!chrom || !Number.isFinite(chromSize) || chromSize <= minStart) return null
  return {
    chrom,
    start: minStart,
    end: Math.max(minStart + 1, Math.round(chromSize)),
  }
}

export function svBufferMatchesRefWindow(bufferData, refWindow) {
  if (!bufferData?.ref_chrom || !refWindow?.chrom) return false
  return normalizeSvChromToken(bufferData.ref_chrom) === normalizeSvChromToken(refWindow.chrom)
}

export function svBufferMatchesAlignment(bufferData, alignmentId = '') {
  const wanted = String(alignmentId || '').trim()
  if (!wanted) return true
  return String(bufferData?.alignment_id || '').trim() === wanted
}

export function deriveAutoTargetWindowFromBuffer(bufferData, refWindow, fallbackWindow = null) {
  if (!refWindow || !bufferData) return fallbackWindow
  if (!svBufferMatchesRefWindow(bufferData, refWindow)) return null
  const segments = Array.isArray(bufferData?.segments) && bufferData.segments.length
    ? bufferData.segments
    : Array.isArray(bufferData?.blocks)
      ? bufferData.blocks
      : []
  if (!segments.length) return fallbackWindow

  let minT = Infinity
  let maxT = -Infinity
  for (const seg of segments) {
    if (!overlaps(seg.ref_start, seg.ref_end, refWindow.start, refWindow.end)) continue
    const lo = Math.min(seg.tgt_start, seg.tgt_end)
    const hi = Math.max(seg.tgt_start, seg.tgt_end)
    if (lo < minT) minT = lo
    if (hi > maxT) maxT = hi
  }

  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT <= minT) {
    return fallbackWindow
  }

  const refSpan = Math.max(1, refWindow.end - refWindow.start)
  const targetCenter = (minT + maxT) / 2
  const targetChromSize = getResolvedChromSize(bufferData?.tgt_chrom_sizes, bufferData?.tgt_chrom)
  return centerWindowOnRange(bufferData.tgt_chrom, targetCenter, refSpan, targetChromSize, 1)
}
