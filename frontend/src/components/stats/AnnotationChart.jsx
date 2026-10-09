import { useCallback, useEffect, useRef, useState } from 'react'
import { MAJOR_CLASS_COLORS, MAJOR_CLASS_LABELS, MAJOR_CLASS_ORDER, clamp, formatInt, majorClassCountsForAnnotation, makeTicks, toNumber } from './statsModel.js'

export function AnnotationChart({ records, basis, isLight, yZoom, onYZoom }) {
  const [dragBand, setDragBand] = useState(null)
  const svgRef = useRef(null)

  const toLocal = useCallback((evt, target = null) => {
    const element = target || svgRef.current || evt.currentTarget
    if (!element) return { x: 0, y: 0 }
    const rect = element.getBoundingClientRect()
    return {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top,
    }
  }, [])

  const recordCount = Math.max(1, records.length)
  const chartWidth = Math.max(620, records.length * 145)
  const chartHeight = 320
  const margin = { top: 14, right: 20, bottom: 96, left: 52 }
  const innerW = chartWidth - margin.left - margin.right
  const innerH = chartHeight - margin.top - margin.bottom
  const barW = Math.min(66, Math.max(42, (innerW / recordCount) * 0.62))
  const topBuffer = 18
  const dragTop = margin.top - topBuffer

  const values = records.map((record) => {
    const ready = (record?.statuses || {}).annotation === 'ready' && record?.annotation
    const ann = record.annotation || {}
    const classes = ready
      ? majorClassCountsForAnnotation(ann, basis)
      : {}
    const total = ready ? MAJOR_CLASS_ORDER.reduce((sum, key) => sum + toNumber(classes[key], 0), 0) : 0
    return { record, ready, classes, total }
  })

  const maxTotal = Math.max(1, ...values.filter((v) => v.ready).map((v) => v.total), 1)
  const domainMin = Math.max(0, toNumber(yZoom?.min, 0))
  const domainMax = Math.max(domainMin + 1, toNumber(yZoom?.max, maxTotal))

  const yForValue = (value) => {
    const v = clamp(value, domainMin, domainMax)
    const frac = (v - domainMin) / (domainMax - domainMin)
    return margin.top + innerH - (innerH * frac)
  }

  const beginDrag = (evt) => {
    if (evt.button !== 0) return
    const point = toLocal(evt)
    const y = clamp(point.y - dragTop, 0, innerH + topBuffer)
    setDragBand({ startY: y, currentY: y })
    evt.preventDefault()
  }

  useEffect(() => {
    if (!dragBand) return undefined
    const element = svgRef.current
    if (!element) return undefined

    const toSelectionY = (e) => {
      const rect = element.getBoundingClientRect()
      const svgY = e.clientY - rect.top
      return clamp(svgY - dragTop, 0, innerH + topBuffer)
    }

    const onMove = (e) => {
      const y = toSelectionY(e)
      setDragBand((prev) => (prev ? { ...prev, currentY: y } : prev))
    }

    const onUp = (e) => {
      const endY = toSelectionY(e)
      setDragBand((prev) => {
        if (!prev) return prev
        const top = Math.min(prev.startY, endY)
        const bottom = Math.max(prev.startY, endY)
        if ((bottom - top) < 8) return null

        const topPlotY = clamp(top - topBuffer, 0, innerH)
        const bottomPlotY = clamp(bottom - topBuffer, 0, innerH)
        const yToValue = (localY) => domainMin + (((innerH - localY) / innerH) * (domainMax - domainMin))
        const selectedMax = yToValue(topPlotY)
        const selectedMin = yToValue(bottomPlotY)
        if (selectedMax > selectedMin) {
          onYZoom({ min: Math.max(0, selectedMin), max: Math.max(selectedMin + 1, selectedMax) })
        }
        return null
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragBand, domainMin, domainMax, innerH, topBuffer, dragTop, onYZoom])

  if (!records.length) {
    return <div className={`text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>No genomes selected.</div>
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <svg ref={svgRef} width={chartWidth} height={chartHeight}>
          <line
            x1={margin.left}
            y1={margin.top + innerH}
            x2={margin.left + innerW}
            y2={margin.top + innerH}
            stroke={isLight ? '#94a3b8' : '#475569'}
          />
          <line
            x1={margin.left}
            y1={margin.top}
            x2={margin.left}
            y2={margin.top + innerH}
            stroke={isLight ? '#94a3b8' : '#475569'}
          />

          {makeTicks(domainMin, domainMax, 5).map((tick) => {
            const y = yForValue(tick)
            return (
              <g key={`tick-${tick}`}>
                <line
                  x1={margin.left}
                  y1={y}
                  x2={margin.left + innerW}
                  y2={y}
                  stroke={isLight ? '#e2e8f0' : '#334155'}
                  strokeDasharray="3 3"
                />
                <text
                  x={margin.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="10"
                  fill={isLight ? '#475569' : '#94a3b8'}
                >
                  {formatInt(tick)}
                </text>
              </g>
            )
          })}

          {values.map((item, idx) => {
            const xCenter = margin.left + ((idx + 0.5) * (innerW / values.length))
            const x = xCenter - (barW / 2)

            if (!item.ready) {
              const status = (item.record?.statuses || {}).annotation || 'loading'
              return (
                <g key={item.record.genome_key}>
                  <rect
                    x={x}
                    y={margin.top}
                    width={barW}
                    height={innerH}
                    fill={isLight ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.08)'}
                    stroke={isLight ? '#94a3b8' : '#64748b'}
                    strokeDasharray="4 3"
                  />
                  <text
                    x={xCenter}
                    y={margin.top + (innerH / 2)}
                    textAnchor="middle"
                    fontSize="9"
                    fill={isLight ? '#64748b' : '#94a3b8'}
                  >
                    {status === 'loading' ? 'loading…' : (status === 'computing' ? 'calculating' : status)}
                  </text>
                  <text
                    x={xCenter}
                    y={margin.top + innerH + 32}
                    textAnchor="middle"
                    fontSize="10"
                    fill={isLight ? '#64748b' : '#94a3b8'}
                  >
                    {item.record.assembly_name || item.record.assembly}
                  </text>
                  <text
                    x={xCenter}
                    y={margin.top + innerH + 47}
                    textAnchor="middle"
                    fontSize="9"
                    fill={isLight ? '#64748b' : '#94a3b8'}
                  >
                    {(item.record.common_name || item.record.scientific_name || item.record.species_key || '').slice(0, 24)}
                  </text>
                </g>
              )
            }

            let cumulative = 0
            return (
              <g key={item.record.genome_key}>
                {MAJOR_CLASS_ORDER.map((key) => {
                  const val = toNumber(item.classes[key], 0)
                  const start = cumulative
                  const end = cumulative + val
                  cumulative = end
                  const visibleStart = Math.max(start, domainMin)
                  const visibleEnd = Math.min(end, domainMax)
                  if (visibleEnd <= visibleStart) return null
                  const yTop = yForValue(visibleEnd)
                  const yBottom = yForValue(visibleStart)
                  return (
                    <rect
                      key={`${item.record.genome_key}-${key}`}
                      x={x}
                      y={yTop}
                      width={barW}
                      height={Math.max(1, yBottom - yTop)}
                      fill={MAJOR_CLASS_COLORS[key]}
                      opacity={0.92}
                    />
                  )
                })}
                <text
                  x={xCenter}
                  y={margin.top + innerH + 14}
                  textAnchor="middle"
                  fontSize="10"
                  fill={isLight ? '#334155' : '#cbd5e1'}
                >
                  {formatInt(item.total)}
                </text>
                <text
                  x={xCenter}
                  y={margin.top + innerH + 32}
                  textAnchor="middle"
                  fontSize="10"
                  fill={isLight ? '#64748b' : '#94a3b8'}
                >
                  {item.record.assembly_name || item.record.assembly}
                </text>
                <text
                  x={xCenter}
                  y={margin.top + innerH + 47}
                  textAnchor="middle"
                  fontSize="9"
                  fill={isLight ? '#64748b' : '#94a3b8'}
                >
                  {(item.record.common_name || item.record.scientific_name || item.record.species_key || '').slice(0, 24)}
                </text>
              </g>
            )
          })}

          <rect
            x={margin.left}
            y={dragTop}
            width={innerW}
            height={innerH + topBuffer}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            onMouseDown={beginDrag}
            onDoubleClick={() => onYZoom(null)}
          />

          {dragBand && (
            <rect
              x={margin.left}
              y={dragTop + Math.min(dragBand.startY, dragBand.currentY)}
              width={innerW}
              height={Math.abs(dragBand.currentY - dragBand.startY)}
              fill={isLight ? 'rgba(37,99,235,0.16)' : 'rgba(56,189,248,0.16)'}
              stroke={isLight ? '#1d4ed8' : '#0ea5e9'}
              strokeDasharray="4 2"
            />
          )}
        </svg>
      </div>

      <div className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        Drag a vertical selection to zoom Y. Double-click to reset.
      </div>

      <div className="flex flex-wrap gap-3">
        {MAJOR_CLASS_ORDER.map((key) => (
          <div key={key} className="flex items-center gap-1.5 text-xs">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: MAJOR_CLASS_COLORS[key] }} />
            <span className={isLight ? 'text-gray-600' : 'text-gray-300'}>{MAJOR_CLASS_LABELS[key] || key.replace('_', ' ')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
