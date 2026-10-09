import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { STRUCTURAL_PLOT_COLOR_SCALE, STRUCTURAL_PLOT_METRICS, clamp, formatFloat, genomeLabel, makeTicks, structuralMetricValue, truncateText } from './statsModel.js'
import { useHorizontalDragScroll } from './useHorizontalDragScroll.js'
import { ZoomOutButton } from './ZoomOutButton'

export function StructuralClusterPlot({ records, isLight }) {
  const ready = (records || []).filter((r) => (r?.statuses || {}).structural === 'ready' && r?.structural)
  const [enabledMetricKeys, setEnabledMetricKeys] = useState(() => new Set(STRUCTURAL_PLOT_METRICS.map((m) => m.key)))
  const [zoomRange, setZoomRange] = useState(null)
  const [dragRect, setDragRect] = useState(null)
  const [hoveredPointKey, setHoveredPointKey] = useState('')
  const [hoverDetailPointKey, setHoverDetailPointKey] = useState('')
  const svgRef = useRef(null)
  const hoverTimerRef = useRef(null)
  const togglesDrag = useHorizontalDragScroll()
  const plotDrag = useHorizontalDragScroll('svg')

  useEffect(() => {
    const validKeys = new Set(STRUCTURAL_PLOT_METRICS.map((m) => m.key))
    setEnabledMetricKeys((prev) => {
      const next = new Set()
      for (const key of prev) {
        if (validKeys.has(key)) next.add(key)
      }
      return next
    })
  }, [])

  useEffect(() => () => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const toggleMetric = (key) => {
    setEnabledMetricKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const toggleAllMetrics = () => {
    setEnabledMetricKeys((prev) => {
      if (prev.size === STRUCTURAL_PLOT_METRICS.length) return new Set()
      return new Set(STRUCTURAL_PLOT_METRICS.map((metric) => metric.key))
    })
  }

  const colorByMetricKey = useMemo(() => {
    const out = new Map()
    STRUCTURAL_PLOT_METRICS.forEach((metric, idx) => {
      out.set(metric.key, STRUCTURAL_PLOT_COLOR_SCALE[idx % STRUCTURAL_PLOT_COLOR_SCALE.length])
    })
    return out
  }, [])

  const enabledMetrics = useMemo(
    () => STRUCTURAL_PLOT_METRICS.filter((metric) => enabledMetricKeys.has(metric.key)),
    [enabledMetricKeys]
  )

  const allPoints = useMemo(() => {
    if (!ready.length) return []

    const metricStats = new Map()
    for (const metric of STRUCTURAL_PLOT_METRICS) {
      const values = []
      for (const record of ready) {
        const raw = structuralMetricValue(record, metric.key)
        const n = Number(raw)
        if (Number.isFinite(n)) values.push(n)
      }
      if (!values.length) continue
      const mean = values.reduce((acc, v) => acc + v, 0) / values.length
      const variance = values.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / Math.max(1, values.length - 1)
      metricStats.set(metric.key, { mean, sd: Math.sqrt(Math.max(variance, 0)) })
    }

    const speciesStats = new Map()
    for (const record of ready) {
      const values = []
      for (const metric of STRUCTURAL_PLOT_METRICS) {
        const raw = structuralMetricValue(record, metric.key)
        const n = Number(raw)
        if (Number.isFinite(n)) values.push(n)
      }
      if (!values.length) continue
      const mean = values.reduce((acc, v) => acc + v, 0) / values.length
      const variance = values.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / Math.max(1, values.length - 1)
      speciesStats.set(record.genome_key, { mean, sd: Math.sqrt(Math.max(variance, 0)) })
    }

    const out = []
    for (let metricIdx = 0; metricIdx < STRUCTURAL_PLOT_METRICS.length; metricIdx += 1) {
      const metric = STRUCTURAL_PLOT_METRICS[metricIdx]
      const mStats = metricStats.get(metric.key)
      if (!mStats) continue

      for (let speciesIdx = 0; speciesIdx < ready.length; speciesIdx += 1) {
        const record = ready[speciesIdx]
        const raw = structuralMetricValue(record, metric.key)
        const value = Number(raw)
        const sStats = speciesStats.get(record.genome_key)
        if (!Number.isFinite(value) || !sStats) continue

        const x = (value - mStats.mean) / (mStats.sd > 0 ? mStats.sd : 1)
        const y = (value - sStats.mean) / (sStats.sd > 0 ? sStats.sd : 1)
        const jitterX = ((speciesIdx % 5) - 2) * 0.03
        const jitterY = ((metricIdx % 5) - 2) * 0.03
        out.push({
          key: `${record.genome_key}:${metric.key}`,
          metricKey: metric.key,
          metricLabel: metric.label,
          metricIndex: metricIdx,
          speciesIndex: speciesIdx,
          speciesName: record.common_name || record.scientific_name || record.species_key || 'Genome',
          speciesLabel: genomeLabel(record),
          assemblyLabel: record.assembly_name || record.assembly || record.species_key || 'Genome',
          value,
          x: x + jitterX,
          y: y + jitterY,
        })
      }
    }

    return out
  }, [ready])

  const points = useMemo(() => {
    if (!enabledMetrics.length) return []
    const enabled = new Set(enabledMetrics.map((metric) => metric.key))
    return allPoints.filter((point) => enabled.has(point.metricKey))
  }, [allPoints, enabledMetrics])

  const plotBounds = useMemo(() => {
    if (!allPoints.length) return null
    const xs = allPoints.map((point) => point.x)
    const ys = allPoints.map((point) => point.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const xPad = Math.max(0.35, (maxX - minX) * 0.12)
    const yPad = Math.max(0.35, (maxY - minY) * 0.12)
    const xLo = minX - xPad
    const xHi = maxX + xPad
    const yLo = minY - yPad
    const yHi = maxY + yPad
    return {
      xMin: xLo,
      xMax: xHi > xLo ? xHi : (xLo + 1),
      yMin: yLo,
      yMax: yHi > yLo ? yHi : (yLo + 1),
    }
  }, [allPoints])

  const tableMetricColWidth = 190
  const tableGenomeColWidth = 188
  const width = Math.max(780, tableMetricColWidth + (Math.max(1, (records || []).length) * tableGenomeColWidth))
  const height = Math.max(360, Math.min(560, Math.round(width * 0.42)))
  const metricGridColumns = Math.max(2, Math.min(5, Math.floor(width / 235)))
  const allMetricsEnabled = enabledMetricKeys.size === STRUCTURAL_PLOT_METRICS.length
  const margin = { top: 20, right: 24, bottom: 56, left: 60 }
  const innerW = width - margin.left - margin.right
  const innerH = height - margin.top - margin.bottom
  const fullXMin = plotBounds?.xMin ?? -1
  const fullXMax = plotBounds?.xMax ?? 1
  const fullYMin = plotBounds?.yMin ?? -1
  const fullYMax = plotBounds?.yMax ?? 1

  useEffect(() => {
    if (!zoomRange || !plotBounds) return
    const next = {
      xMin: clamp(zoomRange.xMin, fullXMin, fullXMax - 0.01),
      xMax: clamp(zoomRange.xMax, fullXMin + 0.01, fullXMax),
      yMin: clamp(zoomRange.yMin, fullYMin, fullYMax - 0.01),
      yMax: clamp(zoomRange.yMax, fullYMin + 0.01, fullYMax),
    }
    if (next.xMax <= next.xMin || next.yMax <= next.yMin) {
      setZoomRange(null)
      return
    }
    const same = (
      Math.abs(next.xMin - zoomRange.xMin) < 1e-9
      && Math.abs(next.xMax - zoomRange.xMax) < 1e-9
      && Math.abs(next.yMin - zoomRange.yMin) < 1e-9
      && Math.abs(next.yMax - zoomRange.yMax) < 1e-9
    )
    if (!same) setZoomRange(next)
  }, [zoomRange, plotBounds, fullXMin, fullXMax, fullYMin, fullYMax])

  const xMin = zoomRange ? zoomRange.xMin : fullXMin
  const xMax = zoomRange ? zoomRange.xMax : fullXMax
  const yMin = zoomRange ? zoomRange.yMin : fullYMin
  const yMax = zoomRange ? zoomRange.yMax : fullYMax
  const xPos = (x) => margin.left + (((x - xMin) / (xMax - xMin)) * innerW)
  const yPos = (y) => margin.top + innerH - (((y - yMin) / (yMax - yMin)) * innerH)
  const xToValue = (localX) => xMin + ((localX / innerW) * (xMax - xMin))
  const yToValue = (localY) => yMin + (((innerH - localY) / innerH) * (yMax - yMin))

  const beginDrag = (evt) => {
    if (evt.button !== 0) return
    const element = svgRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const x = clamp((evt.clientX - rect.left) - margin.left, 0, innerW)
    const y = clamp((evt.clientY - rect.top) - margin.top, 0, innerH)
    setDragRect({ startX: x, startY: y, currentX: x, currentY: y })
    evt.preventDefault()
  }

  useEffect(() => {
    if (!dragRect) return undefined
    const element = svgRef.current
    if (!element) return undefined

    const toSelection = (e) => {
      const rect = element.getBoundingClientRect()
      return {
        x: clamp((e.clientX - rect.left) - margin.left, 0, innerW),
        y: clamp((e.clientY - rect.top) - margin.top, 0, innerH),
      }
    }

    const onMove = (e) => {
      const pos = toSelection(e)
      setDragRect((prev) => (prev ? { ...prev, currentX: pos.x, currentY: pos.y } : prev))
    }

    const onUp = (e) => {
      const pos = toSelection(e)
      setDragRect((prev) => {
        if (!prev) return prev
        const left = Math.min(prev.startX, pos.x)
        const right = Math.max(prev.startX, pos.x)
        const top = Math.min(prev.startY, pos.y)
        const bottom = Math.max(prev.startY, pos.y)
        if ((right - left) < 8 || (bottom - top) < 8) return null
        setZoomRange({
          xMin: clamp(xToValue(left), fullXMin, fullXMax - 0.001),
          xMax: clamp(xToValue(right), fullXMin + 0.001, fullXMax),
          yMin: clamp(yToValue(bottom), fullYMin, fullYMax - 0.001),
          yMax: clamp(yToValue(top), fullYMin + 0.001, fullYMax),
        })
        return null
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragRect, innerW, innerH, margin.left, margin.top, xMin, xMax, yMin, yMax, fullXMin, fullXMax, fullYMin, fullYMax])

  const visiblePoints = useMemo(() => {
    return points.filter((point) => (
      point.x >= xMin && point.x <= xMax && point.y >= yMin && point.y <= yMax
    ))
  }, [points, xMin, xMax, yMin, yMax])

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])

  const handlePointEnter = useCallback((pointKey) => {
    clearHoverTimer()
    setHoveredPointKey(pointKey)
    setHoverDetailPointKey('')
    hoverTimerRef.current = window.setTimeout(() => {
      setHoverDetailPointKey(pointKey)
    }, 1000)
  }, [clearHoverTimer])

  const handlePointLeave = useCallback((pointKey) => {
    clearHoverTimer()
    setHoveredPointKey((prev) => (prev === pointKey ? '' : prev))
    setHoverDetailPointKey((prev) => (prev === pointKey ? '' : prev))
  }, [clearHoverTimer])

  const fullXRange = fullXMax - fullXMin
  const fullYRange = fullYMax - fullYMin
  const currentXRange = xMax - xMin
  const currentYRange = yMax - yMin
  const isZoomed = (
    (currentXRange < (fullXRange * 0.85))
    || (currentYRange < (fullYRange * 0.85))
  )

  const labelDrawData = useMemo(() => {
    if (!isZoomed || !visiblePoints.length) return []
    const candidates = visiblePoints.slice(0, 140).map((point) => {
      const cx = xPos(point.x)
      const cy = yPos(point.y)
      const labelX = Math.min(margin.left + innerW - 6, cx + 10)
      return {
        pointKey: point.key,
        text: truncateText(point.assemblyLabel, 24),
        cx,
        cy,
        labelX,
        preferredY: cy,
      }
    }).sort((a, b) => a.preferredY - b.preferredY)

    if (!candidates.length) return []
    const top = margin.top + 8
    const bottom = margin.top + innerH - 8
    const spacing = 12
    const ys = []
    for (let i = 0; i < candidates.length; i += 1) {
      const minY = top + (i * spacing)
      ys[i] = Math.max(candidates[i].preferredY, minY, (i > 0 ? ys[i - 1] + spacing : minY))
    }
    const overflow = ys[ys.length - 1] - bottom
    if (overflow > 0) {
      for (let i = 0; i < ys.length; i += 1) ys[i] -= overflow
      for (let i = 0; i < ys.length; i += 1) {
        const minY = top + (i * spacing)
        if (ys[i] < minY) ys[i] = minY
      }
    }
    return candidates.map((entry, idx) => ({
      ...entry,
      labelY: ys[idx],
    }))
  }, [isZoomed, visiblePoints, margin.left, margin.top, innerW, innerH, xMin, xMax, yMin, yMax])

  const hoverDetailPoint = useMemo(
    () => visiblePoints.find((point) => point.key === hoverDetailPointKey) || null,
    [visiblePoints, hoverDetailPointKey]
  )

  if (!ready.length) {
    return (
      <div className={`rounded-lg border p-3 text-sm ${isLight ? 'border-gray-200 bg-white text-gray-500' : 'border-gray-700 bg-gray-900/40 text-gray-400'}`}>
        Structural cluster plot appears once one or more genomes have structural stats.
      </div>
    )
  }

  return (
    <div className={`rounded-lg border p-3 space-y-3 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/40'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Structural feature cluster plot</div>
        <ZoomOutButton
          active={Boolean(zoomRange)}
          onClick={() => setZoomRange(null)}
          isLight={isLight}
          title="Zoom out to full range"
        />
      </div>
      <div className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        Toggle structural features and inspect clustering. Drag a rectangle to zoom both axes; double-click to reset.
      </div>

      <div
        ref={togglesDrag.scrollRef}
        className="hide-scrollbar overflow-x-auto cursor-grab select-none"
        onMouseDown={togglesDrag.onMouseDown}
        onMouseMove={togglesDrag.onMouseMove}
        onMouseUp={togglesDrag.onMouseUp}
        onMouseLeave={togglesDrag.onMouseLeave}
        onClickCapture={togglesDrag.onClickCapture}
      >
        <div
          className={`rounded-lg border p-2.5 ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-800/45'}`}
          style={{ width: `${width}px`, minWidth: `${width}px` }}
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className={`text-[11px] font-semibold ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>Feature toggles</div>
            <button
              type="button"
              onClick={toggleAllMetrics}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-colors ${allMetricsEnabled
                ? (isLight
                  ? 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'
                  : 'bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700')
                : (isLight
                  ? 'bg-[#0099ff] border-[#0088ee] text-white hover:bg-[#0088ee]'
                  : 'bg-blue-600 border-blue-500 text-white hover:bg-blue-500')
                }`}
            >
              {allMetricsEnabled ? 'Deactivate all' : 'Activate all'}
            </button>
          </div>

          <div
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${metricGridColumns}, minmax(0, 1fr))` }}
          >
            {STRUCTURAL_PLOT_METRICS.map((metric) => {
              const enabled = enabledMetricKeys.has(metric.key)
              const color = colorByMetricKey.get(metric.key) || '#3b82f6'
              return (
                <button
                  key={`metric-toggle-${metric.key}`}
                  type="button"
                  onClick={() => toggleMetric(metric.key)}
                  className={`w-full text-left rounded-md px-2 py-1.5 text-[11px] transition-colors border border-transparent ${isLight
                    ? 'hover:bg-white/90'
                    : 'hover:bg-gray-700/45'
                    }`}
                  title={`${enabled ? 'Disable' : 'Enable'} ${metric.label}`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: enabled ? color : (isLight ? '#cbd5e1' : '#475569') }}
                    />
                    <span className={enabled
                      ? (isLight ? 'text-gray-800' : 'text-gray-100')
                      : (isLight ? 'text-gray-400' : 'text-gray-500')}
                    >
                      {metric.label}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {points.length > 0 ? (
        <div
          ref={plotDrag.scrollRef}
          className="hide-scrollbar overflow-x-auto cursor-grab select-none"
          onMouseDown={plotDrag.onMouseDown}
          onMouseMove={plotDrag.onMouseMove}
          onMouseUp={plotDrag.onMouseUp}
          onMouseLeave={plotDrag.onMouseLeave}
          onClickCapture={plotDrag.onClickCapture}
        >
          <svg
            ref={svgRef}
            width={width}
            height={height}
            onMouseLeave={() => {
              setHoveredPointKey('')
              setHoverDetailPointKey('')
              clearHoverTimer()
            }}
          >
            {makeTicks(xMin, xMax, 6).map((tick) => {
              const x = xPos(tick)
              return (
                <g key={`sx-${tick}`}>
                  <line
                    x1={x}
                    y1={margin.top}
                    x2={x}
                    y2={margin.top + innerH}
                    stroke={isLight ? '#e2e8f0' : '#334155'}
                    strokeDasharray="3 3"
                  />
                  <text x={x} y={margin.top + innerH + 16} textAnchor="middle" fontSize="10" fill={isLight ? '#475569' : '#94a3b8'}>
                    {tick.toFixed(1)}
                  </text>
                </g>
              )
            })}
            {makeTicks(yMin, yMax, 6).map((tick) => {
              const y = yPos(tick)
              return (
                <g key={`sy-${tick}`}>
                  <line
                    x1={margin.left}
                    y1={y}
                    x2={margin.left + innerW}
                    y2={y}
                    stroke={isLight ? '#e2e8f0' : '#334155'}
                    strokeDasharray="3 3"
                  />
                  <text x={margin.left - 8} y={y + 3} textAnchor="end" fontSize="10" fill={isLight ? '#475569' : '#94a3b8'}>
                    {tick.toFixed(1)}
                  </text>
                </g>
              )
            })}

            <line
              x1={margin.left}
              y1={margin.top + innerH}
              x2={margin.left + innerW}
              y2={margin.top + innerH}
              stroke={isLight ? '#94a3b8' : '#64748b'}
            />
            <line
              x1={margin.left}
              y1={margin.top}
              x2={margin.left}
              y2={margin.top + innerH}
              stroke={isLight ? '#94a3b8' : '#64748b'}
            />

            <rect
              x={margin.left}
              y={margin.top}
              width={innerW}
              height={innerH}
              fill="transparent"
              style={{ cursor: 'crosshair' }}
              onMouseDown={beginDrag}
              onDoubleClick={() => setZoomRange(null)}
            />

            {points.map((point) => {
              const cx = xPos(point.x)
              const cy = yPos(point.y)
              const color = colorByMetricKey.get(point.metricKey) || '#3b82f6'
              const isHovered = hoveredPointKey === point.key
              return (
                <circle
                  key={point.key}
                  cx={cx}
                  cy={cy}
                  r={isHovered ? 5.8 : 4.2}
                  fill={color}
                  stroke={isHovered ? (isLight ? '#0f172a' : '#e2e8f0') : (isLight ? '#ffffff' : '#0f172a')}
                  strokeWidth={isHovered ? '2.1' : '1.2'}
                  opacity={isHovered ? 1 : 0.92}
                  onMouseEnter={() => handlePointEnter(point.key)}
                  onMouseLeave={() => handlePointLeave(point.key)}
                />
              )
            })}

            {labelDrawData.map((label) => {
              const isHovered = hoveredPointKey === label.pointKey
              const yOffset = Math.abs(label.labelY - label.cy)
              return (
                <g key={`label-${label.pointKey}`}>
                  {yOffset > 1.5 && (
                    <line
                      x1={label.cx + 5}
                      y1={label.cy}
                      x2={label.labelX - 2}
                      y2={label.labelY - 3}
                      stroke={isHovered ? (isLight ? '#1d4ed8' : '#38bdf8') : (isLight ? '#94a3b8' : '#64748b')}
                      strokeWidth={isHovered ? '1.2' : '0.9'}
                      strokeDasharray="2 2"
                      opacity={0.75}
                    />
                  )}
                  <text
                    x={label.labelX}
                    y={label.labelY}
                    fontSize="10"
                    fill={isHovered ? (isLight ? '#0f172a' : '#f1f5f9') : (isLight ? '#334155' : '#cbd5e1')}
                    fontWeight={isHovered ? '700' : '500'}
                  >
                    {label.text}
                  </text>
                </g>
              )
            })}

            {dragRect && (
              <rect
                x={margin.left + Math.min(dragRect.startX, dragRect.currentX)}
                y={margin.top + Math.min(dragRect.startY, dragRect.currentY)}
                width={Math.abs(dragRect.currentX - dragRect.startX)}
                height={Math.abs(dragRect.currentY - dragRect.startY)}
                fill={isLight ? 'rgba(37,99,235,0.16)' : 'rgba(56,189,248,0.16)'}
                stroke={isLight ? '#1d4ed8' : '#0ea5e9'}
                strokeDasharray="4 2"
              />
            )}

            {hoverDetailPoint && (() => {
              const cx = xPos(hoverDetailPoint.x)
              const cy = yPos(hoverDetailPoint.y)
              const detailMetric = STRUCTURAL_PLOT_METRICS.find((m) => m.key === hoverDetailPoint.metricKey)
              const featureValue = formatFloat(
                hoverDetailPoint.value,
                detailMetric?.format === 'percent' ? 4 : 2
              )
              const text = `${hoverDetailPoint.speciesName} - ${hoverDetailPoint.assemblyLabel} - ${hoverDetailPoint.metricLabel}: ${featureValue}`
              const w = Math.max(56, Math.min(420, Math.round((text.length * 5.7) + 12)))
              let tx = cx + 12
              let ty = cy - 10
              const xMaxTip = margin.left + innerW - w - 6
              if (tx > xMaxTip) tx = Math.max(margin.left + 6, xMaxTip)
              if (ty < margin.top + 14) ty = margin.top + 14
              return (
                <g>
                  <rect
                    x={tx}
                    y={ty - 12}
                    width={w}
                    height={18}
                    rx={4}
                    fill="#0f172a"
                    stroke={isLight ? '#1e293b' : '#334155'}
                    strokeWidth="0.8"
                    opacity="0.93"
                  />
                  <text
                    x={tx + 7}
                    y={ty}
                    fontSize="10"
                    fill="#f8fafc"
                  >
                    {text}
                  </text>
                </g>
              )
            })()}

            <text x={margin.left + innerW / 2} y={height - 8} textAnchor="middle" fontSize="11" fill={isLight ? '#475569' : '#94a3b8'}>
              Metric-centered z-score across species
            </text>
            <text
              x={14}
              y={margin.top + innerH / 2}
              textAnchor="middle"
              fontSize="11"
              fill={isLight ? '#475569' : '#94a3b8'}
              transform={`rotate(-90 14 ${margin.top + innerH / 2})`}
            >
              Species-centered z-score across all structural features
            </text>
          </svg>
        </div>
      ) : (
        <div className={`rounded border px-3 py-2 text-xs ${isLight ? 'border-gray-200 text-gray-500 bg-gray-50' : 'border-gray-700 text-gray-400 bg-gray-800/50'}`}>
          No plottable points with the current metric selection.
        </div>
      )}
    </div>
  )
}
