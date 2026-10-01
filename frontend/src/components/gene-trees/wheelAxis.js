// Which way a wheel gesture goes: sideways (a pan) or up and down (the scheme's zoom), never
// both. It is settled over the gesture's first few pixels, and a swipe that wanders off its
// line keeps to it.
//
// A pause ends a gesture, but a pause is not enough on its own: a macOS trackpad goes on
// sending a swipe's coasting events for a second or more after the fingers lift, so the next
// swipe often starts with no gap at all. Held until a pause, a zoom's lock outlived it and the
// pan that followed had its sideways movement thrown away (stuck, or nudged by what vertical
// wobble was left). So a lock also gives way to a run of events that clearly go the other
// way; those events move nothing until it does, rather than leaking into the old axis.

export const WHEEL_AXIS_DECIDE_PX = 6
export const WHEEL_AXIS_IDLE_MS = 180
/** How far a run of clearly off-axis events must go before the lock turns to follow it. */
export const WHEEL_AXIS_SWITCH_PX = 10
/** How much more an event must move off the lock's axis than along it to count against it. */
const CONTRARY_RATIO = 2

export const newWheelAxis = () => ({ axis: '', lastTs: -Infinity, dx: 0, dy: 0, contrary: 0 })

/**
 * The wheel event `raw` (from `readWheelEvent`) kept to its gesture's axis: the other
 * component zeroed, or both when the event runs against the lock. Updates `lock` in place.
 */
export function lockWheelAxis(lock, raw) {
  const ax = Math.abs(raw.dx), ay = Math.abs(raw.dy)
  if (raw.ts - lock.lastTs > WHEEL_AXIS_IDLE_MS) Object.assign(lock, newWheelAxis())
  lock.lastTs = raw.ts
  if (!lock.axis) {
    lock.dx += ax
    lock.dy += ay
    if (lock.dx + lock.dy >= WHEEL_AXIS_DECIDE_PX) lock.axis = lock.dx > lock.dy ? 'x' : 'y'
  } else {
    const on = lock.axis === 'x' ? ax : ay, off = lock.axis === 'x' ? ay : ax
    if (off > on * CONTRARY_RATIO) {
      lock.contrary += off
      if (lock.contrary < WHEEL_AXIS_SWITCH_PX) return { ...raw, dx: 0, dy: 0 }
      lock.axis = lock.axis === 'x' ? 'y' : 'x'
      lock.contrary = 0
    } else if (on > 0) {
      lock.contrary = 0
    }
  }
  const axis = lock.axis || (ax > ay ? 'x' : 'y')
  return axis === 'x' ? { ...raw, dy: 0 } : { ...raw, dx: 0 }
}
