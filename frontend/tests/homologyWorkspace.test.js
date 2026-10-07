import assert from 'node:assert/strict'
import test from 'node:test'
import { getGenomeKey } from '../src/utils/genomeIdentity.js'
import { allowedTargets, assemblyKey, buildComparison, cellState, columnKey, defaultFilters, detailTableColumns, effectiveQuery, hasHomologySource, homologyResultTab, initialWorkspace, SearchQueue, targetCandidates, workspaceReducer } from '../src/components/homology/model.js'

const genome = (name, release = '2025_12', path = `/${name}.tsv.gz`) => ({ species_key: name, scientific_name: name, assembly: `${name}_accession`, assembly_name: `${name}_assembly`, provider: 'ensembl', dataset_release_key: `ensembl/${release}`, files: { homology: path, gff3: `/${name}.gff3` } })
const A = genome('human'), B = genome('mouse'), C = genome('fox')
const key = getGenomeKey
const variant = (identity = 90, best = true, type = 'homolog_rbbh', count = 1) => ({ identity, coverage: 100, best, type, count })
const hit = (gene, target, variants = [variant()], assembly = 'Dog1') => ({ query_gene_id: gene, target_key: JSON.stringify(['dog', assembly.toLowerCase(), target]), target_assembly_key: assemblyKey('dog', assembly), species: 'dog', assembly, gene_id: target, symbol: target.toUpperCase(), variants, row_count: variants.reduce((sum, v) => sum + v.count, 0) })
const panel = (genes, hits, status = 'ready') => ({ status, submittedQuery: 'BRCA2', data: { resolved_genes: genes.map(id => ({ id, name: id })), evidence: hits } })
const panels = () => ({ [key(A)]: panel(['A1'], [hit('A1', 'D1'), hit('A1', 'D2', [variant(95, false, 'homolog_bbh')])]), [key(B)]: panel(['B1'], [hit('B1', 'D1'), hit('B1', 'D3', [variant(80, false)])]), [key(C)]: panel(['C1'], [hit('C1', 'D2')]) })
const sync = (state, genomes, sources) => workspaceReducer(state, { type: 'sync', genomes, sources })

test('one active genome always selects its individual results, including before and during searches', () => {
    for (const status of ['idle', 'queued', 'loading', 'missing', 'error', 'stale', 'ready']) {
        const state = { ...initialWorkspace(), panels: { [key(A)]: panel(['A1'], [], status) } }
        assert.equal(homologyResultTab([A], state), key(A))
        assert.equal(homologyResultTab([A], { ...state, activeTab: key(B) }), key(A))
    }
    assert.equal(homologyResultTab([A], initialWorkspace()), key(A))
    assert.equal(homologyResultTab([A], { ...initialWorkspace(), panels: { [key(A)]: panel([], []) } }), key(A))
})

test('two or more active genomes restore the summary and retain valid individual tab choices', () => {
    const state = { ...initialWorkspace(), panels: panels() }
    assert.equal(homologyResultTab([A, B], state), 'summary')
    const selected = { ...state, activeTab: key(A) }
    assert.equal(homologyResultTab([A, B], selected), key(A))
    assert.equal(homologyResultTab([B], selected), key(B))
    assert.equal(homologyResultTab([B, C], selected), 'summary')
    assert.equal(homologyResultTab([], selected), 'summary')
})

test('compact table defaults hide repeated query context while every TSV column stays selectable', () => {
    const columns = ['ref_species', 'query_species', 'query_assembly', 'QUERY_GENE_STABLE_ID', 'query_gene_name', 'ref_gene_stable_id', 'custom_field', 'query_perc_id']
    assert.deepEqual(detailTableColumns(columns), ['ref_species', 'ref_gene_stable_id', 'custom_field', 'query_perc_id'])
    assert.deepEqual(detailTableColumns(columns, columns), columns)
    assert.deepEqual(detailTableColumns(columns, ['QUERY_GENE_STABLE_ID', 'custom_field']), ['QUERY_GENE_STABLE_ID', 'custom_field'])
    assert.deepEqual(detailTableColumns(columns, []), [])
})

function complete(state, genome, id = '1', query = 'BRCA2') {
    const k = key(genome)
    state = workspaceReducer(state, { type: 'start', key: k, requestId: id, query })
    return workspaceReducer(state, { type: 'success', key: k, requestId: id, data: { source_token: 'token', resolved_genes: [{ id: 'A1' }], evidence: [] } })
}

