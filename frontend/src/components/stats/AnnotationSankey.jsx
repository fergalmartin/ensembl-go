import { useCallback, useEffect, useRef, useState } from 'react'
import { MAJOR_CLASS_COLORS, MAJOR_CLASS_LABELS, MAJOR_CLASS_ORDER, biotypeSubtypePriority, clamp, classifyBiotypeClass, formatInt, genomeLabel, majorClassCountsForAnnotation, rectsOverlap, toNumber } from './statsModel.js'
import { ZoomOutButton } from './ZoomOutButton'

export function AnnotationSankeyForRecord({ record, basis, isLight }) {
  const [dragRect, setDragRect] = useState(null)
  const [focusSelection, setFocusSelection] = useState(null)
  const [flowAnimTick, setFlowAnimTick] = useState(0)
  const [hoveredNodeId, setHoveredNodeId] = useState('')
  const svgRef = useRef(null)

  const ann = record?.annotation || {}
  const majorCounts = majorClassCountsForAnnotation(ann, basis)
  const biotypeCounts = basis === 'genes'
    ? (ann.gene_biotype_counts || {})
    : (ann.transcript_biotype_counts || {})
  const biotypeMajorClassMap = basis === 'genes'
    ? (ann.gene_biotype_major_class_map || {})
    : (ann.transcript_biotype_major_class_map || {})

  const classBiotypes = {}
  for (const cls of MAJOR_CLASS_ORDER) classBiotypes[cls] = []

  for (const [biotypeName, rawValue] of Object.entries(biotypeCounts || {})) {
    const value = toNumber(rawValue, 0)
    if (value <= 0) continue
    const cls = classifyBiotypeClass(
      biotypeName,
      biotypeMajorClassMap[biotypeName] || biotypeMajorClassMap[String(biotypeName || '').toLowerCase()] || ''
    )
    classBiotypes[cls].push({ name: biotypeName, value })
  }

  const biotypeNodesAll = []
  const maxPerClass = 6
  for (const cls of MAJOR_CLASS_ORDER) {
    const entries = classBiotypes[cls]
      .slice()
      .sort((a, b) => {
        const p = biotypeSubtypePriority(a.name) - biotypeSubtypePriority(b.name)
        if (p !== 0) return p
        if (b.value !== a.value) return b.value - a.value
        return a.name.localeCompare(b.name)
      })
    const top = entries.slice(0, maxPerClass)
    let shown = 0
    for (const entry of top) {
      shown += entry.value
      biotypeNodesAll.push({
        id: `biotype:${cls}:${entry.name}`,
        cls,
        label: entry.name,
        value: entry.value,
        fromMajor: `major:${cls}`,
      })
    }
    const majorValue = toNumber(majorCounts[cls], 0)
    const remainder = Math.max(0, majorValue - shown)
    if (remainder > 0) {
      biotypeNodesAll.push({
        id: `biotype:${cls}:__other__`,
        cls,
        label: 'other biotypes',
        value: remainder,
        fromMajor: `major:${cls}`,
      })
    }
  }
  const hasBiotypeFlowData = biotypeNodesAll.length > 0

  const focusAllClasses = new Set(focusSelection?.allClasses || [])
  const focusBiotypes = new Set(focusSelection?.biotypes || [])
  let biotypeNodes = focusSelection
    ? biotypeNodesAll.filter((node) => focusAllClasses.has(node.cls) || focusBiotypes.has(node.id))
    : biotypeNodesAll
  if (focusSelection && !biotypeNodes.length) {
    biotypeNodes = biotypeNodesAll
  }

  const majorValueByClass = {}
  for (const cls of MAJOR_CLASS_ORDER) majorValueByClass[cls] = 0
  for (const node of biotypeNodes) {
    majorValueByClass[node.cls] += toNumber(node.value, 0)
  }
  const majorNodes = MAJOR_CLASS_ORDER
    .map((cls) => ({
      id: `major:${cls}`,
      cls,
      label: MAJOR_CLASS_LABELS[cls] || cls.replace('_', ' '),
      value: toNumber(majorValueByClass[cls], 0),
    }))
    .filter((node) => node.value > 0)
  const hasMajorFlowData = majorNodes.length > 0

  const rootTotal = Math.max(1, majorNodes.reduce((sum, node) => sum + node.value, 0))

  const width = 920
  const baseHeight = 360
  const margin = { top: 16, right: 220, bottom: 16, left: 18 }
  const baseInnerH = baseHeight - margin.top - margin.bottom
  const labelMinSpacing = 13
  const labelCountMax = Math.max(1, biotypeNodes.length, majorNodes.length, 1)
  const innerH = Math.max(baseInnerH, ((labelCountMax - 1) * labelMinSpacing) + 28)
  const height = margin.top + innerH + margin.bottom
  const dragTop = 0
  const dragBottom = height
  const nodeWidth = 15
  const sourceX = 50
  const majorX = 324
  const biotypeX = 604
  const nodeGap = 2
  const classGap = 6

  const sourceNode = {
    id: 'source',
    label: basis === 'genes' ? 'Genes' : 'Transcripts',
    value: rootTotal,
    cls: 'protein_coding',
  }

  const biotypeGapCount = Math.max(0, biotypeNodes.length - 1)
  const biotypeClassGapCount = Math.max(0, MAJOR_CLASS_ORDER.filter((cls) => biotypeNodes.some((n) => n.cls === cls)).length - 1)
  const biotypeGapPixels = (biotypeGapCount * nodeGap) + (biotypeClassGapCount * classGap)
  const scale = rootTotal > 0 ? Math.max(1e-6, (innerH - biotypeGapPixels) / rootTotal) : 1e-6

  const toSvgPoint = useCallback((evt) => {
    const element = svgRef.current
    if (!element) return { x: 0, y: 0 }
    const rect = element.getBoundingClientRect()
    const xFrac = rect.width > 0 ? (evt.clientX - rect.left) / rect.width : 0
    const yFrac = rect.height > 0 ? (evt.clientY - rect.top) / rect.height : 0
    return {
      x: clamp(xFrac, 0, 1) * width,
      y: clamp(yFrac, 0, 1) * height,
    }
  }, [width, height])

  useEffect(() => {
    setFlowAnimTick((prev) => prev + 1)
  }, [focusSelection, basis, record?.genome_key])

  const positions = new Map()
  positions.set(sourceNode.id, { x: sourceX, y: margin.top, h: Math.max(2, sourceNode.value * scale), cls: sourceNode.cls })

  let majorY = margin.top
  for (const node of majorNodes) {
    const h = Math.max(2, node.value * scale)
    positions.set(node.id, { x: majorX, y: majorY, h, cls: node.cls })
    majorY += h + nodeGap
  }

  let biotypeY = margin.top
  for (let i = 0; i < MAJOR_CLASS_ORDER.length; i += 1) {
    const cls = MAJOR_CLASS_ORDER[i]
    const classNodes = biotypeNodes.filter((node) => node.cls === cls)
    for (const node of classNodes) {
      const h = Math.max(2, node.value * scale)
      positions.set(node.id, { x: biotypeX, y: biotypeY, h, cls: node.cls })
      biotypeY += h + nodeGap
    }
    if (classNodes.length > 0 && i < MAJOR_CLASS_ORDER.length - 1) {
      const hasLater = MAJOR_CLASS_ORDER.slice(i + 1).some((laterCls) => biotypeNodes.some((node) => node.cls === laterCls))
      if (hasLater) biotypeY += classGap
    }
  }

  const labelYByNodeId = new Map()
  const assignLabelY = (nodeIds) => {
    const entries = nodeIds
      .map((id) => {
        const pos = positions.get(id)
        if (!pos) return null
        return { id, preferred: pos.y + (pos.h / 2) + 4 }
      })
      .filter(Boolean)
      .sort((a, b) => a.preferred - b.preferred)
    if (!entries.length) return

    const top = margin.top + 10
    const bottom = margin.top + innerH - 6
    const ys = []
    for (let i = 0; i < entries.length; i += 1) {
      const minY = top + (i * labelMinSpacing)
      ys[i] = Math.max(entries[i].preferred, minY, (i > 0 ? ys[i - 1] + labelMinSpacing : minY))
    }
    const overflow = ys[ys.length - 1] - bottom
    if (overflow > 0) {
      for (let i = 0; i < ys.length; i += 1) {
        ys[i] -= overflow
      }
      for (let i = 0; i < ys.length; i += 1) {
        const minY = top + (i * labelMinSpacing)
        if (ys[i] < minY) ys[i] = minY
      }
    }
    for (let i = 0; i < entries.length; i += 1) {
      labelYByNodeId.set(entries[i].id, ys[i])
    }
  }

  assignLabelY([sourceNode.id])
  assignLabelY(majorNodes.map((n) => n.id))
  assignLabelY(biotypeNodes.map((n) => n.id))

  const links = []
  for (const major of majorNodes) {
    links.push({ from: sourceNode.id, to: major.id, value: major.value, cls: major.cls })
  }
  for (const cls of MAJOR_CLASS_ORDER) {
    for (const node of biotypeNodes.filter((item) => item.cls === cls)) {
      links.push({ from: node.fromMajor, to: node.id, value: node.value, cls: node.cls })
    }
  }

  const outOffsets = {}
  const inOffsets = {}
  const getOutY = (id, value) => {
    const pos = positions.get(id)
    if (!pos) return 0
    const current = outOffsets[id] || 0
    const y = pos.y + current + ((value * scale) / 2)
    outOffsets[id] = current + (value * scale)
    return y
  }
  const getInY = (id, value) => {
    const pos = positions.get(id)
    if (!pos) return 0
    const current = inOffsets[id] || 0
    const y = pos.y + current + ((value * scale) / 2)
    inOffsets[id] = current + (value * scale)
    return y
  }

  const linkDrawData = links.map((link, idx) => {
    const fromPos = positions.get(link.from)
    const toPos = positions.get(link.to)
    if (!fromPos || !toPos) return null
    const x1 = fromPos.x + nodeWidth
    const x2 = toPos.x
    const y1 = getOutY(link.from, link.value)
    const y2 = getInY(link.to, link.value)
    const c1 = x1 + ((x2 - x1) * 0.4)
    const c2 = x1 + ((x2 - x1) * 0.6)
    const strokeWidth = Math.max(1, link.value * scale)
    return {
      id: `link-${record.genome_key}-${idx}`,
      ...link,
      x1,
      x2,
      y1,
      y2,
      c1,
      c2,
      strokeWidth,
      hitRect: {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2) - (strokeWidth / 2) - 1,
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1) + strokeWidth + 2,
      },
    }
  }).filter(Boolean)

  const allNodes = [sourceNode, ...majorNodes, ...biotypeNodes]
  const nodeHitRects = allNodes.map((node) => {
    const pos = positions.get(node.id)
    if (!pos) return null
    return {
      id: node.id,
      cls: node.cls,
      x: pos.x,
      y: pos.y,
      width: nodeWidth,
      height: pos.h,
    }
  }).filter(Boolean)

  const applyFlowSelection = useCallback((selection) => {
    const selectedClassAll = new Set()
    const selectedBiotypeIds = new Set()

    for (const nodeRect of nodeHitRects) {
      if (!rectsOverlap(selection, nodeRect)) continue
      if (nodeRect.id === 'source') {
        setFocusSelection(null)
        return
      }
      if (nodeRect.id.startsWith('major:')) {
        selectedClassAll.add(nodeRect.cls)
      } else if (nodeRect.id.startsWith('biotype:')) {
        selectedBiotypeIds.add(nodeRect.id)
      }
    }

    for (const link of linkDrawData) {
      if (!rectsOverlap(selection, link.hitRect)) continue
      if (link.from === 'source' && String(link.to || '').startsWith('major:')) {
        selectedClassAll.add(link.cls)
      } else if (String(link.to || '').startsWith('biotype:')) {
        selectedBiotypeIds.add(link.to)
      }
    }

    if (selectedClassAll.size === 0 && selectedBiotypeIds.size === 0) return
    setFocusSelection({
      allClasses: Array.from(selectedClassAll),
      biotypes: Array.from(selectedBiotypeIds),
    })
  }, [linkDrawData, nodeHitRects])

  const beginDrag = (evt) => {
    if (evt.button !== 0) return
    const point = toSvgPoint(evt)
    const x = clamp(point.x, 0, width)
    const y = clamp(point.y, dragTop, dragBottom)
    setDragRect({ startX: x, startY: y, currentX: x, currentY: y })
    evt.preventDefault()
  }

  useEffect(() => {
    if (!dragRect) return undefined

    const onMove = (e) => {
      const point = toSvgPoint(e)
      const x = clamp(point.x, 0, width)
      const y = clamp(point.y, dragTop, dragBottom)
      setDragRect((prev) => (prev ? { ...prev, currentX: x, currentY: y } : prev))
    }

    const onUp = (e) => {
      const point = toSvgPoint(e)
      const x = clamp(point.x, 0, width)
      const y = clamp(point.y, dragTop, dragBottom)
      setDragRect((prev) => {
        if (!prev) return prev
        const left = Math.min(prev.startX, x)
        const right = Math.max(prev.startX, x)
        const top = Math.min(prev.startY, y)
        const bottom = Math.max(prev.startY, y)
        if ((right - left) >= 8 && (bottom - top) >= 8) {
          applyFlowSelection({
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
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
  }, [dragRect, toSvgPoint, width, dragTop, dragBottom, applyFlowSelection])

  if (!hasBiotypeFlowData || !hasMajorFlowData) return null

  return (
    <div className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/40'}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
          {genomeLabel(record)}
        </div>
        <ZoomOutButton
          active={Boolean(focusSelection)}
          onClick={() => setFocusSelection(null)}
          isLight={isLight}
          title="Reset to full flow"
        />
      </div>
      <div className="overflow-x-auto">
        <svg
          ref={svgRef}
          width={width}
          height={height}
          style={{ cursor: 'crosshair' }}
          onMouseDown={beginDrag}
          onDoubleClick={() => setFocusSelection(null)}
        >
          <g key={`flow-refresh-${flowAnimTick}`} className="stats-sankey-refresh">
            {linkDrawData.map((link) => {
              return (
                <path
                  key={link.id}
                  d={`M ${link.x1} ${link.y1} C ${link.c1} ${link.y1}, ${link.c2} ${link.y2}, ${link.x2} ${link.y2}`}
                  fill="none"
                  stroke={MAJOR_CLASS_COLORS[link.cls] || (isLight ? '#94a3b8' : '#64748b')}
                  strokeOpacity={0.35}
                  strokeWidth={link.strokeWidth}
                />
              )
            })}

            {allNodes.map((node) => {
              const pos = positions.get(node.id)
              if (!pos) return null
              const isHoveredNode = hoveredNodeId === node.id
              const color = node.id === 'source'
                ? (isLight ? '#2563eb' : '#3b82f6')
                : (MAJOR_CLASS_COLORS[node.cls] || (isLight ? '#94a3b8' : '#64748b'))
              const defaultLabelY = pos.y + (pos.h / 2) + 4
              const labelY = labelYByNodeId.get(node.id) || defaultLabelY
              return (
                <g key={`node-${record.genome_key}-${node.id}`}>
                  <rect
                    x={pos.x}
                    y={pos.y}
                    width={nodeWidth}
                    height={pos.h}
                    fill={color}
                    opacity={isHoveredNode ? 1 : 0.88}
                    stroke={isHoveredNode ? (isLight ? '#0f172a' : '#e2e8f0') : 'none'}
                    strokeWidth={isHoveredNode ? 1.5 : 0}
                    rx={3}
                  />
                  {Math.abs(labelY - defaultLabelY) > 1.5 && (
                    <line
                      x1={pos.x + nodeWidth + 1}
                      y1={defaultLabelY - 4}
                      x2={pos.x + nodeWidth + 5}
                      y2={labelY - 4}
                      stroke={isLight ? '#94a3b8' : '#64748b'}
                      strokeWidth="1"
                      strokeOpacity="0.8"
                    />
                  )}
                  <text
                    x={pos.x + nodeWidth + 6}
                    y={labelY}
                    fontSize="10"
                    fontWeight={isHoveredNode ? 700 : 500}
                    fill={isLight ? '#334155' : '#cbd5e1'}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId('')}
                  >
                    {`${node.label} (${formatInt(node.value)})`}
                  </text>
                </g>
              )
            })}
          </g>

          {dragRect && (
            <rect
              x={Math.min(dragRect.startX, dragRect.currentX)}
              y={Math.min(dragRect.startY, dragRect.currentY)}
              width={Math.abs(dragRect.currentX - dragRect.startX)}
              height={Math.abs(dragRect.currentY - dragRect.startY)}
              fill={isLight ? 'rgba(37,99,235,0.16)' : 'rgba(56,189,248,0.16)'}
              stroke={isLight ? '#1d4ed8' : '#0ea5e9'}
              strokeDasharray="4 2"
            />
          )}
        </svg>
      </div>
      <div className={`text-[11px] mt-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        Drag a rectangle to focus selected flows. Zoom-out restores the full flow.
      </div>
    </div>
  )
}

export function AnnotationSankey({ records, basis, isLight }) {
  const ready = records.filter((r) => (r?.statuses || {}).annotation === 'ready' && r?.annotation)
  if (!ready.length) return null

  return (
    <div className="space-y-3">
      <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
        {basis === 'genes' ? 'Gene' : 'Transcript'} biotype flow by genome
      </div>
      {ready.map((record) => (
        <AnnotationSankeyForRecord
          key={`sankey-${record.genome_key}-${basis}`}
          record={record}
          basis={basis}
          isLight={isLight}
        />
      ))}
    </div>
  )
}
