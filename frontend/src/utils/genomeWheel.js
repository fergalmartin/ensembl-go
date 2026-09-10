import { getGenomeKey } from './genomeIdentity.js'

export const clampWheelPosition = (position, count) => Math.max(0, Math.min(Math.max(0, count - 1), position))

// Continuous, monotonic detents, with no jump when leaving a face.
export function detentPosition(position) {
  const face = Math.round(position)
  const delta = position - face
  return face + delta * (0.28 + 0.72 * Math.min(1, Math.abs(delta) / 0.32))
}

export const defaultCycleAction = activeCount => activeCount > 1 ? 'add' : 'focus'

export function cycleRailGeometry(count, buttonRect, viewportHeight) {
  const cancelHeight = 32
  // Clears the caption under the bottom-most pair of action buttons, which hangs
  // below the rail; at the old 8px the words sat on top of Cancel.
  const cancelGap = 18
  const bottomSpace = cancelHeight + cancelGap + 12
  const top = Math.max(0, Math.min(buttonRect.bottom + 8, viewportHeight - bottomSpace - 16))
  const height = Math.max(16, Math.min(Math.max(80, (count - 1) * 34 + 32), 420, viewportHeight - top - bottomSpace))
  const padding = Math.min(16, height / 4)
  return { top, height, padding, cancelTop: top + height + cancelGap, cancelHeight, center: (buttonRect.left + buttonRect.right) / 2,
    spacing: count > 1 ? (height - padding * 2) / (count - 1) : 0 }
}

// The hit regions and the visible +/- controls share these dimensions. The
// offset clears the 26px half-width of the rail by more than the buttons' own
// 16px radius, so neither they nor their captions touch it.
export const CYCLE_ACTION_OFFSET = 46
export const CYCLE_ACTION_RADIUS = 18
// Where a pointer sits on the rail, in face units. Shared so that anything
// drawing a rail from cycleRailGeometry reads a cursor at the same place it drew
// the dots: the two drifting apart is what makes a wheel feel unhooked from the
// hand.
export const cycleRailPosition = (y, rail, count) =>
  clampWheelPosition(rail.spacing ? (y - rail.top - rail.padding) / rail.spacing : 0, count)

export function cyclePointerIntent(x, y, rail, count, defaultAction) {
  const position = cycleRailPosition(y, rail, count)
  const face = Math.round(position)
  const dx = x - rail.center
  const validY = y >= rail.top && y <= rail.top + rail.height
  const validX = Math.abs(dx) <= CYCLE_ACTION_OFFSET + CYCLE_ACTION_RADIUS
  return { position, face, action: validY && validX
    ? (dx < -22 ? 'focus' : dx > 22 ? 'add' : defaultAction) : null }
}

export function cycleSelection(active, listed, selectedKey, action) {
  const unique = items => [...new Map(items.map(item => [getGenomeKey(item), item])).values()]
  const pool = unique([...listed, ...active])
  const chosen = pool.find(item => getGenomeKey(item) === selectedKey)
  if (!chosen || !chosen.files?.gff3 || !['focus', 'add'].includes(action)) return null
  // Add is idempotent for an already-active genome; it never reorders the pool.
  const nextActive = action === 'focus' ? [chosen] : unique([...active, chosen])
  const keys = new Set(nextActive.map(getGenomeKey))
  return { active: nextActive, inactive: pool.filter(item => !keys.has(getGenomeKey(item))) }
}

export function cycleGenomeDetails(species) {
  const name = species.display_name || species.common_name || species.scientific_name || species.species_key || ''
  const assembly = species.assembly_name || ''
  const accession = [...new Set([species.assembly, species.gca, species.gcf, species.assembly_accession].filter(Boolean))].join(' · ')
  const label = species.custom_label || species.user_label || species.label || ''
  return { name, assembly, accession, label }
}

// A press that never travels is a click, and a click leaves the wheel open to
// follow the bare cursor. Small enough that a deliberate drag always registers,
// large enough that the hand shake in a click never does.
export const CYCLE_DRAG_THRESHOLD = 6
export const cyclePointerDragged = (origin, x, y) =>
  Boolean(origin) && Math.hypot(x - origin.x, y - origin.y) > CYCLE_DRAG_THRESHOLD

// `add` cannot add a genome that is already open, so the same gesture becomes a
// jump: the pool is left alone and the browser scrolls to that genome instead.
export function cycleActionLabel(action, active) {
  if (action === 'focus') return 'Focus'
  if (action !== 'add') return ''
  return active ? 'Jump' : 'Add'
}

export function cycleActionProgress(action, active) {
  const label = cycleActionLabel(action, active)
  return label === 'Jump' ? 'Jumping to' : label === 'Focus' ? 'Focusing' : label === 'Add' ? 'Adding' : ''
}

// Every genome is scrolled until its control bar meets the app's top bar, which
// the last one can only do if there is empty space beneath it to scroll into.
// `anchorOffset` is that bar's distance from the top of the scroller's content,
// and `spacer` the whitespace already there — subtracted so the answer is what
// the gap should be rather than a measurement of itself.
export function cycleBottomSpacer({ viewport, scrollHeight, anchorOffset, spacer = 0 }) {
  if (!(viewport > 0) || !Number.isFinite(anchorOffset) || !Number.isFinite(scrollHeight)) return 0
  // Rounded up: a pixel too much is invisible, a pixel too little leaves the
  // genome resting just under the top bar it was meant to meet.
  return Math.max(0, Math.ceil(viewport - (scrollHeight - spacer - anchorOffset)))
}
