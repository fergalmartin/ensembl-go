/** The colours a scheme can be drawn in, kept apart from what a scheme means.
 *
 * Two kinds, because the two kinds of scheme ask different questions. `bases`
 * needs four unordered colours that stay apart from each other; conservation
 * and presence need one ordered ramp, where the order is the whole message.
 *
 * Every palette carries both themes explicitly rather than deriving one from
 * the other. A ramp has to gain contrast against the page as the quantity
 * rises - darkening toward the high end on a light ground, brightening on a
 * dark one - so the two are not the same colours with the lightness flipped,
 * and a palette that got that backwards would read as an inverted scale.
 */
import { NUCLEOTIDE_COLORS } from '../../utils/nucleotideStyle.js'

export const BASE_PALETTES = [
  {
    id: 'classic', label: 'Classic',
    note: 'A red, C blue, G orange, T green.',
    light: NUCLEOTIDE_COLORS.light, dark: NUCLEOTIDE_COLORS.dark,
  },
  {
    // Four hues that stay apart under the common forms of colour blindness:
    // no red-green pair carries meaning, and the two blues differ in lightness
    // as well as hue, so they survive being printed grey.
    id: 'accessible', label: 'Colour-blind safe',
    note: 'Pink, blue, sky and orange: no red-green pair carries meaning.',
    light: { baseA: '#c2568f', baseT: '#0072b2', baseC: '#56b4e9', baseG: '#d98200', baseN: '#95a5a6' },
    dark: { baseA: '#ef8ab9', baseT: '#4ea3dd', baseC: '#8ed3f5', baseG: '#f0a93c', baseN: '#5c5f66' },
  },
  {
    // A strong set that shares no hue assignment with the other two: nothing
    // here is the red, green and orange the classic palette trained the eye on,
    // so a sheet in this palette cannot be misread as one in that.
    // C is orange rather than the cyan it started as: beside teal T the two
    // read as one colour on a sheet of single-pixel columns, whatever they look
    // like side by side in the menu. The rose G is deepened to keep its
    // distance from the new orange, the one pair now closest in hue.
    id: 'vivid', label: 'Vivid',
    note: 'Violet, orange, rose and teal: strong, and unlike the other two.',
    light: { baseA: '#7c3aed', baseT: '#0d9488', baseC: '#d97706', baseG: '#be123c', baseN: '#95a5a6' },
    dark: { baseA: '#a78bfa', baseT: '#2dd4bf', baseC: '#fb923c', baseG: '#e11d48', baseN: '#5c5f66' },
  },
  {
    // Quiet enough to read annotations, features and picked regions over.
    id: 'muted', label: 'Muted',
    note: 'The same four hues, damped, so annotations and picks read over them.',
    light: { baseA: '#b0736c', baseT: '#6f9e7c', baseC: '#6a8cae', baseG: '#b39a66', baseN: '#a7aeb8' },
    dark: { baseA: '#9d6a66', baseT: '#6f9576', baseC: '#6b87a6', baseG: '#a79268', baseN: '#5c5f66' },
  },
]

export const RAMP_PALETTES = [
  {
    // Blue for little agreement through to red for a lot, the way a heat map
    // is read - but routed through purple rather than through green and
    // yellow. The usual blue-green-yellow-red sweep is close to unreadable
    // with red-green colour blindness, and its yellow shoulder also collided
    // with the gold this app reserves for what is picked out.
    id: 'heat', label: 'Blue to red',
    note: 'Through purple, avoiding the green and yellow a red-green reader cannot separate.',
    dark: [[0, 30, 48, 110], [.25, 78, 68, 168], [.5, 136, 76, 178], [.75, 196, 76, 150], [1, 246, 92, 84]],
    light: [[0, 150, 178, 224], [.25, 134, 140, 210], [.5, 140, 96, 186], [.75, 164, 60, 146], [1, 178, 32, 44]],
  },
  {
    // Blue to green rather than through it: the pair that fails for a
    // red-green reader is red against green, and neither end here is red.
    id: 'field', label: 'Blue to green',
    note: 'A cool ramp for reading beside warm annotations.',
    dark: [[0, 34, 52, 118], [.33, 36, 104, 158], [.66, 40, 154, 146], [1, 108, 214, 124]],
    light: [[0, 168, 196, 232], [.33, 106, 160, 202], [.66, 54, 134, 150], [1, 16, 94, 74]],
  },
  {
    // One hue, ordered by lightness alone, for when the colour has to survive
    // being screenshotted, printed, or read next to something else coloured.
    id: 'ice', label: 'Ice',
    note: 'One hue ordered by lightness: it survives greyscale and printing.',
    dark: [[0, 24, 44, 82], [.5, 42, 108, 168], [1, 150, 220, 246]],
    light: [[0, 198, 218, 238], [.5, 92, 150, 206], [1, 16, 52, 112]],
  },
  {
    // No hue at all. The one to use when something else on the sheet is
    // carrying the colour - features, picked regions, another layer.
    id: 'mono', label: 'Mono',
    note: 'No hue at all, so anything coloured drawn over it stays the only colour.',
    dark: [[0, 48, 58, 74], [1, 226, 234, 244]],
    light: [[0, 214, 221, 230], [1, 30, 42, 58]],
  },
]

const KINDS = { base: BASE_PALETTES, ramp: RAMP_PALETTES }

/** What this view has always meant by "sequence is here and nothing more is
 * being said about it": the colour a row too thin to read is drawn in, and the
 * one a bin with no comparison to make falls back to. Uniform shading is that
 * same statement made deliberately, so it is that same colour. */
export const PRESENCE = { light: '#7baeb5', dark: '#448d99' }
export const presenceColour = light => PRESENCE[light ? 'light' : 'dark']
const byId = (list, id) => list.find(p => p.id === id) || list[0]

/** The four base colours a palette draws with, in the theme being painted. */
export const basePalette = (id, light) => byId(BASE_PALETTES, id)[light ? 'light' : 'dark']
/** The stops a ramp interpolates, in the theme being painted. */
export const rampStops = (id, light) => byId(RAMP_PALETTES, id)[light ? 'light' : 'dark']
export const paletteById = (kind, id) => byId(KINDS[kind] || BASE_PALETTES, id)
export const palettesOfKind = kind => KINDS[kind] || BASE_PALETTES

/** The default for a kind: the first entry, and the one an unknown id falls to. */
export const defaultPalette = kind => palettesOfKind(kind)[0].id

/** The key for `bases`, in the same shape the ramp schemes produce: the legend
 * component never learns which scheme it is drawing. Five swatches, because a
 * column that is neither a gap nor ACGT still has to have a colour - and a
 * sixth under uniform shading, since a flat block is then a thing the reader
 * sees and has to be able to look up. */
export function basesLegend(light, scale, palette, shading) {
  const colours = basePalette(palette, light)
  const bases = [['A', colours.baseA], ['C', colours.baseC], ['G', colours.baseG], ['T', colours.baseT],
    ['N', colours.baseN]].map(([label, colour]) => ({ label, colour }))
  const uniform = shading === 'uniform'
  return {
    kind: 'swatches',
    swatches: uniform ? [...bases, { label: 'Present', colour: presenceColour(light) }] : bases,
    note: 'One colour per base, with gaps left as the page. Zoomed out past single bases, '
      + (uniform
        ? 'every block becomes one flat colour: where sequence is, and nothing about it.'
        : 'colour becomes agreement with the comparison row instead.'),
  }
}
