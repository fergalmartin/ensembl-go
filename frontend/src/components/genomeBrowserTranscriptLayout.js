/** Whether leaving a temporary transcript layout should discard its sticky row height.
 *
 * Sticky rows keep tracks from jumping while someone pans normally. They must not retain
 * the height of an expanded or flattened view after that mode is switched off, though:
 * doing so leaves thousands of pixels of blank track behind. */
export function shouldResetStickyGeneRows(previous, next) {
  if (!previous || !next) return false
  return Boolean(
    (previous.expanded && !next.expanded)
    || (previous.flatten && !next.flatten)
  )
}
