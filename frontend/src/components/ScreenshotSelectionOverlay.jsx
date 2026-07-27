import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const EMPTY_REFS = Object.freeze([])
const EMPTY_TARGETS = Object.freeze([])

function clipRectToContainer(rect, containerRect) {
  if (!rect || !containerRect) return null
  const left = Math.max(0, rect.left - containerRect.left)
  const top = Math.max(0, rect.top - containerRect.top)
  const right = Math.min(containerRect.width, rect.right - containerRect.left)
  const bottom = Math.min(containerRect.height, rect.bottom - containerRect.top)
  const width = right - left
  const height = bottom - top
  if (!(width > 0 && height > 0)) return null
  return { left, top, width, height }
}

function resolveTargetFromPoint(targets, clientX, clientY) {
  let bestTarget = null
  let bestArea = Number.POSITIVE_INFINITY
  for (const target of Array.isArray(targets) ? targets : []) {
    if (typeof target?.getVisibleRect !== 'function') continue
    const rect = target.getVisibleRect()
    if (!rect) continue
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
    const area = Math.max(1, rect.width * rect.height)
    if (area < bestArea) {
      bestArea = area
      bestTarget = target
    }
  }
  return bestTarget
}

function canScrollNode(node, deltaX, deltaY) {
  if (!node) return false
  const maxScrollTop = Math.max(0, (node.scrollHeight || 0) - (node.clientHeight || 0))
  const maxScrollLeft = Math.max(0, (node.scrollWidth || 0) - (node.clientWidth || 0))
  if (Math.abs(deltaY) >= Math.abs(deltaX) && Math.abs(deltaY) > 0.5) {
    if (deltaY > 0) return node.scrollTop < maxScrollTop - 1
    if (deltaY < 0) return node.scrollTop > 1
  }
  if (Math.abs(deltaX) > 0.5) {
    if (deltaX > 0) return node.scrollLeft < maxScrollLeft - 1
    if (deltaX < 0) return node.scrollLeft > 1
  }
  return false
}

function areSizesEqual(a, b) {
  return a?.width === b?.width && a?.height === b?.height
}

function areRectsEqual(a, b) {
  return (
    a?.left === b?.left
    && a?.top === b?.top
    && a?.width === b?.width
    && a?.height === b?.height
  )
}

function areRectListsEqual(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (!areRectsEqual(a[i], b[i])) return false
  }
  return true
}

