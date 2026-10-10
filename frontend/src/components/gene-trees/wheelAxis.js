// Lock wheel gestures to horizontal pan or vertical zoom after a few pixels.
// A pause ends the gesture. A sustained change of direction also releases the
// lock because trackpad momentum can overlap a new swipe; suppress those
// transition events until the new axis is established.

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
