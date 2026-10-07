import { formatDatasetBadgeLabel, getGenomeKey } from '../../utils/genomeIdentity.js'

export const PAGE_SIZE = 100
export const defaultFilters = () => ({ minIdentity: '', minCoverage: '', types: null, targetScope: 'all', targetAssembly: '', mode: 'all', minSupport: 1, sortKey: 'score', direction: 'desc' })
export const initialWorkspace = () => ({ sharedQuery: '', panels: {}, activeTab: 'summary', filters: defaultFilters(), visibleColumns: null, summaryPage: 0 })
export const normalizeSpecies = value => String(value || '').trim().toLowerCase().replace(/\s+/g, '_')
export function normalizeAssembly(value) {
    const text = String(value || '').trim().toLowerCase()
    return ['grch38', 'grch38.p14'].includes(text) ? 'grch38' : text
}
export const assemblyKey = (species, assembly) => JSON.stringify([normalizeSpecies(species), normalizeAssembly(assembly)])
export const genomeLabel = genome => [genome.display_name || genome.common_name || genome.scientific_name || genome.species_key || 'Genome', genome.assembly_name || genome.assembly || '', formatDatasetBadgeLabel(genome)].filter(Boolean).join(' · ')
export const columnKey = (genomeKey, geneId) => JSON.stringify([genomeKey, String(geneId || '').toLowerCase()])
export const effectiveQuery = (state, key) => (state.panels[key]?.override ?? state.sharedQuery).trim()
export const hasHomologySource = panel => Boolean(panel?.sourcePath) && panel.status !== 'missing'
export function homologyResultTab(genomes, state) {
    if (genomes.length === 1) return getGenomeKey(genomes[0])
    const panel = state.panels[state.activeTab]
    return genomes.some(genome => getGenomeKey(genome) === state.activeTab)
        && panel?.status === 'ready' && panel.data.resolved_genes.length
        ? state.activeTab : 'summary'
}
export function detailTableColumns(columns, selected = null) {
    const queryContext = new Set(['query_species', 'query_assembly', 'query_gene_stable_id', 'query_gene_name'])
    return columns.filter(column => selected === null ? !queryContext.has(column.toLowerCase()) : selected.includes(column))
}

export function newPanel(genome) {
    return { override: null, status: genome.files?.homology ? 'idle' : 'missing', configuredSourcePath: genome.files?.homology || '', sourcePath: genome.files?.homology || '', sourceToken: '', submittedQuery: '', requestId: '', data: null, error: '', offset: 0, navigation: null, navigationSequence: 0, detail: null, detailRequestId: '' }
}

