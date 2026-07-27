import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../backendRuntime'

const SECONDARY_ACCENT = '#00B692'

const SIDE_PRIMARY = 'primary'
const SIDE_SECONDARY = 'secondary'

const HIDDEN_TABLE_COLUMNS = new Set([
    'query_species',
    'query_assembly',
    'query_gene_stable_id',
    'query_gene_name',
])

const COLUMN_LABELS = {
    ref_species: 'Species',
    ref_assembly: 'Assembly',
    ref_gene_stable_id: 'Gene ID',
    ref_gene_name: 'Symbol',
    homology_type: 'Type',
    query_perc_id: 'Protein Identity',
    query_perc_cov: 'Coverage',
}

const STATUS_META = {
    common: { label: 'Common', className: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
    primary_only: { label: 'Primary only', className: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
    secondary_only: { label: 'Secondary only', className: 'bg-teal-500/20 text-teal-300 border-teal-500/40' },
}

function createPanelState() {
    return {
        query: '',
        loading: false,
        error: '',
        columns: [],
        rows: [],
        summary: null,
        collapsed: false,
    }
}

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

function clampPercent(value) {
    const n = toNumberOrNull(value)
    if (n === null) return null
    if (n < 0) return 0
    if (n > 100) return 100
    return n
}

function formatPercent(value) {
    const n = clampPercent(value)
    if (n === null) return '—'
    return `${n.toFixed(2)}%`
}

function identityHeatColor(value) {
    const n = clampPercent(value)
    if (n === null) return '#9ca3af'
    const t = n / 100
    const eased = Math.pow(t, 1.9)
    const light = 93 - (50 * eased)
    return `hsl(211, 90%, ${light}%)`
}

function compareValues(a, b) {
    const aNum = toNumberOrNull(a)
    const bNum = toNumberOrNull(b)
    if (aNum !== null && bNum !== null) return aNum - bNum
    return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' })
}

function normalizeAssemblyName(value) {
    const normalized = String(value || '').trim().toLowerCase()
    if (!normalized) return ''
    if (normalized === 'grch38' || normalized === 'grch38.p14') return 'grch38'
    return normalized
}

function normalizeSpeciesValue(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '_')
}

function formatColumnName(column) {
    const direct = COLUMN_LABELS[String(column || '')]
    if (direct) return direct
    return String(column || '')
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
}

function formatSpeciesValue(rawSpecies) {
    const raw = String(rawSpecies || '').trim()
    if (!raw) return ''
    const normalized = raw.replace(/_/g, ' ')
    const parts = normalized.split(/\s+/).filter(Boolean)
    if (parts.length < 2) return normalized
    const genus = parts[0]
    const species = parts.slice(1).join(' ')
    return `${genus.charAt(0).toUpperCase()}. ${species.toLowerCase()}`
}

function formatSpeciesFullName(rawSpecies) {
    const raw = String(rawSpecies || '').trim()
    if (!raw) return ''
    const normalized = raw.replace(/_/g, ' ')
    const parts = normalized.split(/\s+/).filter(Boolean)
    if (!parts.length) return normalized
    const genus = parts[0]
    const species = parts.slice(1).join(' ')
    if (!species) return genus.charAt(0).toUpperCase() + genus.slice(1).toLowerCase()
    return `${genus.charAt(0).toUpperCase() + genus.slice(1).toLowerCase()} ${species.toLowerCase()}`
}

function formatHomologyType(rawType) {
    const raw = String(rawType || '').trim().toLowerCase()
    if (raw === 'homolog_rbbh') return { label: 'RBBH', tooltip: 'Reciprocal Best BLAST Hit' }
    if (raw === 'homolog_bbh') return { label: 'BBH', tooltip: 'Best BLAST Hit' }
    return { label: String(rawType || ''), tooltip: String(rawType || '') }
}

function looksLikeStableGeneId(value) {
    const raw = String(value || '').trim()
    if (!raw) return false
    return /^ENS[A-Z0-9]*(?:G|T|P)\d+(?:\.\d+)?$/i.test(raw)
}

function processFetchedRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((row, idx) => {
        const identity = toNumberOrNull(row?.query_perc_id)
        const coverage = toNumberOrNull(row?.query_perc_cov)
        const combinedScore = identity !== null && coverage !== null
            ? (identity * 0.6) + (coverage * 0.4)
            : (identity ?? coverage ?? -1)
        return {
            ...row,
            __row_index: idx,
            __query_perc_id_num: identity,
            __query_perc_cov_num: coverage,
            __combined_score: combinedScore,
        }
    })
}

function getUniqueTypes(rows) {
    const seen = new Set()
    for (const row of rows || []) {
        const type = String(row?.homology_type || '').trim()
        if (type) seen.add(type)
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b))
}

function getQueryGeneBanner(rows, summary = null, queryText = '') {
    const scope = String(summary?.matchScope || 'query')
    if (scope !== 'query') {
        const trimmedQuery = String(queryText || '').trim()
        if (!trimmedQuery) return { geneIdText: '—', symbolText: '—' }
        if (looksLikeStableGeneId(trimmedQuery)) return { geneIdText: trimmedQuery, symbolText: '—' }
        return { geneIdText: '—', symbolText: trimmedQuery }
    }
    if (!rows.length) return { geneIdText: '—', symbolText: '—' }

    const ids = Array.from(new Set(rows.map((row) => String(row?.query_gene_stable_id || '').trim()).filter(Boolean)))
    const symbols = Array.from(new Set(rows.map((row) => String(row?.query_gene_name || '').trim()).filter(Boolean)))

    const compact = (values) => {
        if (!values.length) return '—'
        if (values.length === 1) return values[0]
        return `${values[0]} (+${values.length - 1})`
    }

    return {
        geneIdText: compact(ids),
        symbolText: compact(symbols),
    }
}

function buildGeneFocusFromHitRow(row) {
    if (!row) return null
    const id = String(row?.ref_gene_stable_id || '').trim()
    const name = String(row?.ref_gene_name || '').trim()
    if (!id && !name) return null
    return { id: id || name, name: name || id }
}

