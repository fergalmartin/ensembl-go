import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COLOUR_ITEMS,
  COLOUR_SECTIONS,
  DEFAULT_COLOURS,
  DEFAULT_PALETTE,
  FOLLOW_THEME,
  RING_THEME,
  buildPalette,
  codonPartner,
  collisionsIn,
  coloursChanged,
  groupColour,
  groupGradient,
  normaliseColours,
  rgbTriplet,
  shade,
} from '../src/utils/sequenceViewColours.js'
import {
  CLASS_CODES,
  CLASS_STYLE,
  LEVELS,
  LEVEL_GROUPS,
  classStyle,
} from '../src/utils/sequenceViewPalette.js'
import { CDS_STRIPE_COLORS } from '../src/utils/featureColors.js'

test('the defaults are the palette the app already shipped', () => {
  // The guarantee that makes this switch safe to add: turning colours into
  // something a reader can move must not move them for a reader who never does.
  for (const [code, style] of Object.entries(CLASS_STYLE)) {
    const drawn = DEFAULT_PALETTE.style(code)
    assert.equal(drawn.bg, style.bg, `${code} changed colour`)
    assert.equal(Boolean(drawn.outline), Boolean(style.outline), `${code} changed shape`)
    assert.equal(drawn.label, style.label)
  }
})

test('every class a level can draw belongs to exactly one item', () => {
  // Otherwise the menu is a list with a hole in it: an annotation on screen
  // that nothing in the dialog can change, and no way to tell from the dialog.
  const owner = new Map()
  for (const item of COLOUR_ITEMS) {
    for (const code of item.codes) {
      assert.ok(!owner.has(code), `${code} is claimed by ${owner.get(code)} and ${item.key}`)
      owner.set(code, item.key)
    }
  }
  for (const [name, code] of Object.entries(CLASS_CODES)) {
    assert.ok(owner.has(code), `${name} (${code}) is drawn but cannot be coloured`)
  }
})

const section = (key) => COLOUR_SECTIONS.find((item) => item.key === key)
const codesOf = (key) => new Set(section(key).items.flatMap((item) => item.codes))

test('the sections are the two vocabularies, what they share, and the marks', () => {
  assert.deepEqual(
    COLOUR_SECTIONS.map((item) => item.key),
    ['region', 'transcript', 'highlight', 'shared'],
  )
  // A location is drawn in the gene classes, so anything a gene shows must be
  // colourable from the region section or the shared one.
  const regionKeys = codesOf('region')
  const sharedKeys = codesOf('shared')
  for (const group of LEVEL_GROUPS.gene) {
    for (const code of group.classes) {
      assert.ok(regionKeys.has(code) || sharedKeys.has(code), `gene draws ${code} uncolourably`)
    }
  }
  const txKeys = codesOf('transcript')
  for (const group of LEVEL_GROUPS.transcript) {
    for (const code of group.classes) {
      assert.ok(txKeys.has(code) || sharedKeys.has(code), `transcript draws ${code} uncolourably`)
    }
  }
  // Highlighting is not a vocabulary: nothing there is a class of base.
  assert.equal(codesOf('highlight').size, 0)
})

test('a colour mixes towards white or black', () => {
  assert.equal(shade('#000000', 1), '#ffffff')
  assert.equal(shade('#ffffff', -1), '#000000')
  assert.equal(shade('#808080', 0), '#808080')
})

test('the codon stripe survives any colour', () => {
  // Shipped in, shipped out: the pair the app already draws is returned exactly,
  // so nothing repaints for a reader who has not chosen anything.
  assert.equal(codonPartner(CDS_STRIPE_COLORS[0]), CDS_STRIPE_COLORS[1])
  // And a chosen colour keeps a partner that can be told apart from it.
  for (const colour of ['#cc2222', '#0d9488', '#f8fafc', '#111827', '#ffffff', '#000000']) {
    const partner = codonPartner(colour)
    assert.notEqual(partner.toLowerCase(), colour.toLowerCase(), `${colour} has an invisible stripe`)
  }
})

test('a chosen CDS colour drives both of its shades', () => {
  const palette = buildPalette({ ...DEFAULT_COLOURS, cds: '#cc2222' })
  assert.equal(palette.style(CLASS_CODES.cds).bg, '#cc2222')
  assert.equal(palette.style(CLASS_CODES.cds1).bg, codonPartner('#cc2222'))
})

test('an item with several classes colours all of them', () => {
  // A splice site is a donor and an acceptor; colouring one would be a menu
  // that half works.
  const palette = buildPalette({ ...DEFAULT_COLOURS, splice: '#00ff00' })
  assert.equal(palette.style(CLASS_CODES.donor).bg, '#00ff00')
  assert.equal(palette.style(CLASS_CODES.acceptor).bg, '#00ff00')
})

test('nonsense in storage falls back rather than reaching the screen', () => {
  const colours = normaliseColours({ coding: 'not a colour', utr: '#123456', mixed: 42 })
  assert.equal(colours.coding, DEFAULT_COLOURS.coding)
  assert.equal(colours.utr, '#123456')
  assert.equal(colours.mixed, DEFAULT_COLOURS.mixed)
  // Everything else comes back whether it was stored or not.
  assert.deepEqual(Object.keys(colours).sort(), Object.keys(DEFAULT_COLOURS).sort())
})

test('nothing chosen is nothing to reset', () => {
  assert.equal(coloursChanged(DEFAULT_COLOURS), false)
  assert.equal(coloursChanged({ ...DEFAULT_COLOURS, intron: '#123456' }), true)
  // Case is not a change.
  assert.equal(coloursChanged({ ...DEFAULT_COLOURS, intron: DEFAULT_COLOURS.intron.toUpperCase() }), false)
})

