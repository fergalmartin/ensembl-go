import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXON_ALTERNATING_COLORS,
  VARIANT_IMPACT_COLORS,
  buildPaintSegments,
  buildVariantOverlays,
  exonAtResidue,
  formatRange,
  mutedColor,
  paintColorAtResidue,
  VARIANT_MARK_PAD,
  rgbCss,
  summariseExons,
  summariseVariantImpacts,
} from '../src/components/structureExonMapping.js'

/** One variant as /api/structure/variants returns it. */
function variant(residue, impact, extra = {}) {
  return {
    model_residue: residue,
    impact,
    consequence: extra.consequence ?? impact,
    aa_index: extra.aaIndex ?? residue,
    ref_aa: extra.refAa ?? '',
    alt_aa: extra.altAa ?? '',
    track_id: extra.trackId ?? 'trk',
  }
}

/** One range as /api/structure/residue_map returns it. */
function range(exonIndex, aaStart, aaEnd, modelStart, modelEnd, extra = {}) {
  return {
    exon_index: exonIndex,
    aa_start: aaStart,
    aa_end: aaEnd,
    model_start: modelStart,
    model_end: modelEnd,
    genomic_start: extra.genomicStart ?? null,
    genomic_end: extra.genomicEnd ?? null,
  }
}

test('one range per exon summarises to one legend entry each', () => {
  const summary = summariseExons([
    range(0, 1, 46, 1, 46, { genomicStart: 100, genomicEnd: 235 }),
    range(1, 47, 97, 47, 97, { genomicStart: 500, genomicEnd: 650 }),
  ])

  assert.equal(summary.length, 2)
  assert.deepEqual(
    summary.map((exon) => [exon.exonIndex, exon.aaStart, exon.aaEnd, exon.rangeCount]),
    [[0, 1, 46, 1], [1, 47, 97, 1]],
  )
  assert.equal(summary[0].genomicStart, 100)
})

test('an exon broken across several ranges merges into one entry spanning them', () => {
  // What an alignment gap inside a single exon produces.
  const summary = summariseExons([
    range(3, 100, 110, 120, 130),
    range(3, 111, 115, 145, 149),
  ])

  assert.equal(summary.length, 1)
  assert.equal(summary[0].rangeCount, 2)
  assert.deepEqual(
    [summary[0].aaStart, summary[0].aaEnd, summary[0].modelStart, summary[0].modelEnd],
    [100, 115, 120, 149],
  )
})

test('exons are ordered along the protein, not by the order they arrive in', () => {
  const summary = summariseExons([
    range(2, 200, 260, 200, 260),
    range(0, 1, 46, 1, 46),
    range(1, 47, 97, 47, 97),
  ])
  assert.deepEqual(summary.map((exon) => exon.exonIndex), [0, 1, 2])
})

test('empty or missing input yields no entries', () => {
  assert.deepEqual(summariseExons([]), [])
  assert.deepEqual(summariseExons(undefined), [])
})

test('paint segments alternate by position along the protein', () => {
  const segments = [
    range(0, 1, 10, 1, 10),
    range(1, 11, 20, 11, 20),
    range(2, 21, 30, 21, 30),
  ]
  const [first, second, third] = buildPaintSegments(segments, summariseExons(segments), 'light')

  assert.deepEqual(first.color, EXON_ALTERNATING_COLORS.light[0])
  assert.deepEqual(second.color, EXON_ALTERNATING_COLORS.light[1])
  assert.deepEqual(third.color, EXON_ALTERNATING_COLORS.light[0])
})

test('parity follows protein position even when segments arrive out of order', () => {
  // The first exon along the protein must take the first hue whichever order the
  // response happens to list the ranges in.
  const segments = [
    range(1, 11, 20, 11, 20),
    range(0, 1, 10, 1, 10),
  ]
  const painted = buildPaintSegments(segments, summariseExons(segments), 'light')

  assert.deepEqual(painted[1].color, EXON_ALTERNATING_COLORS.light[0]) // exon_index 0
  assert.deepEqual(painted[0].color, EXON_ALTERNATING_COLORS.light[1]) // exon_index 1
})

test('every range of one exon keeps that exon colour', () => {
  const segments = [
    range(0, 1, 10, 1, 10),
    range(1, 11, 15, 11, 15),
    range(1, 16, 20, 30, 34),
  ]
  const painted = buildPaintSegments(segments, summariseExons(segments), 'dark')

  assert.deepEqual(painted[1].color, EXON_ALTERNATING_COLORS.dark[1])
  assert.deepEqual(painted[2].color, EXON_ALTERNATING_COLORS.dark[1])
  assert.deepEqual(painted[2], { ...painted[2], start: 30, end: 34 })
})

