/** Column identity among a cohort of sequences, and the colour ramp it drives.
 *
 * Observed agreement between the sequences in view. It is not an evolutionary
 * constraint score, and nothing here should be labelled as one.
 *
 * Two independent quantities are carried at once, because agreement alone
 * misleads. A block holding three of the ten sequences someone is reading can
 * agree with itself perfectly while being, as a piece of alignment, thin. So
 * identity says how well the sequences that are present agree, representation
 * says how much of the cohort is there to agree, and the two are kept on
 * channels that cannot be confused: identity is the colour, representation is
 * how much of the row that colour fills.
 */
import { rampStops } from './palettes.js'

export const IDENTITY_STEPS = 32, REPRESENTATION_STEPS = 6
export const NOT_COMPARABLE = -1, GAP_RUN = -2
export const RAMP_SIZE = IDENTITY_STEPS

/** The literal fraction, for a readout that has to be honest rather than scaled. */
export const identityFraction = (majority, canonical) => canonical ? majority / canonical : null

/** Sums first, then one division. Averaging per-column fractions would weight a
 * column holding two sequences the same as one holding twenty.
 *
 * `comparable` counts only the columns where two or more canonical bases met,
 * and identity is built from those alone. A column with a single base agrees
 * with itself by definition; counting it would quietly lift every sparse
 * region toward perfect conservation. It still counts toward representation,
 * which is exactly where that sparseness belongs. */
export function conservationScore(majority, canonical, comparable, occupied, columns, cohort, scale) {
  if (!columns || !cohort || !comparable || !canonical) return null
  const identity = majority / canonical
  return {
    identity,
    depth: canonical / comparable,
    conserved: stretch(identity, scale),
    representation: Math.max(0, Math.min(1, occupied / (cohort * columns))),
  }
}

// Real alignments do not use the range a ratio theoretically has. Measured over
// a 44-mammal EPO block, per-bin identity runs from .86 at the 5th percentile to
// 1.00 at the 95th: stretched over 0..1 the whole alignment lands in the top
// eighth of any ramp and every region comes out the same colour. So the ramp is
// fitted to the distribution actually loaded, and the legend prints the numbers
// it was fitted to - an adaptive scale that did not say what it had done would
// be worse than a flat one.
export const DEFAULT_SCALE = { lo: 0.5, hi: 1, fitted: false }
// Narrower than this is noise being magnified into a rainbow.
const MIN_RANGE = 0.04
const BUCKETS = 256

function stretch(identity, scale) {
  const { lo, hi } = scale || DEFAULT_SCALE
  return hi <= lo ? 1 : Math.max(0, Math.min(1, (identity - lo) / (hi - lo)))
}

/** Fit the ramp to the loaded tiles: a column-weighted 2nd and 98th percentile
 * of per-bin identity. Bucketed, so the scale only moves when the distribution
 * moves by a whole bucket rather than jittering on every pan. */
export function conservationScale(sources) {
  const histogram = new Float64Array(BUCKETS)
  let total = 0
  for (const data of sources || []) {
    const bins = data?.bins
    if (!bins?.columns) continue
    for (let i = 0; i < bins.columns.length; i++) {
      const canonical = bins.canonical[i], weight = bins.comparable[i]
      if (!canonical || !weight) continue
      histogram[Math.min(BUCKETS - 1, Math.floor(bins.majority[i] / canonical * BUCKETS))] += weight
      total += weight
    }
  }
  if (total < 64) return DEFAULT_SCALE
  const at = fraction => {
    let seen = 0
    for (let i = 0; i < BUCKETS; i++) { seen += histogram[i]; if (seen >= total * fraction) return i / BUCKETS }
    return 1
  }
  let lo = at(0.02), hi = Math.min(1, at(0.98) + 1 / BUCKETS)
  if (hi - lo < MIN_RANGE) {
    const middle = (lo + hi) / 2
    lo = Math.max(0, middle - MIN_RANGE / 2); hi = Math.min(1, lo + MIN_RANGE)
  }
  return { lo, hi, fitted: true }
}

const bucket = (value, steps) => Math.max(0, Math.min(steps - 1, Math.floor(value * steps)))

/** Both axes in one integer: the colour is the low part, how tall to draw it is
 * the high part. Runs therefore break when either changes, which is what keeps
 * the merged rectangles honest. */
export function conservationIndex(bins, bin, cohort, scale) {
  const score = conservationScore(bins.majority[bin], bins.canonical[bin], bins.comparable[bin],
    bins.occupied[bin], bins.columns[bin], cohort, scale)
  if (!score) return NOT_COMPARABLE
  return bucket(score.representation, REPRESENTATION_STEPS) * IDENTITY_STEPS + bucket(score.conserved, IDENTITY_STEPS)
}

