import { useCallback, useMemo, useRef, useState } from 'react'

function sameStringArray(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function areTargetsEquivalent(prev, next) {
  if (prev === next) return true
  if (!prev || !next) return false
  return (
    String(prev.id || '') === String(next.id || '')
    && String(prev.label || '') === String(next.label || '')
    && String(prev.defaultFormat || '') === String(next.defaultFormat || '')
    && sameStringArray(prev.allowedFormats, next.allowedFormats)
    && prev.getVisibleRect === next.getVisibleRect
    && prev.buildDefaultFilename === next.buildDefaultFilename
    && prev.buildExportSnapshot === next.buildExportSnapshot
  )
}

export default function useScreenshotTargets() {
  const targetMapRef = useRef(new Map())
  const [version, setVersion] = useState(0)

  const upsertTarget = useCallback((target) => {
    const targetId = String(target?.id || '').trim()
    if (!targetId) return
    const previous = targetMapRef.current.get(targetId)
    if (areTargetsEquivalent(previous, target)) return
    targetMapRef.current.set(targetId, target)
    setVersion((value) => value + 1)
  }, [])

  const removeTarget = useCallback((targetId) => {
    const key = String(targetId || '').trim()
    if (!key) return
    if (!targetMapRef.current.has(key)) return
    targetMapRef.current.delete(key)
    setVersion((value) => value + 1)
  }, [])

  const registerTarget = useCallback((target) => {
    upsertTarget(target)
    return () => removeTarget(target?.id)
  }, [removeTarget, upsertTarget])

  const clearTargets = useCallback(() => {
    if (targetMapRef.current.size === 0) return
    targetMapRef.current.clear()
    setVersion((value) => value + 1)
  }, [])

  const targets = useMemo(() => Array.from(targetMapRef.current.values()), [version])

  return {
    targets,
    upsertTarget,
    removeTarget,
    registerTarget,
    clearTargets,
  }
}
