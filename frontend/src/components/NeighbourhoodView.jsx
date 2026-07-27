import { useState, useEffect, useRef, useMemo, useCallback, Component } from 'react'
import iconResetRaw from '../assets/icons/icon_reset.svg?raw'
import { getGenomeKey } from '../utils/genomeIdentity'

const GENE_WIDTH = 94
const GENE_HEIGHT = 20
const GENE_GAP = 12
const GENE_FULL_WIDTH = GENE_WIDTH + GENE_GAP
const ROW_HEIGHT = 118
const CONTROL_ROW_HEIGHT = 106
const CONTROL_ROW_GAP = 12
const DISPLAY_FLANK_GENES_PER_SIDE = Number.POSITIVE_INFINITY
const TOP_PADDING = 34
const BOTTOM_PADDING = 28

const extractPathData = (svgRaw) => {
  if (typeof svgRaw !== 'string') return ''
  const match = svgRaw.replace(/\s+/g, ' ').match(/<path[^>]*\sd=(['"])(.*?)\1/i)
  return match?.[2] || ''
}
const RESET_ICON_PATH_D = extractPathData(iconResetRaw)

function speciesItemKey(species) {
  return getGenomeKey(species)
}

function formatSpeciesLabel(species) {
  if (!species) return ''
  const name = species.display_name || species.common_name || species.scientific_name || species.species_key || 'Genome'
  const assembly = species.assembly_name || species.assembly || ''
  return assembly ? `${name} - ${assembly}` : name
}

function invertStrand(strand) {
  return String(strand || '+') === '-' ? '+' : '-'
}

function getGenePath(x, y, width, height, strand) {
  const arrowWidth = Math.min(width, 10)
  if (String(strand || '+') === '+') {
    return `M${x},${y} L${x + width - arrowWidth},${y} L${x + width},${y + height / 2} L${x + width - arrowWidth},${y + height} L${x},${y + height} Z`
  }
  return `M${x + arrowWidth},${y} L${x + width},${y} L${x + width},${y + height} L${x + arrowWidth},${y + height} L${x},${y + height / 2} Z`
}

function normalizeGenes(rawGenes) {
  if (!Array.isArray(rawGenes)) return []
  return [...rawGenes]
    .filter(Boolean)
    .sort((a, b) => {
      const aStart = Number(a?.start || 0)
      const bStart = Number(b?.start || 0)
      if (aStart !== bStart) return aStart - bStart
      return String(a?.id || '').localeCompare(String(b?.id || ''))
    })
}

function normalizeGeneToken(value) {
  return String(value || '').trim().toLowerCase()
}

function formatHomologyType(rawType) {
  const raw = String(rawType || '').trim().toLowerCase()
  if (raw === 'homolog_rbbh') return 'RBH'
  if (raw === 'homolog_bbh') return 'Regular'
  return String(rawType || '') || 'Unknown'
}

function classifyGeneBiotypeClass(biotypeRaw) {
  const biotype = normalizeGeneToken(String(biotypeRaw || '').replace(/-/g, '_'))
  if (!biotype) return 'protein_coding'
  if (biotype.includes('pseudogene')) return 'pseudogene'
  if (biotype === 'protein_coding') return 'protein_coding'
  if (
    biotype.includes('lnc')
    || biotype.includes('linc')
    || biotype.includes('long_non')
    || biotype === 'antisense'
    || biotype === 'sense_intronic'
    || biotype === 'sense_overlapping'
    || biotype === 'processed_transcript'
  ) return 'long_non_coding'
  if (
    biotype.includes('mirna')
    || biotype.includes('snrna')
    || biotype.includes('snorna')
    || biotype.includes('rrna')
    || biotype.includes('trna')
    || biotype.includes('srp')
    || biotype.includes('scrna')
    || biotype.includes('misc_rna')
    || biotype.includes('ncrna')
    || biotype.includes('ribozyme')
    || biotype.includes('vault_rna')
  ) return 'small_non_coding'
  if (biotype.includes('rna')) return 'small_non_coding'
  return 'protein_coding'
}

function genePassesBiotypeFilter(gene, filters) {
  const biotypeClass = classifyGeneBiotypeClass(gene?.biotype)
  if (biotypeClass === 'protein_coding') return Boolean(filters?.proteinCoding)
  if (biotypeClass === 'long_non_coding') return Boolean(filters?.longNonCoding)
  if (biotypeClass === 'pseudogene') return Boolean(filters?.pseudogene)
  if (biotypeClass === 'small_non_coding') return Boolean(filters?.smallNonCoding)
  return true
}

function buildDisplayGenesWithBalancedFlanks(allGenesRaw, centerGeneId, filters, flankPerSide = DISPLAY_FLANK_GENES_PER_SIDE) {
  const allGenes = normalizeGenes(allGenesRaw)
  if (!allGenes.length) return []
  const normalizedCenterId = String(centerGeneId || '').trim()

  let centerIndex = normalizedCenterId
    ? allGenes.findIndex((gene) => String(gene?.id || '').trim() === normalizedCenterId)
    : -1
  if (centerIndex < 0) centerIndex = allGenes.findIndex((gene) => Boolean(gene?.is_focal))
  if (centerIndex < 0) centerIndex = Math.floor((allGenes.length - 1) / 2)

  const centerGene = allGenes[centerIndex]
  const centerId = String(centerGene?.id || normalizedCenterId || '').trim()
  const includeGene = (gene) => {
    const geneId = String(gene?.id || '').trim()
    if (geneId && geneId === centerId) return true
    if (gene?.is_focal) return true
    return genePassesBiotypeFilter(gene, filters)
  }

  const left = []
  for (let idx = centerIndex - 1; idx >= 0; idx -= 1) {
    const gene = allGenes[idx]
    if (!includeGene(gene)) continue
    left.push(gene)
    if (left.length >= flankPerSide) break
  }
  left.reverse()

  const right = []
  for (let idx = centerIndex + 1; idx < allGenes.length; idx += 1) {
    const gene = allGenes[idx]
    if (!includeGene(gene)) continue
    right.push(gene)
    if (right.length >= flankPerSide) break
  }

  const out = []
  for (const gene of left) out.push(gene)
  if (centerGene) out.push(centerGene)
  for (const gene of right) out.push(gene)
  return out
}

function buildLoadingEdges(genes) {
  if (!Array.isArray(genes) || genes.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  for (const gene of genes) {
    const x = Number(gene?.x)
    const width = Number(gene?.width || 0)
    if (!Number.isFinite(x) || !Number.isFinite(width)) continue
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x + width)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null
  return {
    left: minX - (GENE_GAP / 2),
    right: maxX + (GENE_GAP / 2),
  }
}

function buildVisibleFallbackPairs(refGenes, tgtGenes) {
  const refs = Array.isArray(refGenes) ? refGenes : []
  const tgts = Array.isArray(tgtGenes) ? tgtGenes : []
  if (!refs.length || !tgts.length) return []

  const refOrder = new Map(refs.map((gene, idx) => [String(gene?.id || '').trim(), idx]))
  const tgtOrder = new Map(tgts.map((gene, idx) => [String(gene?.id || '').trim(), idx]))
  const usedRefIds = new Set()
  const usedTgtIds = new Set()
  const out = []

  const addPair = (refIdRaw, tgtIdRaw) => {
    const refId = String(refIdRaw || '').trim()
    const tgtId = String(tgtIdRaw || '').trim()
    if (!refId || !tgtId) return false
    if (usedRefIds.has(refId) || usedTgtIds.has(tgtId)) return false
    usedRefIds.add(refId)
    usedTgtIds.add(tgtId)
    out.push([refId, tgtId])
    return true
  }

  // Priority 1: exact ID matches.
  const tgtById = new Set(tgts.map((gene) => String(gene?.id || '').trim()).filter(Boolean))
  for (const refGene of refs) {
    const refId = String(refGene?.id || '').trim()
    if (refId && tgtById.has(refId)) addPair(refId, refId)
  }

  // Priority 2: symbol matches, disambiguated by neighbourhood order.
  const geneMatchToken = (gene) => normalizeGeneToken(gene?.name || gene?.id)

  const refBySymbol = new Map()
  for (const gene of refs) {
    const id = String(gene?.id || '').trim()
    if (!id || usedRefIds.has(id)) continue
    const symbol = geneMatchToken(gene)
    if (!symbol) continue
    if (!refBySymbol.has(symbol)) refBySymbol.set(symbol, [])
    refBySymbol.get(symbol).push(gene)
  }
  const tgtBySymbol = new Map()
  for (const gene of tgts) {
    const id = String(gene?.id || '').trim()
    if (!id || usedTgtIds.has(id)) continue
    const symbol = geneMatchToken(gene)
    if (!symbol) continue
    if (!tgtBySymbol.has(symbol)) tgtBySymbol.set(symbol, [])
    tgtBySymbol.get(symbol).push(gene)
  }

  const sharedSymbols = [...refBySymbol.keys()].filter((symbol) => tgtBySymbol.has(symbol)).sort()
  for (const symbol of sharedSymbols) {
    const refCandidates = (refBySymbol.get(symbol) || []).filter((gene) => !usedRefIds.has(String(gene?.id || '').trim()))
    const tgtCandidates = (tgtBySymbol.get(symbol) || []).filter((gene) => !usedTgtIds.has(String(gene?.id || '').trim()))
    if (!refCandidates.length || !tgtCandidates.length) continue
    if (refCandidates.length === 1 && tgtCandidates.length === 1) {
      addPair(refCandidates[0]?.id, tgtCandidates[0]?.id)
      continue
    }
    const remainingTargets = [...tgtCandidates].sort((a, b) => (
      (tgtOrder.get(String(a?.id || '').trim()) ?? Number.MAX_SAFE_INTEGER)
      - (tgtOrder.get(String(b?.id || '').trim()) ?? Number.MAX_SAFE_INTEGER)
    ))
    for (const refGene of refCandidates.sort((a, b) => (
      (refOrder.get(String(a?.id || '').trim()) ?? Number.MAX_SAFE_INTEGER)
      - (refOrder.get(String(b?.id || '').trim()) ?? Number.MAX_SAFE_INTEGER)
    ))) {
      if (!remainingTargets.length) break
      const refIdx = refOrder.get(String(refGene?.id || '').trim()) ?? 0
      let bestTargetIdx = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (let idx = 0; idx < remainingTargets.length; idx += 1) {
        const tgtGene = remainingTargets[idx]
        const tgtIdx = tgtOrder.get(String(tgtGene?.id || '').trim()) ?? 0
        const distance = Math.abs(refIdx - tgtIdx)
        if (distance < bestDistance) {
          bestDistance = distance
          bestTargetIdx = idx
        }
      }
      const [chosenTarget] = remainingTargets.splice(bestTargetIdx, 1)
      addPair(refGene?.id, chosenTarget?.id)
    }
  }

  return out
}

function toFocusGene(gene) {
  if (!gene?.id) return null
  return {
    id: gene.id,
    name: gene.name,
    chrom: gene.chrom,
    start: gene.start,
    end: gene.end,
    strand: gene.strand,
  }
}

function renderFlipIcon(isFlipped) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 9a9 9 0 0 0-14.8-4.2L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 15a9 9 0 0 0 14.8 4.2l3.2-3.2" />
      <path d="M21 21v-5h-5" />
      {isFlipped && <line x1="2" y1="2" x2="22" y2="22" stroke="currentColor" strokeWidth="2.6" />}
    </svg>
  )
}

class NeighbourhoodErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('NeighbourhoodView Error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full text-red-500 p-8 text-center bg-gray-50 dark:bg-gray-900 border border-red-200 dark:border-red-900 m-4 rounded-lg">
          <h2 className="text-xl font-bold mb-2">Something went wrong</h2>
          <p className="mb-4 text-sm opacity-80">Failed to render Neighbourhood View</p>
          <pre className="bg-gray-200 dark:bg-black p-4 rounded text-xs text-left overflow-auto max-w-full font-mono border border-gray-300 dark:border-gray-800">
            {this.state.error && this.state.error.toString()}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

const DEFAULT_HOMOLOGY_FILTERS = { showRbh: true, showRegular: true, types: [], minIdentity: 0, minCoverage: 0 }

function NeighbourhoodView({
  theme,
  genomes = [],
  disabledByGenome = {},
  focusGeneByGenome = {},
  queryByGenome = {},
  trackByGenome = {},
  linksByPair = {},
  loadingByGenome = {},
  errorByGenome = {},
  onQueryChange = () => { },
  onResolveGenome = () => { },
  onLinkSelect = () => { },
  onFlipGenome = () => { },
  onSwapAdjacent = () => { },
  onToggleGenome = () => { },
  useHomology = false,
  homologyLinksByPair = {},
  homologyAvailabilityByGenome = {},
  homologyFilters = DEFAULT_HOMOLOGY_FILTERS,
  homologyError = '',
  homologyPairLoading = {},
  noHitGenomeKeys = [],
  onToggleUseHomology = () => { },
  onHomologyFiltersChange = () => { },
}) {
  const isLight = theme === 'light'
  const sidePanelRef = useRef(null)
  const trackAreaRef = useRef(null)
  const dragStateRef = useRef(null)
  const selectionStateRef = useRef(null)
  const selectionRectRef = useRef(null)
  const suppressGeneClickUntilRef = useRef(0)
  const [trackWidth, setTrackWidth] = useState(0)
  const [trackOffsetByGenome, setTrackOffsetByGenome] = useState({})
  const [flippedByGenome, setFlippedByGenome] = useState({})
  const [controlsCollapsed, setControlsCollapsed] = useState(false)
  const [biotypeFilters, setBiotypeFilters] = useState({
    proteinCoding: true,
    longNonCoding: true,
    pseudogene: true,
    smallNonCoding: true,
  })
  const [selectDimArmed, setSelectDimArmed] = useState(false)
  const [selectedGeneIdsByGenome, setSelectedGeneIdsByGenome] = useState({})
  const [selectionRect, setSelectionRect] = useState(null)
  const [homologyFiltersOpen, setHomologyFiltersOpen] = useState(false)
  const [symbolModeActive, setSymbolModeActive] = useState(true)

  const rows = useMemo(() => (
    Array.isArray(genomes)
      ? genomes.map((species, index) => ({
        index,
        genomeKey: speciesItemKey(species),
        species,
        tag: `G${index + 1}`,
        isDisabled: Boolean(disabledByGenome?.[speciesItemKey(species)]),
      })).filter((row) => row.genomeKey)
      : []
  ), [genomes, disabledByGenome])

  const rowKeys = useMemo(() => rows.map((row) => row.genomeKey), [rows])
  useEffect(() => {
    setTrackOffsetByGenome((prev) => {
      const next = {}
      let changed = false
      for (const key of rowKeys) {
        if (Object.prototype.hasOwnProperty.call(prev || {}, key)) {
          next[key] = prev[key]
        } else {
          next[key] = 0
          changed = true
        }
      }
      if (!changed && Object.keys(next).length === Object.keys(prev || {}).length) return prev
      return next
    })
    setFlippedByGenome((prev) => {
      const next = {}
      let changed = false
      for (const key of rowKeys) {
        if (Object.prototype.hasOwnProperty.call(prev || {}, key)) {
          next[key] = prev[key]
        } else {
          next[key] = false
          changed = true
        }
      }
      if (!changed && Object.keys(next).length === Object.keys(prev || {}).length) return prev
      return next
    })
  }, [rowKeys])

  useEffect(() => {
    if (!trackAreaRef.current) return
    const node = trackAreaRef.current
    const update = (width) => setTrackWidth(Math.max(0, width))
    update(node.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        update(entry.contentRect.width)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const rowLayouts = useMemo(() => {
    const byGenome = {}
    const orderedRows = []
    for (const row of rows) {
      const { genomeKey } = row
      const allTrackGenes = row.isDisabled ? [] : normalizeGenes(trackByGenome?.[genomeKey]?.genes)
      const flipped = Boolean(flippedByGenome?.[genomeKey])
      const isLoading = Boolean(loadingByGenome?.[genomeKey])
      const focusedGeneId = String(focusGeneByGenome?.[genomeKey]?.id || '').trim()
      const hasFocusedGeneInTrack = focusedGeneId
        ? allTrackGenes.some((gene) => String(gene?.id || '').trim() === focusedGeneId)
        : false
      const centerGeneId = String(
        (hasFocusedGeneInTrack ? focusedGeneId : '')
        || trackByGenome?.[genomeKey]?.centerGeneId
        || trackByGenome?.[genomeKey]?.requestGeneId
        || allTrackGenes.find((gene) => gene?.is_focal)?.id
        || allTrackGenes[0]?.id
        || ''
      ).trim()
      const filteredGenes = row.isDisabled
        ? []
        : buildDisplayGenesWithBalancedFlanks(allTrackGenes, centerGeneId, biotypeFilters, DISPLAY_FLANK_GENES_PER_SIDE)
      const genes = flipped ? [...filteredGenes].reverse() : filteredGenes
      let centerIndex = genes.findIndex((gene) => String(gene?.id || '').trim() === centerGeneId)
      if (centerIndex < 0) centerIndex = Math.floor(Math.max(0, genes.length - 1) / 2)
      const rowTop = TOP_PADDING + (row.index * ROW_HEIGHT)
      const rowBottom = rowTop + ROW_HEIGHT
      const rowCenterY = rowTop + (ROW_HEIGHT / 2)
      const y = Math.round(rowCenterY - (GENE_HEIGHT / 2))
      const baselineY = rowCenterY
      const baseX = (trackWidth / 2) - (centerIndex * GENE_FULL_WIDTH) - (GENE_WIDTH / 2)
      const offset = Number(trackOffsetByGenome?.[genomeKey] || 0)

      const laidOutGenes = genes.map((gene, geneIndex) => {
        const x = baseX + (geneIndex * GENE_FULL_WIDTH) + offset
        const displayStrand = flipped ? invertStrand(gene?.strand) : String(gene?.strand || '+')
        return {
          ...gene,
          x,
          y,
          width: GENE_WIDTH,
          height: GENE_HEIGHT,
          centerX: x + (GENE_WIDTH / 2),
          centerY: y + (GENE_HEIGHT / 2),
          displayStrand,
        }
      })
      const geneById = new Map(laidOutGenes.map((gene) => [String(gene?.id || ''), gene]))
      const layoutRow = {
        ...row,
        isLoading,
        y,
        rowTop,
        rowBottom,
        rowCenterY,
        baselineY,
        genes: laidOutGenes,
        geneById,
      }
      byGenome[genomeKey] = layoutRow
      orderedRows.push(layoutRow)
    }

    return {
      rows: orderedRows,
      byGenome,
      svgHeight: Math.max(220, TOP_PADDING + (rows.length * ROW_HEIGHT) + BOTTOM_PADDING),
    }
  }, [rows, trackByGenome, flippedByGenome, loadingByGenome, trackOffsetByGenome, trackWidth, focusGeneByGenome, biotypeFilters])

  const rowLayoutsRef = useRef(rowLayouts)
  useEffect(() => {
    rowLayoutsRef.current = rowLayouts
  }, [rowLayouts])

  const selectedGeneIdSetByGenome = useMemo(() => {
    const next = {}
    for (const [key, ids] of Object.entries(selectedGeneIdsByGenome || {})) {
      const normalized = (Array.isArray(ids) ? ids : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
      if (!normalized.length) continue
      next[key] = new Set(normalized)
    }
    return next
  }, [selectedGeneIdsByGenome])

  const hasDimSelection = useMemo(
    () => Object.values(selectedGeneIdSetByGenome).some((set) => set instanceof Set && set.size > 0),
    [selectedGeneIdSetByGenome]
  )
  const anyBiotypeFilterLimited = useMemo(
    () => !(
      biotypeFilters?.proteinCoding
      && biotypeFilters?.longNonCoding
      && biotypeFilters?.pseudogene
      && biotypeFilters?.smallNonCoding
    ),
    [biotypeFilters]
  )

  const homologyUnavailableCount = useMemo(
    () => rows.filter((row) => homologyAvailabilityByGenome?.[row.genomeKey] === 'unavailable').length,
    [rows, homologyAvailabilityByGenome]
  )
  const homologyButtonEnabled = useMemo(
    () => rows.some((row) => ['local', 'downloadable', 'downloading'].includes(homologyAvailabilityByGenome?.[row.genomeKey])),
    [rows, homologyAvailabilityByGenome]
  )
  const homologyAnyDownloading = useMemo(
    () => rows.some((row) => homologyAvailabilityByGenome?.[row.genomeKey] === 'downloading'),
    [rows, homologyAvailabilityByGenome]
  )
  const noHitGenomeLabels = useMemo(() => {
    const keySet = new Set(Array.isArray(noHitGenomeKeys) ? noHitGenomeKeys : [])
    if (!keySet.size) return []
    return rows
      .filter((row) => keySet.has(row.genomeKey))
      .map((row) => formatSpeciesLabel(row.species))
  }, [rows, noHitGenomeKeys])

  useEffect(() => {
    setSelectedGeneIdsByGenome((prev) => {
      const next = {}
      let changed = false
      for (const row of rowLayouts.rows) {
        const key = row.genomeKey
        const ids = Array.isArray(prev?.[key]) ? prev[key] : []
        if (row.isDisabled || !ids.length) {
          if (ids.length) changed = true
          continue
        }
        const valid = ids.filter((id) => row.geneById.has(String(id || '').trim()))
        if (valid.length !== ids.length) changed = true
        if (valid.length) next[key] = valid
      }
      if (!changed && Object.keys(next).length === Object.keys(prev || {}).length) return prev
      return next
    })
  }, [rowLayouts])

  const getPairLinks = useCallback((refGenomeKey, targetGenomeKey) => {
    const pairKey = `${String(refGenomeKey || '').trim()}__${String(targetGenomeKey || '').trim()}`
    const links = linksByPair?.[pairKey]
    if (!Array.isArray(links)) return []
    return links.filter((pair) => Array.isArray(pair) && pair.length >= 2)
  }, [linksByPair])

  const getHomologyPairLinks = useCallback((refGenomeKey, targetGenomeKey) => {
    const pairKey = `${String(refGenomeKey || '').trim()}__${String(targetGenomeKey || '').trim()}`
    const links = homologyLinksByPair?.[pairKey]
    return Array.isArray(links) ? links : []
  }, [homologyLinksByPair])

  const availableHomologyTypes = useMemo(() => {
    const seen = new Set()
    for (const links of Object.values(homologyLinksByPair || {})) {
      for (const link of (Array.isArray(links) ? links : [])) {
        const type = String(link?.homology_type || '').trim()
        if (type) seen.add(type)
      }
    }
    return Array.from(seen).sort()
  }, [homologyLinksByPair])

  const linkItems = useMemo(() => {
    const out = []
    const visibleRows = rowLayouts.rows.filter((row) => !row.isDisabled)
    for (let idx = 0; idx < visibleRows.length - 1; idx += 1) {
      const refRow = visibleRows[idx]
      const tgtRow = visibleRows[idx + 1]
      const pairKey = `${refRow.genomeKey}__${tgtRow.genomeKey}`
      if (homologyPairLoading?.[pairKey]) continue // links hidden while a fresh homology fetch is in flight; spinner renders instead
      const refVisibleIds = new Set(refRow.genes.map((gene) => String(gene?.id || '').trim()).filter(Boolean))
      const tgtVisibleIds = new Set(tgtRow.genes.map((gene) => String(gene?.id || '').trim()).filter(Boolean))

      let pairs = []
      let usingHomologyForPair = false
      if (useHomology) {
        const selectedTypes = Array.isArray(homologyFilters?.types) ? homologyFilters.types : []
        const minIdentity = Number(homologyFilters?.minIdentity || 0)
        const minCoverage = Number(homologyFilters?.minCoverage || 0)
        const filteredHomologyPairs = getHomologyPairLinks(refRow.genomeKey, tgtRow.genomeKey).filter((link) => {
          const srcId = String(link?.ref_gene_id || '').trim()
          const tgtId = String(link?.target_gene_id || '').trim()
          if (!srcId || !tgtId) return false
          if (!refVisibleIds.has(srcId) || !tgtVisibleIds.has(tgtId)) return false
          const isRbh = Boolean(link?.is_rbh)
          if (isRbh && homologyFilters?.showRbh === false) return false
          if (!isRbh && homologyFilters?.showRegular === false) return false
          if (selectedTypes.length && !selectedTypes.includes(String(link?.homology_type || ''))) return false
          if (minIdentity > 0 && Number(link?.perc_id ?? -1) < minIdentity) return false
          if (minCoverage > 0 && Number(link?.perc_cov ?? -1) < minCoverage) return false
          return true
        })
        if (filteredHomologyPairs.length > 0) {
          usingHomologyForPair = true
          pairs = filteredHomologyPairs.map((link) => [String(link.ref_gene_id), String(link.target_gene_id), link])
        }
      }

      // Symbol/ID and Homology are mutually exclusive global modes; when neither is
      // active (both turned off) no links render at all. When Homology is active but
      // this specific pair has no homology data, fall back to Symbol/ID-style matching
      // so the pair degrades gracefully rather than going blank.
      if (!usingHomologyForPair && (useHomology || symbolModeActive)) {
        const backendPairs = getPairLinks(refRow.genomeKey, tgtRow.genomeKey)
        const visibleBackendPairs = backendPairs.filter((pair) => (
          refVisibleIds.has(String(pair?.[0] || '').trim())
          && tgtVisibleIds.has(String(pair?.[1] || '').trim())
        ))
        const fallbackPairs = buildVisibleFallbackPairs(refRow.genes, tgtRow.genes)
        const basePairs = anyBiotypeFilterLimited
          ? fallbackPairs
          : (visibleBackendPairs.length > 0 ? visibleBackendPairs : fallbackPairs)
        pairs = basePairs.map((pair) => [pair[0], pair[1], null])
      }

      for (let pairIdx = 0; pairIdx < pairs.length; pairIdx += 1) {
        const [rawSrcId, rawTgtId, homologyMeta] = pairs[pairIdx]
        const srcId = String(rawSrcId || '')
        const tgtId = String(rawTgtId || '')
        if (hasDimSelection) {
          const srcSelected = selectedGeneIdSetByGenome?.[refRow.genomeKey]?.has(srcId)
          const tgtSelected = selectedGeneIdSetByGenome?.[tgtRow.genomeKey]?.has(tgtId)
          if (!srcSelected || !tgtSelected) continue
        }
        const srcGene = refRow.geneById.get(srcId)
        const tgtGene = tgtRow.geneById.get(tgtId)
        if (!srcGene || !tgtGene) continue
        const x1 = srcGene.centerX
        const y1 = srcGene.y + srcGene.height
        const x2 = tgtGene.centerX
        const y2 = tgtGene.y
        const midY = (y1 + y2) / 2
        const isStraight = Math.abs(x1 - x2) <= 0.5
        out.push({
          key: `${refRow.genomeKey}__${tgtRow.genomeKey}__${srcId}__${tgtId}__${pairIdx}`,
          refGenomeKey: refRow.genomeKey,
          targetGenomeKey: tgtRow.genomeKey,
          srcGene,
          tgtGene,
          isRbh: Boolean(homologyMeta?.is_rbh),
          isHomology: Boolean(homologyMeta),
          homologyType: homologyMeta?.homology_type || '',
          path: isStraight
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
        })
      }
    }
    return out
  }, [rowLayouts, getPairLinks, getHomologyPairLinks, useHomology, symbolModeActive, homologyFilters, homologyPairLoading, hasDimSelection, selectedGeneIdSetByGenome, anyBiotypeFilterLimited])

  const homologyLoadingBoundaries = useMemo(() => {
    const out = []
    const visibleRows = rowLayouts.rows.filter((row) => !row.isDisabled)
    for (let idx = 0; idx < visibleRows.length - 1; idx += 1) {
      const refRow = visibleRows[idx]
      const tgtRow = visibleRows[idx + 1]
      const pairKey = `${refRow.genomeKey}__${tgtRow.genomeKey}`
      if (!homologyPairLoading?.[pairKey]) continue
      out.push({ key: pairKey, y: (refRow.rowBottom + tgtRow.rowTop) / 2 })
    }
    return out
  }, [rowLayouts, homologyPairLoading])

  const getPanTargetForY = useCallback((localY) => {
    for (const row of rowLayouts.rows) {
      if (row.isDisabled) continue
      const minY = row.rowCenterY - 26
      const maxY = row.rowCenterY + 26
      if (localY >= minY && localY <= maxY) {
        return { scope: 'row', genomeKey: row.genomeKey }
      }
    }
    return { scope: 'all' }
  }, [rowLayouts.rows])

  useEffect(() => {
    const handleMove = (event) => {
      const selection = selectionStateRef.current
      if (selection) {
        const area = trackAreaRef.current
        if (!area) return
        const rect = area.getBoundingClientRect()
        const currentX = event.clientX - rect.left + area.scrollLeft
        const currentY = event.clientY - rect.top + area.scrollTop
        const x = Math.min(selection.startX, currentX)
        const y = Math.min(selection.startY, currentY)
        const width = Math.abs(currentX - selection.startX)
        const height = Math.abs(currentY - selection.startY)
        const nextRect = { x, y, width, height }
        selectionRectRef.current = nextRect
        setSelectionRect(nextRect)
        return
      }

      const drag = dragStateRef.current
      if (!drag) return
      const delta = event.clientX - drag.startX
      if (Math.abs(delta) > 3) {
        drag.didDrag = true
      }
      if (drag.scope === 'row' && drag.genomeKey) {
        setTrackOffsetByGenome((prev) => ({
          ...prev,
          [drag.genomeKey]: drag.initialOffset + delta,
        }))
        return
      }
      if (drag.scope === 'all' && drag.initialOffsets) {
        setTrackOffsetByGenome((prev) => {
          const next = { ...prev }
          for (const [genomeKey, initialOffset] of Object.entries(drag.initialOffsets)) {
            next[genomeKey] = Number(initialOffset || 0) + delta
          }
          return next
        })
      }
    }
    const handleUp = () => {
      const selection = selectionStateRef.current
      if (selection) {
        const finalRect = selectionRectRef.current || {
          x: selection.startX,
          y: selection.startY,
          width: 0,
          height: 0,
        }
        selectionStateRef.current = null
        selectionRectRef.current = null
        setSelectionRect(null)

        if (finalRect.width >= 2 && finalRect.height >= 2) {
          const minX = finalRect.x
          const maxX = finalRect.x + finalRect.width
          const minY = finalRect.y
          const maxY = finalRect.y + finalRect.height
          const selected = {}
          for (const row of rowLayoutsRef.current.rows || []) {
            if (row.isDisabled) continue
            const ids = []
            for (const gene of row.genes || []) {
              if (gene.centerX < minX || gene.centerX > maxX) continue
              if (gene.centerY < minY || gene.centerY > maxY) continue
              ids.push(String(gene.id || '').trim())
            }
            if (ids.length) selected[row.genomeKey] = ids
          }
          setSelectedGeneIdsByGenome(selected)
        } else {
          setSelectedGeneIdsByGenome({})
        }
        setSelectDimArmed(false)
        suppressGeneClickUntilRef.current = Date.now() + 220
        return
      }

      const drag = dragStateRef.current
      if (drag?.didDrag) {
        suppressGeneClickUntilRef.current = Date.now() + 220
      }
      dragStateRef.current = null
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  const handleTrackMouseDown = useCallback((event) => {
    if (!trackAreaRef.current) return
    if (selectDimArmed) {
      const area = trackAreaRef.current
      const rect = area.getBoundingClientRect()
      const startX = event.clientX - rect.left + area.scrollLeft
      const startY = event.clientY - rect.top + area.scrollTop
      selectionStateRef.current = { startX, startY }
      const initialRect = { x: startX, y: startY, width: 0, height: 0 }
      selectionRectRef.current = initialRect
      setSelectionRect(initialRect)
      event.preventDefault()
      return
    }
    const rect = trackAreaRef.current.getBoundingClientRect()
    const localY = event.clientY - rect.top
    const target = getPanTargetForY(localY)
    if (target.scope === 'row' && target.genomeKey) {
      dragStateRef.current = {
        scope: 'row',
        genomeKey: target.genomeKey,
        startX: event.clientX,
        initialOffset: Number(trackOffsetByGenome?.[target.genomeKey] || 0),
        didDrag: false,
      }
      return
    }
    const initialOffsets = {}
    for (const row of rowLayouts.rows) {
      initialOffsets[row.genomeKey] = Number(trackOffsetByGenome?.[row.genomeKey] || 0)
    }
    dragStateRef.current = {
      scope: 'all',
      startX: event.clientX,
      initialOffsets,
      didDrag: false,
    }
  }, [getPanTargetForY, rowLayouts.rows, trackOffsetByGenome, selectDimArmed])

  const handleTrackWheel = useCallback((event) => {
    if (!trackAreaRef.current) return
    const rect = trackAreaRef.current.getBoundingClientRect()
    const localY = event.clientY - rect.top
    const dominantDelta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (!Number.isFinite(dominantDelta) || Math.abs(dominantDelta) < 0.01) return
    const target = getPanTargetForY(localY)
    if (target.scope === 'row' && target.genomeKey) {
      setTrackOffsetByGenome((prev) => ({
        ...prev,
        [target.genomeKey]: Number(prev?.[target.genomeKey] || 0) - dominantDelta,
      }))
      event.preventDefault()
      return
    }
    setTrackOffsetByGenome((prev) => {
      const next = { ...prev }
      for (const row of rowLayouts.rows) {
        next[row.genomeKey] = Number(prev?.[row.genomeKey] || 0) - dominantDelta
      }
      return next
    })
    event.preventDefault()
  }, [getPanTargetForY, rowLayouts.rows])

  const emitPairFocus = useCallback((refGenomeKey, targetGenomeKey, srcGene, tgtGene) => {
    if (!srcGene?.id || !tgtGene?.id) return
    setTrackOffsetByGenome((prev) => {
      const next = { ...(prev || {}) }
      let changed = false
      for (const key of [String(refGenomeKey || '').trim(), String(targetGenomeKey || '').trim()]) {
        if (!key) continue
        if (Number(next?.[key] || 0) !== 0) {
          next[key] = 0
          changed = true
        }
      }
      return changed ? next : prev
    })
    onLinkSelect({
      refGenomeKey,
      targetGenomeKey,
      referenceGene: toFocusGene(srcGene),
      targetGene: toFocusGene(tgtGene),
      genesByGenome: {
        [String(refGenomeKey || '').trim()]: toFocusGene(srcGene),
        [String(targetGenomeKey || '').trim()]: toFocusGene(tgtGene),
      },
    })
  }, [onLinkSelect])

  const chooseGeneCandidate = useCallback((candidates, preferredToken) => {
    if (!Array.isArray(candidates) || candidates.length === 0) return null
    if (preferredToken) {
      for (const gene of candidates) {
        if (normalizeGeneToken(gene?.name) === preferredToken) return gene
        if (normalizeGeneToken(gene?.id) === preferredToken) return gene
      }
    }
    return candidates[0] || null
  }, [])

  const handleGeneClick = useCallback((row, gene) => {
    const clickedGeneId = String(gene?.id || '').trim()
    if (!clickedGeneId) return

    const rowsOrdered = (rowLayouts.rows || []).filter((candidateRow) => !candidateRow.isDisabled)
    const selectedRowIndex = rowsOrdered.findIndex((candidateRow) => candidateRow.genomeKey === row.genomeKey)
    if (selectedRowIndex < 0) return
    const selectedByGenome = {
      [row.genomeKey]: gene,
    }
    const preferredToken = normalizeGeneToken(gene?.name || gene?.id)

    // Walk right through adjacent pairs.
    let currentGene = gene
    for (let i = selectedRowIndex; i < rowsOrdered.length - 1; i += 1) {
      const srcRow = rowsOrdered[i]
      const dstRow = rowsOrdered[i + 1]
      const pairs = getPairLinks(srcRow.genomeKey, dstRow.genomeKey)
      const candidates = []
      for (const pair of pairs) {
        if (String(pair?.[0] || '').trim() !== String(currentGene?.id || '').trim()) continue
        const nextGene = dstRow.geneById.get(String(pair?.[1] || '').trim())
        if (nextGene) candidates.push(nextGene)
      }
      const chosen = chooseGeneCandidate(candidates, preferredToken)
      if (!chosen) break
      selectedByGenome[dstRow.genomeKey] = chosen
      currentGene = chosen
    }

    // Walk left through adjacent pairs.
    currentGene = gene
    for (let i = selectedRowIndex; i > 0; i -= 1) {
      const srcRow = rowsOrdered[i - 1]
      const dstRow = rowsOrdered[i]
      const pairs = getPairLinks(srcRow.genomeKey, dstRow.genomeKey)
      const candidates = []
      for (const pair of pairs) {
        if (String(pair?.[1] || '').trim() !== String(currentGene?.id || '').trim()) continue
        const prevGene = srcRow.geneById.get(String(pair?.[0] || '').trim())
        if (prevGene) candidates.push(prevGene)
      }
      const chosen = chooseGeneCandidate(candidates, preferredToken)
      if (!chosen) break
      selectedByGenome[srcRow.genomeKey] = chosen
      currentGene = chosen
    }

    // Fallback for any rows without a link-derived match: try same ID, then same symbol.
    for (const candidateRow of rowsOrdered) {
      if (selectedByGenome[candidateRow.genomeKey]) continue
      const directIdMatch = candidateRow.geneById.get(clickedGeneId)
      if (directIdMatch) {
        selectedByGenome[candidateRow.genomeKey] = directIdMatch
        continue
      }
      if (!preferredToken) continue
      const symbolMatch = candidateRow.genes.find((candidateGene) => (
        normalizeGeneToken(candidateGene?.name) === preferredToken
        || normalizeGeneToken(candidateGene?.id) === preferredToken
      ))
      if (symbolMatch) {
        selectedByGenome[candidateRow.genomeKey] = symbolMatch
      }
    }

    const focusPayload = {}
    for (const [genomeKey, selectedGene] of Object.entries(selectedByGenome)) {
      const asFocusGene = toFocusGene(selectedGene)
      if (!asFocusGene?.id) continue
      focusPayload[genomeKey] = asFocusGene
    }
    if (Object.keys(focusPayload).length === 0) return

    // Re-center all matched rows so homologous selected genes align at mid-view.
    setTrackOffsetByGenome((prev) => {
      const next = { ...(prev || {}) }
      let changed = false
      for (const genomeKey of Object.keys(focusPayload)) {
        if (Number(next?.[genomeKey] || 0) !== 0) {
          next[genomeKey] = 0
          changed = true
        }
      }
      return changed ? next : prev
    })

    onLinkSelect({
      sourceGenomeKey: row.genomeKey,
      sourceGene: toFocusGene(gene),
      genesByGenome: focusPayload,
    })
  }, [rowLayouts.rows, getPairLinks, chooseGeneCandidate, onLinkSelect])

  const handleLinkClick = useCallback((link) => {
    if (!link?.srcGene?.id || !link?.tgtGene?.id) return
    emitPairFocus(link.refGenomeKey, link.targetGenomeKey, link.srcGene, link.tgtGene)
  }, [emitPairFocus])

  const handleGenePathClick = useCallback((row, gene, event) => {
    if (selectDimArmed || selectionStateRef.current) {
      event.stopPropagation()
      return
    }
    if (hasDimSelection) {
      setSelectedGeneIdsByGenome({})
    }
    if (Date.now() < suppressGeneClickUntilRef.current) {
      event.stopPropagation()
      return
    }
    event.stopPropagation()
    handleGeneClick(row, gene)
  }, [handleGeneClick, selectDimArmed, hasDimSelection])

  const handleTrackAreaClick = useCallback((event) => {
    if (event.defaultPrevented) return
    if (selectDimArmed || selectionStateRef.current) return
    if (!hasDimSelection) return
    if (Date.now() < suppressGeneClickUntilRef.current) return
    setSelectedGeneIdsByGenome({})
  }, [selectDimArmed, hasDimSelection])

  const handleToggleFlip = useCallback((genomeKey) => {
    const key = String(genomeKey || '').trim()
    if (!key) return
    setFlippedByGenome((prev) => ({ ...prev, [key]: !prev?.[key] }))
    onFlipGenome(key)
  }, [onFlipGenome])

  const handleRecenterFocused = useCallback(() => {
    setTrackOffsetByGenome((prev) => {
      const next = { ...(prev || {}) }
      let changed = false
      for (const row of rowLayouts.rows || []) {
        if (row.isDisabled) continue
        const focusId = String(focusGeneByGenome?.[row.genomeKey]?.id || '').trim()
        if (!focusId) continue
        const hasFocusInRow = row.geneById.has(focusId)
        if (!hasFocusInRow) continue
        if (Number(next?.[row.genomeKey] || 0) !== 0) {
          next[row.genomeKey] = 0
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [rowLayouts.rows, focusGeneByGenome])

  const handleToggleBiotypeFilter = useCallback((key) => {
    setBiotypeFilters((prev) => ({ ...prev, [key]: !prev?.[key] }))
    setSelectedGeneIdsByGenome({})
    setSelectDimArmed(false)
  }, [])

  const handleToggleHomologyShowFlag = useCallback((flagKey) => {
    const next = { ...homologyFilters, [flagKey]: !homologyFilters?.[flagKey] }
    if (!next.showRbh && !next.showRegular) return
    onHomologyFiltersChange(next)
  }, [homologyFilters, onHomologyFiltersChange])

  const handleToggleHomologyType = useCallback((type) => {
    const current = Array.isArray(homologyFilters?.types) ? homologyFilters.types : []
    const next = current.includes(type) ? current.filter((t) => t !== type) : [...current, type]
    onHomologyFiltersChange({ ...homologyFilters, types: next })
  }, [homologyFilters, onHomologyFiltersChange])

  const handleHomologyThresholdChange = useCallback((field, value) => {
    const parsed = Number(value)
    onHomologyFiltersChange({ ...homologyFilters, [field]: Number.isFinite(parsed) ? parsed : 0 })
  }, [homologyFilters, onHomologyFiltersChange])

  // "Symbol/ID" and "Homology" are mutually exclusive link-source modes; clicking the
  // active one turns all links off rather than leaving the other mode engaged.
  const handleSymbolModeClick = useCallback(() => {
    if (symbolModeActive) {
      setSymbolModeActive(false)
      return
    }
    if (useHomology) onToggleUseHomology()
    setSymbolModeActive(true)
  }, [symbolModeActive, useHomology, onToggleUseHomology])

  const handleHomologyModeClick = useCallback(() => {
    if (!useHomology && symbolModeActive) {
      setSymbolModeActive(false)
    }
    onToggleUseHomology()
  }, [useHomology, symbolModeActive, onToggleUseHomology])

  const handleToggleSelectDim = useCallback(() => {
    if (selectDimArmed || hasDimSelection) {
      setSelectDimArmed(false)
      setSelectedGeneIdsByGenome({})
      setSelectionRect(null)
      selectionRectRef.current = null
      selectionStateRef.current = null
      return
    }
    setSelectedGeneIdsByGenome({})
    setSelectDimArmed(true)
  }, [selectDimArmed, hasDimSelection])

  const panelBgClass = isLight ? 'bg-white border border-gray-200' : 'bg-gray-800 border border-gray-700'
  const toolbarBgClass = isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-900/40 border-gray-700'
  const baselineColor = isLight ? '#9ca3af' : '#4b5563'
  const textPrimaryClass = isLight ? 'text-gray-900' : 'text-gray-100'
  const textMutedClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const collapseButtonClass = `w-7 h-7 rounded border flex items-center justify-center transition-colors ${isLight
    ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
    : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'}`
  const interRowButtonClass = `absolute left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 transition-opacity flex items-center justify-center rounded-md hover:opacity-80 ${isLight
    ? 'text-white'
    : 'text-white'}`
  const biotypeCheckboxStyle = {
    accentColor: isLight ? '#0099ff' : '#0077cc',
    cursor: 'pointer',
    width: '11px',
    height: '11px',
    flexShrink: 0,
  }
  const biotypeLabelStyle = {
    color: isLight ? '#4b5563' : '#9ca3af',
    userSelect: 'none',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  }
  const geneDefaultFill = isLight ? '#0099ff' : '#3b82f6'
  const geneFocusFill = isLight ? '#f97316' : '#fb923c'
  const strokeColor = isLight ? '#1f2937' : '#e5e7eb'
  const linkColor = isLight ? '#374151' : '#d1d5db'
  const rbhLinkColor = geneFocusFill
  const linkModeButtonStyle = (enabled, active) => {
    const disabledBg = isLight ? '#ffffff' : '#1E2938'
    const disabledText = isLight ? '#c0c0c0' : '#4b4b4b'
    const disabledBorder = isLight ? '#d1d5db' : '#4b5563'
    const inactiveBg = isLight ? '#ffffff' : '#1E2938'
    const inactiveText = isLight ? '#4b5563' : '#9ca3af'
    const inactiveBorder = isLight ? '#d1d5db' : '#4b5563'
    const activeBg = isLight ? '#0099ff' : '#0077cc'
    const showEmphasis = enabled && active
    return {
      backgroundColor: enabled ? (showEmphasis ? activeBg : inactiveBg) : disabledBg,
      color: enabled ? (showEmphasis ? '#ffffff' : inactiveText) : disabledText,
      border: `1px solid ${enabled ? (showEmphasis ? 'transparent' : inactiveBorder) : disabledBorder}`,
      cursor: enabled ? 'pointer' : 'default',
    }
  }
  const symbolButtonStyle = linkModeButtonStyle(true, symbolModeActive)
  const homologyButtonStyle = linkModeButtonStyle(homologyButtonEnabled && !homologyAnyDownloading, useHomology)
  const geneLabelBg = isLight ? 'rgba(255,255,255,0.94)' : 'rgba(15,23,42,0.92)'
  const geneLabelBorder = isLight ? 'rgba(148,163,184,0.9)' : 'rgba(71,85,105,0.9)'
  const geneLabelText = isLight ? '#0f172a' : '#f8fafc'
  const loadingEdgeColor = isLight ? '#0284c7' : '#38bdf8'
  const loadingEdgeBg = isLight ? 'rgba(240,249,255,0.96)' : 'rgba(8,47,73,0.92)'

  if (rows.length === 0) {
    return (
      <div className={`h-full w-full rounded-lg ${panelBgClass} flex flex-col items-center justify-center`}>
        <img src="ensembl-e-blue.svg" alt="Ensembl" style={{ width: 140, height: 140 }} />
        <h2 className={`text-xl font-semibold mt-2 ${textPrimaryClass}`}>No active genomes</h2>
        <p className={`text-sm mt-1 ${textMutedClass}`}>Activate one or more genomes with annotation files to use Neighbourhood.</p>
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-hidden flex gap-3">
      <div
        ref={sidePanelRef}
        className={`rounded-lg ${panelBgClass} overflow-hidden flex flex-col transition-[width] duration-200 ${controlsCollapsed ? 'w-[44px] min-w-[44px] max-w-[44px]' : 'w-[276px] min-w-[268px] max-w-[292px]'}`}
      >
        <div className={`px-3 py-2 border-b ${toolbarBgClass} flex items-center ${controlsCollapsed ? 'justify-end' : 'justify-between'}`}>
          {!controlsCollapsed && <div className={`text-sm font-semibold ${textPrimaryClass}`}>Neighbourhood controls</div>}
          <button
            type="button"
            onClick={() => setControlsCollapsed((prev) => !prev)}
            className={collapseButtonClass}
            title={controlsCollapsed ? 'Expand controls' : 'Collapse controls'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              {controlsCollapsed
                ? <polyline points="9 6 15 12 9 18" />
                : <polyline points="15 6 9 12 15 18" />}
            </svg>
          </button>
        </div>
        {!controlsCollapsed && (
          <div className="flex-1 overflow-y-auto px-3 py-0">
          {rows.map((row) => {
            const key = row.genomeKey
            const query = String(queryByGenome?.[key] || '')
            const isLoading = Boolean(loadingByGenome?.[key])
            const rowError = String(errorByGenome?.[key] || '')
            const isDisabled = Boolean(row.isDisabled)
            return (
              <div
                key={key}
                className="relative pt-0"
                style={{ marginBottom: `${row.index === rows.length - 1 ? 0 : CONTROL_ROW_GAP}px` }}
              >
                <div
                  className={`rounded-md border px-2.5 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-800/70'} ${isDisabled ? 'opacity-55' : ''}`}
                  style={{ height: `${CONTROL_ROW_HEIGHT}px` }}
                >
                <div className="h-full flex flex-col justify-center gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex h-6 w-[190px] min-w-[190px] max-w-[190px] items-center rounded-full border px-2.5 text-xs font-medium truncate"
                    style={{
                      backgroundColor: isDisabled
                        ? (isLight ? '#9ca3af' : '#4b5563')
                        : (isLight ? '#0099ff' : '#0077cc'),
                      color: '#ffffff',
                      borderColor: 'transparent',
                    }}
                    title={formatSpeciesLabel(row.species)}
                    onClick={() => onToggleGenome(key)}
                  >
                    <span className="block min-w-0 w-full truncate text-left">
                      {formatSpeciesLabel(row.species)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleFlip(key)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded text-white shrink-0"
                    style={{ backgroundColor: isLight ? '#0099ff' : '#0077cc' }}
                    title={flippedByGenome?.[key] ? "Restore 5' to 3'" : "Flip 3' to 5'"}
                    disabled={isDisabled}
                  >
                    {renderFlipIcon(Boolean(flippedByGenome?.[key]))}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={query}
                    onChange={(event) => onQueryChange(key, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onResolveGenome(key)
                    }}
                    placeholder="Gene symbol or gene/transcript ID"
                    className={`h-8 flex-1 min-w-0 px-2 py-1.5 rounded text-xs border focus:outline-none ${isLight
                      ? 'bg-white border-gray-300 text-gray-800 focus:border-blue-500'
                      : 'bg-gray-700 border-gray-600 text-gray-100 focus:border-blue-500'
                      }`}
                    disabled={isDisabled}
                  />
                  <button
                    type="button"
                    onClick={() => onResolveGenome(key)}
                    disabled={isDisabled || isLoading || !query.trim()}
                    className="h-8 w-8 rounded text-xs font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                    style={{ backgroundColor: isLight ? '#0099ff' : '#0077cc' }}
                  >
                    {isLoading ? '...' : 'Go'}
                  </button>
                </div>
                {rowError && <div className="mt-1 text-[11px] text-red-400">{rowError}</div>}
                {useHomology && homologyAvailabilityByGenome?.[key] === 'unavailable' && (
                  <div className={`mt-1 text-[11px] ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>No homology data published for this genome</div>
                )}
                </div>
                </div>
                {row.index < rows.length - 1 && (
                  <button
                    type="button"
                    className={interRowButtonClass}
                    style={{
                      top: `calc(100% + ${CONTROL_ROW_GAP / 2}px)`,
                      width: 44,
                      height: 24,
                      backgroundColor: isLight ? '#0099ff' : '#0077cc',
                    }}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      const nextRow = rows[row.index + 1]
                      if (!nextRow?.genomeKey) return
                      onSwapAdjacent(row.genomeKey, nextRow.genomeKey)
                    }}
                    title="Swap adjacent genomes"
                  >
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 20V5" />
                      <path d="M4.5 8.5L8 5l3.5 3.5" />
                      <path d="M16 4v15" />
                      <path d="M12.5 15.5L16 19l3.5-3.5" />
                    </svg>
                  </button>
                )}
              </div>
            )
          })}
          </div>
        )}
      </div>

      <div className={`flex-1 min-w-0 rounded-lg ${panelBgClass} overflow-hidden flex flex-col`}>
        <div className={`px-3 py-2 border-b ${toolbarBgClass} flex items-center gap-2`}>
          <button
            type="button"
            onClick={handleRecenterFocused}
            className="h-8 w-8 rounded-md transition-colors hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center"
            title="Re-center focused genes"
          >
            <svg width="24" height="24" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d={RESET_ICON_PATH_D} fill={isLight ? '#0099ff' : '#60a5fa'} />
            </svg>
          </button>
          <button
            type="button"
            onClick={handleToggleSelectDim}
            className="h-8 w-8 rounded-md transition-opacity flex items-center justify-center hover:opacity-80"
            style={{
              backgroundColor: isLight ? '#0099ff' : '#0077cc',
              color: '#ffffff',
              boxShadow: (selectDimArmed || hasDimSelection)
                ? `0 0 0 2px ${isLight ? '#ffffff' : '#111827'} inset`
                : 'none',
            }}
            title={selectDimArmed ? 'Drag a selection rectangle across rows' : (hasDimSelection ? 'Clear selection and dim' : 'Select and dim genes')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="2.5" width="16" height="16" rx="2.2" strokeWidth="2.2" strokeDasharray="3.2 2.2" />
              <path d="M21 16.8v5.2M18.4 19.4h5.2" strokeWidth="2.2" />
            </svg>
          </button>
          <div className="h-4 w-px flex-shrink-0 ml-1 mr-1" style={{ backgroundColor: isLight ? '#dee2e6' : '#495057' }} />
          <div className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'auto auto', fontSize: '10px', lineHeight: '1.35' }}>
            <label className="flex items-center gap-1" style={biotypeLabelStyle}>
              <input
                type="checkbox"
                checked={biotypeFilters.proteinCoding}
                onChange={() => handleToggleBiotypeFilter('proteinCoding')}
                style={biotypeCheckboxStyle}
              />
              Protein-coding
            </label>
            <label className="flex items-center gap-1" style={biotypeLabelStyle}>
              <input
                type="checkbox"
                checked={biotypeFilters.longNonCoding}
                onChange={() => handleToggleBiotypeFilter('longNonCoding')}
                style={biotypeCheckboxStyle}
              />
              Long non-coding
            </label>
            <label className="flex items-center gap-1" style={biotypeLabelStyle}>
              <input
                type="checkbox"
                checked={biotypeFilters.pseudogene}
                onChange={() => handleToggleBiotypeFilter('pseudogene')}
                style={biotypeCheckboxStyle}
              />
              Pseudogene
            </label>
            <label className="flex items-center gap-1" style={biotypeLabelStyle}>
              <input
                type="checkbox"
                checked={biotypeFilters.smallNonCoding}
                onChange={() => handleToggleBiotypeFilter('smallNonCoding')}
                style={biotypeCheckboxStyle}
              />
              Small non-coding
            </label>
          </div>
          <div className="h-4 w-px flex-shrink-0 ml-1 mr-1" style={{ backgroundColor: isLight ? '#dee2e6' : '#495057' }} />
          <div className="relative flex items-center gap-1">
            <button
              type="button"
              onClick={handleSymbolModeClick}
              className="flex-shrink-0 flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
              style={symbolButtonStyle}
              title={symbolModeActive
                ? 'Showing gene symbol/ID-based links — click to turn off links'
                : 'Use gene symbol/ID matching to draw links'}
            >
              Symbol/ID
            </button>
            <button
              type="button"
              onClick={handleHomologyModeClick}
              disabled={!homologyButtonEnabled || homologyAnyDownloading}
              className="flex-shrink-0 flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors"
              style={homologyButtonStyle}
              title={
                homologyAnyDownloading
                  ? 'Downloading homology data…'
                  : !homologyButtonEnabled
                    ? 'No homology TSV files are available for the genomes in this view'
                    : useHomology
                      ? 'Showing real homology links — click to turn off links'
                      : (homologyUnavailableCount > 0
                        ? `Use homology data to draw links (${homologyUnavailableCount} of ${rows.length} genomes lack homology files)`
                        : 'Use homology data to draw links')
              }
            >
              Homology
            </button>
            <button
              type="button"
              onClick={() => setHomologyFiltersOpen((prev) => !prev)}
              className="h-8 w-6 rounded-md transition-colors hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center"
              title="Homology link filters"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {homologyFiltersOpen && (
              <div
                className={`absolute left-0 top-full mt-1 z-30 w-72 rounded-md border p-3 text-xs shadow-lg space-y-3 ${isLight ? 'bg-white border-gray-200 text-gray-700' : 'bg-gray-800 border-gray-600 text-gray-200'}`}
              >
                <div>
                  <div className="font-semibold mb-1">Show links</div>
                  <label className="flex items-center gap-2 mb-1">
                    <input type="checkbox" checked={Boolean(homologyFilters?.showRbh)} onChange={() => handleToggleHomologyShowFlag('showRbh')} />
                    Reciprocal best hit (RBH)
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={Boolean(homologyFilters?.showRegular)} onChange={() => handleToggleHomologyShowFlag('showRegular')} />
                    Regular best hit
                  </label>
                </div>
                {availableHomologyTypes.length > 0 && (
                  <div>
                    <div className="font-semibold mb-1">Homology type</div>
                    <div className="max-h-24 overflow-y-auto space-y-1">
                      {availableHomologyTypes.map((type) => (
                        <label key={type} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={!homologyFilters?.types?.length || homologyFilters.types.includes(type)}
                            onChange={() => handleToggleHomologyType(type)}
                          />
                          {formatHomologyType(type)}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    Min identity %
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={homologyFilters?.minIdentity || 0}
                      onChange={(event) => handleHomologyThresholdChange('minIdentity', event.target.value)}
                      className={`px-1.5 py-1 rounded border text-xs ${isLight ? 'bg-white border-gray-300' : 'bg-gray-700 border-gray-600'}`}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    Min coverage %
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={homologyFilters?.minCoverage || 0}
                      onChange={(event) => handleHomologyThresholdChange('minCoverage', event.target.value)}
                      className={`px-1.5 py-1 rounded border text-xs ${isLight ? 'bg-white border-gray-300' : 'bg-gray-700 border-gray-600'}`}
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
          {homologyError && (
            <span className={`text-[11px] ml-1 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>{homologyError}</span>
          )}
        </div>
        <div
          ref={trackAreaRef}
          className={`flex-1 w-full overflow-auto ${selectDimArmed ? 'cursor-crosshair' : ''}`}
          onMouseDown={handleTrackMouseDown}
          onClick={handleTrackAreaClick}
          onWheel={handleTrackWheel}
        >
          <svg width="100%" height={rowLayouts.svgHeight} className="select-none">
            {rowLayouts.rows.map((row) => (
              <g key={`baseline-${row.genomeKey}`}>
                {!row.isDisabled && (
                  <line
                    x1={0}
                    y1={row.baselineY}
                    x2={Math.max(0, trackWidth)}
                    y2={row.baselineY}
                    stroke={baselineColor}
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    strokeOpacity="0.75"
                  />
                )}
              </g>
            ))}

            {linkItems.map((link) => (
              <path
                key={link.key}
                d={link.path}
                stroke={link.isRbh ? rbhLinkColor : linkColor}
                strokeWidth={link.isRbh ? '2.5' : '2'}
                strokeOpacity={link.isRbh ? '0.85' : '0.68'}
                fill="none"
                className="cursor-pointer hover:opacity-95"
                onClick={(event) => {
                  event.stopPropagation()
                  handleLinkClick(link)
                }}
              />
            ))}

            {homologyLoadingBoundaries.map((boundary) => {
              const cx = (trackWidth / 2) - 56
              return (
                <g key={`homology-loading-${boundary.key}`} pointerEvents="none">
                  <rect
                    x={(trackWidth / 2) - 88}
                    y={boundary.y - 14}
                    width="176"
                    height="28"
                    rx="14"
                    fill={loadingEdgeBg}
                    stroke={loadingEdgeColor}
                    strokeWidth="1"
                  />
                  <g style={{ transformOrigin: `${cx}px ${boundary.y}px` }} className="animate-spin">
                    <circle
                      cx={cx}
                      cy={boundary.y}
                      r="7"
                      fill="none"
                      stroke={loadingEdgeColor}
                      strokeWidth="2"
                      strokeDasharray="22 11"
                      strokeLinecap="round"
                    />
                  </g>
                  <text
                    x={(trackWidth / 2) + 10}
                    y={boundary.y + 4}
                    textAnchor="middle"
                    fill={loadingEdgeColor}
                    fontSize="11"
                    fontWeight="700"
                  >
                    Loading homology…
                  </text>
                </g>
              )
            })}

            {rowLayouts.rows.map((row) => (
              <g key={`genes-${row.genomeKey}`}>
                {row.genes.map((gene) => {
                  const focusId = String(focusGeneByGenome?.[row.genomeKey]?.id || '')
                  const isFocused = focusId && focusId === String(gene?.id || '')
                  const geneLabel = String(gene?.name || gene?.id || '').slice(0, 14)
                  const labelWidth = Math.max(24, (geneLabel.length * 6.1) + 8)
                  const labelHeight = 13
                  const labelX = (gene.x + (gene.width / 2)) - (labelWidth / 2)
                  const labelY = gene.y - 18
                  const isSelectedInDim = hasDimSelection
                    ? Boolean(selectedGeneIdSetByGenome?.[row.genomeKey]?.has(String(gene?.id || '')))
                    : true
                  return (
                    <g key={`${row.genomeKey}-${gene.id}`}>
                      <path
                        d={getGenePath(gene.x, gene.y, gene.width, gene.height, gene.displayStrand)}
                        fill={isFocused ? geneFocusFill : geneDefaultFill}
                        stroke={strokeColor}
                        strokeWidth="1.25"
                        className={`cursor-pointer ${hasDimSelection ? '' : 'hover:opacity-85'}`}
                        opacity={isSelectedInDim ? 1 : 0.22}
                        onClick={(event) => handleGenePathClick(row, gene, event)}
                      >
                        <title>{`${gene.name || gene.id} (${gene.id}) ${gene.chrom}:${gene.start}-${gene.end} • biotype: ${gene.biotype || 'unknown'}`}</title>
                      </path>
                      <rect
                        x={labelX}
                        y={labelY}
                        width={labelWidth}
                        height={labelHeight}
                        rx="3"
                        fill={geneLabelBg}
                        stroke={geneLabelBorder}
                        strokeWidth="0.8"
                        className="pointer-events-none"
                        opacity={isSelectedInDim ? 1 : 0.25}
                      />
                      <text
                        x={gene.x + (gene.width / 2)}
                        y={gene.y - 8}
                        textAnchor="middle"
                        fill={geneLabelText}
                        fontSize="10"
                        fontWeight="600"
                        className="pointer-events-none"
                        opacity={isSelectedInDim ? 1 : 0.25}
                      >
                        {geneLabel}
                      </text>
                    </g>
                  )
                })}
              </g>
            ))}

            {rowLayouts.rows.map((row) => {
              if (row.isDisabled || !row.isLoading) return null
              const edges = buildLoadingEdges(row.genes)
              if (!edges) {
                return (
                  <g key={`loading-${row.genomeKey}`} pointerEvents="none">
                    <rect
                      x={(trackWidth / 2) - 42}
                      y={row.baselineY - 14}
                      width="84"
                      height="28"
                      rx="5"
                      fill={loadingEdgeBg}
                      stroke={loadingEdgeColor}
                      strokeWidth="1"
                    />
                    <text
                      x={trackWidth / 2}
                      y={row.baselineY + 4}
                      textAnchor="middle"
                      fill={loadingEdgeColor}
                      fontSize="11"
                      fontWeight="700"
                    >
                      Loading
                    </text>
                  </g>
                )
              }
              const y1 = row.baselineY - 32
              const y2 = row.baselineY + 32
              const labelY = row.baselineY - 39
              return (
                <g key={`loading-${row.genomeKey}`} pointerEvents="none">
                  {[edges.left, edges.right].map((x, idx) => (
                    <g key={`${row.genomeKey}-loading-edge-${idx}`}>
                      <line
                        x1={x}
                        y1={y1}
                        x2={x}
                        y2={y2}
                        stroke={loadingEdgeColor}
                        strokeWidth="2"
                        strokeDasharray="4 3"
                        strokeOpacity="0.9"
                      />
                      <circle
                        cx={x}
                        cy={row.baselineY}
                        r="4"
                        fill={loadingEdgeBg}
                        stroke={loadingEdgeColor}
                        strokeWidth="1.5"
                      />
                      <rect
                        x={idx === 0 ? x - 60 : x + 6}
                        y={labelY - 11}
                        width="54"
                        height="18"
                        rx="5"
                        fill={loadingEdgeBg}
                        stroke={loadingEdgeColor}
                        strokeWidth="1"
                      />
                      <text
                        x={idx === 0 ? x - 33 : x + 33}
                        y={labelY + 2}
                        textAnchor="middle"
                        fill={loadingEdgeColor}
                        fontSize="10"
                        fontWeight="700"
                      >
                        Loading
                      </text>
                    </g>
                  ))}
                </g>
              )
            })}

            {selectionRect && (
              <rect
                x={selectionRect.x}
                y={selectionRect.y}
                width={selectionRect.width}
                height={selectionRect.height}
                fill={isLight ? 'rgba(0, 153, 255, 0.14)' : 'rgba(96, 165, 250, 0.18)'}
                stroke={isLight ? '#0099ff' : '#60a5fa'}
                strokeWidth="1.5"
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            )}
          </svg>
        </div>
        {useHomology && (
          <div className={`px-3 py-1.5 border-t ${toolbarBgClass} flex items-center gap-4 text-[11px]`}>
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-5" style={{ backgroundColor: rbhLinkColor }} />
              <span className={textMutedClass}>RBH (reciprocal best hit)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-5" style={{ backgroundColor: linkColor }} />
              <span className={textMutedClass}>Regular best hit / approximate match</span>
            </div>
          </div>
        )}
        {noHitGenomeLabels.length > 0 && (
          <div className={`px-3 py-1.5 border-t ${toolbarBgClass} text-[11px] ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
            No hit found for genome{noHitGenomeLabels.length > 1 ? 's' : ''}: {noHitGenomeLabels.join(', ')}
          </div>
        )}
      </div>
    </div>
  )
}

export default function NeighbourhoodViewWrapper(props) {
  return (
    <NeighbourhoodErrorBoundary>
      <NeighbourhoodView {...props} />
    </NeighbourhoodErrorBoundary>
  )
}
