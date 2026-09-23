import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { trackAchievement } from '../achievements/tracker.js'
import { makeExonStateKey } from './featureExplorerExonUtils'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function lerp(a, b, t) {
  return a + ((b - a) * t)
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '')
  if (clean.length !== 6) return { r: 127, g: 127, b: 127 }
  const n = Number.parseInt(clean, 16)
  if (!Number.isFinite(n)) return { r: 127, g: 127, b: 127 }
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  }
}

function rgbToHex({ r, g, b }) {
  const pack = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${pack(r)}${pack(g)}${pack(b)}`
}

const HEAT_STOPS = [
  { t: 0.0, color: '#3b82f6' }, // blue
  { t: 0.33, color: '#8b5cf6' }, // purple
  { t: 0.66, color: '#f59e0b' }, // orange
  { t: 1.0, color: '#ef4444' }, // red
]

export function heatColorFromFraction(fraction) {
  const t = clamp(Number(fraction) || 0, 0, 1)
  for (let i = 0; i < HEAT_STOPS.length - 1; i += 1) {
    const a = HEAT_STOPS[i]
    const b = HEAT_STOPS[i + 1]
    if (t <= b.t) {
      const local = (t - a.t) / Math.max(1e-9, (b.t - a.t))
      const aRgb = hexToRgb(a.color)
      const bRgb = hexToRgb(b.color)
      return rgbToHex({
        r: lerp(aRgb.r, bRgb.r, local),
        g: lerp(aRgb.g, bRgb.g, local),
        b: lerp(aRgb.b, bRgb.b, local),
      })
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1].color
}

function featureLength(start, end) {
  const s = Number(start)
  const e = Number(end)
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0
  return (e - s) + 1
}

function mergeIntervals(intervals) {
  if (!intervals.length) return []
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  const merged = [sorted[0]]
  for (let i = 1; i < sorted.length; i += 1) {
    const curr = sorted[i]
    const last = merged[merged.length - 1]
    if (curr.start <= (last.end + 1)) {
      last.end = Math.max(last.end, curr.end)
    } else {
      merged.push({ ...curr })
    }
  }
  return merged
}

function classifyExon(exonStart, exonEnd, cdsList) {
  const overlaps = []
  for (const cds of cdsList) {
    const s = Math.max(exonStart, Number(cds.start))
    const e = Math.min(exonEnd, Number(cds.end))
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
      overlaps.push({ start: s, end: e })
    }
  }
  if (!overlaps.length) {
    return { cls: 'non_coding', codingSegments: [] }
  }
  const merged = mergeIntervals(overlaps)
  const codingLen = merged.reduce((sum, seg) => sum + featureLength(seg.start, seg.end), 0)
  const exonLen = featureLength(exonStart, exonEnd)
  if (codingLen >= exonLen && merged.length === 1 && merged[0].start <= exonStart && merged[0].end >= exonEnd) {
    return { cls: 'coding', codingSegments: [{ start: exonStart, end: exonEnd }] }
  }
  return { cls: 'partial', codingSegments: merged }
}

function orientedBoundaries(start, end, strand) {
  if (strand === '-') return { fivePrime: end, threePrime: start }
  return { fivePrime: start, threePrime: end }
}

function axisCoord(genomicCoord, reverseOrientation) {
  return reverseOrientation ? -Number(genomicCoord) : Number(genomicCoord)
}

function buildExonInstances(transcript, reverseOrientation) {
  const strand = String(transcript?.strand || '+')
  const chrom = String(transcript?.chrom || '')
  const exons = Array.isArray(transcript?.exons) ? transcript.exons : []
  const cdsList = Array.isArray(transcript?.cds_list) ? transcript.cds_list : []
  const instances = []

  for (let exonIndex = 0; exonIndex < exons.length; exonIndex += 1) {
    const exon = exons[exonIndex]
    const exonStart = Number(exon?.start)
    const exonEnd = Number(exon?.end)
    if (!Number.isFinite(exonStart) || !Number.isFinite(exonEnd) || exonEnd < exonStart) continue

    const boundary = orientedBoundaries(exonStart, exonEnd, strand)
    const classification = classifyExon(exonStart, exonEnd, cdsList)
    const codingSegments = classification.codingSegments.map((seg) => {
      const segBoundary = orientedBoundaries(seg.start, seg.end, strand)
      const a1 = axisCoord(segBoundary.fivePrime, reverseOrientation)
      const a2 = axisCoord(segBoundary.threePrime, reverseOrientation)
      return {
        fivePrime: segBoundary.fivePrime,
        threePrime: segBoundary.threePrime,
        axisStart: Math.min(a1, a2),
        axisEnd: Math.max(a1, a2),
      }
    }).sort((a, b) => a.axisStart - b.axisStart)

    const e1 = axisCoord(boundary.fivePrime, reverseOrientation)
    const e2 = axisCoord(boundary.threePrime, reverseOrientation)
    const axisStart = Math.min(e1, e2)
    const axisEnd = Math.max(e1, e2)

    instances.push({
      transcriptId: transcript.id,
      exonIndex,
      cls: classification.cls,
      chrom,
      strand,
      fivePrime: boundary.fivePrime,
      threePrime: boundary.threePrime,
      axisStart,
      axisEnd,
      codingSegments,
    })
  }

  return instances.sort((a, b) => {
    const d = a.axisStart - b.axisStart
    if (d !== 0) return d
    return a.axisEnd - b.axisEnd
  })
}

function partialSignature(instance) {
  if (instance.cls !== 'partial') return ''
  return instance.codingSegments.map((seg) => `${seg.fivePrime}:${seg.threePrime}`).join('|')
}

function nodeKey(instance) {
  return `${instance.fivePrime}|${instance.threePrime}|${instance.cls}|${partialSignature(instance)}`
}

function exonKey(fivePrime, threePrime) {
  return `${Number(fivePrime)}:${Number(threePrime)}`
}

function intronKey(fromThreePrime, toFivePrime) {
  const a = Number(fromThreePrime)
  const b = Number(toFivePrime)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return ''
  return `${Math.min(a, b)}:${Math.max(a, b)}`
}

export function buildSplicingHeatmapModel(activeTranscripts, reverseOrientation) {
  const transcriptList = Array.isArray(activeTranscripts) ? activeTranscripts : []
  const transcriptCount = transcriptList.length
  if (transcriptCount === 0) {
    return { transcriptCount: 0, nodes: [], edges: [], columns: [] }
  }

  const nodesByKey = new Map()
  const edgeMap = new Map()

  for (const tx of transcriptList) {
    const instances = buildExonInstances(tx, reverseOrientation)
    const pathNodeIds = []
    for (const instance of instances) {
      const key = nodeKey(instance)
      let node = nodesByKey.get(key)
      if (!node) {
        node = {
          id: `n${nodesByKey.size + 1}`,
          key,
          cls: instance.cls,
          chrom: instance.chrom,
          strand: instance.strand,
          fivePrime: instance.fivePrime,
          threePrime: instance.threePrime,
          axisStart: instance.axisStart,
          axisEnd: instance.axisEnd,
          codingSegments: instance.codingSegments,
          transcriptIds: new Set(),
        }
        nodesByKey.set(key, node)
      }
      node.transcriptIds.add(tx.id)
      if (pathNodeIds[pathNodeIds.length - 1] !== node.id) {
        pathNodeIds.push(node.id)
      }
    }

    for (let i = 0; i < pathNodeIds.length - 1; i += 1) {
      const from = pathNodeIds[i]
      const to = pathNodeIds[i + 1]
      const edgeKey = `${from}->${to}`
      let edge = edgeMap.get(edgeKey)
      if (!edge) {
        edge = { id: `e${edgeMap.size + 1}`, from, to, transcriptIds: new Set() }
        edgeMap.set(edgeKey, edge)
      }
      edge.transcriptIds.add(tx.id)
    }
  }

  const nodes = Array.from(nodesByKey.values()).map((node) => {
    const supportCount = node.transcriptIds.size
    return {
      ...node,
      supportCount,
      supportFraction: supportCount / transcriptCount,
      transcriptIds: undefined,
    }
  })

  const edges = Array.from(edgeMap.values()).map((edge) => {
    const supportCount = edge.transcriptIds.size
    return {
      ...edge,
      supportCount,
      supportFraction: supportCount / transcriptCount,
      transcriptIds: undefined,
    }
  })

  const columns = Array.from(
    new Set(nodes.flatMap((node) => [node.axisStart, node.axisEnd]))
  ).sort((a, b) => a - b)

  return { transcriptCount, nodes, edges, columns }
}

function cubicPoint(t, p0, p1, p2, p3) {
  const inv = 1 - t
  return (
    (inv * inv * inv * p0) +
    (3 * inv * inv * t * p1) +
    (3 * inv * t * t * p2) +
    (t * t * t * p3)
  )
}

export function sampleBezierForArrows(pathSpec, spacingPx = 48) {
  const { x1, y1, c1x, c1y, c2x, c2y, x2, y2 } = pathSpec || {}
  const segments = 80
  const points = []
  let total = 0
  let prev = null
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments
    const x = cubicPoint(t, x1, c1x, c2x, x2)
    const y = cubicPoint(t, y1, c1y, c2y, y2)
    if (prev) total += Math.hypot(x - prev.x, y - prev.y)
    points.push({ t, x, y, len: total })
    prev = { x, y }
  }
  if (total < spacingPx * 1.5) return []

  const picks = []
  for (let d = spacingPx; d < (total - (spacingPx * 0.5)); d += spacingPx) {
    let idx = 1
    while (idx < points.length && points[idx].len < d) idx += 1
    if (idx >= points.length) continue
    const p1 = points[idx - 1]
    const p2 = points[idx]
    const span = Math.max(1e-9, p2.len - p1.len)
    const r = (d - p1.len) / span
    const x = lerp(p1.x, p2.x, r)
    const y = lerp(p1.y, p2.y, r)
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x)
    picks.push({ x, y, angle })
  }
  return picks
}

export function layoutSplicingHeatmap(model, viewWidth, opts = {}) {
  const nodes = Array.isArray(model?.nodes) ? model.nodes : []
  const edges = Array.isArray(model?.edges) ? model.edges : []
  const columns = Array.isArray(model?.columns) ? model.columns : []

  const minHeight = Number(opts.minHeight || 220)
  if (!nodes.length || columns.length < 2) {
    return {
      nodes: [],
      edges: [],
      svgWidth: Math.max(720, Math.floor(viewWidth || 0)),
      svgHeight: minHeight,
      rows: 0,
      columns,
    }
  }

  const leftPad = 56
  const rightPad = 44
  const topPad = 24
  const bottomPad = 24
  const nodeHeight = 14
  const rowPitch = 40
  const groupGap = 56
  const minNodeWidth = 14
  const minNaturalNodeWidth = 1

  const nodesForPlacement = nodes
    .map((node) => ({
      ...node,
      axisStart: Number(node.axisStart),
      axisEnd: Number(node.axisEnd),
    }))
    .filter((node) => Number.isFinite(node.axisStart) && Number.isFinite(node.axisEnd))
    .sort((a, b) => {
      const s = a.axisStart - b.axisStart
      if (s !== 0) return s
      const e = a.axisEnd - b.axisEnd
      if (e !== 0) return e
      return String(a.id).localeCompare(String(b.id))
    })

  // Merge overlapping exon coordinate spans into groups.
  const groups = []
  for (const node of nodesForPlacement) {
    const start = Math.min(node.axisStart, node.axisEnd)
    const end = Math.max(node.axisStart, node.axisEnd)
    const last = groups[groups.length - 1]
    if (!last || start > last.axisEnd) {
      groups.push({
        axisStart: start,
        axisEnd: end,
        nodes: [node],
      })
    } else {
      last.axisEnd = Math.max(last.axisEnd, end)
      last.nodes.push(node)
    }
  }

  const totalAxisSpan = groups.reduce((sum, group) => sum + Math.max(1, (group.axisEnd - group.axisStart)), 0)
  const targetInnerWidth = Math.max(620, Math.floor(viewWidth || 0) - leftPad - rightPad)
  const totalGapWidth = Math.max(0, groups.length - 1) * groupGap
  const widthForGroups = Math.max(220, targetInnerWidth - totalGapWidth)
  const bpScale = totalAxisSpan > 0 ? (widthForGroups / totalAxisSpan) : 1

  const provisionalNodes = []
  let runningX = leftPad
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]
    let groupDisplayWidth = 0
    const localNodes = []
    for (const node of group.nodes) {
      const start = Math.min(node.axisStart, node.axisEnd)
      const end = Math.max(node.axisStart, node.axisEnd)
      const offsetPx = (start - group.axisStart) * bpScale
      const naturalWidth = Math.max(minNaturalNodeWidth, (end - start) * bpScale)
      const width = Math.max(minNodeWidth, naturalWidth)
      localNodes.push({
        ...node,
        groupIndex,
        x: runningX + offsetPx,
        w: width,
      })
      groupDisplayWidth = Math.max(groupDisplayWidth, offsetPx + width)
    }
    for (const node of localNodes) provisionalNodes.push(node)
    runningX += groupDisplayWidth + (groupIndex < groups.length - 1 ? groupGap : 0)
  }

  const svgWidth = Math.max(760, Math.floor(viewWidth || 0), Math.ceil(runningX + rightPad))

  const rowEnds = []
  const nodeById = new Map()
  const placementOrder = [...provisionalNodes].sort((a, b) => {
    const s = a.x - b.x
    if (s !== 0) return s
    const e = (a.x + a.w) - (b.x + b.w)
    if (e !== 0) return e
    return String(a.id).localeCompare(String(b.id))
  })
  for (const node of placementOrder) {
    let row = 0
    while (row < rowEnds.length && node.x <= (rowEnds[row] + 2)) row += 1
    if (row === rowEnds.length) rowEnds.push(node.x + node.w)
    else rowEnds[row] = node.x + node.w

    const x = node.x
    const width = node.w
    const y = topPad + (row * rowPitch) + ((rowPitch - nodeHeight) / 2)

    nodeById.set(node.id, {
      ...node,
      row,
      x,
      y,
      w: width,
      h: nodeHeight,
      cx: x + (width / 2),
      cy: y + (nodeHeight / 2),
    })
  }

  const layoutEdges = []
  const skipTopLaneUse = new Map()
  const skipBottomLaneUse = new Map()
  const rowsEstimate = Math.max(1, rowEnds.length)
  const estimatedSvgHeight = Math.max(minHeight, topPad + bottomPad + (rowsEstimate * rowPitch))
  const bypassTopBound = topPad + 4
  const bypassBottomBound = estimatedSvgHeight - bottomPad - 4
  const connectorInset = 1.5
  const topBypassBase = Math.max(8, topPad - 16)
  const bottomBypassBase = topPad + (Math.max(1, rowEnds.length) * rowPitch) - 4
  for (const edge of edges) {
    const from = nodeById.get(edge.from)
    const to = nodeById.get(edge.to)
    if (!from || !to) continue
    let x1 = from.x + from.w + connectorInset
    const y1 = from.cy
    let x2 = to.x - connectorInset
    const y2 = to.cy
    if ((x2 - x1) < 8) {
      x1 = from.x + from.w + 0.5
      x2 = to.x - 0.5
    }
    const span = Math.max(48, Math.abs(x2 - x1))
    const pull = Math.min(44, Math.max(20, span * 0.36))
    let c1x = x1 + pull
    let c2x = x2 - pull
    const skippedAxis = Math.max(0, to.axisStart - from.axisEnd)
    const hasInterveningNode = skippedAxis > 0 && nodesForPlacement.some((node) => (
      node.id !== from.id &&
      node.id !== to.id &&
      node.axisStart < to.axisStart &&
      node.axisEnd > from.axisEnd
    ))
    const requiresBypass = skippedAxis > 0 && hasInterveningNode
    let c1y = y1
    let c2y = y2
    if (requiresBypass) {
      const laneKey = `${from.groupIndex}:${to.groupIndex}:${Math.round(skippedAxis)}`
      const topLanes = skipTopLaneUse.get(laneKey) || 0
      const bottomLanes = skipBottomLaneUse.get(laneKey) || 0
      const preferBottom = from.row > to.row
      let useBottom = false
      if (topLanes === bottomLanes) {
        useBottom = preferBottom
      } else {
        useBottom = bottomLanes < topLanes
      }
      const laneIndex = useBottom ? bottomLanes : topLanes
      if (useBottom) skipBottomLaneUse.set(laneKey, laneIndex + 1)
      else skipTopLaneUse.set(laneKey, laneIndex + 1)

      const normalizedSkip = Math.max(1, Math.round(skippedAxis * bpScale / 24))
      const rowDelta = Math.abs((from.row ?? 0) - (to.row ?? 0))
      const lift = 16 + (normalizedSkip * 2.5) + (laneIndex * 5) + (rowDelta * 3)
      const bypassY = useBottom
        ? bottomBypassBase + (lift * 0.55)
        : (topBypassBase - lift)
      const boundedBypassY = clamp(bypassY, bypassTopBound, bypassBottomBound)
      const hook = Math.min(26, Math.max(12, span * 0.12))
      c1x = x1 + hook
      c2x = x2 - hook
      c1y = boundedBypassY
      c2y = boundedBypassY
    }
    c1y = clamp(c1y, bypassTopBound, bypassBottomBound)
    c2y = clamp(c2y, bypassTopBound, bypassBottomBound)
    layoutEdges.push({
      ...edge,
      x1, y1, x2, y2, c1x, c1y, c2x, c2y, isSkipJunction: requiresBypass,
      pathD: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`,
      arrows: sampleBezierForArrows({ x1, y1, c1x, c1y, c2x, c2y, x2, y2 }, 48),
    })
  }

  const rows = rowEnds.length
  const svgHeight = Math.max(minHeight, topPad + bottomPad + (rows * rowPitch))
  return {
    nodes: Array.from(nodeById.values()),
    edges: layoutEdges,
    svgWidth,
    svgHeight,
    rows,
    columns,
    leftPad,
    rightPad,
  }
}

