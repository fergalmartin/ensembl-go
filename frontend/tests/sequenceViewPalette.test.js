import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLASS_CODES,
  CLASS_GAP,
  CLASS_NONE,
  CLASS_STYLE,
  LEVELS,
  LEVEL_GROUPS,
  classStyle,
  classesForLevel,
  defaultHighlights,
} from '../src/utils/sequenceViewPalette.js'

/** How a class is drawn, reduced to what a reader can actually tell apart. */
function appearance(code) {
  const style = classStyle(code)
  assert.ok(style, `no style for ${code}`)
  return `${style.outline ? 'outline' : 'fill'}:${String(style.bg).toLowerCase()}`
}

test('every class code has a style, and every style a label', () => {
  for (const [name, code] of Object.entries(CLASS_CODES)) {
    const style = classStyle(code)
    assert.ok(style, `${name} (${code}) has no style`)
    assert.ok(style.label, `${name} (${code}) has no label`)
    assert.match(style.bg, /^#[0-9a-f]{6}$/i, `${name} has no usable colour`)
  }
})

test('no two things a reader sees at once are drawn the same way', () => {
  // Per level, because that is what is on screen together. A shared appearance
  // here means a reader cannot tell two annotations apart, whatever the legend
  // says -- which is how intergenic and intronic came to be the same hex.
  for (const level of LEVELS) {
    const seen = new Map()
    for (const group of LEVEL_GROUPS[level] || []) {
      const look = `${group.outlineOnly ? 'outline' : 'fill'}:${(group.gradient || group.swatch).toLowerCase()}`
      assert.ok(
        !seen.has(look),
        `at ${level}, ${group.key} is drawn exactly like ${seen.get(look)}: ${look}`,
      )
      seen.set(look, group.key)
    }
  }
})

test('one colour across the levels means one thing at different resolutions', () => {
  // Coding and CDS deliberately share the exon blue: they are the same answer
  // read at a gene and at a transcript, and a reader moving between the levels
  // should see the blue follow them. They are never on screen together, so the
  // rule above does not forbid it.
  assert.equal(appearance(CLASS_CODES.coding), appearance(CLASS_CODES.cds))
})

test('the coarse answer does not borrow the colour of the exact one', () => {
  // Genic means "a gene is here and its isoforms were not read", which a dense
  // tile falls back to. Since a location is otherwise drawn in the gene classes,
  // that tile can sit beside one drawn in full -- so genic must not look like
  // coding, which is a thing actually known about the bases.
  assert.notEqual(appearance(CLASS_CODES.genic), appearance(CLASS_CODES.coding))
  assert.notEqual(appearance(CLASS_CODES.genic), appearance(CLASS_CODES.intron))
  assert.notEqual(appearance(CLASS_CODES.genic), appearance(CLASS_CODES.intergenic))
})

test('coding and non-coding are told apart by fill, not by shade', () => {
  // Non-coding is exon, so it belongs in the exon blue; a lighter shade of the
  // same blue beside a solid CDS is a difference nobody reliably sees.
  const coding = classStyle(CLASS_CODES.coding)
  const noncoding = classStyle(CLASS_CODES.noncoding)
  assert.equal(coding.outline, undefined)
  assert.equal(noncoding.outline, true)
})

test('intergenic and intronic are told apart by fill as well as by colour', () => {
  const intergenic = classStyle(CLASS_CODES.intergenic)
  const intron = classStyle(CLASS_CODES.intron)
  assert.equal(intergenic.outline, true)
  assert.equal(intron.outline, undefined)
  assert.notEqual(intergenic.bg.toLowerCase(), intron.bg.toLowerCase())
})

test('a gap marker is not a class and has no style to mistake for one', () => {
  assert.equal(classStyle(CLASS_GAP), null)
  assert.equal(classStyle(CLASS_NONE), null)
  assert.equal(classStyle('nonsense'), null)
})

test('a legend swatch is drawn the same way as the cells it explains', () => {
  // The swatch and the cell come from two different tables. If they disagree
  // about whether a class is filled or outlined, the legend is a lie.
  for (const level of LEVELS) {
    for (const group of LEVEL_GROUPS[level] || []) {
      for (const code of group.classes) {
        const style = classStyle(code)
        assert.ok(style, `${level}/${group.key} names a class with no style: ${code}`)
        assert.equal(
          Boolean(group.outlineOnly), Boolean(style.outline),
          `${level}/${group.key} swatch and cell disagree about being outlined`,
        )
        if (group.outlineOnly) {
          assert.equal(
            group.swatch.toLowerCase(), style.bg.toLowerCase(),
            `${level}/${group.key} outlines in a different colour than its cells`,
          )
        }
      }
    }
  }
})

test('every level draws something, and resolves its toggles to codes', () => {
  for (const level of LEVELS) {
    const groups = LEVEL_GROUPS[level] || []
    assert.ok(groups.length > 0, `${level} has no groups`)
    const codes = classesForLevel(level)
    for (const group of groups) {
      for (const code of group.classes) {
        assert.equal(codes.get(code), group.key, `${level}: ${code} resolves elsewhere`)
      }
    }
  }
})

test('everything but repeats starts switched on', () => {
  for (const level of LEVELS) {
    const on = defaultHighlights(level)
    for (const [key, value] of Object.entries(on)) {
      assert.equal(value, key !== 'softmask', `${level}/${key} default`)
    }
  }
})

test('an exon or intron in focus is described exactly as its transcript is', () => {
  assert.equal(LEVEL_GROUPS.feature, LEVEL_GROUPS.transcript)
  assert.equal(LEVEL_GROUPS.custom, LEVEL_GROUPS.transcript)
})

test('the style table is frozen, so a level cannot quietly repaint a class', () => {
  assert.ok(Object.isFrozen(CLASS_STYLE))
  assert.ok(Object.isFrozen(CLASS_CODES))
})