export function workspaceReducer(state, action) {
    if (action.type === 'sync') {
        let changed = false
        const panels = { ...state.panels }
        const active = new Set(action.genomes.map(getGenomeKey))
        for (const [key, panel] of Object.entries(panels)) {
            if (!active.has(key) && (['queued', 'loading'].includes(panel.status) || panel.detail?.status === 'loading')) {
                panels[key] = { ...panel, status: panel.data ? 'ready' : panel.sourcePath ? 'idle' : 'missing', requestId: '', detailRequestId: '', detail: null }
                changed = true
            }
        }
        for (const genome of action.genomes) {
            const key = getGenomeKey(genome)
            const old = panels[key]
            const configuredPath = genome.files?.homology || ''
            const configurationChanged = old && (old.configuredSourcePath ?? old.sourcePath) !== configuredPath
            const source = action.sources?.[key]
            const path = source?.status === 'ready' && source.path ? source.path : configurationChanged ? configuredPath : old?.sourcePath || configuredPath
            const sourcePanel = { ...newPanel(genome), sourcePath: path, status: source?.status === 'missing' ? 'missing' : path ? 'idle' : 'missing', error: source?.detail || '' }
            if (!old || configurationChanged || old.sourcePath !== path) {
                panels[key] = { ...sourcePanel, override: old?.override ?? null, sourceToken: source?.source_token || '' }
                if (old?.data && path && source?.status !== 'missing') panels[key].status = 'stale'
                changed = true
            } else if (action.sources && Object.hasOwn(action.sources, key)) {
                if (old.sourceToken && old.sourceToken !== source.source_token) {
                    panels[key] = { ...sourcePanel, override: old.override, status: source.status === 'ready' ? 'stale' : 'missing', error: source.detail || '', sourceToken: source.source_token }
                    changed = true
                } else if (source.status === 'missing' && old.status !== 'missing') {
                    panels[key] = { ...sourcePanel, override: old.override, status: 'missing', error: source.detail || '' }
                    changed = true
                } else if (source.status === 'ready' && old.status === 'missing') {
                    panels[key] = { ...old, status: 'idle', error: '', sourceToken: source.source_token }
                    changed = true
                } else if (!old.sourceToken && source.source_token) {
                    panels[key] = { ...old, sourceToken: source.source_token }
                    changed = true
                }
            }
        }
        return changed ? { ...state, panels } : state
    }
    if (action.type === 'shared') return { ...state, sharedQuery: action.value }
    if (action.type === 'filters') {
        const detailFields = new Set(['minIdentity', 'minCoverage', 'types', 'targetScope', 'targetAssembly', 'sortKey', 'direction'])
        const changed = Object.entries(action.value).some(([key, value]) => detailFields.has(key) && JSON.stringify(value) !== JSON.stringify(state.filters[key]))
        return { ...state, filters: { ...state.filters, ...action.value }, summaryPage: 0,
            panels: changed ? Object.fromEntries(Object.entries(state.panels).map(([key, panel]) => [key, { ...panel, offset: 0, navigation: null, detailRequestId: '', detail: null }])) : state.panels }
    }
    if (action.type === 'columns') return { ...state, visibleColumns: action.value }
    if (action.type === 'tab') return { ...state, activeTab: action.key }
    if (action.type === 'summaryPage') return { ...state, summaryPage: action.value }
    const panel = state.panels[action.key]
    if (!panel) return state
    let next = panel
    if (action.type === 'override') next = { ...panel, override: action.value }
    if (action.type === 'start') next = { ...panel, requestId: action.requestId, requestSourceToken: panel.sourceToken, submittedQuery: action.query, status: 'queued', error: '', data: null, detail: null, offset: 0, navigation: null, detailRequestId: '' }
    if (['running', 'success', 'failure'].includes(action.type)) {
        if (panel.requestId !== action.requestId) return state
        if (action.type === 'running') next = { ...panel, status: 'loading' }
        if (action.type === 'success') next = panel.sourceToken !== panel.requestSourceToken && panel.sourceToken !== action.data.source_token
            ? { ...panel, status: 'stale', data: null, detail: null, requestId: '' }
            : { ...panel, status: 'ready', data: action.data, sourceToken: action.data.source_token, detail: { status: 'ready', data: action.data } }
        if (action.type === 'failure') next = { ...panel, status: 'error', error: action.error, data: null, detail: null }
    }
    if (action.type === 'focus') next = { ...panel, offset: 0, navigationSequence: (panel.navigationSequence || 0) + 1, navigation: { id: (panel.navigationSequence || 0) + 1, geneId: action.geneId, targetKey: action.targetKey }, detailRequestId: '', detail: null }
    if (action.type === 'page' && (panel.offset !== action.offset || panel.navigation)) next = { ...panel, offset: action.offset, navigation: null, detailRequestId: '', detail: null }
    if (action.type === 'detailStart') next = { ...panel, detailRequestId: action.requestId, detail: { status: 'loading' } }
    if (action.type === 'detailSuccess' || action.type === 'detailFailure') {
        if (panel.detailRequestId !== action.requestId) return state
        if (action.type === 'detailSuccess' && action.data.source_token !== panel.sourceToken) {
            next = { ...panel, status: 'stale', data: null, detail: null, requestId: '', detailRequestId: '' }
        } else {
            next = { ...panel, detail: action.type === 'detailSuccess' ? { status: 'ready', data: action.data } : { status: 'error', error: action.error } }
        }
    }
    return next === panel ? state : { ...state, panels: { ...state.panels, [action.key]: next } }
}

// Replacing a task invalidates it immediately; slots are released only when its
// fetch actually settles, so repeated submissions never exceed the limit.
export class SearchQueue {
    constructor(limit = 3) { this.limit = limit; this.running = 0; this.pending = []; this.tasks = new Map(); this.closed = false; this.sequence = 0 }
    replace(key, work) {
        this.cancel(key)
        const task = { id: String(++this.sequence), key, work, controller: new AbortController() }
        this.tasks.set(key, task)
        this.pending.push(task)
        return task.id
    }
    cancel(key) { this.tasks.get(key)?.controller.abort(); this.tasks.delete(key) }
    pump() {
        while (!this.closed && this.running < this.limit && this.pending.length) {
            const task = this.pending.shift()
            if (task.controller.signal.aborted) continue
            this.running++
            Promise.resolve().then(() => task.work(task)).catch(() => {}).finally(() => {
                this.running--
                if (this.tasks.get(task.key) === task) this.tasks.delete(task.key)
                this.pump()
            })
        }
    }
    dispose() { this.closed = true; for (const key of this.tasks.keys()) this.cancel(key); this.pending = [] }
}

export function targetAssemblyKeys(genomes) {
    const keys = new Set()
    for (const genome of genomes) {
        for (const species of [genome.species_key, genome.scientific_name]) {
            if (!species) continue
            for (const assembly of [genome.assembly_name, genome.assembly, genome.gca]) {
                if (assembly) keys.add(assemblyKey(species, assembly))
            }
        }
    }
    return keys
}

