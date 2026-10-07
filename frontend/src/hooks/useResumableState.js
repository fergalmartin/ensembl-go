import { useEffect, useRef, useState } from 'react'
import {
  consumeRestoredSessionState,
  peekRestoredSessionState,
  registerSessionState,
} from '../sessionResume.js'

/**
 * `useState` that comes back after the page reloads underneath the reader.
 *
 * Starts from what `key` held before the reload when there is one (and `isValid`
 * accepts it), otherwise from `initialValue`. The current value is only read when
 * a snapshot is taken — never on change — so it costs a ref assignment per render
 * and nothing else. See sessionResume.js for when snapshots are taken.
 *
 * `key` should be stable for the component's lifetime: one view, one key.
 */
export function useResumableState(key, initialValue, { isValid = null } = {}) {
  const [value, setValue] = useState(() => {
    const saved = peekRestoredSessionState(key)
    if (saved !== undefined && (!isValid || isValid(saved))) return saved
    return typeof initialValue === 'function' ? initialValue() : initialValue
  })
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    // Taken on mount, not in the initialiser: StrictMode runs that twice and the
    // second run must still see the restored value.
    consumeRestoredSessionState(key)
    return registerSessionState(key, () => valueRef.current)
  }, [key])

  return [value, setValue]
}