test('arbitrary genome counts and release-specific independent state', () => {
    const genomes = Array.from({ length: 25 }, (_, i) => genome(`species${i}`))
    genomes.push(genome('species0', '2024_10'))
    const state = sync(initialWorkspace(), genomes)
    assert.equal(Object.keys(state.panels).length, 26)
    const shared = workspaceReducer(state, { type: 'shared', value: 'BRCA2' })
    const override = workspaceReducer(shared, { type: 'override', key: key(genomes[1]), value: 'MouseID' })
    assert.equal(effectiveQuery(override, key(genomes[0])), 'BRCA2')
    assert.equal(effectiveQuery(override, key(genomes[1])), 'MouseID')
    assert.equal(effectiveQuery(workspaceReducer(override, { type: 'override', key: key(genomes[1]), value: null }), key(genomes[1])), 'BRCA2')
})

test('reordering and reactivation preserve submitted queries and results', () => {
    let state = complete(sync(initialWorkspace(), [A, B]), A)
    const data = state.panels[key(A)].data
    state = sync(state, [B, A])
    state = sync(state, [B])
    state = sync(state, [A, B])
    assert.equal(state.panels[key(A)].data, data)
    state = workspaceReducer(state, { type: 'shared', value: 'Another draft' })
    assert.equal(state.panels[key(A)].submittedQuery, 'BRCA2')
})

test('new downloads enable searches without changing saved paths and survive session sync', () => {
    const mouse = genome('mouse', '2026_04', '')
    const k = key(mouse)
    let state = sync(initialWorkspace(), [mouse])
    assert.equal(hasHomologySource(state.panels[k]), false)
    state = workspaceReducer(state, { type: 'override', key: k, value: 'Brca2' })
    const source = { status: 'ready', path: '/mouse/downloaded.homology.tsv.gz', source_token: 'token' }
    state = sync(state, [mouse], { [k]: source })
    assert.equal(state.panels[k].status, 'idle')
    assert.equal(hasHomologySource(state.panels[k]), true)
    assert.equal(state.panels[k].configuredSourcePath, '')
    assert.equal(effectiveQuery(state, k), 'Brca2')
    state = complete(state, mouse)
    const data = state.panels[k].data
    state = sync(state, [])
    state = sync(state, [mouse])
    state = sync(state, [mouse], { [k]: source })
    assert.equal(state.panels[k].data, data)
    assert.equal(state.panels[k].sourcePath, source.path)
    state = sync(state, [mouse], { [k]: { status: 'missing', path: '', source_token: '' } })
    assert.equal(hasHomologySource(state.panels[k]), false)
    assert.equal(state.panels[k].status, 'missing')
    state = sync(state, [mouse], { [k]: source })
    assert.equal(hasHomologySource(state.panels[k]), true)
    state = sync(state, [{ ...mouse, files: { homology: '/explicit-replacement.tsv' } }])
    assert.equal(state.panels[k].sourcePath, '/explicit-replacement.tsv')
    assert.equal(state.panels[k].sourceToken, '')
})

test('path changes, fingerprint changes and deactivation reject stale responses', () => {
    let state = sync(initialWorkspace(), [A])
    state = workspaceReducer(state, { type: 'start', key: key(A), requestId: '1', query: 'Old' })
    state = workspaceReducer(state, { type: 'start', key: key(A), requestId: '2', query: 'New' })
    const late = workspaceReducer(state, { type: 'success', key: key(A), requestId: '1', data: { source_token: 'old' } })
    assert.equal(late, state)
    state = complete(state, A, '3')
    state = sync(state, [A], { [key(A)]: { status: 'ready', source_token: 'changed' } })
    assert.equal(state.panels[key(A)].status, 'stale')
    assert.equal(state.panels[key(A)].data, null)
    state = complete(state, A, '4')
    state = sync(state, [{ ...A, files: { ...A.files, homology: '/new.tsv' } }])
    assert.equal(state.panels[key(A)].data, null)
    state = workspaceReducer(state, { type: 'start', key: key(A), requestId: '5', query: 'Old' })
    state = sync(state, [])
    assert.equal(state.panels[key(A)].status, 'idle')
    assert.equal(workspaceReducer(state, { type: 'success', key: key(A), requestId: '5', data: {} }), state)
})

test('matrix counts distinct genomes, keeps multiple local genes and duplicate evidence', () => {
    const source = panels()
    source[key(A)] = panel(['A1', 'A2'], [hit('A1', 'D1', [variant(90, true, 'homolog_rbbh', 3)]), hit('A2', 'D1')])
    const result = buildComparison([A, B, C], source, defaultFilters())
    assert.equal(result.columns.length, 4)
    assert.equal(result.comparableCount, 3)
    const row = result.rows.find(row => row.gene_id === 'D1')
    assert.equal(row.support, 2)
    assert.equal(row.bestSupport, 2)
    assert.equal(row.cells.get(columnKey(key(A), 'A1')).hit.row_count, 3)
    assert.notEqual(result.columns[0].key, result.columns[1].key)
})