function buildGeneFocusFromQuery(queryText, rows) {
    const query = String(queryText || '').trim()
    const first = Array.isArray(rows) ? rows[0] : null
    const queryId = String(first?.query_gene_stable_id || '').trim()
    const queryName = String(first?.query_gene_name || '').trim()
    const id = queryId || query || queryName
    const name = queryName || query || queryId
    if (!id && !name) return null
    return { id: id || name, name: name || id }
}

function getHitKey(row) {
    const species = normalizeSpeciesValue(row?.ref_species)
    const assembly = normalizeAssemblyName(row?.ref_assembly)
    const geneId = String(row?.ref_gene_stable_id || '').trim().toLowerCase()
    const geneName = String(row?.ref_gene_name || '').trim().toLowerCase()
    if (!species && !assembly && !geneId && !geneName) return ''
    return [species, assembly, geneId || `name:${geneName}`].join('|')
}

function choosePreferredRow(a, b) {
    const aScore = toNumberOrNull(a?.__combined_score) ?? -1
    const bScore = toNumberOrNull(b?.__combined_score) ?? -1
    if (bScore > aScore) return b
    if (aScore > bScore) return a
    return Number(b?.__row_index || 0) < Number(a?.__row_index || 0) ? b : a
}

function buildComparisonRows(primaryRows, secondaryRows) {
    const primaryMap = new Map()
    for (const row of primaryRows || []) {
        const key = getHitKey(row)
        if (!key) continue
        primaryMap.set(key, primaryMap.has(key) ? choosePreferredRow(primaryMap.get(key), row) : row)
    }

    const secondaryMap = new Map()
    for (const row of secondaryRows || []) {
        const key = getHitKey(row)
        if (!key) continue
        secondaryMap.set(key, secondaryMap.has(key) ? choosePreferredRow(secondaryMap.get(key), row) : row)
    }

    const allKeys = new Set([...primaryMap.keys(), ...secondaryMap.keys()])
    const out = []

    for (const key of allKeys) {
        const primaryRow = primaryMap.get(key) || null
        const secondaryRow = secondaryMap.get(key) || null
        const status = primaryRow && secondaryRow
            ? 'common'
            : (primaryRow ? 'primary_only' : 'secondary_only')
        const row = primaryRow || secondaryRow
        out.push({
            key,
            status,
            primaryRow,
            secondaryRow,
            hitSpecies: String(row?.ref_species || ''),
            hitAssembly: String(row?.ref_assembly || ''),
            hitGeneId: String(row?.ref_gene_stable_id || ''),
            hitSymbol: String(row?.ref_gene_name || ''),
        })
    }

    const statusRank = { common: 0, primary_only: 1, secondary_only: 2 }
    out.sort((a, b) => {
        const rankDiff = (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99)
        if (rankDiff !== 0) return rankDiff

        const aScore = Math.max(
            toNumberOrNull(a.primaryRow?.__combined_score) ?? -1,
            toNumberOrNull(a.secondaryRow?.__combined_score) ?? -1
        )
        const bScore = Math.max(
            toNumberOrNull(b.primaryRow?.__combined_score) ?? -1,
            toNumberOrNull(b.secondaryRow?.__combined_score) ?? -1
        )
        if (bScore !== aScore) return bScore - aScore

        return String(a.key).localeCompare(String(b.key), undefined, { numeric: true, sensitivity: 'base' })
    })

    return out
}

function applyGlobalFilters(rows, filters, unionTypes, isLocalGenomeRow) {
    let next = [...(rows || [])]

    if (filters.localPriority === 'local_only') {
        next = next.filter((row) => isLocalGenomeRow(row))
    }

    const minId = filters.minIdentity === '' ? null : toNumberOrNull(filters.minIdentity)
    const minCov = filters.minCoverage === '' ? null : toNumberOrNull(filters.minCoverage)

    if (minId !== null) {
        next = next.filter((row) => {
            const value = row.__query_perc_id_num
            return value !== null && value >= minId
        })
    }

    if (minCov !== null) {
        next = next.filter((row) => {
            const value = row.__query_perc_cov_num
            return value !== null && value >= minCov
        })
    }

    const selectedTypes = (filters.selectedTypes || []).filter((type) => unionTypes.includes(type))
    if (selectedTypes.length > 0 && selectedTypes.length < unionTypes.length) {
        const keep = new Set(selectedTypes)
        next = next.filter((row) => keep.has(String(row?.homology_type || '').trim()))
    }

    const direction = filters.sortDirection === 'asc' ? 1 : -1
    next.sort((a, b) => {
        if (filters.localPriority === 'local_first') {
            const localDiff = Number(isLocalGenomeRow(b)) - Number(isLocalGenomeRow(a))
            if (localDiff !== 0) return localDiff
        }

        let cmp = 0
        if (filters.sortKey === 'combined') {
            cmp = compareValues(a.__combined_score, b.__combined_score)
        } else if (filters.sortKey === 'query_perc_id') {
            cmp = compareValues(a.__query_perc_id_num, b.__query_perc_id_num)
        } else if (filters.sortKey === 'query_perc_cov') {
            cmp = compareValues(a.__query_perc_cov_num, b.__query_perc_cov_num)
        } else {
            cmp = compareValues(a?.[filters.sortKey], b?.[filters.sortKey])
        }
        if (cmp !== 0) return cmp * direction
        return Number(a.__row_index || 0) - Number(b.__row_index || 0)
    })

    return next
}

