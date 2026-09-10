// Drawing a genome's colour on a pill.
//
// `genomeColorSchemes` answers *which* colour a genome is; this answers how to
// wear it in each of the three states a pill has, on either theme. The two are
// separate because the colour is now the user's to choose: a pale lime and a
// deep indigo are both legal, and a pill that hard-codes white text or assumes a
// dark accent breaks on one of them. Everything here is derived from the colour
// and the surface it sits on, so any colour the picker can produce is legible.

import { sanitizeHexColor } from '../genomeColorSchemes.js'

/** The surface a pill sits on, per theme — the header's own background. */
export const PILL_SURFACE = Object.freeze({ light: '#ffffff', dark: '#1e2938' })

/** The text and border a genome with no colour at all falls back to: a pill for
 *  a genome that is not part of the session says so in grey, as it always did. */
export const PILL_MUTED = Object.freeze({
  light: { text: '#4b5563', border: '#d1d5db' },
  dark: { text: '#9ca3af', border: '#4b5563' },
})

/** What a hollow pill's label is held to: `legibleOn` can always reach it,
 *  because it is free to move the accent toward the surface until it does. */
export const PILL_TEXT_CONTRAST = 4.5

/** What a *solid* pill's label can be held to.
 *
 *  A solid pill is the colour the user picked, so its label has only black and
 *  white to choose between — and a mid-tone fill is a poor background for both.
 *  Sweeping the whole cube, the worst any colour does with the better of the two
 *  is 4.21:1 (around #a87007), so `readableTextOn` is already optimal and this is
 *  the floor rather than a target to design against. It clears the 3:1 that WCAG
 *  asks of a bold 12px label, and beats the fixed white this replaced — which
 *  managed 2.15:1 on the amber in the default palette. */
export const SOLID_FILL_MIN_CONTRAST = 4.2

const clampChannel = (value) => Math.min(255, Math.max(0, Math.round(value)))

export function hexToRgb(hex) {
  const normalized = sanitizeHexColor(hex, '#000000')
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  }
}

export function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((value) => clampChannel(value).toString(16).padStart(2, '0')).join('')}`
}

/** `from` at `amount` 0 through `to` at 1, straight down each channel. */
export function mixHex(from, to, amount) {
  const ratio = Math.min(1, Math.max(0, Number(amount) || 0))
  const start = hexToRgb(from)
  const end = hexToRgb(to)
  return rgbToHex({
    r: start.r + (end.r - start.r) * ratio,
    g: start.g + (end.g - start.g) * ratio,
    b: start.b + (end.b - start.b) * ratio,
  })
}

/** WCAG relative luminance, which is what the contrast ratio is defined on. */
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex)
  const channel = (value) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  const [high, low] = a >= b ? [a, b] : [b, a]
  return (high + 0.05) / (low + 0.05)
}

/** Whichever of near-black and white is more readable on `background`.
 *
 *  What a solid pill's label uses. White was fine while every pill was the same
 *  Ensembl blue; on a colour the user mixed it is a coin toss. */
export function readableTextOn(background, { light = '#ffffff', dark = '#111827' } = {}) {
  return contrastRatio(light, background) >= contrastRatio(dark, background) ? light : dark
}

/** `color` pushed toward white or black until it can be read on `background`.
 *
 *  The direction is set by the background, not the colour: on the dark theme
 *  every accent brightens, on the light theme every accent deepens, so a strip
 *  of pills keeps one visual logic even when their colours are far apart. */
export function legibleOn(color, background, target = PILL_TEXT_CONTRAST) {
  const toward = relativeLuminance(background) < 0.5 ? '#ffffff' : '#000000'
  let candidate = sanitizeHexColor(color, '#000000')
  if (contrastRatio(candidate, background) >= target) return candidate
  for (let step = 1; step <= 20; step += 1) {
    candidate = mixHex(color, toward, step / 20)
    if (contrastRatio(candidate, background) >= target) return candidate
  }
  // Twenty steps lands on `toward` itself, which is the most contrast there is.
  return candidate
}

/**
 * The fill, text and border for one pill.
 *
 * The three states are a ladder of how much of the genome's colour is showing,
 * so which state a pill is in is legible before its label is read:
 *
 *   `active`    — drawn in this view: the colour, solid.
 *   `inactive`  — in the session but not on screen here: the colour, hollow.
 *   `available` — not in the session: grey, with the colour only in the border.
 */
export function genomePillColors(color, { isLight = false, state = 'active' } = {}) {
  const surface = isLight ? PILL_SURFACE.light : PILL_SURFACE.dark
  const muted = isLight ? PILL_MUTED.light : PILL_MUTED.dark
  const accent = sanitizeHexColor(color, '')

  if (!accent) {
    return { backgroundColor: surface, textColor: muted.text, borderColor: muted.border }
  }

  if (state === 'active') {
    return { backgroundColor: accent, textColor: readableTextOn(accent), borderColor: 'transparent' }
  }

  if (state === 'inactive') {
    // A wash rather than nothing: an outlined pill on the dark theme otherwise
    // reads as a hole in the strip, and the wash is what makes the row of
    // inactive pills scan as one group.
    const backgroundColor = mixHex(surface, accent, isLight ? 0.12 : 0.2)
    return {
      backgroundColor,
      textColor: legibleOn(accent, backgroundColor),
      borderColor: mixHex(surface, accent, isLight ? 0.6 : 0.66),
    }
  }

  return {
    backgroundColor: surface,
    textColor: muted.text,
    // Only the border carries the colour: this genome is not in the session, and
    // colouring its label would claim more than that.
    borderColor: mixHex(muted.border, accent, 0.45),
  }
}
