// Genome colours, one per genome.
//
// The colour a genome is drawn in used to be a property of *where it sat*: the
// configuration view held a list and the browser's first panel took the first
// entry, the second the second, and so on. Reordering the pills therefore
// recoloured every genome, and the same genome was a different colour in two
// sessions. Here the colour belongs to the genome itself: an assignment keyed on
// the assembly, carried in the user's configuration, with one default colour for
// every genome that has never been given one.
//
// Keys are assembly keys (`provider::species::assembly`) rather than selection
// keys, so a genome keeps its colour when a different dataset release of the
// same assembly is what happens to be loaded.

import { getAssemblyGenomeKey } from './utils/genomeIdentity.js'

/** The blue every genome wears until it is given a colour of its own. */
export const DEFAULT_GENOME_COLOR = '#3366cc'

/** The colour an inactive genome rests in, everywhere one is drawn grey. */
export const INACTIVE_GENOME_COLOR = '#858b98'

/** The ten colours offered without the user having to mix one.
 *
 *  Distinguishable side by side and against both themes' backgrounds; the first
 *  is the default, so a picker opened on an unassigned genome already has its
 *  current colour selected. */
export const BUILTIN_GENOME_COLOR_PALETTE = Object.freeze([
  '#3366cc', // Ensembl blue
  '#00b692', // teal
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#ef4444', // red
  '#0ea5e9', // sky
  '#84cc16', // lime
  '#f97316', // orange
  '#64748b', // slate
])

/** Custom colours are the user's own; the cap only stops the row growing without
 *  end, and is high enough that nobody reaches it by working normally. */
export const MAX_CUSTOM_GENOME_COLORS = 24

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6})$/
const SHORT_HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3})$/

export function sanitizeHexColor(value, fallback = DEFAULT_GENOME_COLOR) {
  const candidate = String(value || '').trim()
  if (HEX_COLOR_RE.test(candidate)) return candidate.toLowerCase()
  // A hand-edited configuration is as likely to say `#f80` as `#ff8800`.
  if (SHORT_HEX_COLOR_RE.test(candidate)) {
    return `#${candidate.slice(1).split('').map((digit) => digit + digit).join('')}`.toLowerCase()
  }
  return fallback
}

/** The configured default, or the built-in blue when there is no usable one. */
export function normalizeGenomeDefaultColor(value) {
  return sanitizeHexColor(value, DEFAULT_GENOME_COLOR)
}

/** The user's own colours: valid, lowercased, deduplicated, capped.
 *
 *  Built-in colours are dropped rather than kept as duplicates — the palette
 *  shows them already, and a custom row echoing them reads as an error. */
export function normalizeCustomGenomeColors(rawColors) {
  const builtins = new Set(BUILTIN_GENOME_COLOR_PALETTE)
  const out = []
  for (const raw of (Array.isArray(rawColors) ? rawColors : [])) {
    const color = sanitizeHexColor(raw, '')
    if (!color || builtins.has(color) || out.includes(color)) continue
    out.push(color)
    if (out.length >= MAX_CUSTOM_GENOME_COLORS) break
  }
  return out
}

/** Every colour the picker offers: the ten built-ins then the user's own. */
export function genomeColorPalette(config) {
  return [...BUILTIN_GENOME_COLOR_PALETTE, ...normalizeCustomGenomeColors(config?.genome_color_palette)]
}

/** The user's palette with `color` in it, unchanged when it is already there. */
export function withCustomGenomeColor(rawColors, color) {
  const normalized = sanitizeHexColor(color, '')
  const existing = normalizeCustomGenomeColors(rawColors)
  if (!normalized || BUILTIN_GENOME_COLOR_PALETTE.includes(normalized) || existing.includes(normalized)) {
    return existing
  }
  // Oldest first would push a fresh colour off the end of a full palette; the
  // one just mixed is the one the user wants to reach again.
  return [normalized, ...existing].slice(0, MAX_CUSTOM_GENOME_COLORS)
}

export function withoutCustomGenomeColor(rawColors, color) {
  const normalized = sanitizeHexColor(color, '')
  return normalizeCustomGenomeColors(rawColors).filter((entry) => entry !== normalized)
}

/** The key a genome's colour is filed under: its assembly, not its dataset. */
export function genomeColorKey(genome) {
  return getAssemblyGenomeKey(genome) || ''
}

/** The assignment map, with unusable keys and colours dropped. */
export function normalizeGenomeColorAssignments(rawAssignments) {
  const source = (rawAssignments && typeof rawAssignments === 'object' && !Array.isArray(rawAssignments))
    ? rawAssignments
    : {}
  const out = {}
  for (const [rawKey, rawColor] of Object.entries(source)) {
    const key = String(rawKey || '').trim()
    if (!key) continue
    const color = sanitizeHexColor(rawColor, '')
    if (!color) continue
    out[key] = color
  }
  return out
}

/** The colour a genome is drawn in.
 *
 *  A tutorial hands its genomes an explicit colour index so its screenshots and
 *  its prose agree whatever the reader's own genomes are coloured; that index
 *  wins, and everything else falls back to the assignment then the default. */
