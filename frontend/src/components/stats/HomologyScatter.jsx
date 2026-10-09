import { useCallback, useEffect, useRef, useState } from 'react'
import { clamp, formatFloat, formatInt, genomeLabel, makeTicks, toNumber } from './statsModel.js'

export function HomologyScatter({ records, isLight, zoomRange, onZoomRange }) {
  const [dragRect, setDragRect] = useState(null)
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

  const ready = records.filter((r) => (r?.statuses || {}).homology === 'ready' && r?.homology)
  const points = ready
    .map((r) => {
      const hom = r.homology || {}
      const x = Number((hom.coverage || {}).mean)
      const y = Number((hom.identity || {}).mean)
      const rowCount = Number(hom.row_count || 0)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      return {
        genome_key: r.genome_key,
        label: genomeLabel(r),
        x: Math.max(0, Math.min(100, x)),
        y: Math.max(0, Math.min(100, y)),
        rowCount,
        summary: hom,
      }
    })
    .filter(Boolean)

  const xMin = Math.max(0, toNumber(zoomRange?.xMin, 0))
  const xMax = Math.min(100, Math.max(xMin + 1, toNumber(zoomRange?.xMax, 100)))
  const yMin = Math.max(0, toNumber(zoomRange?.yMin, 0))
  const yMax = Math.min(100, Math.max(yMin + 1, toNumber(zoomRange?.yMax, 100)))

  const width = 560
  const height = 330
  const margin = { top: 14, right: 18, bottom: 44, left: 52 }
  const innerW = width - margin.left - margin.right
  const innerH = height - margin.top - margin.bottom
  const maxRows = Math.max(1, ...points.map((p) => p.rowCount))

  const xPos = (x) => {
    const frac = (clamp(x, xMin, xMax) - xMin) / (xMax - xMin)
    return margin.left + (frac * innerW)
  }
  const yPos = (y) => {
    const frac = (clamp(y, yMin, yMax) - yMin) / (yMax - yMin)
    return margin.top + innerH - (frac * innerH)
  }

  const beginDrag = (evt) => {
    if (evt.button !== 0) return
    const point = toLocal(evt, evt.currentTarget)
    const x = clamp(point.x, 0, innerW)
    const y = clamp(point.y, 0, innerH)
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

        const xToValue = (plotX) => xMin + ((plotX / innerW) * (xMax - xMin))
        const yToValue = (plotY) => yMin + (((innerH - plotY) / innerH) * (yMax - yMin))
        const selectedXMin = xToValue(left)
        const selectedXMax = xToValue(right)
        const selectedYMin = yToValue(bottom)
        const selectedYMax = yToValue(top)
        if (selectedXMax > selectedXMin && selectedYMax > selectedYMin) {
          onZoomRange({
            xMin: Math.max(0, selectedXMin),
            xMax: Math.min(100, selectedXMax),
            yMin: Math.max(0, selectedYMin),
            yMax: Math.min(100, selectedYMax),
          })
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
  }, [dragRect, innerW, innerH, xMin, xMax, yMin, yMax, onZoomRange, margin.left, margin.top])

  if (!points.length) {
    return <div className={`text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>No homology stats available for selected genomes.</div>
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[580px,1fr] gap-3">
      <div className="overflow-x-auto">
        <svg ref={svgRef} width={width} height={height}>
          <line x1={margin.left} y1={margin.top + innerH} x2={margin.left + innerW} y2={margin.top + innerH} stroke={isLight ? '#94a3b8' : '#475569'} />
          <line x1={margin.left} y1={margin.top} x2={margin.left} y2={margin.top + innerH} stroke={isLight ? '#94a3b8' : '#475569'} />

          {makeTicks(xMin, xMax, 5).map((tick) => (
            <g key={`grid-${tick}`}>
              <line x1={xPos(tick)} y1={margin.top} x2={xPos(tick)} y2={margin.top + innerH} stroke={isLight ? '#e2e8f0' : '#334155'} strokeDasharray="3 3" />
              <text x={xPos(tick)} y={margin.top + innerH + 14} textAnchor="middle" fontSize="10" fill={isLight ? '#475569' : '#94a3b8'}>
                {formatFloat(tick, 1)}
              </text>
            </g>
          ))}

          {makeTicks(yMin, yMax, 5).map((tick) => (
            <g key={`y-grid-${tick}`}>
              <line x1={margin.left} y1={yPos(tick)} x2={margin.left + innerW} y2={yPos(tick)} stroke={isLight ? '#e2e8f0' : '#334155'} strokeDasharray="3 3" />
              <text x={margin.left - 8} y={yPos(tick) + 4} textAnchor="end" fontSize="10" fill={isLight ? '#475569' : '#94a3b8'}>{formatFloat(tick, 1)}</text>
            </g>
          ))}

          {points.filter((p) => p.x >= xMin && p.x <= xMax && p.y >= yMin && p.y <= yMax).map((point) => {
            const radius = 4 + (10 * Math.sqrt(point.rowCount / maxRows))
            return (
              <g key={`point-${point.genome_key}`}>
                <circle
                  cx={xPos(point.x)}
                  cy={yPos(point.y)}
                  r={radius}
                  fill={isLight ? 'rgba(37,99,235,0.52)' : 'rgba(56,189,248,0.52)'}
                  stroke={isLight ? '#1e3a8a' : '#0369a1'}
                />
                <text
                  x={xPos(point.x)}
                  y={yPos(point.y) - (radius + 3)}
                  textAnchor="middle"
                  fontSize="9"
                  fill={isLight ? '#334155' : '#cbd5e1'}
                >
                  {(point.label || '').slice(0, 24)}
                </text>
              </g>
            )
          })}

          <rect
            x={margin.left}
            y={margin.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            onMouseDown={beginDrag}
            onDoubleClick={() => onZoomRange(null)}
          />

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

          <text x={margin.left + innerW / 2} y={height - 6} textAnchor="middle" fontSize="11" fill={isLight ? '#475569' : '#94a3b8'}>
            Mean coverage (%)
          </text>
          <text
            x={14}
            y={margin.top + innerH / 2}
            textAnchor="middle"
            fontSize="11"
            fill={isLight ? '#475569' : '#94a3b8'}
            transform={`rotate(-90 14 ${margin.top + innerH / 2})`}
          >
            Mean identity (%)
          </text>
        </svg>
      </div>

      <div className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/40'}`}>
        <div className={`text-xs font-semibold mb-2 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>Homology summary</div>
        <div className={`text-[11px] mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
          Drag a rectangle over a cluster to zoom both coverage and identity. Double-click to reset.
        </div>
        <div className="space-y-2">
          {points.map((point) => (
            <div key={`summary-${point.genome_key}`} className={`text-xs pb-2 border-b last:border-b-0 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
              <div className={`${isLight ? 'text-gray-700' : 'text-gray-200'}`}>{point.label}</div>
              <div className={`grid grid-cols-2 gap-1 mt-1 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                <div>Rows: {formatInt(point.summary.row_count)}</div>
                <div>Identity median: {formatFloat((point.summary.identity || {}).median, 2)}</div>
                <div>Coverage median: {formatFloat((point.summary.coverage || {}).median, 2)}</div>
                <div>P90 identity: {formatFloat((point.summary.identity || {}).p90, 2)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
