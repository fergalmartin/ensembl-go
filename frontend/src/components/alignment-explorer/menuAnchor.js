import { useEffect } from 'react'

/** Where to put a menu hanging off a control-bar button, and when to close it.
 *
 * The bar scrolls sideways, so a menu cannot live inside it without being
 * clipped: it is drawn over the page and pinned to the button it belongs to.
 *
 * The position is taken when the menu opens rather than watched, because the
 * bar does not move while a menu is open - it is what the pointer is busy with
 * - and measuring in an effect would mean a second render for every open.
 *
 * `side` picks which edge is pinned. A button near the right of the bar hangs
 * its menu leftward from its own right edge, which is what keeps it on screen;
 * one in the middle hangs rightward from its left edge for the same reason, and
 * is pulled back from the window edge if the menu would not otherwise fit.
 */
export const MENU_WIDTH = 400

export function menuPosition(element, side = 'left') {
  const rect = element?.getBoundingClientRect()
  if (!rect) return { top: 0, left: 8 }
  const top = Math.round(rect.bottom + 6)
  return side === 'right'
    ? { top, right: Math.round(Math.max(8, window.innerWidth - rect.right)) }
    : { top, left: Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8))) }
}

/** Close on Escape, or on a press anywhere but the menu and its own button.
 *
 * The press is watched in the capture phase so that one landing on the canvas
 * closes the menu instead of starting a gesture with it.
 */
export function useMenuDismiss(open, close, button, menuClass) {
  useEffect(() => {
    if (!open) return
    const away = event => {
      const target = event.target
      if (!target?.closest?.(`.${menuClass}`) && !button.current?.contains(target)) close()
    }
    const key = event => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key) }
  }, [open, close, button, menuClass])
}

/** Where a flash of feedback goes: directly above the button that caused it,
 * so the word and the press are in the same place. Fixed, like the menus, for
 * the same reason - the bar scrolls and would clip it. */
export function toastPosition(element) {
  const rect = element?.getBoundingClientRect()
  if (!rect) return { top: 0, left: 8 }
  return { top: Math.round(Math.max(4, rect.top - 26)), left: Math.round(rect.left) }
}