test('best-hit sets disagree, ties remain, and filters never promote lower-ranked hits', () => {
    const source = panels()
    const result = buildComparison([A, B, C], source, defaultFilters())
    assert.equal(result.disagreements, 1)
    assert.equal(result.sharedBest, 1)
    assert.equal(result.shared, 2)
    const filtered = buildComparison([A, B, C], source, { ...defaultFilters(), types: ['homolog_bbh'] })
    assert.equal(filtered.rows.length, 1)
    assert.equal(filtered.rows[0].bestSupport, 0)
    assert.equal(cellState(filtered.columns[2], filtered.rows[0].cells.get(filtered.columns[2].key)), 'filtered')
    assert.equal(buildComparison([A, B, C], source, { ...defaultFilters(), types: [] }).rows.length, 0)
})

test('different paralogues within one genome are not cross-genome disagreement', () => {
    const source = { [key(A)]: panel(['A1', 'A2'], [hit('A1', 'D1'), hit('A2', 'D2')]) }
    assert.equal(buildComparison([A], source, defaultFilters()).disagreements, 0)
    source[key(B)] = panel(['B1', 'B2'], [hit('B1', 'D1'), hit('B2', 'D2')])
    assert.equal(buildComparison([A, B], source, defaultFilters()).disagreements, 0)
})

test('missing files, errors, pending searches and unresolved genes are excluded from denominator', () => {
    const source = { ...panels(), [key(B)]: { status: 'error' }, [key(C)]: panel([], []) }
    const result = buildComparison([A, B, C], source, defaultFilters())
    assert.equal(result.comparableCount, 1)
    assert.equal(cellState(result.columns[1]), 'Search failed')
    assert.equal(cellState(result.columns[2]), 'No gene resolved')
    for (const [status, label] of [['missing', 'No file'], ['queued', 'Queued'], ['loading', 'Searching'], ['stale', 'File changed'], ['idle', 'Not searched']]) assert.equal(cellState({ status }), label)
    assert.equal(cellState({ status: 'ready', gene: { id: 'A1' } }), 'No hit reported')
})

test('summary filters select shared, unique, best, support and target scopes', () => {
    const source = panels()
    assert.equal(buildComparison([A, B, C], source, { ...defaultFilters(), mode: 'shared' }).rows.length, 2)
    assert.equal(buildComparison([A, B, C], source, { ...defaultFilters(), mode: 'unique' }).rows.length, 1)
    assert.equal(buildComparison([A, B, C], source, { ...defaultFilters(), minSupport: 3 }).rows.length, 0)
    assert.equal(buildComparison([A, B, C], source, { ...defaultFilters(), minIdentity: '94' }).rows.length, 1)
    assert.equal(buildComparison([A, B, C], source, { ...defaultFilters(), targetScope: 'active' }).rows.length, 0)
    const dog = { ...genome('dog'), assembly_name: 'Dog1' }
    assert.equal(buildComparison([A, B, C], source, { ...defaultFilters(), targetScope: 'local' }, [dog]).rows.length, 3)
    assert.deepEqual(allowedTargets({ ...defaultFilters(), targetScope: 'active', targetAssembly: assemblyKey('dog', 'Dog1') }, [A], [dog]), [])
})

test('browser navigation uses target species and assembly, preserves release candidates', () => {
    const human = { ...A, species_key: 'Homo_sapiens', assembly_name: 'GRCh38.p14' }
    const otherRelease = { ...human, dataset_release_key: 'ensembl/2024_10' }
    const target = { species: 'homo sapiens', assembly: 'GRCh38', gene_id: 'ENSG1' }
    assert.deepEqual(targetCandidates(target, [B, human, otherRelease]), [human, otherRelease])
    assert.deepEqual(targetCandidates({ ...target, gene_id: '' }, [human]), [])
})

test('browser links default to the active annotation release rather than other local releases', () => {
    const human = { ...A, species_key: 'Homo_sapiens', assembly_name: 'GRCh38.p14' }
    const otherRelease = { ...human, dataset_release_key: 'ensembl/2024_10' }
    const target = { species: 'homo sapiens', assembly: 'GRCh38', gene_id: 'ENSG1' }
    assert.deepEqual(targetCandidates(target, [otherRelease, human], [B, human]), [human])
    assert.deepEqual(targetCandidates(target, [otherRelease, human], [otherRelease]), [otherRelease])
    // Active records own the browser's actual file paths, even if discovery is stale.
    assert.deepEqual(targetCandidates(target, [otherRelease], [human]), [human])
    assert.deepEqual(targetCandidates(target, [otherRelease, human], [B]), [otherRelease, human])
    assert.deepEqual(targetCandidates(target, [otherRelease, human], [human, otherRelease]), [human, otherRelease])
    const differentAssembly = { ...human, assembly: 'OtherAssembly', assembly_name: 'OtherAssembly' }
    assert.deepEqual(targetCandidates(target, [otherRelease, human], [differentAssembly]), [otherRelease, human])
})