/** The second axis on its own: how much of the cohort is present, whatever it
 * says. Answers "where is this alignment thin?" without agreement confusing it,
 * and costs nothing beyond what conservation already asked the server for. */
export function representationIndex(bins, bin, cohort) {
  const columns = bins.columns[bin]
  if (!columns || !cohort) return NOT_COMPARABLE
  const fraction = Math.min(1, bins.occupied[bin] / (cohort * columns))
  return (REPRESENTATION_STEPS - 1) * IDENTITY_STEPS + bucket(fraction, IDENTITY_STEPS)
}

export const rampColour = index => index % IDENTITY_STEPS
/** Never zero: a column that is present at all has to be visible, or a thin
 * region and an absent one look the same. */
export const rampHeight = index =>
  0.24 + 0.76 * (Math.floor(index / IDENTITY_STEPS) + 1) / REPRESENTATION_STEPS

// The stops themselves live in palettes.js; what matters here is that a ramp
// is a fixed-length lookup table, built once per palette and theme and read by
// index in the painter. Building colours per bin was measurably the slowest
// part of the old bin path.
const ramps = new Map()

export function buildRamp(light, palette) {
  const key = `${palette || ''}:${light ? 'light' : 'dark'}`
  if (ramps.has(key)) return ramps.get(key)
  const stops = rampStops(palette, light), ramp = new Array(IDENTITY_STEPS)
  for (let i = 0; i < IDENTITY_STEPS; i++) {
    const t = IDENTITY_STEPS === 1 ? 1 : i / (IDENTITY_STEPS - 1)
    let a = stops[0], b = stops[stops.length - 1]
    for (let s = 0; s < stops.length - 1; s++) if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1] }
    const span = b[0] - a[0], f = span ? (t - a[0]) / span : 0
    const mix = j => Math.round(a[j] + (b[j] - a[j]) * f)
    ramp[i] = `rgb(${mix(1)},${mix(2)},${mix(3)})`
  }
  ramps.set(key, ramp)
  return ramp
}

export const buildRepresentationRamp = buildRamp

/** Legend data, not markup, so this module stays testable without a DOM. */
export function conservationLegend(light, scale = DEFAULT_SCALE, palette) {
  return {
    kind: 'ramp',
    bar: buildRamp(light, palette),
    low: scale.fitted ? `${(scale.lo * 100).toFixed(0)}%` : 'less',
    high: scale.fitted ? `${(scale.hi * 100).toFixed(0)}%` : 'more',
    across: 'Agreement between the sequences present',
    heights: [1, 3, 5].map(r => 0.24 + 0.76 * (r + 1) / REPRESENTATION_STEPS),
    down: 'Bar height: share of the cohort present',
    note: scale.fitted
      ? 'Observed column identity among the sequences in view, scaled to the range loaded. Not a constraint score.'
      : 'Observed column identity among the sequences in view. Not a constraint score.',
  }
}

export function representationLegend(light, scale, palette) {
  return {
    kind: 'ramp',
    bar: buildRamp(light, palette),
    low: '0%', high: '100%',
    across: 'Share of the cohort present',
    heights: [],
    down: '',
    note: 'How much of the cohort this block holds, whatever it agrees on.',
  }
}

/** Merge neighbouring columns that land in the same bucket into one run. A
 * conserved stretch collapses to a handful of fills where painting it base by
 * base would have cost one per column. */
export function conservationRuns(data, from, to, cohort, gapAt, index = conservationIndex, scale) {
  const runs = []
  if (!data || to <= from) return runs
  const { bin_size: size, start: origin, bins } = data
  let run = null
  for (let column = from; column < to;) {
    const bin = Math.floor((column - origin) / size)
    const binEnd = Math.min(to, origin + (bin + 1) * size)
    // Once per bin, never once per column: the bucket cannot change inside one.
    const value = bin < 0 || bin >= bins.columns.length ? NOT_COMPARABLE : index(bins, bin, cohort, scale)
    // A gap belongs to this row alone and breaks the run, so an absent stretch
    // stays visible inside a wash that is otherwise about the whole column.
    const step = gapAt ? 1 : binEnd - column
    for (let end = column + step; column < binEnd; column = end, end = Math.min(binEnd, end + step)) {
      const at = gapAt && gapAt(column) ? GAP_RUN : value
      if (run && run.index === at && run.end === column) run.end = end
      else runs.push(run = { start: column, end, index: at })
    }
  }
  return runs
}
