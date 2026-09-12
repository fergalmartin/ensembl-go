import { buildRamp, buildRepresentationRamp, conservationIndex, representationIndex,
  conservationLegend, representationLegend } from './conservation.js'
import { basesLegend } from './palettes.js'

/** How a block's cells get their colour. One entry per scheme, read once per
 * paint and never inside a loop.
 *
 * `bases` carries no ramp at all, which is what keeps it on the original,
 * optimised path: the painter tests for a ramp and otherwise does not know a
 * scheme exists. A scheme with `cohort` set is the only reason the conservation
 * tile stream is ever asked for anything.
 *
 * `palettes` says which set of colours the scheme can be drawn in - four
 * unordered base colours, or an ordered ramp - and is what the Colour menu
 * offers on that scheme's tab.
 *
 * Adding one means adding an entry here. A scheme needing a statistic the
 * cohort payload does not carry needs a backend field too: consensus mismatch,
 * for instance, would want the majority base, which is not additive and so
 * cannot come from the prefix sums the way these counts do.
 */
export const COLOUR_SCHEMES = [
  { id: 'bases', label: 'Bases', cohort: false, ramp: null, index: null, legend: basesLegend, palettes: 'base',
    shading: true,
    hint: 'One colour per base close up. What happens once the bases are too small to draw is the shading below.',
    status: null },
  { id: 'conservation', label: 'Conservation', cohort: true, ramp: buildRamp, index: conservationIndex, legend: conservationLegend, palettes: 'ramp',
    hint: 'Colour is how well the sequences present agree, from blue for little to red for a lot, scaled to the range actually loaded. Bar height is how much of the cohort is there to agree: a block holding three of ten sequences draws a thin bar however perfectly those three agree. Observed agreement, not a constraint score.',
    status: 'Column identity' },
  { id: 'representation', label: 'Presence', cohort: true, ramp: buildRepresentationRamp, index: representationIndex, legend: representationLegend, palettes: 'ramp',
    hint: 'How much of the cohort each column actually holds, with agreement left out of it.',
    status: 'Cohort presence' },
]

/** What `bases` does once a column is too narrow to be a base.
 *
 * Two answers, and they are alternatives rather than schemes: the sequence is
 * still the sequence either way, and this only decides what stands in for it
 * when it cannot be drawn. Relative is what this view has always done; uniform
 * is the same admission the row-too-thin case already makes, chosen on purpose.
 */
export const SHADING_MODES = [
  { id: 'relative', label: 'Relative',
    hint: 'Agreement with each block\'s comparison row, so a bin is coloured relative to that row.' },
  { id: 'uniform', label: 'Uniform',
    hint: 'One flat colour for every block: where the sequence is, and nothing about what it says.' },
]
export const shadingById = id => SHADING_MODES.find(mode => mode.id === id) || SHADING_MODES[0]

export const schemeById = id => COLOUR_SCHEMES.find(s => s.id === id) || COLOUR_SCHEMES[0]