const DRAG_THRESHOLD_PX = 3
const MIN_CENTER_GAP = 40
const EDGE_ENDPOINT_INSET = 1.5
const EDGE_BEND_EPSILON = 0.15
const NODE_OVERRIDE_EPSILON = 0.15
const NODE_VIEWPORT_MARGIN = 8
const spliceLayoutSessionCache = new Map()

function emptyInteractiveLayoutState() {
  return {
    nodeOverridesByKey: {},
    edgeOverridesByPair: {},
  }
}

function cloneInteractiveLayoutState(state) {
  return {
    nodeOverridesByKey: { ...(state?.nodeOverridesByKey || {}) },
    edgeOverridesByPair: { ...(state?.edgeOverridesByPair || {}) },
  }
}

function layoutStateEquals(a, b) {
  const aNodes = a?.nodeOverridesByKey || {}
  const bNodes = b?.nodeOverridesByKey || {}
  const aEdges = a?.edgeOverridesByPair || {}
  const bEdges = b?.edgeOverridesByPair || {}
  const aNodeKeys = Object.keys(aNodes)
  const bNodeKeys = Object.keys(bNodes)
  if (aNodeKeys.length !== bNodeKeys.length) return false
  for (const key of aNodeKeys) {
    const av = Number(aNodes[key]?.cy)
    const bv = Number(bNodes[key]?.cy)
    if (!Number.isFinite(av) && !Number.isFinite(bv)) continue
    if (Math.abs(av - bv) > NODE_OVERRIDE_EPSILON) return false
  }
  const aEdgeKeys = Object.keys(aEdges)
  const bEdgeKeys = Object.keys(bEdges)
  if (aEdgeKeys.length !== bEdgeKeys.length) return false
  for (const key of aEdgeKeys) {
    const aDx = Number(aEdges[key]?.bendDx || 0)
    const bDx = Number(bEdges[key]?.bendDx || 0)
    const aDy = Number(aEdges[key]?.bendDy || 0)
    const bDy = Number(bEdges[key]?.bendDy || 0)
    if (Math.abs(aDx - bDx) > EDGE_BEND_EPSILON || Math.abs(aDy - bDy) > EDGE_BEND_EPSILON) return false
  }
  return true
}