export default function ScreenshotSelectionOverlay({
  active = false,
  theme = 'dark',
  containerRef,
  scrollContainerRef = null,
  exemptRefs = EMPTY_REFS,
  targets = EMPTY_TARGETS,
  onSelect,
  onCancel,
  instructions = 'Click on the highlighted area to export',
  useViewport = false,
  highlightSingleTarget = false,
  selectSingleTargetOnClick = false,
}) {
  const isLight = theme === 'light'
  const [hoveredTargetId, setHoveredTargetId] = useState('')
  const [highlightRect, setHighlightRect] = useState(null)
  const [cutoutRects, setCutoutRects] = useState([])
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const pointerPositionRef = useRef({ clientX: 0, clientY: 0, hasPointer: false })
  const selectedOnMouseDownRef = useRef(false)

  const hoveredTarget = useMemo(
    () => targets.find((target) => target?.id === hoveredTargetId) || null,
    [hoveredTargetId, targets]
  )

  const clearHighlight = useCallback(() => {
    setHoveredTargetId((current) => (current ? '' : current))
    setHighlightRect((current) => (current ? null : current))
  }, [])

  const resetOverlayGeometry = useCallback(() => {
    setCutoutRects((current) => (current.length ? [] : current))
    setContainerSize((current) => {
      const emptySize = { width: 0, height: 0 }
      return areSizesEqual(current, emptySize) ? current : emptySize
    })
  }, [])

  const refreshOverlayGeometry = useCallback((clientX = null, clientY = null) => {
    const container = containerRef?.current
    if (!useViewport && !container) {
      resetOverlayGeometry()
      clearHighlight()
      return null
    }

    const containerRect = useViewport
      ? {
          left: 0,
          top: 0,
          right: window.innerWidth || document.documentElement?.clientWidth || 0,
          bottom: window.innerHeight || document.documentElement?.clientHeight || 0,
          width: window.innerWidth || document.documentElement?.clientWidth || 0,
          height: window.innerHeight || document.documentElement?.clientHeight || 0,
        }
      : container.getBoundingClientRect()
    const nextContainerSize = {
      width: Math.max(0, Math.round(containerRect.width || 0)),
      height: Math.max(0, Math.round(containerRect.height || 0)),
    }
    setContainerSize((current) => (
      areSizesEqual(current, nextContainerSize) ? current : nextContainerSize
    ))

    const nextCutouts = []
    for (const target of Array.isArray(targets) ? targets : []) {
      if (typeof target?.getVisibleRect !== 'function') continue
      const rect = target.getVisibleRect()
      const clippedRect = clipRectToContainer(rect, containerRect)
      if (clippedRect) nextCutouts.push(clippedRect)
    }
    for (const maybeRef of Array.isArray(exemptRefs) ? exemptRefs : []) {
      const node = maybeRef?.current || null
      if (!node || typeof node.getBoundingClientRect !== 'function') continue
      const rect = node.getBoundingClientRect()
      const clippedRect = clipRectToContainer(rect, containerRect)
      if (clippedRect) nextCutouts.push(clippedRect)
    }
    setCutoutRects((current) => (
      areRectListsEqual(current, nextCutouts) ? current : nextCutouts
    ))

    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      if (highlightSingleTarget && Array.isArray(targets) && targets.length === 1) {
        const singleTarget = targets[0]
        const targetRect = singleTarget?.getVisibleRect?.() || null
        const clippedRect = clipRectToContainer(targetRect, containerRect)
        if (clippedRect) {
          setHoveredTargetId(singleTarget.id)
          setHighlightRect(clippedRect)
        } else {
          clearHighlight()
        }
      }
      return null
    }

    pointerPositionRef.current = { clientX, clientY, hasPointer: true }
    const nextTarget = resolveTargetFromPoint(targets, clientX, clientY)
    if (!nextTarget) {
      clearHighlight()
      return null
    }
    const targetRect = nextTarget.getVisibleRect?.() || null
    const clippedRect = clipRectToContainer(targetRect, containerRect)
    if (!clippedRect) {
      clearHighlight()
      return null
    }
    setHoveredTargetId(nextTarget.id)
    setHighlightRect(clippedRect)
    return nextTarget
  }, [clearHighlight, containerRef, exemptRefs, highlightSingleTarget, resetOverlayGeometry, targets, useViewport])

  useEffect(() => {
    let frameId = 0
    if (!active) {
      pointerPositionRef.current = { clientX: 0, clientY: 0, hasPointer: false }
      frameId = requestAnimationFrame(() => {
        clearHighlight()
        resetOverlayGeometry()
      })
      return () => cancelAnimationFrame(frameId)
    }
    frameId = requestAnimationFrame(() => {
      refreshOverlayGeometry()
    })
    return () => cancelAnimationFrame(frameId)
  }, [active, clearHighlight, refreshOverlayGeometry, resetOverlayGeometry])

  useEffect(() => {
    if (!active) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur()
        }
        onCancel?.()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, onCancel])

  const updateHoveredTarget = useCallback((clientX, clientY) => {
    return refreshOverlayGeometry(clientX, clientY)
  }, [refreshOverlayGeometry])

  useEffect(() => {
    if (!active) return undefined
    const handleReposition = () => {
      const pointer = pointerPositionRef.current
      if (pointer?.hasPointer) {
        updateHoveredTarget(pointer.clientX, pointer.clientY)
      } else {
        refreshOverlayGeometry()
      }
    }
    const scrollNode = scrollContainerRef?.current || containerRef?.current
    scrollNode?.addEventListener?.('scroll', handleReposition, { passive: true })
    window.addEventListener('resize', handleReposition)
    return () => {
      scrollNode?.removeEventListener?.('scroll', handleReposition)
      window.removeEventListener('resize', handleReposition)
    }
  }, [active, containerRef, scrollContainerRef, updateHoveredTarget, refreshOverlayGeometry])

  if (!active) return null

  return (
    <div
      data-screenshot-selection-overlay="true"
      className={`${useViewport ? 'fixed' : 'absolute'} inset-0 z-30 overflow-hidden`}
      style={{ cursor: 'crosshair' }}
      onMouseMove={(event) => {
        updateHoveredTarget(event.clientX, event.clientY)
      }}
      onMouseLeave={() => clearHighlight()}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.button !== 0) return
        const singleTarget = selectSingleTargetOnClick && Array.isArray(targets) && targets.length === 1
          ? targets[0]
          : null
        if (singleTarget) {
          selectedOnMouseDownRef.current = true
          onSelect?.(singleTarget)
        }
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (selectedOnMouseDownRef.current) {
          selectedOnMouseDownRef.current = false
          return
        }
        const singleTarget = selectSingleTargetOnClick && Array.isArray(targets) && targets.length === 1
          ? targets[0]
          : null
        const target = singleTarget || updateHoveredTarget(event.clientX, event.clientY)
        if (target) {
          onSelect?.(target)
        } else {
          onCancel?.()
        }
      }}
      onWheel={(event) => {
        const hoveredTargetScrollNode = hoveredTarget?.getScrollElement?.()
        const outerScrollNode = scrollContainerRef?.current || containerRef?.current
        const scrollCandidates = [hoveredTargetScrollNode, outerScrollNode]
          .filter(Boolean)
          .filter((node, index, list) => list.indexOf(node) === index)
        const scrollNode = scrollCandidates.find((node) => (
          typeof node?.scrollBy === 'function' && canScrollNode(node, event.deltaX, event.deltaY)
        )) || scrollCandidates.find((node) => typeof node?.scrollBy === 'function')
        if (!scrollNode) return
        event.preventDefault()
        event.stopPropagation()
        scrollNode.scrollBy({
          left: event.deltaX,
          top: event.deltaY,
          behavior: 'auto',
        })
        const pointer = pointerPositionRef.current
        if (pointer?.hasPointer) {
          requestAnimationFrame(() => {
            updateHoveredTarget(pointer.clientX, pointer.clientY)
          })
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <svg
        className="absolute inset-0 pointer-events-none"
        width={Math.max(1, containerSize.width)}
        height={Math.max(1, containerSize.height)}
        viewBox={`0 0 ${Math.max(1, containerSize.width)} ${Math.max(1, containerSize.height)}`}
        preserveAspectRatio="none"
      >
        <path
          fill={isLight ? 'rgba(15, 23, 42, 0.28)' : 'rgba(2, 6, 23, 0.58)'}
          fillRule="evenodd"
          d={[
            `M0 0H${Math.max(1, containerSize.width)}V${Math.max(1, containerSize.height)}H0Z`,
            ...cutoutRects.map((rect) => `M${rect.left} ${rect.top}H${rect.left + rect.width}V${rect.top + rect.height}H${rect.left}Z`),
          ].join(' ')}
        />
      </svg>

      {highlightRect && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: highlightRect.left,
            top: highlightRect.top,
            width: highlightRect.width,
            height: highlightRect.height,
            border: '4px solid rgba(255,255,255,0.98)',
            boxShadow: '0 0 0 2px rgba(15, 23, 42, 0.7), 0 18px 36px rgba(15, 23, 42, 0.25)',
            borderRadius: '10px',
          }}
        />
      )}

      {highlightRect && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: Math.max(8, highlightRect.left + highlightRect.width - 8),
            top: Math.max(8, highlightRect.top + 8),
            transform: 'translateX(-100%)',
          }}
        >
          <div
            className="rounded-lg px-3 py-1.5 text-xs font-semibold shadow-md"
            style={{
              backgroundColor: isLight ? 'rgba(255, 255, 255, 0.62)' : 'rgba(15, 23, 42, 0.56)',
              color: isLight ? '#0f172a' : '#f8fafc',
              border: `1px solid ${isLight ? 'rgba(148, 163, 184, 0.45)' : 'rgba(148, 163, 184, 0.24)'}`,
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              minWidth: 250,
              maxWidth: 'min(340px, calc(100% - 16px))',
              textAlign: 'center',
              lineHeight: 1.35,
            }}
          >
            {instructions}
          </div>
        </div>
      )}
    </div>
  )
}
