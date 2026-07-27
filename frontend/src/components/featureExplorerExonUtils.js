function normalizeInterval(start, end) {
  const s = Number(start)
  const e = Number(end)
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null
  const lo = Math.min(s, e)
  const hi = Math.max(s, e)
  if (hi < lo) return null
  return { start: lo, end: hi }
}

function intervalLength(start, end) {
  const norm = normalizeInterval(start, end)
  if (!norm) return 0
  return (norm.end - norm.start) + 1
}

function mergeIntervals(intervals) {
  const normalized = (Array.isArray(intervals) ? intervals : [])
    .map((item) => normalizeInterval(item?.start, item?.end))
    .filter(Boolean)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end))
  if (!normalized.length) return []
  const merged = [{ ...normalized[0] }]
  for (let i = 1; i < normalized.length; i += 1) {
    const curr = normalized[i]
    const last = merged[merged.length - 1]
    if (curr.start <= (last.end + 1)) {
      last.end = Math.max(last.end, curr.end)
    } else {
      merged.push({ ...curr })
    }
  }
  return merged
}

export function orientedBoundariesFromCoords(start, end, strand) {
  const norm = normalizeInterval(start, end)
  if (!norm) return { fivePrime: 0, threePrime: 0 }
  if (String(strand || '+') === '-') {
    return { fivePrime: norm.end, threePrime: norm.start }
  }
  return { fivePrime: norm.start, threePrime: norm.end }
}

export function classifyExonState(exonStart, exonEnd, cdsList = []) {
  const exon = normalizeInterval(exonStart, exonEnd)
  if (!exon) {
    return {
      stateClass: 'non_coding',
      codingStart: null,
      codingEnd: null,
      codingSegments: [],
    }
  }

  const overlaps = []
  for (const cds of (Array.isArray(cdsList) ? cdsList : [])) {
    const cdsNorm = normalizeInterval(cds?.start, cds?.end)
    if (!cdsNorm) continue
    const ovStart = Math.max(exon.start, cdsNorm.start)
    const ovEnd = Math.min(exon.end, cdsNorm.end)
    if (ovEnd >= ovStart) overlaps.push({ start: ovStart, end: ovEnd })
  }
  const merged = mergeIntervals(overlaps)
  if (!merged.length) {
    return {
      stateClass: 'non_coding',
      codingStart: null,
      codingEnd: null,
      codingSegments: [],
    }
  }

  const exonLen = intervalLength(exon.start, exon.end)
  const codingLen = merged.reduce((sum, item) => sum + intervalLength(item.start, item.end), 0)
  const fullSpan = merged.length === 1
    && merged[0].start <= exon.start
    && merged[0].end >= exon.end
    && codingLen >= exonLen

  if (fullSpan) {
    return {
      stateClass: 'coding',
      codingStart: exon.start,
      codingEnd: exon.end,
      codingSegments: [{ start: exon.start, end: exon.end }],
    }
  }

  return {
    stateClass: 'partial_coding',
    codingStart: Math.min(...merged.map((item) => item.start)),
    codingEnd: Math.max(...merged.map((item) => item.end)),
    codingSegments: merged,
  }
}

export function makeExonBoundaryKey(chrom, start, end, strand) {
  const norm = normalizeInterval(start, end)
  const c = String(chrom || '')
  const s = String(strand || '+')
  if (!norm) return `${c}:0:0:${s}`
  return `${c}:${Math.round(norm.start)}:${Math.round(norm.end)}:${s}`
}

export function makeExonStateKey({ chrom, start, end, strand, stateClass, codingSegments = [] }) {
  const boundary = makeExonBoundaryKey(chrom, start, end, strand)
  const cls = String(stateClass || 'non_coding')
  const signature = cls === 'partial_coding'
    ? mergeIntervals(codingSegments)
      .map((item) => `${Math.round(item.start)}-${Math.round(item.end)}`)
      .join(',')
    : ''
  return `${boundary}|${cls}|${signature}`
}

export function parseExonStateKey(rawKey) {
  const key = String(rawKey || '').trim()
  if (!key) {
    return {
      exonStateKey: '',
      boundaryKey: '',
      chrom: '',
      start: 0,
      end: 0,
      strand: '+',
      stateClass: 'non_coding',
      codingSegments: [],
    }
  }
  const [boundaryPart = '', stateClassRaw = 'non_coding', signatureRaw = ''] = key.split('|')
  const boundaryParts = boundaryPart.split(':')
  let chrom = ''
  let start = 0
  let end = 0
  let strand = '+'
  if (boundaryParts.length >= 4) {
    strand = boundaryParts.pop() || '+'
    end = Number(boundaryParts.pop() || 0)
    start = Number(boundaryParts.pop() || 0)
    chrom = boundaryParts.join(':')
  }
  const stateClass = String(stateClassRaw || 'non_coding')
  const codingSegments = []
  if (stateClass === 'partial_coding' && signatureRaw) {
    signatureRaw.split(',').forEach((chunk) => {
      const [sRaw, eRaw] = String(chunk || '').split('-')
      const norm = normalizeInterval(Number(sRaw), Number(eRaw))
      if (norm) codingSegments.push(norm)
    })
  }
  return {
    exonStateKey: key,
    boundaryKey: makeExonBoundaryKey(chrom, start, end, strand),
    chrom,
    start,
    end,
    strand,
    stateClass,
    codingSegments,
  }
}

export function buildTranscriptExonInstances(tx, geneChrom = '') {
  const txStrand = String(tx?.strand || '+')
  const txChrom = String(tx?.chrom || geneChrom || '')
  const exons = (Array.isArray(tx?.exons) ? tx.exons : [])
    .map((exon) => normalizeInterval(exon?.start, exon?.end))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start)
  if (txStrand === '-') exons.reverse()

  const cdsList = (Array.isArray(tx?.cds_list) ? tx.cds_list : [])
    .map((cds) => normalizeInterval(cds?.start, cds?.end))
    .filter(Boolean)

  const out = []
  for (let exonRank = 0; exonRank < exons.length; exonRank += 1) {
    const exon = exons[exonRank]
    const state = classifyExonState(exon.start, exon.end, cdsList)
    const boundaries = orientedBoundariesFromCoords(exon.start, exon.end, txStrand)
    const boundaryKey = makeExonBoundaryKey(txChrom, exon.start, exon.end, txStrand)
    const exonStateKey = makeExonStateKey({
      chrom: txChrom,
      start: exon.start,
      end: exon.end,
      strand: txStrand,
      stateClass: state.stateClass,
      codingSegments: state.codingSegments,
    })
    out.push({
      transcriptId: String(tx?.id || ''),
      exonRank: exonRank + 1,
      totalExons: exons.length,
      chrom: txChrom,
      strand: txStrand,
      start: exon.start,
      end: exon.end,
      fivePrime: boundaries.fivePrime,
      threePrime: boundaries.threePrime,
      length: intervalLength(exon.start, exon.end),
      stateClass: state.stateClass,
      codingStart: state.codingStart,
      codingEnd: state.codingEnd,
      codingSegments: state.codingSegments,
      boundaryKey,
      exonStateKey,
    })
  }
  return out
}

export function buildTranscriptExonMap(tx, geneChrom = '') {
  const instances = buildTranscriptExonInstances(tx, geneChrom)
  const map = new Map()
  for (const item of instances) {
    map.set(item.boundaryKey, item)
  }
  return map
}
