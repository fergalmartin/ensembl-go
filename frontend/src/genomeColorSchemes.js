export const PRIMARY_GENOME_DEFAULT_COLOR = '#3366cc'
export const SECONDARY_GENOME_DEFAULT_COLOR = '#00b692'
export const DEFAULT_GENOME_BROWSER_COLOR_COUNT = 5

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6})$/

export function sanitizeHexColor(value, fallback = SECONDARY_GENOME_DEFAULT_COLOR) {
  const candidate = String(value || '').trim()
  if (HEX_COLOR_RE.test(candidate)) return candidate.toLowerCase()
  return fallback
}

export function buildDefaultGenomeBrowserColors(count = DEFAULT_GENOME_BROWSER_COLOR_COUNT) {
  const safeCount = Math.max(DEFAULT_GENOME_BROWSER_COLOR_COUNT, Number(count) || DEFAULT_GENOME_BROWSER_COLOR_COUNT)
  return Array.from({ length: safeCount }, (_, index) => (
    index === 0 ? PRIMARY_GENOME_DEFAULT_COLOR : SECONDARY_GENOME_DEFAULT_COLOR
  ))
}

export function normalizeGenomeBrowserColors(rawColors) {
  const source = Array.isArray(rawColors) ? rawColors : []
  const minLength = Math.max(DEFAULT_GENOME_BROWSER_COLOR_COUNT, source.length || 0)
  const out = []

  for (let index = 0; index < minLength; index += 1) {
    const fallback = index === 0 ? PRIMARY_GENOME_DEFAULT_COLOR : SECONDARY_GENOME_DEFAULT_COLOR
    out.push(sanitizeHexColor(source[index], fallback))
  }

  return out
}

export function getGenomeBrowserColor(rawColors, index) {
  const normalized = normalizeGenomeBrowserColors(rawColors)
  if (index < normalized.length) return normalized[index]
  return SECONDARY_GENOME_DEFAULT_COLOR
}