export function resolveGenomeColor(config, genome) {
  return genomeColorResolver(config)(genome)
}

/** The colours a tutorial's genomes are drawn in, in dataset order.
 *
 *  A tutorial's genomes must look the same for every reader, whatever the reader
 *  has coloured their own copies of them — the prose says "the blue panel". So a
 *  genome a tutorial installed carries a colour index instead of an assignment,
 *  and reads it out of the tutorial's own palette when it declares one. */
export function tutorialGenomeColorPalette(config) {
  const declared = (Array.isArray(config?.tutorial_color_palette) ? config.tutorial_color_palette : [])
    .map((entry) => sanitizeHexColor(entry, ''))
    .filter(Boolean)
  return declared.length ? declared : BUILTIN_GENOME_COLOR_PALETTE
}

/** One lookup built once, for a view colouring a whole list of genomes. */
export function genomeColorResolver(config) {
  const assignments = normalizeGenomeColorAssignments(config?.genome_colors)
  const fallback = normalizeGenomeDefaultColor(config?.genome_default_color)
  const tutorialPalette = tutorialGenomeColorPalette(config)
  return (genome) => {
    const tutorialIndex = Number(genome?.tutorial_color_index)
    if (Number.isInteger(tutorialIndex) && tutorialIndex >= 0) {
      return tutorialPalette[tutorialIndex % tutorialPalette.length]
    }
    const key = genomeColorKey(genome)
    return (key && assignments[key]) || fallback
  }
}

/** The colour a set of genomes shares, or `''` when they disagree.
 *
 *  What the bulk control shows: a single swatch when the selection already
 *  agrees, and the mixed marker when it does not. */
export function sharedGenomeColor(config, genomes) {
  const resolve = genomeColorResolver(config)
  let shared = ''
  for (const genome of (Array.isArray(genomes) ? genomes : [])) {
    const color = resolve(genome)
    if (!shared) shared = color
    else if (shared !== color) return ''
  }
  return shared
}

/** `genome_colors` with `genomes` painted `color`.
 *
 *  Assigning the default colour removes the entry rather than storing it: a
 *  genome the user has never touched and one they have deliberately set back to
 *  the default should both follow a later change of default. */
export function assignGenomeColors(rawAssignments, genomes, color, defaultColor = DEFAULT_GENOME_COLOR) {
  const next = normalizeGenomeColorAssignments(rawAssignments)
  const normalizedDefault = normalizeGenomeDefaultColor(defaultColor)
  const normalized = sanitizeHexColor(color, '')
  if (!normalized) return next
  for (const genome of (Array.isArray(genomes) ? genomes : [genomes])) {
    const key = genomeColorKey(genome)
    if (!key) continue
    if (normalized === normalizedDefault) delete next[key]
    else next[key] = normalized
  }
  return next
}

/** The configuration patch a colour change produces: the assignment, and the
 *  palette when the colour was one the user mixed themselves. */
export function genomeColorConfigPatch(config, genomes, color) {
  const normalized = sanitizeHexColor(color, '')
  if (!normalized) return null
  return {
    genome_colors: assignGenomeColors(
      config?.genome_colors,
      genomes,
      normalized,
      config?.genome_default_color,
    ),
    genome_color_palette: withCustomGenomeColor(config?.genome_color_palette, normalized),
  }
}

/** Colours for genomes that no longer exist are dead weight in a configuration
 *  file that is otherwise hand-readable; dropping them is cheap and keeps a
 *  deleted-then-re-added genome from silently inheriting its old colour. */
export function pruneGenomeColorAssignments(rawAssignments, genomes) {
  const assignments = normalizeGenomeColorAssignments(rawAssignments)
  const live = new Set(
    (Array.isArray(genomes) ? genomes : [])
      .map((genome) => genomeColorKey(genome))
      .filter(Boolean)
  )
  const out = {}
  for (const [key, color] of Object.entries(assignments)) {
    if (live.has(key)) out[key] = color
  }
  return out
}

/** Startup migration off the old positional list.
 *
 *  The first entry was the primary genome's colour, which is what "the default
 *  colour" now means; the rest were the colours the user had picked out for
 *  themselves, so they carry over into the palette rather than being lost. */
export function migrateLegacyGenomeColors(config) {
  const legacy = Array.isArray(config?.genome_browser_colors) ? config.genome_browser_colors : []
  const hasDefault = Boolean(sanitizeHexColor(config?.genome_default_color, ''))
  const patch = {
    genome_default_color: hasDefault
      ? normalizeGenomeDefaultColor(config?.genome_default_color)
      : normalizeGenomeDefaultColor(legacy[0]),
    genome_colors: normalizeGenomeColorAssignments(config?.genome_colors),
    genome_color_palette: normalizeCustomGenomeColors(config?.genome_color_palette),
  }
  if (hasDefault) return patch
  // Only on the first run under the new model, so a colour the user has since
  // removed from their palette does not come back on every launch.
  let palette = patch.genome_color_palette
  for (const raw of legacy.slice(1)) {
    palette = withCustomGenomeColor(palette, raw)
  }
  return { ...patch, genome_color_palette: palette }
}
