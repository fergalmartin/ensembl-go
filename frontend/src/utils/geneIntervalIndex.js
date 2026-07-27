const intervalIndexCache = new WeakMap()

function normalizedStart(gene) {
  const value = Number(gene?.start)
  return Number.isFinite(value) ? value : 0
}

function normalizedEnd(gene) {
  const start = normalizedStart(gene)
  const value = Number(gene?.end)
  return Number.isFinite(value) ? value : start
}

export function buildGeneIntervalIndex(rawGenes) {
  const source = Array.isArray(rawGenes) ? rawGenes : []
  const cached = intervalIndexCache.get(source)
  if (cached) return cached

  const genes = source.every((gene, index) => (
    index === 0 || normalizedStart(source[index - 1]) <= normalizedStart(gene)
  ))
    ? source
    : source.slice().sort((left, right) => (
      normalizedStart(left) - normalizedStart(right)
      || normalizedEnd(left) - normalizedEnd(right)
      || String(left?.id || '').localeCompare(String(right?.id || ''))
    ))

  const starts = new Float64Array(genes.length)
  const prefixMaxEnds = new Float64Array(genes.length)
  let maxEnd = Number.NEGATIVE_INFINITY
  for (let index = 0; index < genes.length; index += 1) {
    const start = normalizedStart(genes[index])
    const end = normalizedEnd(genes[index])
    starts[index] = start
    maxEnd = Math.max(maxEnd, start, end)
    prefixMaxEnds[index] = maxEnd
  }

  const intervalIndex = { genes, starts, prefixMaxEnds }
  intervalIndexCache.set(source, intervalIndex)
  if (genes !== source) intervalIndexCache.set(genes, intervalIndex)
  return intervalIndex
}

function firstPrefixEndAtOrAfter(prefixMaxEnds, target) {
  let low = 0
  let high = prefixMaxEnds.length
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2)
    if (prefixMaxEnds[mid] >= target) high = mid
    else low = mid + 1
  }
  return low
}

function firstStartAfter(starts, target) {
  let low = 0
  let high = starts.length
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2)
    if (starts[mid] > target) high = mid
    else low = mid + 1
  }
  return low
}

export function queryGeneIntervalIndex(indexOrGenes, start, end) {
  const index = Array.isArray(indexOrGenes)
    ? buildGeneIntervalIndex(indexOrGenes)
    : indexOrGenes
  if (!index?.genes?.length) return []

  const rangeStart = Math.max(0, Math.floor(Number(start) || 0))
  const numericEnd = Number(end)
  const rangeEnd = Math.max(rangeStart + 1, Math.ceil(Number.isFinite(numericEnd) ? numericEnd : rangeStart + 1))
  const first = firstPrefixEndAtOrAfter(index.prefixMaxEnds, rangeStart)
  const afterLast = firstStartAfter(index.starts, rangeEnd)
  if (first >= afterLast) return []

  const matches = []
  for (let position = first; position < afterLast; position += 1) {
    const gene = index.genes[position]
    const geneStart = normalizedStart(gene)
    const geneEnd = normalizedEnd(gene)
    if (Math.max(geneStart, geneEnd) >= rangeStart && Math.min(geneStart, geneEnd) <= rangeEnd) {
      matches.push(gene)
    }
  }
  return matches
}

export function sameGeneRange(left, right) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue
    if (
      String(left[index]?.id || '') !== String(right[index]?.id || '')
      || normalizedStart(left[index]) !== normalizedStart(right[index])
      || normalizedEnd(left[index]) !== normalizedEnd(right[index])
      || String(left[index]?.name || '') !== String(right[index]?.name || '')
      || String(left[index]?.strand || '') !== String(right[index]?.strand || '')
      || String(left[index]?.biotype || '') !== String(right[index]?.biotype || '')
    ) return false
  }
  return true
}
