// The app's heat map colours: blue for little, through purple and orange, to red for a lot.
// First drawn as the Feature Explorer's exon coverage heatmap; the gene trees' conservation
// colouring uses the same ramp, so a heat colour reads the same wherever it appears.

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const lerp = (a, b, t) => a + ((b - a) * t)

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '')
  if (clean.length !== 6) return { r: 127, g: 127, b: 127 }
  const n = Number.parseInt(clean, 16)
  if (!Number.isFinite(n)) return { r: 127, g: 127, b: 127 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex({ r, g, b }) {
  const pack = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${pack(r)}${pack(g)}${pack(b)}`
}

export const HEAT_STOPS = [
  { t: 0.0, color: '#3b82f6' }, // blue
  { t: 0.33, color: '#8b5cf6' }, // purple
  { t: 0.66, color: '#f59e0b' }, // orange
  { t: 1.0, color: '#ef4444' }, // red
]

/** The heat colour for `fraction` (0..1), as a hex string. */
export function heatColorFromFraction(fraction) {
  const t = clamp(Number(fraction) || 0, 0, 1)
  for (let i = 0; i < HEAT_STOPS.length - 1; i += 1) {
    const a = HEAT_STOPS[i]
    const b = HEAT_STOPS[i + 1]
    if (t <= b.t) {
      const local = (t - a.t) / Math.max(1e-9, (b.t - a.t))
      const aRgb = hexToRgb(a.color)
      const bRgb = hexToRgb(b.color)
      return rgbToHex({
        r: lerp(aRgb.r, bRgb.r, local),
        g: lerp(aRgb.g, bRgb.g, local),
        b: lerp(aRgb.b, bRgb.b, local),
      })
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1].color
}
