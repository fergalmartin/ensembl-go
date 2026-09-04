// Turning the backend's residue map into something the 3D viewer can paint.
//
// Exons alternate between two hues rather than each taking its own colour: a
// transcript can have fifty coding exons, and no categorical palette survives
// that. What the colour has to answer is "where does one exon's contribution to
// this fold end", which is a two-state question. Identity comes from the legend
// beside the viewer, so it is never carried by colour alone.
//
// Both pairs clear every check in the validated default palette (worst CVD ΔE
// 24.7 light / 26.8 dark against a target of 8).
export const EXON_ALTERNATING_COLORS = {
  light: [{ r: 42, g: 120, b: 214 }, { r: 235, g: 104, b: 52 }],
  dark: [{ r: 57, g: 135, b: 229 }, { r: 217, g: 89, b: 38 }],
}

// Residues the transcript does not reach — a model longer than the translation,
// or a stretch the alignment could not place. Deliberately low-contrast: these
// should recede behind the exons rather than compete with them.
export const UNMAPPED_COLOR = {
  light: { r: 203, g: 213, b: 225 },
  dark: { r: 71, g: 85, b: 105 },
}

// The whole chain in one neutral, for looking at the fold without an overlay.
// Not the unmapped colour: that one is meant to disappear against the surface,
// which would leave the plain view all but invisible.
export const PLAIN_COLOR = {
  light: { r: 100, g: 116, b: 139 },
  dark: { r: 148, g: 163, b: 184 },
}

// The viewer's own background, so the mute's final step back is toward what is
// actually behind the model. Kept in step with THEME_BACKGROUNDS in
// backend/static/structure/viewer.js.
const SURFACE_COLOR = {
  light: { r: 255, g: 255, b: 255 },
  dark: { r: 31, g: 41, b: 55 },
}

// Variant impact is a three-class status encoding, not another categorical one.
// It has to survive being read on top of the exon colouring, which already owns
// the blue/orange axis — the axis that also happens to be the only one red-green
// colour blindness leaves intact. Rather than fight for a third safe hue, the
// exon layer mutes whenever variants are shown (see `dim` in buildPaintSegments),
// which drops its chroma and hands the hue channel to these.
//
// Both sets clear every check in the validated default palette at --pairs all:
// light worst CVD ΔE 9.9, dark 13.0, against a target of 8.
export const VARIANT_IMPACT_COLORS = {
  light: {
    silent: { r: 13, g: 148, b: 136 },
    missense: { r: 194, g: 135, b: 11 },
    truncating: { r: 214, g: 31, b: 38 },
    other: { r: 100, g: 116, b: 139 },
  },
  dark: {
    silent: { r: 18, g: 163, b: 150 },
    missense: { r: 189, g: 138, b: 14 },
    truncating: { r: 194, g: 50, b: 60 },
    other: { r: 148, g: 163, b: 184 },
  },
}

export const VARIANT_IMPACT_ORDER = ['truncating', 'missense', 'silent', 'other']

export const VARIANT_IMPACT_LABELS = {
  truncating: 'Truncating',
  missense: 'Missense',
  silent: 'Synonymous',
  other: 'Other',
}

export const CONSEQUENCE_LABELS = {
  synonymous: 'synonymous',
  missense: 'missense',
  stop_gained: 'stop gained',
  stop_lost: 'stop lost',
  start_lost: 'start lost',
  frameshift: 'frameshift',
  inframe_insertion: 'in-frame insertion',
  inframe_deletion: 'in-frame deletion',
  protein_altering: 'protein altering',
}

