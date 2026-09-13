import { useEffect } from 'react'

/** Where to put a menu hanging off a control-bar button, and when to close it.
 *
 * Menus are drawn over the page and pinned to the control they belong to.
 *
 * Clamp the full menu to the viewport and keep a connector aimed at its button.
 * Moving the toolbar or resizing the window dismisses the menu; internal menu
 * scrolling leaves it open.
 */
export const MENU_WIDTH = 400

export function menuPosition(element, width = MENU_WIDTH) {
  const rect = element?.getBoundingClientRect()
  if (!rect) return { top: 0, left: 8 }
  const actualWidth = Math.min(width, window.innerWidth - 16)
  const left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - actualWidth - 8)))
  return { top: Math.round(rect.bottom + 9), left, width: actualWidth,
    '--al-menu-max-height': `${Math.max(120, window.innerHeight - rect.bottom - 17)}px`,
    '--al-menu-pointer': `${Math.max(14, Math.min(actualWidth - 14, rect.left + rect.width / 2 - left))}px` }
}

/** Close on Escape, or on a press anywhere but the menu and its own button.
 *
 * The press is watched in the capture phase so that one landing on the canvas
 * closes the menu instead of starting a gesture with it.
 */
export function useMenuDismiss(open, close, button, menuClass) {
  useEffect(() => {
    if (!open) return
    // One toolbar menu at a time, including keyboard-opened menus.
    window.dispatchEvent(new Event('alignment-menu-open'))
    const away = event => {
      const target = event.target
      if (!target?.closest?.(`.${menuClass}`) && !button.current?.contains(target)) close()
    }
    const key = event => { if (event.key === 'Escape') {
      close()
      const trigger = button.current?.matches('button') ? button.current : button.current?.querySelector('[aria-expanded]')
      trigger?.focus()
    } }
    const moved = event => { if (!event.target?.closest?.(`.${menuClass}`)) close() }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    window.addEventListener('alignment-menu-open', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', moved, true)
    return () => {
      window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key)
      window.removeEventListener('alignment-menu-open', close); window.removeEventListener('resize', close)
      window.removeEventListener('scroll', moved, true)
    }
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
