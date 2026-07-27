const IDENTITY_TRANSFORM = Object.freeze({
  scaleX: 1,
  translateX: 0,
  canTransform: true,
  isIdentity: true,
})

/**
 * Map x coordinates projected in renderWindow into displayWindow without
 * rebuilding genomic track geometry during a pan or zoom preview.
 */
export function getSvAuxTrackTransform(renderWindow, displayWindow, width, sourceWidth = width) {
  if (!renderWindow || !displayWindow) return IDENTITY_TRANSFORM

  const renderChrom = String(renderWindow.chrom || '')
  const displayChrom = String(displayWindow.chrom || '')
  const renderStart = Number(renderWindow.start)
  const renderEnd = Number(renderWindow.end)
  const displayStart = Number(displayWindow.start)
  const displayEnd = Number(displayWindow.end)
  const safeWidth = Number(width)
  const renderWidth = Number(sourceWidth)

  if (
    !renderChrom
    || !displayChrom
    || renderChrom !== displayChrom
    || !Number.isFinite(renderStart)
    || !Number.isFinite(renderEnd)
    || !Number.isFinite(displayStart)
    || !Number.isFinite(displayEnd)
    || !Number.isFinite(safeWidth)
    || safeWidth <= 0
    || !Number.isFinite(renderWidth)
    || renderWidth <= 0
  ) {
    return {
      scaleX: 1,
      translateX: 0,
      canTransform: false,
      isIdentity: true,
    }
  }

  const renderSpan = renderEnd - renderStart
  const displaySpan = displayEnd - displayStart
  if (renderSpan <= 0 || displaySpan <= 0) {
    return {
      scaleX: 1,
      translateX: 0,
      canTransform: false,
      isIdentity: true,
    }
  }

  const scaleX = (renderSpan / displaySpan) * (safeWidth / renderWidth)
  const translateX = ((renderStart - displayStart) / displaySpan) * safeWidth
  const isIdentity = Math.abs(scaleX - 1) < 1e-9 && Math.abs(translateX) < 1e-6
  return { scaleX, translateX, canTransform: true, isIdentity }
}

export function buildSvAuxTrackRenderWindow(
  window,
  { haloWindows = 2, maxHaloBp = 1_000_000, minStart = 0 } = {},
) {
  if (!window?.chrom) return window || null
  const start = Number(window.start)
  const end = Number(window.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return window
  const span = end - start
  const halo = Math.max(0, Math.min(span * Math.max(0, Number(haloWindows) || 0), Math.max(0, Number(maxHaloBp) || 0)))
  return {
    chrom: window.chrom,
    start: Math.max(Number(minStart) || 0, start - halo),
    end: end + halo,
  }
}

export function getSvAuxTrackGeometryWidth(viewWindow, renderWindow, width) {
  const viewSpan = Number(viewWindow?.end) - Number(viewWindow?.start)
  const renderSpan = Number(renderWindow?.end) - Number(renderWindow?.start)
  const safeWidth = Math.max(1, Number(width) || 1)
  if (!Number.isFinite(viewSpan) || viewSpan <= 0 || !Number.isFinite(renderSpan) || renderSpan <= 0) {
    return safeWidth
  }
  return safeWidth * (renderSpan / viewSpan)
}

export function getSvAuxTrackMatrix(transform, translateY = 0) {
  const scaleX = Number(transform?.scaleX)
  const translateX = Number(transform?.translateX)
  const safeY = Number(translateY)
  return `matrix(${Number.isFinite(scaleX) ? scaleX : 1} 0 0 1 ${Number.isFinite(translateX) ? translateX : 0} ${Number.isFinite(safeY) ? safeY : 0})`
}