export function rgbCss(color) {
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

// How far a muted colour gives up its chroma, and how far it then steps back
// toward the viewer background.
//
// The split matters. Blending straight toward the background is the obvious way
// to make something recede, and it is the wrong instrument here: at the strength
// an emphasis needs, it drops the rest of the fold to 1.5–2.0:1 against the
// background, and Mol*'s diffuse shading takes the darker faces below even that.
// The unlocked exons then do not recede — they vanish, which reads as the model
// losing geometry rather than as one exon being picked out.
//
// So the mute is carried by chroma instead: most of the way to a grey of the
// same relative luminance, then a small pull toward the background for a residue
// of depth. Locked exons stay saturated, everything else turns slate, and the
// muted colours hold 2.9–3.7:1 against the background in both themes (they held
// 1.5–2.0:1 when the blend went straight to the background). Preserving
// luminance is also what lets one pair of constants serve both themes: there is
// no longer a direction in which white strips chroma faster than the dark
// background does.
const MUTE_DESATURATION = 0.7
const MUTE_BACKGROUND_PULL = 0.15

function srgbToLinear(channel) {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value) {
  const channel = value <= 0.0031308 ? value * 12.92 : (1.055 * (value ** (1 / 2.4))) - 0.055
  return Math.max(0, Math.min(255, Math.round(channel * 255)))
}

/** The grey that shares a colour's relative luminance. */
function luminanceMatchedGrey(color) {
  const luminance = (0.2126 * srgbToLinear(color.r))
    + (0.7152 * srgbToLinear(color.g))
    + (0.0722 * srgbToLinear(color.b))
  const level = linearToSrgb(luminance)
  return { r: level, g: level, b: level }
}

function blend(color, target, amount) {
  return {
    r: Math.round(color.r + ((target.r - color.r) * amount)),
    g: Math.round(color.g + ((target.g - color.g) * amount)),
    b: Math.round(color.b + ((target.b - color.b) * amount)),
  }
}

/**
 * Drain a colour's chroma so it steps back without disappearing.
 *
 * Used for the two cases where the exon layer has to yield: exons the user has
 * not locked, and every exon while a variant overlay is on top. `amount`
 * overrides the desaturation strength — 0 returns the colour untouched, 1 takes
 * it to the matched grey — and the background pull scales with it.
 */
export function mutedColor(color, theme, amount = null) {
  const key = theme === 'light' ? 'light' : 'dark'
  const strength = Math.min(1, Math.max(0, amount == null ? MUTE_DESATURATION : amount))
  const drained = blend(color, luminanceMatchedGrey(color), strength)
  return blend(drained, SURFACE_COLOR[key], MUTE_BACKGROUND_PULL * strength)
}

export function formatRange(start, end) {
  return start === end ? `${start}` : `${start}–${end}`
}

/**
 * Collapse the backend's per-run ranges into one entry per coding exon.
 *
 * An exon can yield several ranges when an alignment gap interrupts it, but the
 * legend lists exons, not ranges — so the spans are merged here while the
 * ranges themselves stay intact for painting.
 */
export function summariseExons(segments) {
  const byExon = new Map()
  for (const segment of segments || []) {
    const index = Number(segment.exon_index)
    const existing = byExon.get(index)
    if (!existing) {
      byExon.set(index, {
        exonIndex: index,
        aaStart: segment.aa_start,
        aaEnd: segment.aa_end,
        modelStart: segment.model_start,
        modelEnd: segment.model_end,
        genomicStart: segment.genomic_start ?? null,
        genomicEnd: segment.genomic_end ?? null,
        rangeCount: 1,
      })
      continue
    }
    existing.aaStart = Math.min(existing.aaStart, segment.aa_start)
    existing.aaEnd = Math.max(existing.aaEnd, segment.aa_end)
    existing.modelStart = Math.min(existing.modelStart, segment.model_start)
    existing.modelEnd = Math.max(existing.modelEnd, segment.model_end)
    existing.rangeCount += 1
  }
  return [...byExon.values()].sort((a, b) => a.aaStart - b.aaStart)
}

/**
 * Viewer-ready colour ranges for the exon overlay.
 *
 * Parity follows the exon's position along the protein, not its index in the
 * response, so the alternation stays visually correct even if the backend ever
 * returns segments out of order.
 *
 * `lockedExons`, when non-empty, mutes everything outside it: locking is an
 * emphasis, so it has to leave the rest of the fold visible rather than hide it.
 * `dim` mutes the whole layer, which is what makes room for a variant overlay.
 */
export function buildPaintSegments(segments, exonSummary, theme, options = {}) {
  if (!segments?.length) return []
  const { lockedExons = null, dim = false } = options
  const mode = theme === 'light' ? 'light' : 'dark'
  const palette = EXON_ALTERNATING_COLORS[mode]
  const order = new Map((exonSummary || []).map((exon, position) => [exon.exonIndex, position]))
  const hasLocks = Boolean(lockedExons && lockedExons.size > 0)

  return segments.map((segment) => {
    const exonIndex = Number(segment.exon_index)
    const position = order.get(exonIndex) ?? 0
    const locked = hasLocks && lockedExons.has(exonIndex)
    const base = palette[position % palette.length]
    const shouldMute = (hasLocks && !locked) || (dim && !locked)
    return {
      start: segment.model_start,
      end: segment.model_end,
      color: shouldMute ? mutedColor(base, mode) : base,
      tooltip: `Exon ${position + 1} · aa ${formatRange(segment.aa_start, segment.aa_end)}`,
    }
  })
}

/** The paint colour covering a model residue, for an overlay to sit on top of. */
export function paintColorAtResidue(paintSegments, residue) {
  for (const segment of paintSegments || []) {
    if (residue >= segment.start && residue <= segment.end) return segment.color
  }
  return null
}

// A single residue is about two pixels of ribbon on a 500-residue protein, so a
// variant mark is drawn as a short band centred on it. The exact position is
// always available in the tooltip and in the panel, and the band never crosses
// into a neighbouring exon's territory by more than this.
export const VARIANT_MARK_PAD = 1

/**
 * Viewer-ready colour ranges for the variant layer.
 *
 * These are ordinary paint ranges, appended after the exon ranges so they win
 * where the two overlap — the viewer applies overpaint in array order. Spheres
 * would be the more obvious mark, and pdbe-molstar has an API for them, but that
 * API creates the component without drawing it; see viewer.js.
 */
export function buildVariantOverlays(variants, theme, bounds = null) {
  const palette = VARIANT_IMPACT_COLORS[theme === 'light' ? 'light' : 'dark']
  const byResidue = new Map()

  for (const variant of variants || []) {
    const residue = Number(variant.model_residue)
    if (!residue) continue
    // Several variants can land on one residue; the most severe one decides the
    // colour, because that is the one a reader must not miss.
    const existing = byResidue.get(residue)
    const rank = VARIANT_IMPACT_ORDER.indexOf(variant.impact)
    if (existing && existing.rank <= rank) {
      existing.count += 1
      continue
    }
    byResidue.set(residue, {
      rank: rank < 0 ? VARIANT_IMPACT_ORDER.length : rank,
      variant,
      count: existing ? existing.count + 1 : 1,
    })
  }

  const low = bounds?.start ?? 1
  const high = bounds?.end ?? Number.MAX_SAFE_INTEGER

  return [...byResidue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([residue, entry]) => {
      const { variant, count } = entry
      const impact = palette[variant.impact] ? variant.impact : 'other'
      const extra = count > 1 ? ` (+${count - 1} more)` : ''
      const change = variant.ref_aa && variant.alt_aa
        ? ` · ${variant.ref_aa}${variant.aa_index}${variant.alt_aa}`
        : ''
      return {
        residue,
        start: Math.max(low, residue - VARIANT_MARK_PAD),
        end: Math.min(high, residue + VARIANT_MARK_PAD),
        color: palette[impact],
        tooltip: `${CONSEQUENCE_LABELS[variant.consequence] || 'variant'}${change}${extra}`,
      }
    })
}

/** Per-impact counts for the variant legend, in severity order. */
export function summariseVariantImpacts(variants) {
  const counts = new Map(VARIANT_IMPACT_ORDER.map((impact) => [impact, 0]))
  for (const variant of variants || []) {
    const impact = counts.has(variant.impact) ? variant.impact : 'other'
    counts.set(impact, counts.get(impact) + 1)
  }
  return VARIANT_IMPACT_ORDER
    .map((impact) => ({ impact, count: counts.get(impact) }))
    .filter((entry) => entry.count > 0)
}

/** The exon covering a model residue, or null when it is outside the mapping. */
export function exonAtResidue(exonSummary, residue) {
  if (residue == null) return null
  return (exonSummary || []).find(
    (exon) => residue >= exon.modelStart && residue <= exon.modelEnd,
  ) || null
}
