import { useCallback, useEffect, useRef, useState } from 'react'

export default function useHorizontalPillScroll(options = {}) {
  const scrollAmount = Number.isFinite(Number(options?.scrollAmount))
    ? Number(options.scrollAmount)
    : 200

  const scrollRef = useRef(null)
  const dragRef = useRef({ dragging: false, moved: false, startX: 0, scrollLeft: 0 })
  const suppressClickRef = useRef(false)
  // Whether the strip has anything to scroll to, so a caller can leave its arrows out
  // entirely until they would do something. `overflowing` is the one to hide arrows on;
  // the two directions are for disabling whichever end the strip is already at.
  const [overflow, setOverflow] = useState({ overflowing: false, canLeft: false, canRight: false })

  const syncOverflow = useCallback(() => {
    const node = scrollRef.current
    const next = { overflowing: false, canLeft: false, canRight: false }
    if (node) {
      const maxScroll = node.scrollWidth - node.clientWidth
      next.overflowing = maxScroll > 1
      next.canLeft = node.scrollLeft > 1
      next.canRight = next.overflowing && node.scrollLeft < maxScroll - 1
    }
    setOverflow((prev) => (
      prev.overflowing === next.overflowing
        && prev.canLeft === next.canLeft
        && prev.canRight === next.canRight
        ? prev
        : next
    ))
  }, [])

  const handleScroll = useCallback((direction) => {
    if (!scrollRef.current) return
    scrollRef.current.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    })
  }, [scrollAmount])

  const onMouseDown = useCallback((event) => {
    if (event.button !== 0) return
    const node = scrollRef.current
    if (!node) return
    dragRef.current = {
      dragging: true,
      moved: false,
      startX: event.pageX - node.offsetLeft,
      scrollLeft: node.scrollLeft,
    }
    suppressClickRef.current = false
    node.style.cursor = 'grabbing'
  }, [])

  const onMouseMove = useCallback((event) => {
    const drag = dragRef.current
    if (!drag.dragging) return
    const node = scrollRef.current
    if (!node) return
    const x = event.pageX - node.offsetLeft
    const delta = x - drag.startX
    if (Math.abs(delta) > 4) {
      drag.moved = true
      suppressClickRef.current = true
    }
    if (!drag.moved) return
    event.preventDefault()
    node.scrollLeft = drag.scrollLeft - delta
  }, [])

  const onMouseUp = useCallback(() => {
    const wasDragged = dragRef.current.moved
    dragRef.current.dragging = false
    dragRef.current.moved = false
    if (scrollRef.current) scrollRef.current.style.cursor = 'grab'
    if (wasDragged) {
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (scrollRef.current) {
        scrollRef.current.style.cursor = 'grab'
      }
    }
  }, [])

  // Three things move the ends of the strip and none of them is a render of this hook:
  // the viewport resizing, items being added or removed, and the strip being scrolled.
  // Watching all three here means no caller has to remember to tell us.
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return undefined

    // `observe` fires the callback once straight away with the current size, which is
    // the first measurement — so there is no need to call syncOverflow here, and not
    // calling it keeps the initial state out of the render pass.
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(syncOverflow)
      : null
    resizeObserver?.observe(node)
    const initialFrame = resizeObserver ? 0 : requestAnimationFrame(syncOverflow)

    const mutationObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(syncOverflow)
      : null
    mutationObserver?.observe(node, { childList: true, subtree: true })

    node.addEventListener('scroll', syncOverflow, { passive: true })
    window.addEventListener('resize', syncOverflow)
    return () => {
      if (initialFrame) cancelAnimationFrame(initialFrame)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      node.removeEventListener('scroll', syncOverflow)
      window.removeEventListener('resize', syncOverflow)
    }
  }, [syncOverflow])

  return {
    scrollRef,
    suppressClickRef,
    handleScroll,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    isOverflowing: overflow.overflowing,
    canScrollLeft: overflow.canLeft,
    canScrollRight: overflow.canRight,
    syncOverflow,
  }
}
