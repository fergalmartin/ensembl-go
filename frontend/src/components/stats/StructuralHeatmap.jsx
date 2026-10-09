import { useEffect, useRef, useState } from 'react'
import { STRUCTURAL_METRICS, STRUCTURAL_SELECTABLE_STATUSES, formatFloat, formatInt, formatPercent, structuralDisplayStatus, structuralMetricValue, truncateText } from './statsModel.js'
import { useHorizontalDragScroll } from './useHorizontalDragScroll.js'

export function StructuralHeatmap({ records, isLight, generatingLabel = 'Generating', structuralRuntimeStatusByKey, onToggleGenerateForKey }) {
  const [hoveredColumnKey, setHoveredColumnKey] = useState('')
  const [referenceColumnKey, setReferenceColumnKey] = useState('')
  const [columnOrder, setColumnOrder] = useState([])
  const [dragColumnKey, setDragColumnKey] = useState('')
  const [dropColumnKey, setDropColumnKey] = useState('')
  const headerDragRef = useRef({ startX: 0, startY: 0, moved: false, suppressClick: false })
  const displayRecords = records || []
  const tableDrag = useHorizontalDragScroll()
  const structuralStatus = (record) => (record?.statuses || {}).structural || 'missing'
  const hasStructuralData = (record) => Boolean(record?.structural)
  const isReadyRecord = (record) => (
    hasStructuralData(record)
    && ['ready', 'computing'].includes(structuralStatus(record))
  )
  const runtimeStatusForKey = (genomeKey) => structuralRuntimeStatusByKey?.get(genomeKey) || ''
  const readyKeys = new Set(
    displayRecords
      .filter((r) => isReadyRecord(r))
      .map((r) => r.genome_key)
  )

  useEffect(() => {
    const keys = new Set(displayRecords.map((r) => r.genome_key))
    if (referenceColumnKey && !keys.has(referenceColumnKey)) {
      setReferenceColumnKey('')
    }
    if (hoveredColumnKey && !keys.has(hoveredColumnKey)) {
      setHoveredColumnKey('')
    }
    if (dragColumnKey && !keys.has(dragColumnKey)) {
      setDragColumnKey('')
      setDropColumnKey('')
    }
  }, [displayRecords, referenceColumnKey, hoveredColumnKey, dragColumnKey])

  useEffect(() => {
    const incoming = displayRecords.map((record) => record.genome_key)
    setColumnOrder((prev) => {
      const next = prev.filter((key) => incoming.includes(key))
      for (const key of incoming) {
        if (!next.includes(key)) next.push(key)
      }
      const unchanged = next.length === prev.length && next.every((key, idx) => key === prev[idx])
      return unchanged ? prev : next
    })
  }, [displayRecords])

  useEffect(() => {
    if (!dragColumnKey) return undefined
    const onMove = (e) => {
      const drag = headerDragRef.current
      if (!drag.moved) {
        const movedX = Math.abs(e.clientX - drag.startX)
        const movedY = Math.abs(e.clientY - drag.startY)
        if (movedX >= 4 || movedY >= 4) drag.moved = true
      }
      if (!drag.moved) return
      const target = document.elementFromPoint(e.clientX, e.clientY)
      const col = target?.closest?.('[data-struct-col-key]')
      const key = col?.getAttribute?.('data-struct-col-key') || ''
      if (key && key !== dragColumnKey) setDropColumnKey(key)
      else setDropColumnKey('')
    }

    const finishDrag = (e) => {
      const drag = headerDragRef.current
      let finalDropKey = dropColumnKey
      if (drag.moved && e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
        const target = document.elementFromPoint(e.clientX, e.clientY)
        const col = target?.closest?.('[data-struct-col-key]')
        const key = col?.getAttribute?.('data-struct-col-key') || ''
        if (key) finalDropKey = key
      }
      if (drag.moved && finalDropKey && finalDropKey !== dragColumnKey) {
        setColumnOrder((prev) => {
          const src = prev.indexOf(dragColumnKey)
          const dst = prev.indexOf(finalDropKey)
          if (src < 0 || dst < 0 || src === dst) return prev
          const next = [...prev]
          const temp = next[src]
          next[src] = next[dst]
          next[dst] = temp
          return next
        })
      }
      if (drag.moved) {
        drag.suppressClick = true
        window.setTimeout(() => {
          headerDragRef.current.suppressClick = false
        }, 0)
      }
      drag.moved = false
      setDragColumnKey('')
      setDropColumnKey('')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', finishDrag)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', finishDrag)
    }
  }, [dragColumnKey, dropColumnKey])

  if (!displayRecords.length) return null

  const recordsByKey = new Map(displayRecords.map((record) => [record.genome_key, record]))
  const orderedRecords = columnOrder.map((key) => recordsByKey.get(key)).filter(Boolean)

  const referenceRecord = referenceColumnKey
    ? (orderedRecords.find((r) => r.genome_key === referenceColumnKey) || null)
    : null
  const isReferenceReady = referenceRecord && readyKeys.has(referenceRecord.genome_key)
  const usableReferenceRecord = isReferenceReady ? referenceRecord : null

  const columnShadeClass = (idx) => {
    if (idx % 2 === 0) return isLight ? 'bg-slate-50/75' : 'bg-slate-800/35'
    return isLight ? 'bg-slate-100/75' : 'bg-slate-700/35'
  }
  const columnInteractiveClass = (idx, key) => {
    const base = columnShadeClass(idx)
    const hover = hoveredColumnKey === key
      ? (isLight ? ' !bg-blue-100/80' : ' !bg-blue-900/45')
      : ''
    const selected = referenceColumnKey === key
      ? (isLight ? ' !bg-blue-200/85' : ' !bg-blue-800/50')
      : ''
    const dragSource = dragColumnKey === key
      ? (isLight ? ' !bg-blue-300/90' : ' !bg-blue-700/60')
      : ''
    const dragTarget = dropColumnKey === key
      ? (isLight ? ' !bg-blue-200/70' : ' !bg-blue-800/40')
      : ''
    return `${base}${hover}${selected}${dragSource}${dragTarget}`
  }
  const formatMetricValue = (metric, value, countValue = null) => {
    if (metric.countKey) {
      const countText = formatInt(countValue)
      const percentText = formatPercent(value)
      if (countText === '—' && percentText === '—') return '—'
      if (countText === '—') return `— (${percentText})`
      if (percentText === '—') return `${countText} (—)`
      return `${countText} (${percentText})`
    }
    if (metric.format === 'percent') return formatPercent(value)
    if (metric.format === 'int') return formatInt(value)
    return formatFloat(value, 2)
  }
  const formatMetricDelta = (metric, delta) => {
    if (!Number.isFinite(delta)) return null
    const normalizedDelta = Math.abs(delta) < 1e-12 ? 0 : delta
    if (metric.format === 'percent') {
      const pct = normalizedDelta * 100
      const sign = pct >= 0 ? '+' : ''
      return `${sign}${pct.toFixed(2)}%`
    }
    const sign = normalizedDelta >= 0 ? '+' : ''
    return `${sign}${normalizedDelta.toFixed(2)}`
  }
  const renderMetricCell = (metric, value, baselineValue, isReference, countValue = null) => {
    const n = Number(value)
    const b = Number(baselineValue)
    const hasDelta = (
      referenceColumnKey
      && !isReference
      && Number.isFinite(n)
      && Number.isFinite(b)
    )

    if (!hasDelta) {
      return formatMetricValue(metric, value, countValue)
    }

    const delta = n - b
    const normalizedDelta = Math.abs(delta) < 1e-12 ? 0 : delta
    const deltaText = formatMetricDelta(metric, delta)
    const deltaClass = normalizedDelta < 0
      ? (isLight ? 'text-rose-700' : 'text-rose-300')
      : (isLight ? 'text-blue-700' : 'text-sky-300')

    return (
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span className={`font-semibold ${deltaClass}`}>({deltaText})</span>
        <span>{formatMetricValue(metric, value, countValue)}</span>
      </div>
    )
  }
  const headerLabel = (record) => truncateText(record.assembly_name || record.assembly || 'Genome', 18)
  const headerTitle = (record) => {
    const speciesName = record.common_name || record.scientific_name || record.species_key || 'Genome'
    const assemblyName = record.assembly_name || record.assembly || '—'
    const gca = record.gca || record.assembly || '—'
    return `${speciesName} - ${assemblyName} - ${gca}`
  }
  const isMetricPending = (record, metric) => {
    if (!record?.structural) return false
    const pending = new Set(record.structural?.pending_metrics || [])
    if (pending.has(metric.key)) return true
    if (metric.sequenceBased && record.structural?.sequence_metrics_status === 'computing') return true
    return false
  }
  const isGeneratingRecord = (record) => runtimeStatusForKey(record.genome_key) === 'running'
  const isQueuedRecord = (record) => runtimeStatusForKey(record.genome_key) === 'queued'
  const canGenerateRecord = (record) => (
    STRUCTURAL_SELECTABLE_STATUSES.has(structuralStatus(record))
    && !isGeneratingRecord(record)
    && !isQueuedRecord(record)
    && typeof onToggleGenerateForKey === 'function'
  )
  const placeholderLabel = (record) => {
    if (isGeneratingRecord(record)) return generatingLabel
    if (isQueuedRecord(record)) return 'Queued'
    if (canGenerateRecord(record)) return 'Click to generate'
    return structuralDisplayStatus(structuralStatus(record))
  }
  const metricColWidth = 190
  const genomeColWidth = 188
  const tableWidth = metricColWidth + (orderedRecords.length * genomeColWidth)

  return (
    <div className="space-y-2">
      <div className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        Hover columns to highlight. Click a ready column to set reference deltas. Click non-ready columns to generate.
      </div>
      <div
        ref={tableDrag.scrollRef}
        className="hide-scrollbar overflow-x-auto cursor-grab select-none"
        onMouseDown={tableDrag.onMouseDown}
        onMouseMove={tableDrag.onMouseMove}
        onMouseUp={tableDrag.onMouseUp}
        onMouseLeave={tableDrag.onMouseLeave}
        onClickCapture={tableDrag.onClickCapture}
      >
        <table
          className="table-fixed text-xs border-collapse"
          style={{ width: `${tableWidth}px`, minWidth: `${tableWidth}px` }}
          onMouseLeave={() => setHoveredColumnKey('')}
        >
          <colgroup>
            <col style={{ width: `${metricColWidth}px` }} />
            {orderedRecords.map((record) => (
              <col key={`col-${record.genome_key}`} style={{ width: `${genomeColWidth}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className={`text-left px-2 py-2 border-b ${isLight ? 'border-gray-200 text-gray-600' : 'border-gray-700 text-gray-300'}`}>Metric</th>
              {orderedRecords.map((record, colIdx) => {
                const ready = isReadyRecord(record)
                const runtime = runtimeStatusForKey(record.genome_key)
                const showRuntimeControl = runtime === 'running' || runtime === 'queued'
                return (
                  <th
                    key={`head-${record.genome_key}`}
                    data-struct-col-key={record.genome_key}
                    title={headerTitle(record)}
                    onMouseEnter={() => {
                      setHoveredColumnKey(record.genome_key)
                      if (dragColumnKey && dragColumnKey !== record.genome_key) {
                        setDropColumnKey(record.genome_key)
                      }
                    }}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return
                      e.stopPropagation()
                      headerDragRef.current = {
                        startX: e.clientX,
                        startY: e.clientY,
                        moved: false,
                        suppressClick: false,
                      }
                      setDragColumnKey(record.genome_key)
                      setDropColumnKey('')
                    }}
                    onClick={() => {
                      if (headerDragRef.current.suppressClick) return
                      if (ready) {
                        setReferenceColumnKey((prev) => (prev === record.genome_key ? '' : record.genome_key))
                      }
                    }}
                    className={`text-left px-2 py-2 border-b select-none ${isLight ? 'border-gray-200 text-gray-600' : 'border-gray-700 text-gray-300'} ${columnInteractiveClass(colIdx, record.genome_key)} ${ready ? 'cursor-pointer' : 'cursor-grab'}`}
                  >
                    <span className="block truncate">
                      {headerLabel(record)}
                      {referenceColumnKey === record.genome_key ? ' *' : ''}
                    </span>
                    {(showRuntimeControl || !ready) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (showRuntimeControl || canGenerateRecord(record)) {
                            onToggleGenerateForKey(record.genome_key)
                          }
                        }}
                        disabled={!(showRuntimeControl || canGenerateRecord(record))}
                        className={`mt-1 rounded px-1.5 py-0.5 text-[10px] uppercase border ${(showRuntimeControl || canGenerateRecord(record))
                          ? (isLight
                            ? 'bg-[#0099ff] text-white border-[#0088ee] hover:bg-[#0088ee]'
                            : 'bg-blue-600 text-white border-blue-500 hover:bg-blue-500')
                          : (isLight
                            ? 'bg-gray-100 text-gray-500 border-gray-300'
                            : 'bg-gray-800 text-gray-400 border-gray-700')
                          }`}
                      >
                        {showRuntimeControl ? (runtime === 'running' ? generatingLabel : 'Queued') : placeholderLabel(record)}
                      </button>
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {STRUCTURAL_METRICS.map((metric, metricIdx) => (
              <tr key={metric.key}>
                <td className={`px-2 py-1.5 border-b ${isLight ? 'border-gray-200 text-gray-700' : 'border-gray-700 text-gray-200'}`}>
                  {metric.label}
                </td>
                {orderedRecords.map((record, colIdx) => {
                  const ready = isReadyRecord(record)
                  const generating = isGeneratingRecord(record)
                  const canGenerate = canGenerateRecord(record)
                  if (ready) {
                    const value = structuralMetricValue(record, metric.key)
                    const countValue = metric.countKey ? structuralMetricValue(record, metric.countKey) : null
                    const pendingMetric = isMetricPending(record, metric)
                    const baseline = usableReferenceRecord
                      ? Number(structuralMetricValue(usableReferenceRecord, metric.key))
                      : null
                    return (
                      <td
                        key={`${record.genome_key}-${metric.key}`}
                        onMouseEnter={() => setHoveredColumnKey(record.genome_key)}
                        onClick={() => setReferenceColumnKey((prev) => (prev === record.genome_key ? '' : record.genome_key))}
                        className={`px-2 py-1.5 border-b cursor-pointer select-none ${isLight ? 'border-gray-200 text-gray-800' : 'border-gray-700 text-gray-100'} ${columnInteractiveClass(colIdx, record.genome_key)}`}
                      >
                        {Number.isFinite(Number(value))
                          ? renderMetricCell(metric, value, baseline, referenceColumnKey === record.genome_key, countValue)
                          : (pendingMetric
                            ? <span className={isLight ? 'text-gray-500' : 'text-gray-400'}>Calculating</span>
                            : <span className={isLight ? 'text-gray-400' : 'text-gray-500'}>—</span>)}
                      </td>
                    )
                  }
                  return (
                    <td
                      key={`${record.genome_key}-${metric.key}`}
                      onMouseEnter={() => setHoveredColumnKey(record.genome_key)}
                      className={`px-2 py-1.5 border-b align-middle ${isLight ? 'border-gray-200 text-gray-500' : 'border-gray-700 text-gray-400'} ${columnInteractiveClass(colIdx, record.genome_key)}`}
                    >
                      <span className={isLight ? 'text-gray-400' : 'text-gray-500'}> </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