test('paint segments carry the model residue numbers, not the local ones', () => {
  // The distinction that matters for a non-canonical isoform.
  const segments = [range(0, 1, 10, 55, 64)]
  const [painted] = buildPaintSegments(segments, summariseExons(segments), 'light')

  assert.equal(painted.start, 55)
  assert.equal(painted.end, 64)
  assert.match(painted.tooltip, /aa 1–10/)
})

test('no segments paints nothing', () => {
  assert.deepEqual(buildPaintSegments([], [], 'light'), [])
  assert.deepEqual(buildPaintSegments(undefined, [], 'light'), [])
})

test('a residue resolves to the exon whose model range contains it', () => {
  const summary = summariseExons([
    range(0, 1, 10, 1, 10),
    range(1, 11, 20, 11, 20),
  ])

  assert.equal(exonAtResidue(summary, 5).exonIndex, 0)
  assert.equal(exonAtResidue(summary, 11).exonIndex, 1)
  assert.equal(exonAtResidue(summary, 999), null)
  assert.equal(exonAtResidue(summary, null), null)
})

test('formatting helpers', () => {
  assert.equal(formatRange(4, 4), '4')
  assert.equal(formatRange(4, 9), '4–9')
  assert.equal(rgbCss({ r: 1, g: 2, b: 3 }), 'rgb(1, 2, 3)')
})

test('locking one exon mutes the others and leaves it alone', () => {
  const segments = [range(0, 1, 10, 1, 10), range(1, 11, 20, 11, 20)]
  const summary = summariseExons(segments)
  const painted = buildPaintSegments(segments, summary, 'dark', { lockedExons: new Set([1]) })

  assert.deepEqual(painted[1].color, EXON_ALTERNATING_COLORS.dark[1])
  assert.notDeepEqual(painted[0].color, EXON_ALTERNATING_COLORS.dark[0])
  assert.deepEqual(painted[0].color, mutedColor(EXON_ALTERNATING_COLORS.dark[0], 'dark'))
})

test('locking several exons keeps all of them at full strength', () => {
  const segments = [range(0, 1, 10, 1, 10), range(1, 11, 20, 11, 20), range(2, 21, 30, 21, 30)]
  const summary = summariseExons(segments)
  const painted = buildPaintSegments(segments, summary, 'light', { lockedExons: new Set([0, 2]) })

  assert.deepEqual(painted[0].color, EXON_ALTERNATING_COLORS.light[0])
  assert.deepEqual(painted[2].color, EXON_ALTERNATING_COLORS.light[0])
  assert.deepEqual(painted[1].color, mutedColor(EXON_ALTERNATING_COLORS.light[1], 'light'))
})

test('an empty lock set changes nothing', () => {
  const segments = [range(0, 1, 10, 1, 10), range(1, 11, 20, 11, 20)]
  const summary = summariseExons(segments)
  const plain = buildPaintSegments(segments, summary, 'dark')
  const locked = buildPaintSegments(segments, summary, 'dark', { lockedExons: new Set() })
  assert.deepEqual(locked, plain)
})

test('dimming mutes the whole exon layer so variants can sit on top', () => {
  const segments = [range(0, 1, 10, 1, 10), range(1, 11, 20, 11, 20)]
  const summary = summariseExons(segments)
  const painted = buildPaintSegments(segments, summary, 'dark', { dim: true })
  assert.deepEqual(painted[0].color, mutedColor(EXON_ALTERNATING_COLORS.dark[0], 'dark'))
  assert.deepEqual(painted[1].color, mutedColor(EXON_ALTERNATING_COLORS.dark[1], 'dark'))
})

test('muting drains chroma and leaves the colour untouched at zero', () => {
  const blue = EXON_ALTERNATING_COLORS.dark[0]
  assert.deepEqual(mutedColor(blue, 'dark', 0), blue)
  // Fully drained is a grey, give or take the background pull.
  const grey = mutedColor(blue, 'dark', 1)
  assert.ok(
    Math.max(grey.r, grey.g, grey.b) - Math.min(grey.r, grey.g, grey.b) < 20,
    `fully muted colour kept chroma: ${JSON.stringify(grey)}`,
  )
})

