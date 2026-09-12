import { BUILTIN_GENOME_COLOR_PALETTE, sanitizeHexColor } from '../../genomeColorSchemes.js'

export const MOTIF_STORAGE_KEY = 'alignment-explorer:motifs:v1'
export const MAX_MOTIFS = 100
export function normalizeMotifs(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : []).filter(m => m && typeof m.id === 'string' &&
    m.id.length > 0 && m.id.length <= 100 && !seen.has(m.id) && seen.add(m.id)).slice(0, MAX_MOTIFS).map((m, i) => ({
    id: m.id, pattern: String(m.pattern || '').slice(0, 500), kind: m.kind === 'regex' ? 'regex' : 'literal',
    enabled: m.enabled !== false, color: sanitizeHexColor(m.color, BUILTIN_GENOME_COLOR_PALETTE[i % 10]),
  }))
}
export function loadMotifs(storage) {
  try { return normalizeMotifs(JSON.parse((storage ?? globalThis.localStorage).getItem(MOTIF_STORAGE_KEY))) } catch { return [] }
}
export function saveMotifs(motifs, storage) {
  try { (storage ?? globalThis.localStorage).setItem(MOTIF_STORAGE_KEY, JSON.stringify(motifs)); return true } catch { return false }
}
export function moveMotif(motifs, id, target) {
  const from = motifs.findIndex(m => m.id === id), to = motifs.findIndex(m => m.id === target)
  if (from < 0 || to < 0 || from === to) return motifs
  const next = [...motifs]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}
// Colour, order and enable switches are applied while painting. Only the active
// definitions enter the search key, sorted so dragging never triggers a search.
export function motifSearchKey(motifs) {
  return JSON.stringify(motifs.filter(m => m.enabled && m.pattern).map(({ id, pattern, kind }) =>
    ({ id, pattern, kind })).sort((a, b) => a.id.localeCompare(b.id)))
}
export function motifLegend(motifs) {
  return { kind: 'swatches', swatches: motifs.filter(m => m.enabled && m.pattern).map((m, i) =>
    ({ label: `${i + 1}. ${m.pattern}`, colour: m.color })),
  note: 'Top motif wins overlaps. Unmatched sequence stays neutral.' }
}

/** Resolve overlaps once per response/order change, never per canvas cell. */
export function resolveMotifSpans(motifs, spans) {
  const events = []
  motifs.forEach((m, priority) => {
    if (!m.enabled || !m.pattern) return
    for (const [start, end] of spans?.[m.id] || []) {
      events.push([start, priority, 1], [end, priority, -1])
    }
  })
  events.sort((a, b) => a[0] - b[0])
  const active = new Map(), result = []
  let previous = events[0]?.[0]
  for (let i = 0; i < events.length;) {
    const position = events[i][0]
    if (position > previous && active.size) {
      const priority = Math.min(...active.keys()), color = motifs[priority].color
      const last = result.at(-1)
      if (last && last[1] === previous && last[2] === color) last[1] = position
      else result.push([previous, position, color])
    }
    while (i < events.length && events[i][0] === position) {
      const [, priority, delta] = events[i++]
      const count = (active.get(priority) || 0) + delta
      if (count) active.set(priority, count)
      else active.delete(priority)
    }
    previous = position
  }
  return result
}

export function firstMotifSpan(spans, column) {
  let low = 0, high = spans.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (spans[mid][1] <= column) low = mid + 1
    else high = mid
  }
  return low
}