export function targetCandidates(hit, genomes, activeGenomes = []) {
    if (!hit.species || !hit.assembly || !hit.gene_id) return []
    const wanted = assemblyKey(hit.species, hit.assembly)
    const seen = new Set()
    const candidates = [...activeGenomes, ...genomes].filter(genome => {
        const key = getGenomeKey(genome)
        if (seen.has(key) || !genome.files?.gff3 || !targetAssemblyKeys([genome]).has(wanted)) return false
        seen.add(key)
        return true
    })
    const activeKeys = new Set(activeGenomes.map(getGenomeKey))
    const activeCandidates = candidates.filter(genome => activeKeys.has(getGenomeKey(genome)))
    return activeCandidates.length ? activeCandidates : candidates
}

export function variantPasses(variant, filters) {
    for (const [field, threshold] of [['identity', filters.minIdentity], ['coverage', filters.minCoverage]]) {
        if (threshold !== '' && threshold != null && (variant[field] == null || variant[field] < Number(threshold))) return false
    }
    return filters.types === null || filters.types.includes(variant.type)
}

export function allowedTargets(filters, genomes, localGenomes) {
    const keys = filters.targetScope === 'active' ? targetAssemblyKeys(genomes) : filters.targetScope === 'local' ? targetAssemblyKeys(localGenomes) : null
    if (filters.targetAssembly) return keys && !keys.has(filters.targetAssembly) ? [] : [filters.targetAssembly]
    return keys ? [...keys] : null
}

export function buildComparison(genomes, panels, filters, localGenomes = genomes) {
    const columns = []
    const comparable = new Set()
    const rows = new Map()
    const bestSets = new Map()
    const targets = allowedTargets(filters, genomes, localGenomes)
    for (const genome of genomes) {
        const key = getGenomeKey(genome)
        const panel = panels[key]
        const genes = panel?.status === 'ready' ? panel.data?.resolved_genes || [] : []
        if (genes.length) comparable.add(key)
        for (const gene of genes.length ? genes : [null]) columns.push({ key: columnKey(key, gene?.id || ''), genomeKey: key, genome, gene, status: panel?.status || 'idle' })
        if (!genes.length) continue
        for (const hit of panel.data.evidence || []) {
            const col = columnKey(key, hit.query_gene_id)
            const targetKey = hit.incomplete ? JSON.stringify([key, hit.target_key]) : hit.target_key
            const entry = rows.get(targetKey) || { ...hit, target_key: targetKey, cells: new Map() }
            const visible = hit.variants.filter(variant => variantPasses(variant, filters))
            entry.cells.set(col, { hit, visible })
            rows.set(targetKey, entry)
            if (hit.incomplete) continue
            const assembly = bestSets.get(hit.target_assembly_key) || new Map()
            // Empty sets make a missing target's evidence explicit during comparison.
            const hits = assembly.get(key) || new Set()
            if (hit.variants.some(variant => variant.best)) hits.add(hit.target_key)
            assembly.set(key, hits)
            bestSets.set(hit.target_assembly_key, assembly)
        }
    }
    const disagreements = new Set()
    for (const [assembly, sets] of bestSets) {
        const nonempty = [...sets.values()].filter(set => set.size).map(set => JSON.stringify([...set].sort()))
        if (new Set(nonempty).size > 1) disagreements.add(assembly)
    }
    const result = []
    for (const row of rows.values()) {
        if (targets && !targets.includes(row.target_assembly_key)) continue
        const support = new Set(), bestSupport = new Set()
        for (const col of columns) {
            const cell = row.cells.get(col.key)
            if (cell?.visible.length) support.add(col.genomeKey)
            if (cell?.visible.some(variant => variant.best)) bestSupport.add(col.genomeKey)
        }
        row.support = support.size
        row.bestSupport = bestSupport.size
        row.disagreement = disagreements.has(row.target_assembly_key)
        if (!row.support || row.support < Number(filters.minSupport || 1)) continue
        if (filters.mode === 'shared' && row.support < 2) continue
        if (filters.mode === 'unique' && row.support !== 1) continue
        if (filters.mode === 'best' && !row.bestSupport) continue
        if (filters.mode === 'disagreements' && !row.disagreement) continue
        result.push(row)
    }
    result.sort((a, b) => a.target_assembly_key.localeCompare(b.target_assembly_key) || b.bestSupport - a.bestSupport || b.support - a.support || a.gene_id.localeCompare(b.gene_id))
    return { columns, rows: result, comparableCount: comparable.size, shared: result.filter(row => row.support > 1).length, sharedBest: result.filter(row => row.bestSupport > 1).length, unique: result.filter(row => row.support === 1).length, disagreements: new Set(result.filter(row => row.disagreement).map(row => row.target_assembly_key)).size }
}

export function cellState(column, cell) {
    if (cell) return cell.visible.length ? 'hit' : 'filtered'
    if (column.status === 'missing') return 'No file'
    if (column.status === 'error') return 'Search failed'
    if (column.status === 'stale') return 'File changed'
    if (['queued', 'loading'].includes(column.status)) return column.status === 'queued' ? 'Queued' : 'Searching'
    if (column.status !== 'ready') return 'Not searched'
    return column.gene ? 'No hit reported' : 'No gene resolved'
}