function buildBaseCyByKey(baseNodes, nodeKeyById) {
  const map = new Map()
  for (const node of Array.isArray(baseNodes) ? baseNodes : []) {
    const key = nodeKeyById.get(node.id) || node.key || node.id
    map.set(key, Number(node.cy))
  }
  return map
}

function applyInteractiveNodePositions(baseNodes, nodeKeyById, nodeOverridesByKey) {
  const nodesById = new Map()
  const nodesByKey = new Map()
  for (const baseNode of Array.isArray(baseNodes) ? baseNodes : []) {
    const key = nodeKeyById.get(baseNode.id) || baseNode.key || baseNode.id
    const overrideCy = Number(nodeOverridesByKey?.[key]?.cy)
    const cy = Number.isFinite(overrideCy) ? overrideCy : Number(baseNode.cy)
    const h = Number(baseNode.h || 0)
    const next = {
      ...baseNode,
      key,
      cy,
      y: cy - (h / 2),
    }
    nodesById.set(baseNode.id, next)
    nodesByKey.set(key, next)
  }
  return { nodesById, nodesByKey }
}

function overlapsOnX(a, b) {
  const aLeft = Number(a?.x)
  const aRight = aLeft + Number(a?.w || 0)
  const bLeft = Number(b?.x)
  const bRight = bLeft + Number(b?.w || 0)
  if (!Number.isFinite(aLeft) || !Number.isFinite(aRight) || !Number.isFinite(bLeft) || !Number.isFinite(bRight)) return false
  return aLeft <= bRight && bLeft <= aRight
}

function getOverlapComponent(nodesByKey, rootKey) {
  const root = nodesByKey.get(rootKey)
  if (!root) return new Set()
  const keys = Array.from(nodesByKey.keys())
  const visited = new Set()
  const queue = [rootKey]
  while (queue.length > 0) {
    const key = queue.shift()
    if (visited.has(key)) continue
    visited.add(key)
    const node = nodesByKey.get(key)
    if (!node) continue
    for (const otherKey of keys) {
      if (visited.has(otherKey) || otherKey === key) continue
      const other = nodesByKey.get(otherKey)
      if (!other) continue
      if (!overlapsOnX(node, other)) continue
      queue.push(otherKey)
    }
  }
  return visited
}

function reflowOverlapCluster(nodesByKey, draggedNodeKey, targetCy, minCenterGap = MIN_CENTER_GAP) {
  const componentKeys = getOverlapComponent(nodesByKey, draggedNodeKey)
  if (!componentKeys.size) {
    return { nextNodesByKey: new Map(nodesByKey), componentKeys }
  }

  const nextNodesByKey = new Map()
  for (const [key, value] of nodesByKey.entries()) {
    nextNodesByKey.set(key, { ...value })
  }

  const dragged = nextNodesByKey.get(draggedNodeKey)
  if (!dragged) return { nextNodesByKey, componentKeys }
  dragged.cy = Number(targetCy)
  dragged.y = dragged.cy - (Number(dragged.h || 0) / 2)

  const ordered = Array.from(componentKeys)
    .map((key) => nextNodesByKey.get(key))
    .filter(Boolean)
    .sort((a, b) => {
      const d = Number(a.cy) - Number(b.cy)
      if (d !== 0) return d
      return String(a.key).localeCompare(String(b.key))
    })

  const dragIndex = ordered.findIndex((node) => node.key === draggedNodeKey)
  if (dragIndex < 0) return { nextNodesByKey, componentKeys }

  for (let i = dragIndex + 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]
    const curr = ordered[i]
    if ((curr.cy - prev.cy) < minCenterGap) {
      curr.cy = prev.cy + minCenterGap
    }
  }
  for (let i = dragIndex - 1; i >= 0; i -= 1) {
    const below = ordered[i + 1]
    const curr = ordered[i]
    if ((below.cy - curr.cy) < minCenterGap) {
      curr.cy = below.cy - minCenterGap
    }
  }

  for (const node of ordered) {
    node.y = node.cy - (Number(node.h || 0) / 2)
    nextNodesByKey.set(node.key, node)
  }

  return { nextNodesByKey, componentKeys }
}