test('a collision is only reported once a reader has caused one', () => {
  // 5' and 3' UTR ship as one purple, and saying so before anybody has touched
  // them is noise about a decision they did not make.
  assert.equal(collisionsIn('transcript', DEFAULT_COLOURS).size, 0)
  assert.equal(collisionsIn('region', DEFAULT_COLOURS).size, 0)
  assert.equal(collisionsIn('shared', DEFAULT_COLOURS).size, 0)

  const clash = collisionsIn('transcript', { ...DEFAULT_COLOURS, utr3: DEFAULT_COLOURS.splice })
  assert.equal(clash.get('splice'), '3′ UTR')
})

test('two marks of different kinds in one colour are not a collision', () => {
  // A filled cell and a rule under one are not confusable, whatever they share.
  const colours = { ...DEFAULT_COLOURS, mixed: DEFAULT_COLOURS.overlap }
  assert.equal(collisionsIn('region', colours).size, 0)
})

test('the legend and the switches show what is on screen', () => {
  const palette = buildPalette({ ...DEFAULT_COLOURS, intron: '#123456', cds: '#cc2222' })
  const intron = LEVEL_GROUPS.gene.find((group) => group.key === 'intron')
  assert.equal(groupColour(intron, palette), '#123456')
  // The overlap group has no classes at all: it is a rule beside them.
  const overlap = LEVEL_GROUPS.location.find((group) => group.key === 'overlap')
  assert.equal(groupColour(overlap, palette), palette.overlap)
  // A striped group's sample stripes in the chosen colours.
  const cds = LEVEL_GROUPS.transcript.find((group) => group.key === 'cds')
  assert.equal(groupGradient(cds, palette), `linear-gradient(90deg, #cc2222 50%, ${codonPartner('#cc2222')} 50%)`)
  assert.equal(groupGradient(intron, palette), null, 'a single-tone group has no gradient')
})

test('every group of every level resolves to a colour', () => {
  const palette = buildPalette(DEFAULT_COLOURS)
  for (const level of LEVELS) {
    for (const group of LEVEL_GROUPS[level] || []) {
      const colour = groupColour(group, palette)
      assert.match(String(colour), /^#[0-9a-f]{6}$/i, `${level}/${group.key} has no colour`)
      // And it is the one the palette shipped with, since nothing was chosen.
      const expected = group.classes?.length ? classStyle(group.classes[0]).bg : palette.overlap
      assert.equal(colour, expected)
    }
  }
})


// ---- highlighting ---------------------------------------------------------
//
// A selection and the ring on a base are marks about what the reader is doing,
// drawn over whatever colour a base already wears. They are not classes, so they
// come through the palette by their own names.

test('the selection keeps the alpha an animation drives', () => {
  // It cannot be a hex: the wash and the outline breathe, and the alpha of each
  // is a custom property a keyframe moves.
  const palette = DEFAULT_PALETTE
  assert.match(palette.selection.wash, /^rgb\(\d+ \d+ \d+ \/ var\(--sequence-select-alpha, [\d.]+\)\)$/)
  assert.match(palette.selection.edge, /^rgb\(\d+ \d+ \d+ \/ var\(--sequence-select-edge-alpha, [\d.]+\)\)$/)
  // And what shipped: the amber the alignment explorer picks with.
  assert.ok(palette.selection.wash.startsWith(`rgb(${rgbTriplet('#f2c766')} /`))
})

test('a chosen selection colour reaches both the wash and the line', () => {
  const palette = buildPalette({ ...DEFAULT_COLOURS, selection: '#22c55e' })
  const triplet = rgbTriplet('#22c55e')
  assert.ok(palette.selection.wash.includes(triplet))
  assert.ok(palette.selection.edge.includes(triplet))
  assert.equal(palette.selection.colour, '#22c55e')
})

test('the ring follows the theme until somebody picks a colour', () => {
  // High contrast against the page is the whole of its job, and which colour
  // that is depends on the page.
  const shipped = buildPalette(DEFAULT_COLOURS)
  assert.equal(shipped.colours.base, FOLLOW_THEME)
  assert.equal(shipped.ring(true), RING_THEME.light)
  assert.equal(shipped.ring(false), RING_THEME.dark)

  const chosen = buildPalette({ ...DEFAULT_COLOURS, base: '#ff00ff' })
  assert.equal(chosen.ring(true), '#ff00ff')
  assert.equal(chosen.ring(false), '#ff00ff', 'a chosen colour is the same on both themes')
})

test('following the theme survives a round trip through storage', () => {
  assert.equal(normaliseColours({ base: FOLLOW_THEME }).base, FOLLOW_THEME)
  assert.equal(normaliseColours({ base: '#123456' }).base, '#123456')
  // And nonsense still falls back to following it rather than to a colour.
  assert.equal(normaliseColours({ base: 'not a colour' }).base, FOLLOW_THEME)
})

test('a themed item on its default is not a change to reset', () => {
  assert.equal(coloursChanged(DEFAULT_COLOURS), false)
  assert.equal(coloursChanged({ ...DEFAULT_COLOURS, base: RING_THEME.dark }), true)
})

test('highlighting has no collisions to report against the classes', () => {
  // It is a section of its own, and a mark over a base cannot be confused with
  // the colour of one however they are set.
  assert.equal(collisionsIn('highlight', DEFAULT_COLOURS).size, 0)
  const both = { ...DEFAULT_COLOURS, selection: '#f8fafc', base: '#f8fafc' }
  assert.equal(collisionsIn('highlight', both).size, 0, 'a wash and a ring are different marks')
})
