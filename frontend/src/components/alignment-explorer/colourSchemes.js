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
    hint: 'Each base has its own colour. When you zoom out, the shading setting below determines how blocks are coloured.',
    status: null },
  { id: 'conservation', label: 'Conservation', cohort: true, ramp: buildRamp, index: conservationIndex, legend: conservationLegend, palettes: 'ramp',
    hint: 'Colour shows agreement between sequences, using the selected palette and the range of values in the loaded region. Bar height shows the proportion of the comparison set present. A block with three of ten sequences has a shorter bar, even if all three agree. This measures observed sequence identity, not evolutionary constraint.',
    status: 'Column identity' },
  { id: 'representation', label: 'Presence', cohort: true, ramp: buildRepresentationRamp, index: representationIndex, legend: representationLegend, palettes: 'ramp',
    hint: 'Colour shows the proportion of the comparison set present in each column, regardless of how well the sequences agree.',
    status: 'Sequence presence' },
]

/** What the alignment is painted in while the find box is open.
 *
 * Not one of the Colour menu's schemes any more: Find is its own control on the
 * bar, as it is in the sequence view, and while it is open it takes over the
 * painting - matches in the reader's colours over a neutral sheet, since a match
 * drawn over base or conservation colours is a colour among colours. Whatever
 * Colour is set to is kept, and comes back when the box is shut.
 *
 * The id stays `motif`: it is the backend's own routes and the painter's test,
 * and renaming it would change a word nobody sees. */
export const FIND_SCHEME = { id: 'motif', label: 'Find', cohort: false, status: 'Find matches' }

export const schemeById = id => id === FIND_SCHEME.id ? FIND_SCHEME : COLOUR_SCHEMES.find(s => s.id === id) || COLOUR_SCHEMES[0]

/** What `bases` does once a column is too narrow to be a base.
 *
 * Two answers, and they are alternatives rather than schemes: the sequence is
 * still the sequence either way, and this only decides what stands in for it
 * when it cannot be drawn. Relative is what this view has always done; uniform
 * is the same admission the row-too-thin case already makes, chosen on purpose.
 */
export const SHADING_MODES = [
  { id: 'relative', label: 'Relative',
    hint: 'Colour shows agreement with the comparison row in each block.' },
  { id: 'uniform', label: 'Uniform',
    hint: 'Use a single colour to show where sequence is present, without showing base identity or agreement.' },
]
export const shadingById = id => SHADING_MODES.find(mode => mode.id === id) || SHADING_MODES[0]