export default function HomologyView({
    theme = 'dark',
    config,
    refSpecies = null,
    tgtSpecies = null,
    refPillLabel = '',
    tgtPillLabel = '',
    refResolved = null,
    tgtResolved = null,
    browserRefGene = null,
    browserTgtGene = null,
    onRefPillClick = null,
    onTgtPillClick = null,
    onRefGeneFocus = null,
    onTgtGeneFocus = null,
}) {
    const isLight = theme === 'light'
    const panelClass = isLight ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-800 border border-gray-700'
    const subtlePanelClass = isLight ? 'bg-gray-50 border border-gray-200' : 'bg-gray-750 border border-gray-700'
    const labelClass = isLight ? 'text-gray-600' : 'text-gray-300'
    const mutedClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const inputClass = isLight
        ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-[#0099ff]/40 focus:border-[#0099ff]'
        : 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500/40 focus:border-blue-500'
    const buttonClass = isLight
        ? 'bg-[#0099ff] hover:bg-[#0088ee] text-white'
        : 'bg-blue-600 hover:bg-blue-500 text-white'

    const [panels, setPanels] = useState({
        [SIDE_PRIMARY]: createPanelState(),
        [SIDE_SECONDARY]: createPanelState(),
    })

    const [filtersExpanded, setFiltersExpanded] = useState(false)
    const [sortKey, setSortKey] = useState('combined')
    const [sortDirection, setSortDirection] = useState('desc')
    const [localPriority, setLocalPriority] = useState('score')
    const [minIdentity, setMinIdentity] = useState('')
    const [minCoverage, setMinCoverage] = useState('')
    const [selectedTypes, setSelectedTypes] = useState([])
    const [visibleColumns, setVisibleColumns] = useState([])
    const [comparisonCollapsed, setComparisonCollapsed] = useState(false)

    const queryManuallyEditedRef = useRef({ [SIDE_PRIMARY]: false, [SIDE_SECONDARY]: false })
    const previousSourceKeyRef = useRef({ [SIDE_PRIMARY]: '', [SIDE_SECONDARY]: '' })

    const hasSecondary = Boolean(tgtSpecies)

    const primaryHomologyPath = refSpecies?.files?.homology || config?.homologies_file || ''
    const secondaryHomologyPath = tgtSpecies?.files?.homology || ''

    const primarySourceKey = refSpecies?.files?.gff3 || ''
    const secondarySourceKey = tgtSpecies?.files?.gff3 || ''

    const setPanel = useCallback((side, updater) => {
        setPanels((prev) => {
            const current = prev[side]
            const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater }
            if (next === current) return prev
            return { ...prev, [side]: next }
        })
    }, [])

    const primaryCandidate = useMemo(() => {
        return (
            browserRefGene?.name ||
            browserRefGene?.id ||
            refResolved?.gene?.name ||
            refResolved?.gene?.id ||
            refResolved?.selectedTranscriptId ||
            ''
        )
    }, [
        browserRefGene?.name,
        browserRefGene?.id,
        refResolved?.gene?.name,
        refResolved?.gene?.id,
        refResolved?.selectedTranscriptId,
    ])

    const secondaryCandidate = useMemo(() => {
        return (
            browserTgtGene?.name ||
            browserTgtGene?.id ||
            tgtResolved?.gene?.name ||
            tgtResolved?.gene?.id ||
            tgtResolved?.selectedTranscriptId ||
            ''
        )
    }, [
        browserTgtGene?.name,
        browserTgtGene?.id,
        tgtResolved?.gene?.name,
        tgtResolved?.gene?.id,
        tgtResolved?.selectedTranscriptId,
    ])

    const syncQueryFromCandidate = useCallback((side, candidate, sourceKey) => {
        const trimmedCandidate = String(candidate || '').trim()
        const previousKey = previousSourceKeyRef.current[side] || ''
        const sourceChanged = previousKey !== sourceKey

        if (sourceChanged) {
            previousSourceKeyRef.current[side] = sourceKey
            queryManuallyEditedRef.current[side] = false
            setPanel(side, (curr) => {
                const currentQuery = curr.query.trim()
                if (looksLikeStableGeneId(currentQuery)) {
                    return { ...curr, query: '' }
                }
                return curr
            })
            return
        }

        if (!trimmedCandidate) return
        if (queryManuallyEditedRef.current[side]) return

        setPanel(side, (curr) => {
            if (curr.query.trim()) return curr
            return { ...curr, query: trimmedCandidate }
        })
    }, [setPanel])

    useEffect(() => {
        syncQueryFromCandidate(SIDE_PRIMARY, primaryCandidate, primarySourceKey)
    }, [syncQueryFromCandidate, primaryCandidate, primarySourceKey])

    useEffect(() => {
        syncQueryFromCandidate(SIDE_SECONDARY, secondaryCandidate, secondarySourceKey)
    }, [syncQueryFromCandidate, secondaryCandidate, secondarySourceKey])

    useEffect(() => {
        setPanel(SIDE_PRIMARY, (curr) => ({ ...curr, rows: [], columns: [], summary: null, error: '' }))
    }, [primaryHomologyPath, primarySourceKey, setPanel])

    useEffect(() => {
        setPanel(SIDE_SECONDARY, (curr) => ({ ...curr, rows: [], columns: [], summary: null, error: '' }))
    }, [secondaryHomologyPath, secondarySourceKey, setPanel])

    const runHomologyQuery = useCallback(async (side) => {
        const panel = panels[side]
        const queryText = String(panel.query || '').trim()
        const path = side === SIDE_PRIMARY ? primaryHomologyPath : secondaryHomologyPath
        const focusHandler = side === SIDE_PRIMARY ? onRefGeneFocus : onTgtGeneFocus

        if (!queryText) {
            setPanel(side, (curr) => ({ ...curr, error: 'Enter a gene symbol or stable ID.', rows: [], columns: [], summary: null }))
            return
        }

        if (!path) {
            setPanel(side, (curr) => ({ ...curr, error: 'No homology file configured for this genome.', rows: [], columns: [], summary: null }))
            return
        }

        setPanel(side, (curr) => ({ ...curr, loading: true, error: '' }))

        try {
            const params = new URLSearchParams({
                path,
                gene_query: queryText,
                limit: '15000',
            })
            const res = await fetch(`${API_BASE}/api/homology/query?${params.toString()}`)
            if (!res.ok) {
                const err = await res.json().catch(() => ({}))
                throw new Error(err.detail || 'Failed to query homology table.')
            }

            const data = await res.json()
            const fetchedColumnsRaw = Array.isArray(data.columns) ? data.columns : []
            const fetchedColumns = fetchedColumnsRaw.filter((column) => !HIDDEN_TABLE_COLUMNS.has(column))
            const processedRows = processFetchedRows(data.rows)

            setPanel(side, (curr) => ({
                ...curr,
                loading: false,
                error: '',
                columns: fetchedColumns,
                rows: processedRows,
                summary: {
                    query: data.query || queryText,
                    matchedBy: data.matched_by || 'exact',
                    matchScope: data.match_scope || 'query',
                    totalMatches: Number(data.total_matches || processedRows.length),
                    returnedRows: Number(data.returned_rows || processedRows.length),
                    truncated: Boolean(data.truncated),
                },
            }))

            if (focusHandler) {
                const matchScope = String(data.match_scope || 'query')
                const focusGene = matchScope === 'query'
                    ? buildGeneFocusFromQuery(queryText, processedRows)
                    : { id: queryText, name: queryText }
                if (focusGene) focusHandler(focusGene)
            }
        } catch (e) {
            setPanel(side, (curr) => ({
                ...curr,
                loading: false,
                error: e.message || 'Failed to query homology table.',
                columns: [],
                rows: [],
                summary: null,
            }))
        }
    }, [panels, primaryHomologyPath, secondaryHomologyPath, onRefGeneFocus, onTgtGeneFocus, setPanel])

    const allColumns = useMemo(() => {
        const seen = new Set()
        const out = []
        for (const col of panels[SIDE_PRIMARY].columns || []) {
            if (seen.has(col)) continue
            seen.add(col)
            out.push(col)
        }
        for (const col of panels[SIDE_SECONDARY].columns || []) {
            if (seen.has(col)) continue
            seen.add(col)
            out.push(col)
        }
        return out
    }, [panels])

    const allTypes = useMemo(() => {
        const primaryTypes = getUniqueTypes(panels[SIDE_PRIMARY].rows)
        const secondaryTypes = getUniqueTypes(panels[SIDE_SECONDARY].rows)
        return Array.from(new Set([...primaryTypes, ...secondaryTypes])).sort((a, b) => a.localeCompare(b))
    }, [panels])

    useEffect(() => {
        setVisibleColumns((prev) => {
            if (!allColumns.length) return []
            if (!prev.length) return [...allColumns]
            const keep = prev.filter((col) => allColumns.includes(col))
            const append = allColumns.filter((col) => !keep.includes(col))
            return [...keep, ...append]
        })
    }, [allColumns])

    useEffect(() => {
        setSelectedTypes((prev) => {
            if (!allTypes.length) return []
            if (!prev.length) return [...allTypes]
            const keep = prev.filter((type) => allTypes.includes(type))
            return keep.length ? keep : [...allTypes]
        })
    }, [allTypes])

    const filters = useMemo(() => ({
        sortKey,
        sortDirection,
        localPriority,
        minIdentity,
        minCoverage,
        selectedTypes,
    }), [sortKey, sortDirection, localPriority, minIdentity, minCoverage, selectedTypes])

    const topListAssemblies = useMemo(() => {
        const assemblies = new Set()
        for (const species of (config?.active_species || [])) {
            const isInTopList = species?.files?.gff3 !== config?.ref_gff && species?.files?.gff3 !== config?.target_gff
            if (!isInTopList) continue
            const assemblyName = normalizeAssemblyName(species?.assembly_name)
            if (assemblyName) assemblies.add(assemblyName)
        }
        return assemblies
    }, [config?.active_species, config?.ref_gff, config?.target_gff])

    const isLocalGenomeRow = useCallback((row) => {
        if (!topListAssemblies.size) return false
        const rowAssembly = normalizeAssemblyName(row?.ref_assembly)
        if (!rowAssembly) return false
        return topListAssemblies.has(rowAssembly)
    }, [topListAssemblies])

    const primaryDisplayedRows = useMemo(() => {
        return applyGlobalFilters(panels[SIDE_PRIMARY].rows, filters, allTypes, isLocalGenomeRow)
    }, [panels, filters, allTypes, isLocalGenomeRow])

    const secondaryDisplayedRows = useMemo(() => {
        return applyGlobalFilters(panels[SIDE_SECONDARY].rows, filters, allTypes, isLocalGenomeRow)
    }, [panels, filters, allTypes, isLocalGenomeRow])

    const primaryQueryBanner = useMemo(
        () => getQueryGeneBanner(panels[SIDE_PRIMARY].rows, panels[SIDE_PRIMARY].summary, panels[SIDE_PRIMARY].query),
        [panels]
    )
    const secondaryQueryBanner = useMemo(
        () => getQueryGeneBanner(panels[SIDE_SECONDARY].rows, panels[SIDE_SECONDARY].summary, panels[SIDE_SECONDARY].query),
        [panels]
    )

    const primaryLocalCount = useMemo(
        () => panels[SIDE_PRIMARY].rows.reduce((count, row) => count + (isLocalGenomeRow(row) ? 1 : 0), 0),
        [panels, isLocalGenomeRow]
    )

    const secondaryLocalCount = useMemo(
        () => panels[SIDE_SECONDARY].rows.reduce((count, row) => count + (isLocalGenomeRow(row) ? 1 : 0), 0),
        [panels, isLocalGenomeRow]
    )

    const sortOptions = useMemo(() => {
        const base = [
            { id: 'combined', label: 'Combined score (Protein Identity + Coverage)' },
            { id: 'query_perc_id', label: 'Protein Identity score' },
            { id: 'query_perc_cov', label: 'Coverage score' },
        ]
        const dynamic = allColumns
            .filter((col) => !['query_perc_id', 'query_perc_cov'].includes(col))
            .map((col) => ({ id: col, label: formatColumnName(col) }))
        return [...base, ...dynamic]
    }, [allColumns])

    const comparisonRows = useMemo(
        () => buildComparisonRows(primaryDisplayedRows, secondaryDisplayedRows),
        [primaryDisplayedRows, secondaryDisplayedRows]
    )

    const comparisonCounts = useMemo(() => {
        let common = 0
        let primaryOnly = 0
        let secondaryOnly = 0
        for (const row of comparisonRows) {
            if (row.status === 'common') common += 1
            else if (row.status === 'primary_only') primaryOnly += 1
            else if (row.status === 'secondary_only') secondaryOnly += 1
        }
        return { common, primaryOnly, secondaryOnly }
    }, [comparisonRows])

    const renderGenomePill = ({ label, isActive, onClick, title, showNoFile = false, accent = null }) => (
        <button
            type="button"
            onClick={onClick}
            disabled={!onClick}
            className="inline-flex w-[220px] items-center rounded-full border px-3 py-1.5 text-xs font-medium"
            style={{
                backgroundColor: isActive
                    ? (accent || (isLight ? '#0099ff' : '#0077cc'))
                    : (isLight ? '#ffffff' : '#1E2938'),
                color: isActive
                    ? '#ffffff'
                    : (isLight ? '#4b5563' : '#9ca3af'),
                borderColor: isActive
                    ? 'transparent'
                    : (isLight ? '#d1d5db' : '#4b5563'),
                cursor: onClick ? 'pointer' : 'default',
            }}
            title={title}
        >
            <span className="truncate">{label}</span>
            {showNoFile && <span className="ml-2 text-[10px] font-semibold">No file</span>}
        </button>
    )

    const queryDisplay = useCallback((side, banner) => {
        const panel = panels[side]
        const manual = queryManuallyEditedRef.current[side]
        const query = String(panel.query || '').trim()
        if (manual && query) return query
        if (banner.symbolText !== '—') return banner.symbolText
        if (banner.geneIdText !== '—') return banner.geneIdText
        return query || '—'
    }, [panels])

    const renderControlSide = ({
        side,
        species,
        pillLabel,
        path,
        banner,
        onPillClick,
        onLoad,
        missingMessage,
    }) => {
        const panel = panels[side]
        const canLoad = Boolean(species && path)
        const sourceFile = path ? path.split('/').pop() : ''

        return (
            <div className={`rounded-lg ${subtlePanelClass} p-3`}>
                <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                        {renderGenomePill({
                            label: pillLabel || 'Genome',
                            isActive: true,
                            onClick: onPillClick,
                            title: `${pillLabel || 'Genome'} (click to deactivate)`,
                            showNoFile: !path,
                            accent: side === SIDE_SECONDARY ? SECONDARY_ACCENT : null,
                        })}
                    </div>
                    <div className={`text-xs ${mutedClass} text-right`}>
                        Query: <span className={labelClass}>{queryDisplay(side, banner)}</span>
                    </div>
                </div>

                <form
                    onSubmit={(e) => {
                        e.preventDefault()
                        onLoad()
                    }}
                    className="flex items-center gap-2"
                >
                    <input
                        type="text"
                        value={panel.query}
                        onChange={(e) => {
                            queryManuallyEditedRef.current[side] = true
                            const value = e.target.value
                            setPanel(side, (curr) => ({ ...curr, query: value }))
                        }}
                        placeholder="Gene symbol or stable ID"
                        className={`flex-1 border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 transition-colors ${inputClass}`}
                    />
                    <button
                        type="submit"
                        disabled={panel.loading || !panel.query.trim() || !canLoad}
                        className={`px-4 py-2 rounded text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${buttonClass}`}
                    >
                        {panel.loading ? 'Loading...' : 'Load'}
                    </button>
                </form>

                <div className={`mt-2 text-xs ${mutedClass}`}>
                    Source: <span className={labelClass}>{sourceFile || 'Not configured'}</span>
                </div>
                {!canLoad && (
                    <div className="mt-1 text-xs text-amber-400">{missingMessage}</div>
                )}
                {panel.error && (
                    <div className="mt-1 text-xs text-red-400">{panel.error}</div>
                )}
            </div>
        )
    }

    const renderDataCell = (row, column, colIdx, isLocalRow, cellKey) => {
        const baseClass = `${(column === 'query_perc_id' || column === 'query_perc_cov') ? '' : 'whitespace-nowrap'} ${isLocalRow
            ? (isLight ? 'bg-blue-100 text-blue-900 font-medium' : 'bg-blue-900/45 text-blue-100 font-medium')
            : (isLight ? 'bg-white text-gray-800' : 'bg-transparent text-gray-200')
            } ${isLocalRow && colIdx === 0 ? (isLight ? 'border-l-2 border-blue-400' : 'border-l-2 border-blue-300') : ''}`

        if (column === 'ref_species') {
            const raw = String(row?.[column] ?? '')
            const label = formatSpeciesValue(raw) || '—'
            const fullLabel = formatSpeciesFullName(raw) || label
            return (
                <td key={cellKey} className={`px-3 py-2 ${baseClass}`}>
                    <span className="inline-block max-w-[130px] truncate align-middle" title={fullLabel}>{label}</span>
                </td>
            )
        }

        if (column === 'ref_assembly') {
            const raw = String(row?.[column] ?? '')
            const label = raw || '—'
            return (
                <td key={cellKey} className={`px-3 py-2 ${baseClass}`}>
                    <span className="inline-block max-w-[145px] truncate align-middle" title={raw || label}>{label}</span>
                </td>
            )
        }

        if (column === 'homology_type') {
            const { label, tooltip } = formatHomologyType(row?.[column])
            return (
                <td key={cellKey} className={`px-3 py-2 ${baseClass}`}>
                    <span title={tooltip || label}>{label || '—'}</span>
                </td>
            )
        }

        if (column === 'query_perc_id') {
            const value = clampPercent(row?.__query_perc_id_num ?? row?.[column])
            if (value === null) return <td key={cellKey} className={`px-3 py-2 ${baseClass}`}>—</td>
            const fillColor = identityHeatColor(value)
            const textColor = isLight ? '#374151' : '#e5e7eb'
            return (
                <td key={cellKey} className={`px-3 py-2 ${baseClass}`}>
                    <div className="flex items-center gap-2 min-w-[170px]" title={`Protein Identity: ${formatPercent(value)}`}>
                        <div className={`h-3.5 w-24 rounded-sm overflow-hidden ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`} aria-hidden="true">
                            <div className="h-full" style={{ width: `${value}%`, backgroundColor: fillColor }} />
                        </div>
                        <span className="text-xs tabular-nums" style={{ color: textColor }}>{formatPercent(value)}</span>
                    </div>
                </td>
            )
        }

        if (column === 'query_perc_cov') {
            const value = clampPercent(row?.__query_perc_cov_num ?? row?.[column])
            if (value === null) return <td key={cellKey} className={`px-3 py-2 ${baseClass}`}>—</td>
            const fillColor = identityHeatColor(value)
            const emptyColor = isLight ? '#dbeafe' : '#334155'
            const textColor = isLight ? '#374151' : '#e5e7eb'
            return (
                <td key={cellKey} className={`px-3 py-2 ${baseClass}`}>
                    <div className="flex items-center gap-2 min-w-[170px]" title={`Coverage: ${formatPercent(value)}`}>
                        <span
                            className="inline-block w-6 h-6 rounded-full"
                            style={{ background: `conic-gradient(${fillColor} 0% ${value}%, ${emptyColor} ${value}% 100%)` }}
                            aria-hidden="true"
                        />
                        <span className="text-xs tabular-nums" style={{ color: textColor }}>{formatPercent(value)}</span>
                    </div>
                </td>
            )
        }

        return <td key={cellKey} className={`px-3 py-2 ${baseClass}`}>{String(row?.[column] ?? '') || '—'}</td>
    }

    const handleTableRowClick = useCallback((side, row) => {
        const focusHandler = side === SIDE_PRIMARY ? onRefGeneFocus : onTgtGeneFocus
        if (!focusHandler) return
        const focusGene = buildGeneFocusFromHitRow(row)
        if (!focusGene) return
        focusHandler(focusGene)
    }, [onRefGeneFocus, onTgtGeneFocus])

    const renderResultsPanel = ({ side, pillLabel, onPillClick, rows, queryBanner }) => {
        const panel = panels[side]
        const tableRows = rows
        const tableColumns = (visibleColumns.length > 0 ? visibleColumns : allColumns)
        const canClickRows = (side === SIDE_PRIMARY && onRefGeneFocus) || (side === SIDE_SECONDARY && onTgtGeneFocus)

        const panelContainerClass = panel.collapsed
            ? `${panelClass} rounded-lg overflow-hidden h-[64px] min-h-[64px] flex flex-col`
            : `${panelClass} rounded-lg overflow-hidden h-[560px] min-h-[560px] flex flex-col`
        const headerClass = panel.collapsed
            ? `px-4 py-2.5 min-h-[64px] border-b ${isLight ? 'border-gray-200' : 'border-gray-700'} flex items-center justify-between gap-3`
            : `px-4 py-2.5 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'} flex items-center justify-between gap-3`

        return (
            <div className={panelContainerClass}>
                <div className={headerClass}>
                    <div className="min-w-0 flex items-center gap-3">
                        {renderGenomePill({
                            label: pillLabel || 'Genome',
                            isActive: true,
                            onClick: onPillClick,
                            title: `${pillLabel || 'Genome'} (click to deactivate)`,
                            showNoFile: false,
                            accent: side === SIDE_SECONDARY ? SECONDARY_ACCENT : null,
                        })}
                        <div className={`text-xs ${mutedClass} truncate`}>
                            Query Gene ID: <span className={labelClass}>{queryBanner.geneIdText}</span>
                            <span className="ml-3">Query Symbol: <span className={labelClass}>{queryBanner.symbolText}</span></span>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className={`text-xs ${mutedClass}`}>{tableRows.length} shown</span>
                        <button
                            type="button"
                            onClick={() => setPanel(side, (curr) => ({ ...curr, collapsed: !curr.collapsed }))}
                            className={`p-1 rounded ${isLight ? 'hover:bg-gray-100 text-gray-500' : 'hover:bg-gray-700 text-gray-300'}`}
                            title={panel.collapsed ? 'Expand table' : 'Collapse table'}
                        >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                {panel.collapsed ? <path d="M4 6l4 4 4-4" /> : <path d="M4 10l4-4 4 4" />}
                            </svg>
                        </button>
                    </div>
                </div>

                {!panel.collapsed && (
                    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
                        {panel.loading ? (
                            <div className="h-full flex items-center justify-center">
                                <div className={`text-sm ${mutedClass}`}>Loading homologies...</div>
                            </div>
                        ) : panel.rows.length === 0 ? (
                            <div className="h-full flex items-center justify-center px-6">
                                <div className={`text-sm text-center ${mutedClass}`}>
                                    Search and load to view homology rows for this genome.
                                </div>
                            </div>
                        ) : tableColumns.length === 0 ? (
                            <div className="h-full flex items-center justify-center px-6">
                                <div className={`text-sm text-center ${mutedClass}`}>
                                    Select at least one visible column in Table Filters & Display.
                                </div>
                            </div>
                        ) : (
                            <table className="w-full min-w-max text-sm">
                                <thead className={`sticky top-0 z-10 ${isLight ? 'bg-gray-100 text-gray-600' : 'bg-gray-900 text-gray-300'}`}>
                                    <tr>
                                        {tableColumns.map((column) => (
                                            <th key={`${side}-${column}`} className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">
                                                {formatColumnName(column)}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {tableRows.map((row, idx) => {
                                        const isLocalRow = isLocalGenomeRow(row)
                                        const rowFocus = buildGeneFocusFromHitRow(row)
                                        const clickable = Boolean(canClickRows && rowFocus)
                                        return (
                                            <tr
                                                key={`${side}-${row.__row_index}-${idx}`}
                                                className={`border-b ${isLight ? 'border-gray-100' : 'border-gray-700/40'} ${clickable ? (isLight ? 'cursor-pointer hover:bg-blue-50/40' : 'cursor-pointer hover:bg-blue-900/20') : ''}`}
                                                onClick={() => clickable && handleTableRowClick(side, row)}
                                            >
                                                {tableColumns.map((column, colIdx) => (
                                                    renderDataCell(row, column, colIdx, isLocalRow, `${side}-${row.__row_index}-${column}`)
                                                ))}
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                )}
            </div>
        )
    }

    const handleComparisonRowClick = useCallback((entry) => {
        if (entry.primaryRow && onRefGeneFocus) {
            const gene = buildGeneFocusFromHitRow(entry.primaryRow)
            if (gene) onRefGeneFocus(gene)
        }
        if (entry.secondaryRow && onTgtGeneFocus) {
            const gene = buildGeneFocusFromHitRow(entry.secondaryRow)
            if (gene) onTgtGeneFocus(gene)
        }
    }, [onRefGeneFocus, onTgtGeneFocus])

    if (!refSpecies) {
        return (
            <div className="h-full flex flex-col gap-4">
                <div className={`${panelClass} rounded-lg p-6 flex items-center justify-center`}>
                    <div className={`text-sm ${mutedClass}`}>
                        Activate one or two genomes with homology TSV files to query homologies.
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="h-full overflow-y-auto pr-1 flex flex-col gap-4">
            <div className={`${panelClass} rounded-lg p-4`}>
                <div className={`grid gap-3 ${hasSecondary ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {renderControlSide({
                        side: SIDE_PRIMARY,
                        species: refSpecies,
                        pillLabel: refPillLabel || 'Primary genome',
                        path: primaryHomologyPath,
                        banner: primaryQueryBanner,
                        onPillClick: onRefPillClick,
                        onLoad: () => runHomologyQuery(SIDE_PRIMARY),
                        missingMessage: 'No homology file for primary genome.',
                    })}

                    {hasSecondary && renderControlSide({
                        side: SIDE_SECONDARY,
                        species: tgtSpecies,
                        pillLabel: tgtPillLabel || 'Secondary genome',
                        path: secondaryHomologyPath,
                        banner: secondaryQueryBanner,
                        onPillClick: onTgtPillClick,
                        onLoad: () => runHomologyQuery(SIDE_SECONDARY),
                        missingMessage: hasSecondary
                            ? 'No homology file for secondary genome.'
                            : 'Activate a secondary genome to enable this side.',
                    })}
                </div>

                <div className={`mt-3 rounded-lg ${subtlePanelClass} p-3`}>
                    <button
                        type="button"
                        onClick={() => setFiltersExpanded((prev) => !prev)}
                        className={`w-full flex items-center justify-between text-sm font-semibold ${labelClass}`}
                    >
                        <span>Table Filters & Display</span>
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`transition-transform ${filtersExpanded ? 'rotate-180' : ''}`}
                        >
                            <path d="M4 6l4 4 4-4" />
                        </svg>
                    </button>

                    {filtersExpanded && (
                        <div className="mt-3 grid grid-cols-1 xl:grid-cols-2 gap-4">
                            <div className="space-y-3">
                                <div>
                                    <label className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${mutedClass}`}>Sort by</label>
                                    <select
                                        value={sortKey}
                                        onChange={(e) => setSortKey(e.target.value)}
                                        className={`w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 ${inputClass}`}
                                    >
                                        {sortOptions.map((option) => (
                                            <option key={option.id} value={option.id}>{option.label}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    <div>
                                        <label className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${mutedClass}`}>Direction</label>
                                        <select
                                            value={sortDirection}
                                            onChange={(e) => setSortDirection(e.target.value)}
                                            className={`w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 ${inputClass}`}
                                        >
                                            <option value="desc">Highest first</option>
                                            <option value="asc">Lowest first</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${mutedClass}`}>Genome list priority</label>
                                        <select
                                            value={localPriority}
                                            onChange={(e) => setLocalPriority(e.target.value)}
                                            className={`w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 ${inputClass}`}
                                        >
                                            <option value="score">Score only</option>
                                            <option value="local_first">Genome list first</option>
                                            <option value="local_only">Genome list only</option>
                                        </select>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    <div>
                                        <label className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${mutedClass}`}>Min protein identity %</label>
                                        <input
                                            type="text"
                                            inputMode="decimal"
                                            value={minIdentity}
                                            onChange={(e) => setMinIdentity(e.target.value)}
                                            className={`w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 ${inputClass}`}
                                            placeholder="Any"
                                        />
                                    </div>
                                    <div>
                                        <label className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${mutedClass}`}>Min coverage %</label>
                                        <input
                                            type="text"
                                            inputMode="decimal"
                                            value={minCoverage}
                                            onChange={(e) => setMinCoverage(e.target.value)}
                                            className={`w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 ${inputClass}`}
                                            placeholder="Any"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <div>
                                    <label className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${mutedClass}`}>Homology type</label>
                                    {allTypes.length === 0 ? (
                                        <div className={`text-xs ${mutedClass}`}>No homology types available.</div>
                                    ) : (
                                        <div className="max-h-24 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1.5 pr-1">
                                            {allTypes.map((type) => {
                                                const { label, tooltip } = formatHomologyType(type)
                                                const checked = selectedTypes.includes(type)
                                                return (
                                                    <label key={type} className={`inline-flex items-center gap-2 text-xs ${labelClass}`}>
                                                        <input
                                                            type="checkbox"
                                                            checked={checked}
                                                            onChange={() => {
                                                                setSelectedTypes((prev) => {
                                                                    if (prev.includes(type)) return prev.filter((item) => item !== type)
                                                                    return [...prev, type]
                                                                })
                                                            }}
                                                            className="rounded"
                                                        />
                                                        <span className="truncate" title={tooltip || label}>{label}</span>
                                                    </label>
                                                )
                                            })}
                                        </div>
                                    )}
                                </div>

                                <div>
                                    <label className={`block text-xs font-semibold uppercase tracking-wide mb-1 ${mutedClass}`}>Visible columns</label>
                                    {allColumns.length === 0 ? (
                                        <div className={`text-xs ${mutedClass}`}>Load data to choose visible columns.</div>
                                    ) : (
                                        <div className="max-h-32 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1.5 pr-1">
                                            {allColumns.map((column) => {
                                                const checked = visibleColumns.includes(column)
                                                return (
                                                    <label key={column} className={`inline-flex items-center gap-2 text-xs ${labelClass}`}>
                                                        <input
                                                            type="checkbox"
                                                            checked={checked}
                                                            onChange={() => {
                                                                setVisibleColumns((prev) => {
                                                                    if (prev.includes(column)) {
                                                                        if (prev.length <= 1) return prev
                                                                        return prev.filter((item) => item !== column)
                                                                    }
                                                                    const next = [...prev, column]
                                                                    return allColumns.filter((col) => next.includes(col))
                                                                })
                                                            }}
                                                            className="rounded"
                                                        />
                                                        <span className="truncate">{formatColumnName(column)}</span>
                                                    </label>
                                                )
                                            })}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {renderResultsPanel({
                side: SIDE_PRIMARY,
                pillLabel: refPillLabel || 'Primary genome',
                onPillClick: onRefPillClick,
                rows: primaryDisplayedRows,
                queryBanner: primaryQueryBanner,
            })}

            {hasSecondary && renderResultsPanel({
                side: SIDE_SECONDARY,
                pillLabel: tgtPillLabel || 'Secondary genome',
                onPillClick: onTgtPillClick,
                rows: secondaryDisplayedRows,
                queryBanner: secondaryQueryBanner,
            })}

            {hasSecondary && (
                <div className={comparisonCollapsed
                    ? `${panelClass} rounded-lg overflow-hidden h-[64px] min-h-[64px] flex flex-col`
                    : `${panelClass} rounded-lg overflow-hidden h-[560px] min-h-[560px] flex flex-col`}
                >
                    <div className={`px-4 py-2.5 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'} flex items-center justify-between`}>
                        <div className={`text-sm font-semibold ${labelClass}`}>Homology comparison</div>
                        <div className="flex items-center gap-2">
                            <div className={`text-xs ${mutedClass}`}>
                                Common: <span className={labelClass}>{comparisonCounts.common}</span>
                                <span className="ml-3">Primary-only: <span className={labelClass}>{comparisonCounts.primaryOnly}</span></span>
                                <span className="ml-3">Secondary-only: <span className={labelClass}>{comparisonCounts.secondaryOnly}</span></span>
                            </div>
                            <button
                                type="button"
                                onClick={() => setComparisonCollapsed((prev) => !prev)}
                                className={`p-1 rounded ${isLight ? 'hover:bg-gray-100 text-gray-500' : 'hover:bg-gray-700 text-gray-300'}`}
                                title={comparisonCollapsed ? 'Expand table' : 'Collapse table'}
                            >
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    {comparisonCollapsed ? <path d="M4 6l4 4 4-4" /> : <path d="M4 10l4-4 4 4" />}
                                </svg>
                            </button>
                        </div>
                    </div>

                    {!comparisonCollapsed && (
                        <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
                        {comparisonRows.length === 0 ? (
                            <div className="h-full flex items-center justify-center px-6">
                                <div className={`text-sm text-center ${mutedClass}`}>
                                    Load homology data for both genomes to compare shared and unique hits.
                                </div>
                            </div>
                        ) : (
                            <table className="w-full min-w-max text-sm">
                                <thead className={`sticky top-0 z-10 ${isLight ? 'bg-gray-100 text-gray-600' : 'bg-gray-900 text-gray-300'}`}>
                                    <tr>
                                        <th className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">Status</th>
                                        <th className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">Species</th>
                                        <th className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">Assembly</th>
                                        <th className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">Gene ID</th>
                                        <th className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">Symbol</th>
                                        <th className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">Primary Identity</th>
                                        <th className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">Primary Coverage</th>
                                        <th className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">Secondary Identity</th>
                                        <th className="px-3 py-2 text-left whitespace-nowrap border-b border-gray-600/20">Secondary Coverage</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {comparisonRows.map((entry) => {
                                        const statusMeta = STATUS_META[entry.status] || STATUS_META.common
                                        const rowClass = entry.status === 'common'
                                            ? (isLight ? 'bg-white' : 'bg-transparent')
                                            : entry.status === 'primary_only'
                                                ? (isLight ? 'bg-amber-50/60' : 'bg-amber-900/10')
                                                : (isLight ? 'bg-teal-50/60' : 'bg-teal-900/10')
                                        const clickable = Boolean((entry.primaryRow && onRefGeneFocus) || (entry.secondaryRow && onTgtGeneFocus))

                                        return (
                                            <tr
                                                key={entry.key}
                                                className={`border-b ${isLight ? 'border-gray-100' : 'border-gray-700/40'} ${rowClass} ${clickable ? (isLight ? 'cursor-pointer hover:bg-blue-50/40' : 'cursor-pointer hover:bg-blue-900/15') : ''}`}
                                                onClick={() => clickable && handleComparisonRowClick(entry)}
                                            >
                                                <td className="px-3 py-2 whitespace-nowrap">
                                                    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold ${statusMeta.className}`}>
                                                        {statusMeta.label}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-2 whitespace-nowrap">{formatSpeciesValue(entry.hitSpecies) || '—'}</td>
                                                <td className="px-3 py-2 whitespace-nowrap" title={entry.hitAssembly || '—'}>
                                                    <span className="inline-block max-w-[150px] truncate align-middle">{entry.hitAssembly || '—'}</span>
                                                </td>
                                                <td className="px-3 py-2 whitespace-nowrap">{entry.hitGeneId || '—'}</td>
                                                <td className="px-3 py-2 whitespace-nowrap">{entry.hitSymbol || '—'}</td>
                                                <td className="px-3 py-2 whitespace-nowrap">
                                                    {entry.primaryRow ? formatPercent(entry.primaryRow.__query_perc_id_num ?? entry.primaryRow.query_perc_id) : <span className="text-amber-400">Not found</span>}
                                                </td>
                                                <td className="px-3 py-2 whitespace-nowrap">
                                                    {entry.primaryRow ? formatPercent(entry.primaryRow.__query_perc_cov_num ?? entry.primaryRow.query_perc_cov) : <span className="text-amber-400">Not found</span>}
                                                </td>
                                                <td className="px-3 py-2 whitespace-nowrap">
                                                    {entry.secondaryRow ? formatPercent(entry.secondaryRow.__query_perc_id_num ?? entry.secondaryRow.query_perc_id) : <span className="text-teal-400">Not found</span>}
                                                </td>
                                                <td className="px-3 py-2 whitespace-nowrap">
                                                    {entry.secondaryRow ? formatPercent(entry.secondaryRow.__query_perc_cov_num ?? entry.secondaryRow.query_perc_cov) : <span className="text-teal-400">Not found</span>}
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        )}
                        </div>
                    )}
                </div>
            )}

            {!hasSecondary && (
                <div className={`${panelClass} rounded-lg p-4`}>
                    <div className={`text-sm ${mutedClass}`}>
                        Activate a secondary genome to load a second homology table and enable cross-table comparison.
                    </div>
                </div>
            )}
        </div>
    )
}
