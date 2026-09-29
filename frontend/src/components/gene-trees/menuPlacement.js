import { menuPosition } from '../alignment-explorer/menuAnchor.js'

/**
 * Where a menu opens: below its control, as the Alignment Explorer's do, unless the
 * control is low on the screen (the selection bar at the foot of the canvas) and there
 * is more room above it — then above, pointing down at it.
 */
export function menuPlacement(element, width) {
  const below = menuPosition(element, width, 'gt')
  const rect = element?.getBoundingClientRect()
  if (!rect || window.innerHeight - rect.bottom >= 280 || rect.top <= window.innerHeight - rect.bottom) return below
  const rest = { ...below }
  delete rest.top
  return { ...rest, bottom: Math.round(window.innerHeight - rect.top + 9), above: true,
    '--gt-menu-max-height': `${Math.max(120, rect.top - 17)}px` }
}