function normalizeNodesForViewport(nodesById, baseSvgHeight) {
  const nodes = Array.from(nodesById.values())
  if (!nodes.length) {
    return {
      nodesById,
      svgHeight: Math.max(220, Number(baseSvgHeight) || 220),
    }
  }

  let minTop = Number.POSITIVE_INFINITY
  let maxBottom = Number.NEGATIVE_INFINITY
  for (const node of nodes) {
    minTop = Math.min(minTop, Number(node.y))
    maxBottom = Math.max(maxBottom, Number(node.y) + Number(node.h || 0))
  }

  const shiftY = minTop < NODE_VIEWPORT_MARGIN ? (NODE_VIEWPORT_MARGIN - minTop) : 0
  const shiftedById = new Map()
  for (const node of nodes) {
    const next = shiftY !== 0
      ? { ...node, y: node.y + shiftY, cy: node.cy + shiftY }
      : node
    shiftedById.set(node.id, next)
  }

  let nextMaxBottom = Number.NEGATIVE_INFINITY
  for (const node of shiftedById.values()) {
    nextMaxBottom = Math.max(nextMaxBottom, Number(node.y) + Number(node.h || 0))
  }
  const baseHeight = Math.max(220, Number(baseSvgHeight) || 220)
  const svgHeight = Math.max(baseHeight, nextMaxBottom + NODE_VIEWPORT_MARGIN)

  return {
    nodesById: shiftedById,
    svgHeight,
  }
}

