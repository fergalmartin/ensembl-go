// Manual browser fixture: exercises the real controller/view without writing user configuration.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/index.css'
import '../../../src/App.css'
import HomologyView from '../../../src/components/HomologyView.jsx'
import useHomologyWorkspace from '../../../src/components/homology/useHomologyWorkspace.js'
import { assemblyKey, defaultFilters, variantPasses } from '../../../src/components/homology/model.js'
import { getGenomeKey } from '../../../src/utils/genomeIdentity.js'

const makeGenome = (name, assembly) => ({ species_key: name.toLowerCase(), scientific_name: name, display_name: name, assembly, assembly_name: assembly, provider: 'ensembl', dataset_release_key: 'ensembl/2025_12', files: { homology: `/${name}.tsv`, gff3: `/${name}.gff3` } })
const sources = [makeGenome('Human', 'Human1'), makeGenome('Mouse', 'Mouse1'), makeGenome('Fox', 'Fox1')]
const targetGenome = makeGenome('Dog', 'Dog1')
const allGenomes = [...sources, targetGenome]
let generation = 'fixture1'
const copies = 75
const fields = ['query_gene_stable_id', 'query_gene_name', 'ref_species', 'ref_assembly', 'ref_gene_stable_id', 'ref_gene_name', 'homology_type', 'query_perc_id', 'query_perc_cov', 'original_extra']
const targets = [
    [['D1', 90, true], ['D2', 95, false], ['D4', 90, true]],
    [['D1', 89, true], ['D3', 80, false], ['D4', 89, true]],
    [['D2', 88, true], ['D3', 70, false], ['D4', 88, true]],
]
function responseFor(body) {
    const genome = allGenomes.find(item => getGenomeKey(item) === body.genome_key) || sources[0]
    const sourceIndex = Math.max(0, sources.indexOf(genome))
    const geneId = `GENE_${genome.display_name}`
    const evidence = targets[sourceIndex].map(([id, identity, best]) => ({ query_gene_id: geneId, target_key: JSON.stringify(['dog', 'dog1', id.toLowerCase()]), target_assembly_key: assemblyKey('dog', 'Dog1'), species: 'dog', assembly: 'Dog1', gene_id: id, symbol: `Hit_${id}`, variants: [{ type: best ? 'homolog_rbbh' : 'homolog_bbh', identity, coverage: 100, best, count: copies }], row_count: copies, incomplete: false }))
    const noMatch = body.gene_query === 'none'
    const originalRows = noMatch ? [] : evidence.flatMap(hit => Array.from({ length: copies }, (_, i) => ({ row_id: `${hit.gene_id}-${i}`, query_gene_id: geneId, target_key: hit.target_key, best: hit.variants[0].best, values: { query_gene_stable_id: geneId, query_gene_name: 'BRCA2', ref_species: 'dog', ref_assembly: 'Dog1', ref_gene_stable_id: hit.gene_id, ref_gene_name: hit.symbol, homology_type: hit.variants[0].type, query_perc_id: String(hit.variants[0].identity), query_perc_cov: '100', original_extra: `evidence ${i}` } })))
    const filters = { ...defaultFilters(), minIdentity: body.min_identity ?? '', minCoverage: body.min_coverage ?? '', types: body.types ?? null }
    const rows = originalRows.filter(entry => (!body.query_gene_id || entry.query_gene_id === body.query_gene_id) && (!body.target_key || entry.target_key === body.target_key) && (!body.target_assemblies || body.target_assemblies.includes(assemblyKey('dog', 'Dog1'))) && variantPasses({ type: entry.values.homology_type, identity: Number(entry.values.query_perc_id), coverage: 100 }, filters))
    const direction = body.direction === 'asc' ? 1 : -1
    const score = row => Number(row.values.query_perc_id) * .6 + Number(row.values.query_perc_cov) * .4
    const tier = row => row.values.homology_type === 'homolog_rbbh' ? 2 : row.values.homology_type === 'homolog_bbh' ? 1 : 0
    rows.sort((a, b) => direction * (!body.sort_key || body.sort_key === 'score' ? tier(a) - tier(b) || score(a) - score(b) : ['query_perc_id', 'query_perc_cov'].includes(body.sort_key) ? Number(a.values[body.sort_key]) - Number(b.values[body.sort_key]) : a.values[body.sort_key].localeCompare(b.values[body.sort_key])))
    const focus = body.focus_query_gene_id && body.focus_target_key ? rows.findIndex(row => row.query_gene_id === body.focus_query_gene_id && row.target_key === body.focus_target_key) : -1
    const limit = body.limit || 100
    const offset = focus >= 0 ? Math.floor(focus / limit) * limit : body.offset || 0
    return { genome_key: body.genome_key, query: body.gene_query, source_token: generation, columns: fields, canonical_columns: Object.fromEntries(fields.map(field => [field, field])), matched_by: noMatch ? 'none' : 'exact', resolved_genes: noMatch ? [] : [{ id: geneId, name: 'BRCA2', provenance: [{ endpoint: 'query', field: 'query_gene_name', value: 'BRCA2' }] }], evidence: body.include_evidence === false ? null : noMatch ? [] : evidence, types: ['homolog_bbh', 'homolog_rbbh'], total_rows: originalRows.length, filtered_rows: rows.length, offset, limit, focus_row_id: focus >= 0 ? rows[focus].row_id : null, rows: rows.slice(offset, offset + limit) }
}
const actualFetch = window.fetch.bind(window)
window.fetch = async (url, options = {}) => {
    const text = String(url)
    if (text.includes('/api/homology/sources')) return Response.json({ sources: Object.fromEntries(allGenomes.map(genome => [getGenomeKey(genome), { status: 'ready', source_token: generation }])) })
    if (text.includes('/api/remote/local-assemblies')) return Response.json(allGenomes)
    if (text.includes('/api/homology/search')) {
        const body = JSON.parse(options.body)
        if (body.gene_query === 'fail') return Response.json({ detail: 'Fixture search failed' }, { status: 400 })
        return Response.json(responseFor(body))
    }
    return actualFetch(url, options)
}
export default function Fixture() {
    const [genomes, setGenomes] = useState(sources)
    const [shown, setShown] = useState(true)
    const [theme, setTheme] = useState('dark')
    const [opened, setOpened] = useState('')
    const workspace = useHomologyWorkspace({ genomes, localGenomes: allGenomes, outputDir: '/fixture', enabled: shown })
    const addTwelve = () => {
        const first = allGenomes.length - 4
        const extras = Array.from({ length: 12 }, (_, i) => makeGenome(`Extra${first + i}`, `Assembly${first + i}`))
        allGenomes.push(...extras)
        setGenomes(value => [...value, ...extras])
    }
    const config = { genome_colors: Object.fromEntries(allGenomes.map((genome, i) => [getGenomeKey(genome).split('::dataset::')[0], ['#3366cc', '#00b692', '#8b5cf6', '#f59e0b'][i]])) }
    return <div className={`h-screen flex flex-col ${theme === 'light' ? 'bg-slate-50 text-gray-900' : 'bg-gray-900 text-gray-200'}`}>
        <div className="flex flex-wrap gap-3 p-3 border-b border-gray-500 text-xs"><b>Isolated homology QA fixture</b><button onClick={() => setShown(value => !value)}>Switch view</button><button onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}>Toggle fixture theme</button><button onClick={() => setGenomes(value => [...value].reverse())}>Reverse genome order</button><button onClick={addTwelve}>Add twelve genomes</button><button onClick={() => { generation = 'fixture2'; setShown(false) }}>Change fixture source</button><span role="status">{opened}</span></div>
        <div className="flex-1 min-h-0">{shown ? <HomologyView theme={theme} config={config} genomes={genomes} localGenomes={workspace.availableGenomes} workspace={workspace} onToggleGenome={genome => setGenomes(value => value.filter(item => getGenomeKey(item) !== getGenomeKey(genome)))} onOpenGene={(genome, gene) => setOpened(`Opened ${genome.display_name}: ${gene.id}`)} /> : <div className="p-6">Other view. Homology state remains in its parent.</div>}</div>
    </div>
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture /></React.StrictMode>)