// The bug this guards against: muting by blending toward the background used to
// take the unlocked exons to 1.5–2.0:1 against it, at which point Mol*'s shading
// finished the job and whole lobes of the fold read as missing rather than as
// de-emphasised. A muted colour has to stay visible as geometry.
test('a muted colour keeps enough contrast against the background to be seen', () => {
  const backgrounds = { light: { r: 255, g: 255, b: 255 }, dark: { r: 31, g: 41, b: 55 } }
  const channel = (value) => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = (c) => (0.2126 * channel(c.r)) + (0.7152 * channel(c.g)) + (0.0722 * channel(c.b))
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  for (const theme of ['light', 'dark']) {
    for (const base of EXON_ALTERNATING_COLORS[theme]) {
      const ratio = contrast(mutedColor(base, theme), backgrounds[theme])
      assert.ok(ratio > 2.8, `${theme} muted colour is ${ratio.toFixed(2)}:1 against the background`)
    }
  }
})

test('one mute serves both themes and keeps the pair apart', () => {
  // Preserving luminance is what removed the need for a per-theme amount: the
  // old blend toward the surface lost chroma far faster toward white than
  // toward the dark background, so the two themes needed different strengths.
  for (const theme of ['light', 'dark']) {
    const [a, b] = EXON_ALTERNATING_COLORS[theme].map((c) => mutedColor(c, theme))
    const distance = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)
    assert.ok(distance > 90, `${theme} muted pair collapsed (distance ${distance})`)
  }
})

test('a variant paints a short band centred on its residue', () => {
  const overlays = buildVariantOverlays([variant(40, 'missense')], 'dark', { start: 1, end: 100 })
  assert.equal(overlays.length, 1)
  assert.equal(overlays[0].residue, 40)
  assert.equal(overlays[0].start, 40 - VARIANT_MARK_PAD)
  assert.equal(overlays[0].end, 40 + VARIANT_MARK_PAD)
  assert.deepEqual(overlays[0].color, VARIANT_IMPACT_COLORS.dark.missense)
})

test('a band never runs past the ends of the model', () => {
  const overlays = buildVariantOverlays([variant(1, 'silent'), variant(100, 'silent')], 'light', { start: 1, end: 100 })
  assert.equal(overlays[0].start, 1)
  assert.equal(overlays[1].end, 100)
})

test('overlays come out in residue order so later ones paint over earlier', () => {
  const overlays = buildVariantOverlays([variant(80, 'silent'), variant(10, 'missense'), variant(45, 'truncating')], 'dark', null)
  assert.deepEqual(overlays.map((o) => o.residue), [10, 45, 80])
})

test('several variants on one residue take the most severe colour', () => {
  const overlays = buildVariantOverlays([
    variant(7, 'silent'),
    variant(7, 'truncating'),
    variant(7, 'missense'),
  ], 'light', null)

  assert.equal(overlays.length, 1)
  assert.deepEqual(overlays[0].color, VARIANT_IMPACT_COLORS.light.truncating)
  assert.match(overlays[0].tooltip, /\+2 more/)
})

test('a variant with no model residue is not drawn', () => {
  assert.deepEqual(buildVariantOverlays([variant(0, 'missense')], 'dark', null), [])
})

test('an unrecognised impact falls back to the neutral colour', () => {
  const overlays = buildVariantOverlays([variant(3, 'regulatory')], 'dark', null)
  assert.deepEqual(overlays[0].color, VARIANT_IMPACT_COLORS.dark.other)
})

test('the overlay tooltip names the amino-acid change when there is one', () => {
  const overlays = buildVariantOverlays(
    [variant(12, 'missense', { consequence: 'missense', aaIndex: 12, refAa: 'R', altAa: 'H' })],
    'light',
    null,
  )
  assert.match(overlays[0].tooltip, /missense · R12H/)
})

test('impact counts come back in severity order and skip empty classes', () => {
  const summary = summariseVariantImpacts([
    variant(1, 'silent'),
    variant(2, 'truncating'),
    variant(3, 'silent'),
  ])
  assert.deepEqual(summary, [
    { impact: 'truncating', count: 1 },
    { impact: 'silent', count: 2 },
  ])
})

test('the paint colour under a residue is found by range, not by index', () => {
  const painted = [
    { start: 1, end: 10, color: { r: 1, g: 1, b: 1 } },
    { start: 20, end: 30, color: { r: 2, g: 2, b: 2 } },
  ]
  assert.deepEqual(paintColorAtResidue(painted, 25), { r: 2, g: 2, b: 2 })
  assert.equal(paintColorAtResidue(painted, 15), null)
})