function buildInteractiveEdges(baseEdges, nodesById, nodeKeyById, edgeOverridesByPair, svgHeight) {
  const edges = []
  const minY = 4
  const maxY = Math.max(minY + 8, Number(svgHeight) - 4)
  for (const baseEdge of Array.isArray(baseEdges) ? baseEdges : []) {
    const fromNode = nodesById.get(baseEdge.from)
    const toNode = nodesById.get(baseEdge.to)
    if (!fromNode || !toNode) continue
    const fromKey = nodeKeyById.get(baseEdge.from) || fromNode.key || baseEdge.from
    const toKey = nodeKeyById.get(baseEdge.to) || toNode.key || baseEdge.to
    const pairKey = `${fromKey}->${toKey}`
    const edgeOverride = edgeOverridesByPair?.[pairKey] || { bendDx: 0, bendDy: 0 }
    const bendDx = Number(edgeOverride?.bendDx || 0)
    const bendDy = Number(edgeOverride?.bendDy || 0)
    const hasManualBend = Math.abs(bendDx) > EDGE_BEND_EPSILON || Math.abs(bendDy) > EDGE_BEND_EPSILON

    let x1 = Number(fromNode.x) + Number(fromNode.w || 0) + EDGE_ENDPOINT_INSET
    let x2 = Number(toNode.x) - EDGE_ENDPOINT_INSET
    const y1 = Number(fromNode.cy)
    const y2 = Number(toNode.cy)
    if ((x2 - x1) < 8) {
      x1 = Number(fromNode.x) + Number(fromNode.w || 0) + 0.5
      x2 = Number(toNode.x) - 0.5
    }

    const endpointDeltaAvg = (((y1 - Number(baseEdge.y1)) + (y2 - Number(baseEdge.y2))) / 2)
    let c1x = Number(baseEdge.c1x) + bendDx
    let c2x = Number(baseEdge.c2x) + bendDx
    let c1y = Number(baseEdge.c1y) + endpointDeltaAvg + bendDy
    let c2y = Number(baseEdge.c2y) + endpointDeltaAvg + bendDy

    // For node-driven relayout (no manual connector bend), keep a single-arch shape
    // so curves do not fall into midpoint S-bends as endpoints move vertically.
    if (!hasManualBend) {
      const baseMinY = Math.min(Number(baseEdge.y1), Number(baseEdge.y2))
      const baseMaxY = Math.max(Number(baseEdge.y1), Number(baseEdge.y2))
      const baseCtrlMidY = (Number(baseEdge.c1y) + Number(baseEdge.c2y)) / 2
      const liveMinY = Math.min(y1, y2)
      const liveMaxY = Math.max(y1, y2)
      const liveDeltaY = Math.abs(y2 - y1)
      const spanX = Math.abs(x2 - x1)

      let archDirection = 0
      if (baseCtrlMidY < (baseMinY - 0.5)) archDirection = -1
      else if (baseCtrlMidY > (baseMaxY + 0.5)) archDirection = 1
      else if (liveDeltaY > 2) archDirection = y1 <= y2 ? -1 : 1

      if (archDirection !== 0 && liveDeltaY > 2) {
        const lift = clamp((liveDeltaY * 0.6) + (spanX * 0.08), 10, 88)
        const archY = archDirection < 0 ? (liveMinY - lift) : (liveMaxY + lift)
        c1y = archY
        c2y = archY
      }
    }

    c1y = clamp(c1y, minY, maxY)
    c2y = clamp(c2y, minY, maxY)

    const pathSpec = { x1, y1, c1x, c1y, c2x, c2y, x2, y2 }
    edges.push({
      ...baseEdge,
      pairKey,
      bendDx,
      bendDy,
      x1,
      y1,
      c1x,
      c1y,
      c2x,
      c2y,
      x2,
      y2,
      pathD: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`,
      arrows: sampleBezierForArrows(pathSpec, 48),
    })
  }
  return edges
}

function cleanupInteractiveState(state, baseCyByKey, validEdgePairKeys) {
  const source = state || emptyInteractiveLayoutState()
  const nextNodes = {}
  for (const [key, value] of Object.entries(source.nodeOverridesByKey || {})) {
    if (!baseCyByKey.has(key)) continue
    const baseCy = Number(baseCyByKey.get(key))
    const overrideCy = Number(value?.cy)
    if (!Number.isFinite(baseCy) || !Number.isFinite(overrideCy)) continue
    if (Math.abs(overrideCy - baseCy) <= NODE_OVERRIDE_EPSILON) continue
    nextNodes[key] = { cy: overrideCy }
  }

  const nextEdges = {}
  for (const [pairKey, value] of Object.entries(source.edgeOverridesByPair || {})) {
    if (validEdgePairKeys && !validEdgePairKeys.has(pairKey)) continue
    const bendDx = Number(value?.bendDx || 0)
    const bendDy = Number(value?.bendDy || 0)
    if (Math.abs(bendDx) <= EDGE_BEND_EPSILON && Math.abs(bendDy) <= EDGE_BEND_EPSILON) continue
    nextEdges[pairKey] = { bendDx, bendDy }
  }

  return {
    nodeOverridesByKey: nextNodes,
    edgeOverridesByPair: nextEdges,
  }
}

function interpolateInteractiveState(fromState, toState, t, baseCyByKey, validEdgePairKeys) {
  const fromNodes = fromState?.nodeOverridesByKey || {}
  const toNodes = toState?.nodeOverridesByKey || {}
  const fromEdges = fromState?.edgeOverridesByPair || {}
  const toEdges = toState?.edgeOverridesByPair || {}

  const outNodes = {}
  const nodeKeys = new Set([...Object.keys(fromNodes), ...Object.keys(toNodes)])
  for (const key of nodeKeys) {
    if (!baseCyByKey.has(key)) continue
    const baseCy = Number(baseCyByKey.get(key))
    if (!Number.isFinite(baseCy)) continue
    const fromCy = Number(fromNodes[key]?.cy)
    const toCy = Number(toNodes[key]?.cy)
    const startCy = Number.isFinite(fromCy) ? fromCy : baseCy
    const endCy = Number.isFinite(toCy) ? toCy : baseCy
    const cy = lerp(startCy, endCy, t)
    if (t >= 1 && !Number.isFinite(toCy)) continue
    outNodes[key] = { cy }
  }

  const outEdges = {}
  const edgeKeys = new Set([...Object.keys(fromEdges), ...Object.keys(toEdges)])
  for (const key of edgeKeys) {
    if (validEdgePairKeys && !validEdgePairKeys.has(key)) continue
    const fromDx = Number(fromEdges[key]?.bendDx || 0)
    const fromDy = Number(fromEdges[key]?.bendDy || 0)
    const toDx = Number(toEdges[key]?.bendDx || 0)
    const toDy = Number(toEdges[key]?.bendDy || 0)
    const bendDx = lerp(fromDx, toDx, t)
    const bendDy = lerp(fromDy, toDy, t)
    if (t >= 1 && !toEdges[key]) continue
    outEdges[key] = { bendDx, bendDy }
  }

  return {
    nodeOverridesByKey: outNodes,
    edgeOverridesByPair: outEdges,
  }
}

function easeOutCubic(t) {
  const clamped = clamp(Number(t) || 0, 0, 1)
  return 1 - ((1 - clamped) ** 3)
}

function emptyDragState() {
  return {
    kind: '',
    nodeId: '',
    nodeKey: '',
    edgeId: '',
    edgePairKey: '',
    pointerId: null,
    startX: 0,
    startY: 0,
    startCy: 0,
    startBendDx: 0,
    startBendDy: 0,
    active: false,
  }
}

function classLabel(cls) {
  if (cls === 'coding') return 'coding'
  if (cls === 'partial') return 'partial'
  return 'non-coding'
}

function formatCoord(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString()
}

function nodeStateClass(nodeCls) {
  if (nodeCls === 'partial') return 'partial_coding'
  if (nodeCls === 'coding') return 'coding'
  return 'non_coding'
}

function buildNodeExonStateKey(node, geneChrom, geneStrand) {
  if (!node) return ''
  const start = Math.min(Number(node.fivePrime), Number(node.threePrime))
  const end = Math.max(Number(node.fivePrime), Number(node.threePrime))
  if (!Number.isFinite(start) || !Number.isFinite(end)) return ''
  const strand = String(node.strand || geneStrand || '+')
  const chrom = String(node.chrom || geneChrom || '')
  const stateClass = nodeStateClass(node.cls)
  const codingSegments = stateClass === 'partial_coding'
    ? (Array.isArray(node.codingSegments) ? node.codingSegments : []).map((seg) => ({
      start: Math.min(Number(seg.fivePrime), Number(seg.threePrime)),
      end: Math.max(Number(seg.fivePrime), Number(seg.threePrime)),
    }))
    : []
  return makeExonStateKey({
    chrom,
    start,
    end,
    strand,
    stateClass,
    codingSegments,
  })
}

export default function TranscriptSplicingHeatmap({
  activeTranscripts = [],
  reverseOrientation = false,
  theme = 'dark',
  onSelectionChange = null,
  onGraphPointerDown = null,
  clearSelectionSignal = 0,
  focusedTranscriptId = '',
  layoutSessionKey = '',
  geneChrom = '',
  geneStrand = '+',
  onSelectedExonStateKeyChange = null,
}) {
  const isLight = theme === 'light'
  const sessionKey = String(layoutSessionKey || '').trim()
  const [collapsed, setCollapsed] = useState(false)
  const [hoveredNodeId, setHoveredNodeId] = useState('')
  const [hoveredEdgeId, setHoveredEdgeId] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [committedInteractiveState, setCommittedInteractiveState] = useState(() => emptyInteractiveLayoutState())
  const [displayInteractiveState, setDisplayInteractiveState] = useState(() => emptyInteractiveLayoutState())
  const [dragState, setDragState] = useState(() => emptyDragState())
  const viewportRef = useRef(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const displayInteractiveRef = useRef(displayInteractiveState)
  const committedInteractiveRef = useRef(committedInteractiveState)
  const dragStateRef = useRef(dragState)
  const suppressNextClickRef = useRef(false)
  const animationFrameRef = useRef(0)
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return undefined
    const measure = () => setViewportWidth(el.clientWidth || 0)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const model = useMemo(
    () => buildSplicingHeatmapModel(activeTranscripts, reverseOrientation),
    [activeTranscripts, reverseOrientation]
  )

  const layout = useMemo(
    () => layoutSplicingHeatmap(model, viewportWidth, { minHeight: 220 }),
    [model, viewportWidth]
  )

  const nodeKeyById = useMemo(
    () => new Map(model.nodes.map((node) => [node.id, node.key])),
    [model.nodes]
  )
  const nodeExonStateKeyById = useMemo(() => {
    const map = new Map()
    for (const node of model.nodes) {
      map.set(node.id, buildNodeExonStateKey(node, geneChrom, geneStrand))
    }
    return map
  }, [model.nodes, geneChrom, geneStrand])
  const edgePairKeyById = useMemo(() => {
    const map = new Map()
    for (const edge of model.edges) {
      const fromKey = nodeKeyById.get(edge.from) || edge.from
      const toKey = nodeKeyById.get(edge.to) || edge.to
      map.set(edge.id, `${fromKey}->${toKey}`)
    }
    return map
  }, [model.edges, nodeKeyById])
  const validEdgePairKeys = useMemo(
    () => new Set(Array.from(edgePairKeyById.values()).filter(Boolean)),
    [edgePairKeyById]
  )
  const baseCyByKey = useMemo(
    () => buildBaseCyByKey(layout.nodes, nodeKeyById),
    [layout.nodes, nodeKeyById]
  )

  useEffect(() => {
    displayInteractiveRef.current = displayInteractiveState
  }, [displayInteractiveState])
  useEffect(() => {
    committedInteractiveRef.current = committedInteractiveState
  }, [committedInteractiveState])
  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  const stopLayoutAnimation = useCallback(() => {
    if (!animationFrameRef.current) return
    cancelAnimationFrame(animationFrameRef.current)
    animationFrameRef.current = 0
  }, [])

  const animateDisplayStateTo = useCallback((targetState, fromState = null, durationMs = 180) => {
    stopLayoutAnimation()
    const startState = cloneInteractiveLayoutState(fromState || displayInteractiveRef.current)
    const endState = cloneInteractiveLayoutState(targetState)
    const startTime = performance.now()

    const step = (now) => {
      const elapsed = now - startTime
      const tRaw = durationMs <= 0 ? 1 : clamp(elapsed / durationMs, 0, 1)
      const eased = easeOutCubic(tRaw)
      const interpolated = interpolateInteractiveState(
        startState,
        endState,
        eased,
        baseCyByKey,
        validEdgePairKeys
      )
      setDisplayInteractiveState(interpolated)
      if (tRaw >= 1) {
        animationFrameRef.current = 0
        setDisplayInteractiveState(endState)
        return
      }
      animationFrameRef.current = requestAnimationFrame(step)
    }

    animationFrameRef.current = requestAnimationFrame(step)
  }, [baseCyByKey, validEdgePairKeys, stopLayoutAnimation])

  useEffect(() => () => stopLayoutAnimation(), [stopLayoutAnimation])

  useEffect(() => {
    const cached = sessionKey ? spliceLayoutSessionCache.get(sessionKey) : null
    const nextState = cloneInteractiveLayoutState(cached || emptyInteractiveLayoutState())
    stopLayoutAnimation()
    setCommittedInteractiveState(nextState)
    setDisplayInteractiveState(nextState)
    setDragState(emptyDragState())
  }, [sessionKey, stopLayoutAnimation])

  useEffect(() => {
    if (!sessionKey) return
    spliceLayoutSessionCache.set(sessionKey, cloneInteractiveLayoutState(committedInteractiveState))
  }, [sessionKey, committedInteractiveState])

  useEffect(() => {
    const cleanedCommitted = cleanupInteractiveState(committedInteractiveRef.current, baseCyByKey, validEdgePairKeys)
    if (!layoutStateEquals(cleanedCommitted, committedInteractiveRef.current)) {
      setCommittedInteractiveState(cleanedCommitted)
    }
    if (!dragStateRef.current.kind) {
      const cleanedDisplay = cleanupInteractiveState(displayInteractiveRef.current, baseCyByKey, validEdgePairKeys)
      if (!layoutStateEquals(cleanedDisplay, displayInteractiveRef.current)) {
        setDisplayInteractiveState(cleanedDisplay)
      }
    }
  }, [baseCyByKey, validEdgePairKeys])

  useEffect(() => {
    if (!selectedNodeId) return
    if (!model.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId('')
    }
  }, [model.nodes, selectedNodeId])

  useEffect(() => {
    setSelectedNodeId('')
  }, [clearSelectionSignal])

  const selectionState = useMemo(() => {
    if (!selectedNodeId) {
      return {
        hasSelection: false,
        nodeIds: new Set(),
        edgeIds: new Set(),
      }
    }
    const nodeIdsInModel = new Set(model.nodes.map((node) => node.id))
    if (!nodeIdsInModel.has(selectedNodeId)) {
      return {
        hasSelection: false,
        nodeIds: new Set(),
        edgeIds: new Set(),
      }
    }

    const outgoing = new Map()
    const incoming = new Map()
    for (const edge of model.edges) {
      const out = outgoing.get(edge.from) || []
      out.push(edge)
      outgoing.set(edge.from, out)
      const inc = incoming.get(edge.to) || []
      inc.push(edge)
      incoming.set(edge.to, inc)
    }

    const reachable = new Set([selectedNodeId])
    const forwardQueue = [selectedNodeId]
    while (forwardQueue.length) {
      const id = forwardQueue.shift()
      const nextEdges = outgoing.get(id) || []
      for (const edge of nextEdges) {
        if (!reachable.has(edge.to)) {
          reachable.add(edge.to)
          forwardQueue.push(edge.to)
        }
      }
    }

    const terminalNodeIds = model.nodes
      .filter((node) => (outgoing.get(node.id) || []).length === 0)
      .map((node) => node.id)

    const canReachTerminal = new Set(terminalNodeIds)
    const reverseQueue = [...terminalNodeIds]
    while (reverseQueue.length) {
      const id = reverseQueue.shift()
      const prevEdges = incoming.get(id) || []
      for (const edge of prevEdges) {
        if (!canReachTerminal.has(edge.from)) {
          canReachTerminal.add(edge.from)
          reverseQueue.push(edge.from)
        }
      }
    }

    const selectedNodes = new Set([selectedNodeId])
    const selectedEdges = new Set()
    for (const edge of model.edges) {
      const onForwardPath = reachable.has(edge.from) && reachable.has(edge.to)
      const reachesTerminal = canReachTerminal.has(edge.to)
      if (!onForwardPath || !reachesTerminal) continue
      selectedEdges.add(edge.id)
      selectedNodes.add(edge.from)
      selectedNodes.add(edge.to)
    }

    return {
      hasSelection: true,
      nodeIds: selectedNodes,
      edgeIds: selectedEdges,
    }
  }, [model.edges, model.nodes, selectedNodeId])

  const selectionProjection = useMemo(() => {
    if (!selectionState.hasSelection || !selectedNodeId) {
      return {
        hasSelection: false,
        selectedNodeId: '',
      selectedTranscriptIds: [],
      byTranscript: {},
    }
    }

    const nodeById = new Map(model.nodes.map((node) => [node.id, node]))
    const nodeIdByKey = new Map(model.nodes.map((node) => [node.key, node.id]))
    const selectedEdgePairKeys = new Set(
      model.edges
        .filter((edge) => selectionState.edgeIds.has(edge.id))
        .map((edge) => `${edge.from}->${edge.to}`)
    )

    const selectedTranscriptIds = []
    const byTranscript = {}

    for (const tx of activeTranscripts) {
      const instances = buildExonInstances(tx, reverseOrientation)
      const pathNodeIds = []
      for (const instance of instances) {
        const id = nodeIdByKey.get(nodeKey(instance))
        if (!id) continue
        if (pathNodeIds[pathNodeIds.length - 1] !== id) {
          pathNodeIds.push(id)
        }
      }
      if (!pathNodeIds.length) continue

      let pathStartIndex = -1
      for (let i = 0; i < pathNodeIds.length; i += 1) {
        if (pathNodeIds[i] !== selectedNodeId) continue
        let validSuffix = true
        for (let j = i; j < pathNodeIds.length - 1; j += 1) {
          if (!selectedEdgePairKeys.has(`${pathNodeIds[j]}->${pathNodeIds[j + 1]}`)) {
            validSuffix = false
            break
          }
        }
        if (validSuffix) {
          pathStartIndex = i
          break
        }
      }
      if (pathStartIndex < 0) continue

      const highlightedExonKeys = []
      const prePathExonKeys = []
      const highlightedIntronKeys = []

      for (let i = 0; i < pathNodeIds.length; i += 1) {
        const node = nodeById.get(pathNodeIds[i])
        if (!node) continue
        const key = exonKey(node.fivePrime, node.threePrime)
        if (i < pathStartIndex) prePathExonKeys.push(key)
        else highlightedExonKeys.push(key)

        if (i >= pathStartIndex && i < pathNodeIds.length - 1) {
          const nextNode = nodeById.get(pathNodeIds[i + 1])
          if (!nextNode) continue
          const iKey = intronKey(node.threePrime, nextNode.fivePrime)
          if (iKey) highlightedIntronKeys.push(iKey)
        }
      }

      selectedTranscriptIds.push(tx.id)
      byTranscript[tx.id] = {
        highlightedExonKeys: Array.from(new Set(highlightedExonKeys)),
        prePathExonKeys: Array.from(new Set(prePathExonKeys)),
        highlightedIntronKeys: Array.from(new Set(highlightedIntronKeys)),
        pathNodeIds: [...pathNodeIds.slice(pathStartIndex)],
        pathEdgePairKeys: pathNodeIds
          .slice(pathStartIndex)
          .slice(0, -1)
          .map((fromNodeId, idx) => `${fromNodeId}->${pathNodeIds[pathStartIndex + idx + 1]}`),
      }
    }

    return {
      hasSelection: true,
      selectedNodeId,
      selectedTranscriptIds,
      byTranscript,
    }
  }, [selectionState, selectedNodeId, model.nodes, model.edges, activeTranscripts, reverseOrientation])

  const effectiveSelectionState = useMemo(() => {
    if (!selectionState.hasSelection) return selectionState
    const txId = String(focusedTranscriptId || '').trim()
    if (!txId) return selectionState
    const txProjection = selectionProjection.byTranscript?.[txId]
    if (!txProjection) return selectionState
    const pairKeys = new Set(Array.isArray(txProjection.pathEdgePairKeys) ? txProjection.pathEdgePairKeys : [])
    const focusedEdgeIds = new Set(
      model.edges
        .filter((edge) => pairKeys.has(`${edge.from}->${edge.to}`))
        .map((edge) => edge.id)
    )
    return {
      hasSelection: true,
      nodeIds: new Set(Array.isArray(txProjection.pathNodeIds) ? txProjection.pathNodeIds : []),
      edgeIds: focusedEdgeIds,
    }
  }, [selectionState, selectionProjection, focusedTranscriptId, model.edges])

  const renderedLayout = useMemo(() => {
    const cleanedDisplay = cleanupInteractiveState(displayInteractiveState, baseCyByKey, validEdgePairKeys)
    const { nodesById } = applyInteractiveNodePositions(layout.nodes, nodeKeyById, cleanedDisplay.nodeOverridesByKey)
    const normalized = normalizeNodesForViewport(nodesById, layout.svgHeight)
    const edges = buildInteractiveEdges(
      layout.edges,
      normalized.nodesById,
      nodeKeyById,
      cleanedDisplay.edgeOverridesByPair,
      normalized.svgHeight
    )
    return {
      ...layout,
      nodes: Array.from(normalized.nodesById.values()),
      edges,
      svgHeight: normalized.svgHeight,
    }
  }, [layout, displayInteractiveState, baseCyByKey, validEdgePairKeys, nodeKeyById])

  const commitNodeDragState = useCallback((nodeKey, sourceState) => {
    const cleaned = cleanupInteractiveState(sourceState, baseCyByKey, validEdgePairKeys)
    const { nodesByKey } = applyInteractiveNodePositions(layout.nodes, nodeKeyById, cleaned.nodeOverridesByKey)
    const dragged = nodesByKey.get(nodeKey)
    if (!dragged) return cleaned
    const { nextNodesByKey, componentKeys } = reflowOverlapCluster(nodesByKey, nodeKey, dragged.cy, MIN_CENTER_GAP)
    const nextNodeOverrides = { ...cleaned.nodeOverridesByKey }
    for (const key of componentKeys) {
      const node = nextNodesByKey.get(key)
      if (!node) continue
      nextNodeOverrides[key] = { cy: Number(node.cy) }
    }
    return cleanupInteractiveState(
      {
        nodeOverridesByKey: nextNodeOverrides,
        edgeOverridesByPair: { ...cleaned.edgeOverridesByPair },
      },
      baseCyByKey,
      validEdgePairKeys
    )
  }, [baseCyByKey, validEdgePairKeys, layout.nodes, nodeKeyById])

  const handleNodePointerDown = useCallback((event, node) => {
    if (!effectiveSelectionState.hasSelection || !effectiveSelectionState.nodeIds.has(node.id)) return
    const pointerId = event?.pointerId
    if (typeof pointerId !== 'number') return
    event.preventDefault()
    event.stopPropagation()
    stopLayoutAnimation()
    setHoveredNodeId('')
    setHoveredEdgeId('')
    const nodeKey = node.key || nodeKeyById.get(node.id) || node.id
    const overrideCy = Number(displayInteractiveRef.current?.nodeOverridesByKey?.[nodeKey]?.cy)
    const startCy = Number.isFinite(overrideCy) ? overrideCy : Number(node.cy)
    setDragState({
      kind: 'node',
      nodeId: node.id,
      nodeKey,
      edgeId: '',
      edgePairKey: '',
      pointerId,
      startX: Number(event.clientX),
      startY: Number(event.clientY),
      startCy,
      startBendDx: 0,
      startBendDy: 0,
      active: false,
    })
  }, [effectiveSelectionState, nodeKeyById, stopLayoutAnimation])

  const handleEdgePointerDown = useCallback((event, edge) => {
    if (!effectiveSelectionState.hasSelection || !effectiveSelectionState.edgeIds.has(edge.id)) return
    const pointerId = event?.pointerId
    if (typeof pointerId !== 'number') return
    event.preventDefault()
    event.stopPropagation()
    stopLayoutAnimation()
    setHoveredNodeId('')
    setHoveredEdgeId('')
    const pairKey = String(edge?.pairKey || edgePairKeyById.get(edge.id) || '').trim()
    if (!pairKey) return
    const override = displayInteractiveRef.current?.edgeOverridesByPair?.[pairKey] || { bendDx: 0, bendDy: 0 }
    setDragState({
      kind: 'edge',
      nodeId: '',
      nodeKey: '',
      edgeId: edge.id,
      edgePairKey: pairKey,
      pointerId,
      startX: Number(event.clientX),
      startY: Number(event.clientY),
      startCy: 0,
      startBendDx: Number(override?.bendDx || 0),
      startBendDy: Number(override?.bendDy || 0),
      active: false,
    })
  }, [effectiveSelectionState, edgePairKeyById, stopLayoutAnimation])

  const handleResetLayout = useCallback(() => {
    const fromState = cloneInteractiveLayoutState(displayInteractiveRef.current)
    const emptyState = emptyInteractiveLayoutState()
    stopLayoutAnimation()
    setCommittedInteractiveState(emptyState)
    if (sessionKey) spliceLayoutSessionCache.delete(sessionKey)
    animateDisplayStateTo(emptyState, fromState, 180)
  }, [animateDisplayStateTo, sessionKey, stopLayoutAnimation])

  useEffect(() => {
    const activeDrag = dragState.kind ? dragState : null
    if (!activeDrag) return undefined

    const handlePointerMove = (event) => {
      const current = dragStateRef.current
      if (!current.kind) return
      if (current.pointerId !== null && event.pointerId !== current.pointerId) return
      const dx = Number(event.clientX) - Number(current.startX)
      const dy = Number(event.clientY) - Number(current.startY)
      const distance = Math.hypot(dx, dy)
      if (!current.active && distance < DRAG_THRESHOLD_PX) return
      if (!current.active) {
        setDragState((prev) => ({ ...prev, active: true }))
        trackAchievement('fe.dragGraph')
      }
      if (current.kind === 'node' && current.nodeKey) {
        const nextCy = Number(current.startCy) + dy
        setDisplayInteractiveState((prev) => ({
          ...prev,
          nodeOverridesByKey: {
            ...prev.nodeOverridesByKey,
            [current.nodeKey]: { cy: nextCy },
          },
        }))
      } else if (current.kind === 'edge' && current.edgePairKey) {
        const nextDx = Number(current.startBendDx) + dx
        const nextDy = Number(current.startBendDy) + dy
        setDisplayInteractiveState((prev) => ({
          ...prev,
          edgeOverridesByPair: {
            ...prev.edgeOverridesByPair,
            [current.edgePairKey]: { bendDx: nextDx, bendDy: nextDy },
          },
        }))
      }
    }

    const finalizeDrag = (event, cancelled = false) => {
      const current = dragStateRef.current
      if (!current.kind) return
      if (current.pointerId !== null && event?.pointerId !== undefined && event.pointerId !== current.pointerId) return
      const fromState = cloneInteractiveLayoutState(displayInteractiveRef.current)

      if (current.active && !cancelled) {
        let nextCommitted = cleanupInteractiveState(fromState, baseCyByKey, validEdgePairKeys)
        if (current.kind === 'node' && current.nodeKey) {
          nextCommitted = commitNodeDragState(current.nodeKey, fromState)
        }
        setCommittedInteractiveState(nextCommitted)
        animateDisplayStateTo(nextCommitted, fromState, 180)
        suppressNextClickRef.current = true
      } else {
        setDisplayInteractiveState(cloneInteractiveLayoutState(committedInteractiveRef.current))
      }

      setDragState(emptyDragState())
    }

    const handlePointerCancel = (event) => finalizeDrag(event, true)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finalizeDrag)
    window.addEventListener('pointercancel', handlePointerCancel)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finalizeDrag)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }, [dragState, animateDisplayStateTo, baseCyByKey, validEdgePairKeys, commitNodeDragState])

  useEffect(() => {
    if (typeof onSelectionChange !== 'function') return
    onSelectionChange(selectionProjection)
  }, [onSelectionChange, selectionProjection])

  const hasData = model.transcriptCount > 0 && renderedLayout.nodes.length > 0
  const hasManualLayout = Object.keys(committedInteractiveState.nodeOverridesByKey || {}).length > 0
    || Object.keys(committedInteractiveState.edgeOverridesByPair || {}).length > 0

  const nodeLegendBase = isLight ? '#334155' : '#cbd5e1'
  const edgeBaseStroke = isLight ? '#64748b' : '#94a3b8'

  return (
    <div data-splice-heatmap-root="true" className={`mt-3 rounded-xl border ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-800'}`}>
      {!collapsed && (
        <div className="px-3 py-3">
          <div
            ref={viewportRef}
            data-splice-heatmap-viewport="true"
            className={`rounded-lg border min-h-[220px] ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/35'}`}
          >
            {!hasData ? (
              <div className={`h-[220px] flex items-center justify-center text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                Activate at least one transcript to render the splicing heatmap.
              </div>
            ) : (
              <div data-splice-heatmap-scroll="true" className="overflow-x-auto">
                <svg
                  data-splice-heatmap-graphic="true"
                  width={renderedLayout.svgWidth}
                  height={renderedLayout.svgHeight}
                  onMouseDownCapture={() => {
                    if (typeof onGraphPointerDown === 'function') {
                      onGraphPointerDown()
                    }
                  }}
                  onClick={() => {
                    if (suppressNextClickRef.current) {
                      suppressNextClickRef.current = false
                      return
                    }
                    setSelectedNodeId('')
                    if (typeof onSelectedExonStateKeyChange === 'function') {
                      onSelectedExonStateKeyChange('')
                    }
                  }}
                >
                  {renderedLayout.edges.map((edge) => {
                    const edgeHovered = hoveredEdgeId === edge.id
                    const linkedNodeHover = hoveredNodeId && (edge.from === hoveredNodeId || edge.to === hoveredNodeId)
                    const selected = effectiveSelectionState.hasSelection && effectiveSelectionState.edgeIds.has(edge.id)
                    const draggable = selected
                    const active = edgeHovered || linkedNodeHover || selected
                    const dimmed = effectiveSelectionState.hasSelection && !selected
                    const strokeOpacity = clamp((0.18 + (0.62 * edge.supportFraction)) * (dimmed ? 0.12 : 1), 0.04, 1)
                    const strokeWidth = (1 + (4 * edge.supportFraction)) + (active ? 1.6 : 0)
                    return (
                      <g
                        key={edge.id}
                        onMouseEnter={() => {
                          if (dragStateRef.current.kind) return
                          setHoveredEdgeId(edge.id)
                        }}
                        onMouseLeave={() => {
                          if (dragStateRef.current.kind) return
                          setHoveredEdgeId('')
                        }}
                      >
                        <path
                          d={edge.pathD}
                          fill="none"
                          stroke={edgeBaseStroke}
                          strokeOpacity={strokeOpacity}
                          strokeWidth={strokeWidth}
                          strokeLinecap="round"
                        >
                          <title>{`Junction support: ${edge.supportCount}/${model.transcriptCount}`}</title>
                        </path>
                        {edge.arrows.map((arrow, idx) => (
                          <path
                            key={`${edge.id}-arrow-${idx}`}
                            d="M -3 -2.2 L 0 0 L -3 2.2"
                            transform={`translate(${arrow.x} ${arrow.y}) rotate(${(arrow.angle * 180) / Math.PI})`}
                            fill="none"
                            stroke={edgeBaseStroke}
                            strokeOpacity={strokeOpacity * (active ? 1 : 0.8)}
                            strokeWidth={active ? 1.25 : 1}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        ))}
                        <path
                          d={edge.pathD}
                          fill="none"
                          stroke="rgba(0,0,0,0.001)"
                          strokeWidth={14}
                          strokeLinecap="round"
                          pointerEvents="stroke"
                          onPointerDown={(event) => {
                            if (!draggable) return
                            event.currentTarget?.setPointerCapture?.(event.pointerId)
                            handleEdgePointerDown(event, edge)
                          }}
                          style={{
                            cursor: draggable
                              ? ((dragState.kind === 'edge' && dragState.edgeId === edge.id && dragState.active) ? 'grabbing' : 'grab')
                              : 'default',
                          }}
                        />
                      </g>
                    )
                  })}

                  {renderedLayout.nodes.map((node) => {
                    const color = heatColorFromFraction(node.supportFraction)
                    const nodeHovered = hoveredNodeId === node.id
                    const linkedEdgeHover = hoveredEdgeId
                      && renderedLayout.edges.some((edge) => edge.id === hoveredEdgeId && (edge.from === node.id || edge.to === node.id))
                    const selected = effectiveSelectionState.hasSelection && effectiveSelectionState.nodeIds.has(node.id)
                    const draggable = selected
                    const active = nodeHovered || linkedEdgeHover || selected
                    const dimmed = effectiveSelectionState.hasSelection && !selected
                    const opacity = dimmed ? 0.22 : 1
                    const strokeWidth = active ? 2.6 : 1.3
                    const span = Math.max(1e-9, node.axisEnd - node.axisStart)
                    return (
                      <g
                        key={node.id}
                        onMouseEnter={() => {
                          if (dragStateRef.current.kind) return
                          setHoveredNodeId(node.id)
                        }}
                        onMouseLeave={() => {
                          if (dragStateRef.current.kind) return
                          setHoveredNodeId('')
                        }}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (suppressNextClickRef.current) {
                            suppressNextClickRef.current = false
                            return
                          }
                          setSelectedNodeId((prev) => {
                            const nextNodeId = prev === node.id ? '' : node.id
                            if (typeof onSelectedExonStateKeyChange === 'function') {
                              const nextKey = nextNodeId ? String(nodeExonStateKeyById.get(nextNodeId) || '') : ''
                              onSelectedExonStateKeyChange(nextKey)
                            }
                            return nextNodeId
                          })
                        }}
                        style={{ cursor: selected ? 'grab' : 'pointer', opacity }}
                      >
                        {node.cls === 'coding' && (
                          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx={2.5} fill={color} fillOpacity={active ? 0.62 : 0.45} />
                        )}
                        {node.cls === 'partial' && (
                          <>
                            {node.codingSegments.map((seg, idx) => {
                              const segStart = Math.min(seg.axisStart, seg.axisEnd)
                              const segEnd = Math.max(seg.axisStart, seg.axisEnd)
                              const sx = node.x + (((segStart - node.axisStart) / span) * node.w)
                              const sw = Math.max(1.5, ((segEnd - segStart) / span) * node.w)
                              return (
                                <rect
                                  key={`${node.id}-partial-${idx}`}
                                  x={sx}
                                  y={node.y}
                                  width={sw}
                                  height={node.h}
                                  rx={2}
                                  fill={color}
                                  fillOpacity={active ? 0.95 : 0.8}
                                />
                              )
                            })}
                          </>
                        )}
                        <rect
                          x={node.x}
                          y={node.y}
                          width={node.w}
                          height={node.h}
                          rx={2.5}
                          fill={node.cls === 'non_coding' ? 'none' : 'transparent'}
                          stroke={color}
                          strokeWidth={strokeWidth}
                        >
                          <title>{`${classLabel(node.cls)} exon ${formatCoord(node.fivePrime)}-${formatCoord(node.threePrime)} | support ${node.supportCount}/${model.transcriptCount} (click to lock downstream paths)`}</title>
                        </rect>
                        <rect
                          x={node.x}
                          y={node.y}
                          width={node.w}
                          height={node.h}
                          rx={2.5}
                          fill="rgba(0,0,0,0.001)"
                          stroke="none"
                          pointerEvents="all"
                          onPointerDown={(event) => {
                            if (!draggable) return
                            event.currentTarget?.setPointerCapture?.(event.pointerId)
                            handleNodePointerDown(event, node)
                          }}
                        />
                      </g>
                    )
                  })}
                </svg>
              </div>
            )}
          </div>
        </div>
      )}

      <div
        data-splice-heatmap-footer="true"
        role="button"
        tabIndex={0}
        onClick={toggleCollapsed}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggleCollapsed()
          }
        }}
        className={`px-3 py-2 flex items-end justify-between gap-3 cursor-pointer select-none ${collapsed ? '' : (isLight ? 'border-t border-gray-200' : 'border-t border-gray-700')}`}
      >
        {collapsed ? (
          <div className={`text-xs ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
            Transcript splicing heatmap - Click the arrow to expand
          </div>
        ) : (
          <div className={`text-[11px] flex flex-wrap items-center gap-x-4 gap-y-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
            <span className={`text-xs font-semibold whitespace-nowrap ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
              Transcript splicing heatmap
            </span>
            <span className="inline-flex items-center gap-2">
              <span className={`text-[10px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>rare</span>
              <span
                className="h-2.5 w-28 rounded-full border"
                style={{
                  borderColor: isLight ? '#cbd5e1' : '#475569',
                  background: 'linear-gradient(90deg, #3b82f6 0%, #8b5cf6 33%, #f59e0b 66%, #ef4444 100%)',
                }}
              />
              <span className={`text-[10px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>common</span>
            </span>
            <span className={`inline-flex items-center gap-1.5 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
              <span className="inline-block w-3 h-3 rounded-sm border" style={{ borderColor: nodeLegendBase }} />
              non-coding (outline)
            </span>
            <span className={`inline-flex items-center gap-1.5 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
              <span className="inline-block w-3 h-3 rounded-sm border" style={{ backgroundColor: '#8b5cf6', borderColor: '#8b5cf6' }} />
              coding (filled)
            </span>
            <span className={`inline-flex items-center gap-1.5 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
              <span className="inline-block w-3 h-3 rounded-sm border" style={{ borderColor: '#f59e0b', background: 'linear-gradient(90deg, rgba(245,158,11,0.85) 45%, transparent 45%)' }} />
              partial (overlay split)
            </span>
            <span>Curves are deduplicated splice junctions (width/opacity by support).</span>
            <span>Click an exon to lock downstream 5&apos;&rarr;3&apos; paths; click empty space to clear.</span>
          </div>
        )}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              handleResetLayout()
            }}
            disabled={!hasManualLayout}
            className={`min-w-[92px] px-2.5 h-7 rounded border inline-flex items-center justify-center whitespace-nowrap text-[11px] font-semibold transition-colors ${
              hasManualLayout
                ? (isLight
                  ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                  : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600')
                : (isLight
                  ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                  : 'bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed')
            }`}
            title={hasManualLayout ? 'Reset manual exon/connector layout for this gene context' : 'No manual layout adjustments to reset'}
          >
            Reset layout
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              toggleCollapsed()
            }}
            className={`w-7 h-7 mb-0.5 rounded border flex items-center justify-center transition-colors shrink-0 ${isLight
              ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
              : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
              }`}
            title={collapsed ? 'Expand splicing heatmap' : 'Collapse splicing heatmap'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              {collapsed ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
