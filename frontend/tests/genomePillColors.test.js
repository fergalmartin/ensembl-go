import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_GENOME_COLOR_PALETTE } from '../src/genomeColorSchemes.js'
import {
  PILL_MUTED,
  PILL_SURFACE,
  PILL_TEXT_CONTRAST,
  SOLID_FILL_MIN_CONTRAST,
  contrastRatio,
  genomePillColors,
  legibleOn,
  mixHex,
  readableTextOn,
  relativeLuminance,
} from '../src/utils/genomePillColors.js'

const THEMES = [{ isLight: true }, { isLight: false }]
// Colours the picker can produce that the old fixed white-on-blue would fail on.
const AWKWARD = ['#ffffff', '#000000', '#f7f3a0', '#84cc16', '#1a1a2e', '#ff00ff']

test('mixHex walks from one colour to the other and clamps outside 0..1', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0), '#000000')
  assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff')
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080')
  assert.equal(mixHex('#000000', '#ffffff', -3), '#000000')
  assert.equal(mixHex('#000000', '#ffffff', 9), '#ffffff')
})

test('contrast is symmetric and spans the known extremes', () => {
  assert.ok(relativeLuminance('#ffffff') > relativeLuminance('#000000'))
  assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21)
  assert.equal(contrastRatio('#3366cc', '#ffffff'), contrastRatio('#ffffff', '#3366cc'))
  assert.equal(Math.round(contrastRatio('#ffffff', '#ffffff')), 1)
})

test('a solid pill takes whichever label colour its fill can carry', () => {
  assert.equal(readableTextOn('#111827'), '#ffffff')
  assert.equal(readableTextOn('#f7f3a0'), '#111827')
  for (const color of [...BUILTIN_GENOME_COLOR_PALETTE, ...AWKWARD]) {
    const text = readableTextOn(color)
    assert.ok(contrastRatio(text, color) >= SOLID_FILL_MIN_CONTRAST, `${color} -> ${text}`)
    // Optimal, not merely adequate: the other choice is never better.
    const other = text === '#ffffff' ? '#111827' : '#ffffff'
    assert.ok(contrastRatio(text, color) >= contrastRatio(other, color), color)
  }
})

test('legibleOn moves an accent toward the surface it has to be read against', () => {
  // Dark surface: accents brighten. Light surface: accents deepen.
  assert.ok(relativeLuminance(legibleOn('#3366cc', '#1e2938')) > relativeLuminance('#3366cc'))
  assert.ok(relativeLuminance(legibleOn('#f7f3a0', '#ffffff')) < relativeLuminance('#f7f3a0'))
  // An accent that is already legible is left exactly as it is.
  assert.equal(legibleOn('#ffffff', '#000000'), '#ffffff')
})

test('every palette colour is readable in every pill state on both themes', () => {
  for (const color of [...BUILTIN_GENOME_COLOR_PALETTE, ...AWKWARD]) {
    for (const theme of THEMES) {
      for (const state of ['active', 'inactive', 'available']) {
        const { backgroundColor, textColor, borderColor } = genomePillColors(color, { ...theme, state })
        assert.match(backgroundColor, /^#[0-9a-f]{6}$/)
        // A solid fill is the user's colour and cannot be adjusted; the hollow
        // states set their own accent and are held to the higher bar.
        const floor = state === 'active' ? SOLID_FILL_MIN_CONTRAST : PILL_TEXT_CONTRAST
        assert.ok(
          contrastRatio(textColor, backgroundColor) >= floor - 0.01,
          `${color} ${state} ${theme.isLight ? 'light' : 'dark'}: ${textColor} on ${backgroundColor}`,
        )
        if (state !== 'active') assert.match(borderColor, /^#[0-9a-f]{6}$/)
      }
    }
  }
})

test('the three states are a ladder: solid, hollow, then barely there', () => {
  for (const theme of THEMES) {
    const surface = theme.isLight ? PILL_SURFACE.light : PILL_SURFACE.dark
    const active = genomePillColors('#8b5cf6', { ...theme, state: 'active' })
    const inactive = genomePillColors('#8b5cf6', { ...theme, state: 'inactive' })
    const available = genomePillColors('#8b5cf6', { ...theme, state: 'available' })

    assert.equal(active.backgroundColor, '#8b5cf6')
    assert.equal(active.borderColor, 'transparent')
    // The hollow pill is a wash of the colour, not the bare surface.
    assert.notEqual(inactive.backgroundColor, surface)
    assert.ok(
      contrastRatio(inactive.backgroundColor, surface) < contrastRatio(active.backgroundColor, surface),
      'the wash sits between the surface and the solid fill',
    )
    // The unselected pill keeps the surface and the muted label it always had.
    assert.equal(available.backgroundColor, surface)
    assert.equal(available.textColor, theme.isLight ? PILL_MUTED.light.text : PILL_MUTED.dark.text)
    assert.notEqual(available.borderColor, theme.isLight ? PILL_MUTED.light.border : PILL_MUTED.dark.border)
  }
})

test('two genomes stay distinguishable in the hollow state', () => {
  for (const theme of THEMES) {
    const blue = genomePillColors('#3366cc', { ...theme, state: 'inactive' })
    const amber = genomePillColors('#f59e0b', { ...theme, state: 'inactive' })
    assert.notEqual(blue.backgroundColor, amber.backgroundColor)
    assert.notEqual(blue.borderColor, amber.borderColor)
    assert.notEqual(blue.textColor, amber.textColor)
  }
})

test('a genome with no usable colour falls back to the plain grey pill', () => {
  for (const theme of THEMES) {
    const muted = theme.isLight ? PILL_MUTED.light : PILL_MUTED.dark
    for (const state of ['active', 'inactive', 'available']) {
      const pill = genomePillColors('', { ...theme, state })
      assert.equal(pill.textColor, muted.text)
      assert.equal(pill.borderColor, muted.border)
    }
  }
})