test('incomplete targets cannot become shared even when two selections reuse one TSV', () => {
    const incomplete = { ...hit('A1', ''), incomplete: true, target_key: 'incomplete:same-file:1' }
    const result = buildComparison([A, B], { [key(A)]: panel(['A1'], [incomplete]), [key(B)]: panel(['A1'], [incomplete]) }, defaultFilters())
    assert.equal(result.rows.length, 2)
    assert.equal(result.shared, 0)
    assert.ok(result.rows.every(row => row.support === 1))
})

test('detail responses cannot replace a newer selection or changed source', () => {
    let state = complete(sync(initialWorkspace(), [A]), A)
    state = workspaceReducer(state, { type: 'detailStart', key: key(A), requestId: 'd1' })
    state = workspaceReducer(state, { type: 'focus', key: key(A), geneId: 'A1', targetKey: 'target' })
    assert.equal(workspaceReducer(state, { type: 'detailSuccess', key: key(A), requestId: 'd1', data: { source_token: 'token' } }), state)
    state = workspaceReducer(state, { type: 'detailStart', key: key(A), requestId: 'd2' })
    state = workspaceReducer(state, { type: 'detailSuccess', key: key(A), requestId: 'd2', data: { source_token: 'changed' } })
    assert.equal(state.panels[key(A)].status, 'stale')
})

test('reselecting the same detail does not strand a pending page; filters invalidate it', () => {
    let state = complete(sync(initialWorkspace(), [A]), A)
    state = workspaceReducer(state, { type: 'detailStart', key: key(A), requestId: 'd1' })
    const repeated = workspaceReducer(state, { type: 'page', key: key(A), offset: 0 })
    assert.equal(repeated.panels[key(A)].detailRequestId, 'd1')
    assert.equal(workspaceReducer(state, { type: 'filters', value: { types: null } }).panels[key(A)].detailRequestId, 'd1')
    assert.equal(workspaceReducer(state, { type: 'filters', value: { mode: 'shared' } }).panels[key(A)].detailRequestId, 'd1')
    state = workspaceReducer(state, { type: 'filters', value: { minIdentity: '50' } })
    assert.equal(state.panels[key(A)].detailRequestId, '')
    assert.equal(workspaceReducer(state, { type: 'detailSuccess', key: key(A), requestId: 'd1', data: { source_token: 'token' } }), state)
})

test('summary navigation positions evidence without narrowing the table and repeats safely', () => {
    let state = complete(sync(initialWorkspace(), [A]), A)
    const data = state.panels[key(A)].data
    state = workspaceReducer(state, { type: 'focus', key: key(A), geneId: 'A1', targetKey: 'target' })
    assert.equal(state.panels[key(A)].data, data)
    assert.deepEqual(state.panels[key(A)].navigation, { id: 1, geneId: 'A1', targetKey: 'target' })
    state = workspaceReducer(state, { type: 'detailStart', key: key(A), requestId: 'd1' })
    state = workspaceReducer(state, { type: 'focus', key: key(A), geneId: 'A1', targetKey: 'target' })
    assert.equal(state.panels[key(A)].navigation.id, 2)
    assert.equal(workspaceReducer(state, { type: 'detailSuccess', key: key(A), requestId: 'd1', data: { source_token: 'token' } }), state)
    state = workspaceReducer(state, { type: 'detailStart', key: key(A), requestId: 'd2' })
    state = workspaceReducer(state, { type: 'detailSuccess', key: key(A), requestId: 'd2', data: { source_token: 'token', offset: 100, filtered_rows: 245 } })
    assert.equal(state.panels[key(A)].detail.data.offset, 100)
    // Previous from the focused second page must work even though the input
    // offset was zero before the backend located that page.
    state = workspaceReducer(state, { type: 'page', key: key(A), offset: 0 })
    assert.equal(state.panels[key(A)].navigation, null)
    assert.equal(state.panels[key(A)].detail, null)
})

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
test('queue limits work to three concurrent searches and replaces pending/running work', async () => {
    const queue = new SearchQueue(3)
    let active = 0, peak = 0
    const releases = []
    const started = []
    const work = name => async task => {
        if (task.controller.signal.aborted) return
        started.push(name)
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => releases.push(resolve))
        active--
    }
    for (let i = 0; i < 8; i++) queue.replace(`g${i}`, work(`g${i}`))
    queue.pump()
    await flush()
    assert.equal(active, 3)
    queue.replace('g4', work('replacement'))
    queue.cancel('g0')
    while (queue.running || queue.pending.length) {
        releases.splice(0).forEach(release => release())
        await flush()
    }
    assert.equal(peak, 3)
    assert.equal(started.includes('g4'), false)
    assert.equal(started.includes('replacement'), true)
    queue.dispose()
    assert.equal(queue.tasks.size, 0)
})
