import { useMemo, useState } from 'react'
import GenomePill, { genomePillLabels } from './GenomePill'
import AppButtonIcon from './AppButtonIcon'
import { getGenomeKey } from '../utils/genomeIdentity.js'
import { genomeColorResolver } from '../genomeColorSchemes.js'
import { genomePillColors } from '../utils/genomePillColors.js'
import { buildComparison, cellState, detailTableColumns, effectiveQuery, genomeLabel, hasHomologySource, homologyResultTab, PAGE_SIZE, targetCandidates } from './homology/model.js'
import useResultsViewport from './homology/useResultsViewport.js'
import useRowFocus from './homology/useRowFocus.js'
import './homology/search.css'

const scrollbarClass = isLight => `themed-scrollbar themed-scrollbar-${isLight ? 'light' : 'dark'}`
const percent = value => value == null || value === '' || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(2)}%`
const typeLabel = type => type === 'homolog_rbbh' ? 'RBBH' : type === 'homolog_bbh' ? 'BBH' : type || 'Unspecified'
const hitDescription = (type, preferred) => `${({ homolog_rbbh: 'Reciprocal best match', homolog_bbh: 'Best match' }[type] || type || 'Unspecified')}${preferred ? ' · Preferred hit for this query gene and target genome' : ''}`
const columnLabel = key => ({ ref_species: 'Species', ref_assembly: 'Assembly', query_perc_id: 'Protein Identity', query_perc_cov: 'Coverage', ref_gene_stable_id: 'Gene ID', query_gene_stable_id: 'Query Gene ID', ref_gene_name: 'Symbol', query_gene_name: 'Query Symbol', homology_type: 'Type' }[key.toLowerCase()] || key.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' '))
const statusLabel = panel => ({ idle: 'Not searched', missing: 'No homology file', stale: 'File changed · search again', queued: 'Queued', loading: 'Searching / preparing index…', error: 'Search failed', ready: panel?.data?.resolved_genes.length ? `${panel.data.resolved_genes.length} gene(s) · ${panel.data.total_rows.toLocaleString()} rows` : 'No matching genes' }[panel?.status] || 'Not searched')

function Pagination({ offset, total, onChange, className }) {
    return <div data-homology-pagination className={`shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-t ${className}`}>
        <span className="text-xs">{total ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total.toLocaleString()}` : '0 rows'}</span>
        <div className="flex gap-2">
            <button className="rounded border px-3 py-1 text-xs disabled:opacity-40" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
            <button className="rounded border px-3 py-1 text-xs disabled:opacity-40" disabled={offset + PAGE_SIZE >= total} onClick={() => onChange(offset + PAGE_SIZE)}>Next</button>
        </div>
    </div>
}

function Badge({ genome, color, isLight, onClick, compact = false, selected }) {
    const labels = genomePillLabels(genome)
    const scientificName = String(genome.scientific_name || genome.species_key || '').replaceAll('_', ' ').trim()
    const parts = scientificName.split(/\s+/)
    const abbreviatedName = compact && parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : scientificName
    const name = genome.display_name || genome.common_name || abbreviatedName || 'Genome'
    const assembly = String(genome.assembly_name || genome.assembly || '')
    return <span className="relative inline-block shrink-0 pb-1.5 max-w-full">
        <GenomePill as="span" displayName={name} displayAssembly={compact && assembly.length > 10 ? `${assembly.substring(0, 7)}...` : assembly} badge={labels.badge} badgeTooltip={labels.badgeTooltip} tooltip={`${labels.pillTooltip}${onClick ? ' · click to deactivate' : ''}`} isLight={isLight} {...genomePillColors(color, { isLight, state: selected === false ? 'inactive' : 'active' })} maxWidth={compact ? '200px' : '300px'} onClick={onClick} />
    </span>
}

function ResultTab({ selected, disabled = false, title, isLight, color = '#3b82f6', label, onClick, children }) {
    const appearance = selected
        ? isLight ? 'bg-white border-gray-300 text-gray-900' : 'bg-gray-800 border-gray-600 text-white'
        : isLight ? 'border-transparent text-gray-600 hover:bg-gray-200/70' : 'border-transparent text-gray-400 hover:bg-gray-700/60'
    return <button type="button" role="tab" disabled={disabled} title={title} tabIndex={selected && !disabled ? 0 : -1} aria-selected={selected} aria-disabled={disabled} aria-controls="homology-result-panel" aria-label={label} onClick={onClick} className={`relative shrink-0 inline-flex items-center justify-center rounded-t-lg border border-b-0 px-3 pt-2 pb-3 ${disabled ? 'cursor-default opacity-40' : 'cursor-pointer'} transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 focus-visible:outline-offset-[-3px] ${appearance}`}>
        {children}
        {selected && <span className="absolute bottom-0 inset-x-2 h-0.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />}
    </button>
}

function OpenHit({ hit, localGenomes, activeGenomes, onOpenGene, children }) {
    const candidates = targetCandidates(hit, localGenomes, activeGenomes)
    const gene = { id: hit.gene_id, name: hit.symbol || hit.gene_id }
    if (candidates.length === 1) return <button className="cursor-pointer inline-flex items-center gap-1 text-blue-500 hover:underline whitespace-nowrap focus-visible:outline-2 focus-visible:outline-blue-500" title={`Open ${hit.gene_id} in the Genome Browser · ${genomeLabel(candidates[0])}`} aria-label={`Open ${hit.gene_id} in ${genomeLabel(candidates[0])}`} onClick={() => onOpenGene(candidates[0], gene)}>{children}<AppButtonIcon buttonId="genome_browser" compact /></button>
    if (candidates.length > 1) return <details className="inline-block align-middle">
        <summary className="cursor-pointer text-blue-500 hover:underline list-none" aria-label={`Choose target dataset for ${hit.gene_id}`} title="Choose a dataset to open in the Genome Browser"><span className="inline-flex items-center gap-1">{children}<AppButtonIcon buttonId="genome_browser" compact /></span></summary>
        <div className="flex flex-col items-start gap-1 mt-1 text-xs">{candidates.map(genome => <button key={getGenomeKey(genome)} className="cursor-pointer text-blue-500 hover:underline" onClick={() => onOpenGene(genome, gene)}>{genomeLabel(genome)}</button>)}</div>
    </details>
    return <span title="Target annotation unavailable locally">{children}</span>
}

function ComparisonMatrix({ comparison, state, dispatch, openEvidence, colors, isLight, surface, muted, border }) {
    const offset = Math.min(state.summaryPage, Math.max(0, Math.floor((comparison.rows.length - 1) / PAGE_SIZE) * PAGE_SIZE))
    const rows = comparison.rows.slice(offset, offset + PAGE_SIZE)
    return <>
        <div className={`shrink-0 px-4 py-3 border-b ${border}`}>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm"><span><b>{comparison.sharedBest}</b> shared best hits</span><span><b>{comparison.shared}</b> shared hits</span><span><b>{comparison.unique}</b> single-genome hits</span><span><b>{comparison.disagreements}</b> target genomes with different best-hit sets</span></div>
            <p className={`text-xs mt-2 ${muted}`}>Comparing {comparison.comparableCount} of {comparison.columns.reduce((set, col) => set.add(col.genomeKey), new Set()).size} active genomes with resolved genes. Support counts genomes, not gene copies. Scores retain the TSV’s query direction.</p>
            <p className={`text-xs mt-1 ${muted}`} title="Preferred hits are chosen by type (RBBH, then BBH, then other types), followed by 60% identity and 40% coverage. Equal choices are retained. Filters do not change this choice.">★ Preferred hit · RBBH: reciprocal best match · BBH: best match</p>
        </div>
        <div data-homology-stage className="shrink-0 flex flex-col h-[var(--homology-rows-height,70vh)] min-h-[200px]">
        {!rows.length ? <div className={`flex-1 min-h-0 flex items-center justify-center p-8 text-center ${muted}`}>{comparison.comparableCount ? 'No hits pass these filters.' : 'Search active genomes to compare their homology evidence.'}</div> : <div data-homology-rows role="region" aria-label="Summary hit rows" tabIndex={0} className={`flex-1 min-h-0 overflow-auto focus-visible:outline-2 focus-visible:outline-blue-500 focus-visible:outline-offset-[-2px] ${scrollbarClass(isLight)}`}>
            <table className="text-xs min-w-full border-separate border-spacing-0">
                <caption className="sr-only">Homology hits across searched genomes, grouped by target species and assembly</caption>
                <thead className="sticky top-0 z-20">
                    <tr><th className={`sticky left-0 z-30 text-left px-4 py-3 border-b ${surface} ${border} min-w-[280px]`}>Target gene / support</th>{comparison.columns.map(column => <th key={column.key} scope="col" className={`px-3 py-3 border-b text-left min-w-[205px] ${surface} ${border}`} style={{ borderTop: `3px solid ${colors(column.genome)}` }}>
                        <Badge genome={column.genome} color={colors(column.genome)} isLight={isLight} compact />
                        {column.gene ? <><div className="font-semibold mt-1">{column.gene.name || 'Unnamed'}</div><div className={`font-normal mt-0.5 ${muted}`}>{column.gene.id}</div></> : <div className={`font-normal mt-1 ${muted}`}>{statusLabel(state.panels[column.genomeKey])}</div>}
                    </th>)}</tr>
                </thead>
                <tbody>{rows.map((row, index) => <MatrixRow key={row.target_key} row={row} showGroup={index === 0 || rows[index - 1].target_assembly_key !== row.target_assembly_key} comparison={comparison} openEvidence={openEvidence} surface={surface} muted={muted} border={border} isLight={isLight} />)}</tbody>
            </table>
        </div>}
        </div>
        <Pagination offset={offset} total={comparison.rows.length} onChange={value => dispatch({ type: 'summaryPage', value })} className={border} />
    </>
}

function MatrixRow({ row, showGroup, comparison, openEvidence, surface, muted, border, isLight }) {
    return <>{showGroup && <tr><th scope="rowgroup" colSpan={comparison.columns.length + 1} className={`px-4 py-2 text-left ${isLight ? 'bg-slate-100' : 'bg-slate-900'} ${border} border-b`}>
        {row.species.replaceAll('_', ' ')} · {row.assembly || 'Assembly unspecified'} {row.disagreement && <span className="ml-3 text-amber-600 dark:text-amber-400">Different best-hit sets</span>}
    </th></tr>}
        <tr><th scope="row" className={`sticky left-0 z-10 px-4 py-3 text-left border-b ${surface} ${border}`}>
            <div className="font-semibold">{row.symbol || 'Unnamed gene'}</div><div className={`font-normal break-all mt-1 ${muted}`}>{row.gene_id || 'ID unspecified'}</div>
            <div className="mt-2 font-normal">{row.support}/{comparison.comparableCount} genomes · {row.bestSupport > 1 ? '★ Shared best' : row.support > 1 ? 'Shared hit' : 'Single-genome hit'}</div>
            {row.incomplete && <div className={`font-normal mt-1 ${muted}`}>Incomplete identity · kept separate</div>}
        </th>{comparison.columns.map(column => {
            const cell = row.cells.get(column.key)
            const status = cellState(column, cell)
            if (status !== 'hit') return <td key={column.key} className={`px-3 py-3 border-b ${border} ${muted}`}><span>{status === 'filtered' ? 'Filtered out' : status}</span>{status === 'filtered' && <button className="block underline mt-1" title="View the full table with the current filters" onClick={() => openEvidence(column.genomeKey, column.gene.id, cell.hit.target_key)}>View table</button>}</td>
            const visible = cell.visible
            const identity = visible[0].identity
            return <td key={column.key} className={`border-b ${border} align-top`} style={{ backgroundColor: identity == null ? undefined : isLight ? `rgba(37,99,235,${.04 + .14 * Math.min(100, Math.max(0, identity)) / 100})` : `rgba(59,130,246,${.05 + .18 * Math.min(100, Math.max(0, identity)) / 100})` }}>
                <button className="w-full h-full text-left px-3 py-3 hover:bg-blue-500/10 focus-visible:outline-2 focus-visible:outline-blue-500" title={`View the full table at ${row.gene_id || row.symbol}`} onClick={() => openEvidence(column.genomeKey, column.gene.id, cell.hit.target_key)} aria-label={`Inspect ${row.gene_id || row.symbol} evidence for ${genomeLabel(column.genome)}, ${column.gene.id}`}>
                    {visible.slice(0, 3).map((variant, i) => <div key={i} className={i ? 'mt-2' : ''}><div className="font-semibold" title={hitDescription(variant.type, variant.best)}>{variant.best ? '★ ' : ''}{typeLabel(variant.type)} {variant.count > 1 && <span className={muted}>×{variant.count}</span>}</div><div className={`mt-0.5 tabular-nums ${muted}`}>{percent(variant.identity)} id · {percent(variant.coverage)} cov</div></div>)}
                    {visible.length > 3 && <div className="mt-2 underline">+{visible.length - 3} evidence variants</div>}
                </button>
            </td>
        })}</tr>
    </>
}

function ResultsTable({ genome, panel, state, dispatch, localGenomes, activeGenomes, onOpenGene, isLight, muted, border }) {
    const key = getGenomeKey(genome)
    const data = panel?.data
    const detail = panel?.detail
    const page = detail?.data
    const rowsRef = useRowFocus(key, panel?.navigation, detail)
    if (panel?.status !== 'ready') {
        const message = panel?.error || ({ missing: 'No homology file available for this genome.', stale: 'The homology file changed. Search this genome again.', queued: 'Search queued…', loading: 'Searching / preparing index…', error: 'Search failed.' }[panel?.status] || 'Search this genome to see its homology hits.')
        return <div data-homology-stage className={`shrink-0 h-[var(--homology-rows-height,70vh)] min-h-[200px] flex items-center justify-center p-8 text-center ${panel?.status === 'error' ? 'text-red-500' : muted}`} role={panel?.status === 'error' ? 'alert' : 'status'}>{message}</div>
    }
    const columns = detailTableColumns(data.columns, state.visibleColumns)
    const canonical = data.canonical_columns
    const read = (entry, name) => entry.values[canonical[name]] || ''
    return <>
        <div data-homology-stage className="shrink-0 flex flex-col h-[var(--homology-rows-height,70vh)] min-h-[200px]">
        {detail?.status === 'loading' ? <div className={`flex-1 min-h-0 flex items-center justify-center p-8 text-center ${muted}`} role="status">Loading rows…</div> : detail?.status === 'error' ? <div className={`flex-1 min-h-0 overflow-auto p-8 text-red-500 ${scrollbarClass(isLight)}`} role="alert">{detail.error}</div> : !data.resolved_genes.length ? <div className={`flex-1 min-h-0 flex items-center justify-center p-8 text-center ${muted}`}>No matching genes.</div> : !columns.length ? <div className={`flex-1 min-h-0 flex items-center justify-center p-8 text-center ${muted}`}>Select columns in Filters and display.</div> : !page?.rows.length ? <div className={`flex-1 min-h-0 flex items-center justify-center p-8 text-center ${muted}`}>No rows pass these filters.</div> : <div ref={rowsRef} data-homology-rows role="region" aria-label="Individual hit rows" tabIndex={0} className={`flex-1 min-h-0 overflow-auto focus-visible:outline-2 focus-visible:outline-blue-500 focus-visible:outline-offset-[-2px] ${scrollbarClass(isLight)}`}>
            <table className="w-full min-w-max text-sm border-separate border-spacing-0"><caption className="sr-only">Original homology TSV rows for {genomeLabel(genome)}</caption><thead className="sticky top-0 z-10"><tr>{columns.map(column => <th key={column} scope="col" className={`text-left whitespace-nowrap px-3 py-2 border-b ${isLight ? 'bg-gray-100 text-gray-600' : 'bg-gray-900 text-gray-300'} ${border}`}>{columnLabel(column)}</th>)}</tr></thead>
                <tbody>{page.rows.map((entry, i) => {
                    const hit = { species: read(entry, 'ref_species'), assembly: read(entry, 'ref_assembly'), gene_id: read(entry, 'ref_gene_stable_id'), symbol: read(entry, 'ref_gene_name') }
                    const gene = data.resolved_genes.find(gene => gene.id === entry.query_gene_id)
                    return <TableRows key={entry.row_id} entry={entry} gene={gene} showGroup={i === 0 || page.rows[i - 1].query_gene_id !== entry.query_gene_id} columns={columns} canonical={canonical} hit={hit} genome={genome} localGenomes={localGenomes} activeGenomes={activeGenomes} onOpenGene={onOpenGene} isLight={isLight} border={border} muted={muted} />
                })}</tbody>
            </table>
        </div>}
        </div>
        <Pagination offset={page?.offset ?? panel.offset} total={page?.filtered_rows || 0} onChange={offset => dispatch({ type: 'page', key, offset })} className={border} />
    </>
}

function PercentageDisplay({ value, coverage, isLight }) {
    if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) return '—'
    const bounded = Math.max(0, Math.min(100, Number(value)))
    const fill = `hsl(211, 90%, ${93 - 50 * Math.pow(bounded / 100, 1.9)}%)`
    return <div className="flex items-center gap-2" title={`${coverage ? 'Coverage' : 'Protein identity'}: ${percent(value)}`}>
        {coverage ? <span className="shrink-0 w-6 h-6 rounded-full" style={{ background: `conic-gradient(${fill} 0% ${bounded}%, ${isLight ? '#dbeafe' : '#334155'} ${bounded}% 100%)` }} aria-hidden="true" />
            : <span className={`shrink-0 h-3.5 w-24 rounded-sm overflow-hidden ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`} aria-hidden="true"><span className="block h-full" style={{ width: `${bounded}%`, backgroundColor: fill }} /></span>}
        <span className="text-xs tabular-nums whitespace-nowrap">{percent(value)}</span>
    </div>
}

function TableRows({ entry, gene, showGroup, columns, canonical, hit, genome, localGenomes, activeGenomes, onOpenGene, isLight, border, muted }) {
    const local = targetCandidates(hit, localGenomes).length > 0
    const provenance = gene?.provenance?.map(origin => `${origin.endpoint === 'ref' ? 'Hit' : 'Local'} ${origin.field.endsWith('_name') ? 'symbol' : 'ID'}: ${origin.value}`).join('\n')
    return <>{showGroup && <tr><th scope="rowgroup" colSpan={columns.length} className={`text-left px-3 py-1.5 text-xs font-normal ${isLight ? 'bg-gray-50' : 'bg-gray-900/40'} border-b ${border}`}><span title={provenance}><span className={muted}>Query: </span><span className="font-semibold">{gene?.name || 'Unnamed'}</span><span className={`ml-2 ${muted}`}>{entry.query_gene_id}</span></span>{genome.files?.gff3 && <button className="cursor-pointer inline-flex align-middle ml-2 text-blue-500" title="Open query gene in the Genome Browser" aria-label={`Open ${entry.query_gene_id} in ${genomeLabel(genome)}`} onClick={() => onOpenGene(genome, { id: entry.query_gene_id, name: gene?.name || entry.query_gene_id })}><AppButtonIcon buttonId="genome_browser" compact /></button>}</th></tr>}
        <tr data-homology-row-id={entry.row_id} className={local ? isLight ? 'bg-blue-100/60 text-blue-900 hover:bg-blue-100' : 'bg-blue-900/30 text-blue-100 hover:bg-blue-900/45' : isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-700/20'}>{columns.map((column, i) => {
            const value = entry.values[column]
            let content = <span className={value ? '' : muted}>{value || '—'}</span>
            if (column === canonical.ref_species) {
                const fullName = String(value || '').replaceAll('_', ' ').trim()
                const parts = fullName.split(/\s+/)
                const label = fullName ? parts.length > 1 ? `${parts[0][0].toUpperCase()}. ${parts.slice(1).join(' ').toLowerCase()}` : fullName : '—'
                content = <span className="inline-block max-w-[130px] truncate align-middle" title={fullName}>{label}</span>
            } else if (column === canonical.ref_assembly) {
                content = <span className="inline-block max-w-[145px] truncate align-middle" title={value}>{value || '—'}</span>
            } else if ([canonical.query_perc_id, canonical.query_perc_cov].includes(column)) {
                content = <PercentageDisplay value={value} coverage={column === canonical.query_perc_cov} isLight={isLight} />
            } else if (column === canonical.homology_type) {
                content = <span title={hitDescription(value, entry.best)}>{entry.best && <><span aria-hidden="true">★ </span><span className="sr-only">Preferred hit: </span></>}{typeLabel(value)}</span>
            } else if (column === canonical.ref_gene_stable_id || column === canonical.ref_gene_name && !columns.includes(canonical.ref_gene_stable_id)) {
                content = <OpenHit hit={hit} localGenomes={localGenomes} activeGenomes={activeGenomes} onOpenGene={onOpenGene}>{value || '—'}</OpenHit>
            }
            return <td key={column} className={`px-3 py-2 whitespace-nowrap border-b ${isLight ? 'border-gray-100' : 'border-gray-700/40'} ${local && i === 0 ? 'border-l-2 border-l-blue-400' : ''}`}>{content}</td>
        })}</tr>
    </>
}

export default function HomologyView({ theme = 'dark', config, genomes, localGenomes, workspace, onToggleGenome, onOpenGene }) {
    const { state, dispatch, run, runAll, openEvidence } = workspace
    const [filtersOpen, setFiltersOpen] = useState(false)
    const { rootRef, resultsRef } = useResultsViewport()
    const light = theme === 'light'
    const surface = light ? 'bg-white' : 'bg-gray-800'
    const border = light ? 'border-gray-200' : 'border-gray-700'
    const muted = light ? 'text-gray-500' : 'text-gray-400'
    const input = `rounded border px-3 py-2 text-sm ${border} ${light ? 'bg-white' : 'bg-gray-900'} focus:outline-2 focus:outline-blue-500`
    const colors = useMemo(() => genomeColorResolver(config), [config])
    const comparison = useMemo(() => buildComparison(genomes, state.panels, state.filters, localGenomes), [genomes, state.panels, state.filters, localGenomes])
    const readyPanels = genomes.map(genome => state.panels[getGenomeKey(genome)]).filter(panel => panel?.status === 'ready')
    const allTypes = [...new Set(readyPanels.flatMap(panel => panel.data.types))].sort()
    const allColumns = [...new Set(readyPanels.flatMap(panel => panel.data.columns))]
    const visibleColumns = detailTableColumns(allColumns, state.visibleColumns)
    const targets = new Map(readyPanels.flatMap(panel => panel.data.evidence.map(hit => [hit.target_assembly_key, `${hit.species.replaceAll('_', ' ')} · ${hit.assembly || 'unspecified assembly'}`])))
    const tab = homologyResultTab(genomes, state)
    const activeGenome = genomes.find(genome => getGenomeKey(genome) === tab)
    const activePanel = activeGenome && state.panels[tab]
    const setFilter = value => dispatch({ type: 'filters', value })
    const handleTabKey = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.target.getAttribute('role') !== 'tab') return
        event.preventDefault()
        const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]:not(:disabled)')]
        if (!tabs.length) return
        const current = tabs.indexOf(event.target)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        tabs[next].focus({ preventScroll: true })
        const strip = event.currentTarget.getBoundingClientRect()
        const target = tabs[next].getBoundingClientRect()
        if (target.left < strip.left) event.currentTarget.scrollLeft += target.left - strip.left
        else if (target.right > strip.right) event.currentTarget.scrollLeft += target.right - strip.right
        tabs[next].click()
    }
    const busy = genomes.some(genome => ['queued', 'loading'].includes(state.panels[getGenomeKey(genome)]?.status))
    const multipleGenomes = genomes.length > 1
    const canSearch = genomes.some(genome => hasHomologySource(state.panels[getGenomeKey(genome)]) && effectiveQuery(state, getGenomeKey(genome)))
    return <div ref={rootRef} data-homology-workspace style={{ colorScheme: light ? 'light' : 'dark' }} className={`h-full overflow-y-auto p-4 md:p-6 space-y-4 ${scrollbarClass(light)} ${light ? 'text-gray-800' : 'text-gray-200'}`}>
        <section className={`rounded-xl border p-4 ${surface} ${border}`} aria-label="Homology searches">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-lg font-semibold">Homologies</h1><p className={`text-sm mt-1 ${muted}`}>{genomes.length === 1 ? 'Search local genes and explore their homology hits.' : 'Search local genes across genomes, then compare their shared hits.'}</p></div><span className={`text-xs ${muted}`} aria-live="polite">{genomes.length} active genome{genomes.length === 1 ? '' : 's'}{busy ? ' · searches in progress' : ''}</span></div>
            <div className={`homology-shared-search ${multipleGenomes ? 'homology-shared-search-open' : ''}`} aria-hidden={!multipleGenomes} inert={!multipleGenomes}>
                <div className="homology-shared-search-clip">
                    <form className="homology-shared-search-form flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (multipleGenomes) runAll() }}><label className="flex-1 min-w-52"><span className="sr-only">Shared gene symbol or ID</span><input className={`${input} w-full`} value={state.sharedQuery} onChange={event => dispatch({ type: 'shared', value: event.target.value })} placeholder="Gene symbol or ID across all genomes" /></label><button className="cursor-pointer rounded bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-semibold disabled:opacity-40" disabled={!multipleGenomes || !canSearch}>Search all</button></form>
                </div>
            </div>
            {!genomes.length && <p className={`mt-4 text-sm ${muted}`}>Activate genomes using the genome pills above to start searching.</p>}
            <div className={`mt-4 space-y-2 max-h-[320px] overflow-y-auto ${scrollbarClass(light)}`}>{genomes.map(genome => {
                const key = getGenomeKey(genome)
                const panel = state.panels[key]
                return <div key={key} className={`rounded-lg border p-3 ${border}`}>
                    <div className="flex flex-wrap items-center gap-3"><Badge genome={genome} color={colors(genome)} isLight={light} onClick={() => onToggleGenome(genome)} /><span className={`text-xs ${panel?.status === 'error' ? 'text-red-500' : muted}`} role="status">{statusLabel(panel)}</span>{panel?.submittedQuery && <span className={`text-xs ${muted}`}>Submitted: {panel.submittedQuery}</span>}{panel?.data?.matched_by === 'contains' && <span className="text-xs text-amber-600">Partial match</span>}</div>
                    <form className="flex flex-wrap items-center gap-2 mt-2" onSubmit={event => { event.preventDefault(); run(key) }}>
                        <input className={`${input} flex-1 min-w-40`} aria-label={`${multipleGenomes ? 'Query override' : 'Gene symbol or ID'} for ${genomeLabel(genome)}`} value={panel?.override ?? (multipleGenomes ? '' : state.sharedQuery)} placeholder={multipleGenomes ? state.sharedQuery ? `Using shared query: ${state.sharedQuery}` : 'Optional per-genome query' : 'Gene symbol or ID'} onChange={event => dispatch(multipleGenomes || panel?.override != null ? { type: 'override', key, value: event.target.value } : { type: 'shared', value: event.target.value })} />
                        {multipleGenomes && panel?.override !== null && panel?.override !== undefined && <button type="button" className={`cursor-pointer text-xs underline ${muted}`} onClick={() => dispatch({ type: 'override', key, value: null })}>Use shared query</button>}
                        <button className={`rounded border px-3 py-2 text-xs disabled:opacity-40 ${border}`} disabled={!hasHomologySource(panel) || !effectiveQuery(state, key)}>Search genome</button>
                    </form>{panel?.error && <p className="mt-2 text-xs text-red-500" role="alert">{panel.error}</p>}
                </div>
            })}</div>
        </section>
        <section className={`rounded-xl border ${surface} ${border}`} aria-label="Result filters">
            <button className="w-full text-left px-4 py-3 text-sm font-semibold" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}>Filters and display {filtersOpen ? '▴' : '▾'}</button>
            {filtersOpen && <div className="px-4 pb-4 space-y-3">
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                    <label className="text-xs">Summary rows<select className={`${input} block w-full mt-1`} value={state.filters.mode} onChange={event => setFilter({ mode: event.target.value })}>{[['all', 'All hits'], ['shared', 'Shared hits'], ['unique', 'Single-genome hits'], ['best', 'Best hits'], ['disagreements', 'Best-hit differences']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="text-xs">Target scope<select className={`${input} block w-full mt-1`} value={state.filters.targetScope} onChange={event => setFilter({ targetScope: event.target.value })}><option value="all">All TSV targets</option><option value="active">Active genomes</option><option value="local">Locally available genomes</option></select></label>
                    <label className="text-xs">Target genome<select className={`${input} block w-full mt-1`} value={state.filters.targetAssembly} onChange={event => setFilter({ targetAssembly: event.target.value })}><option value="">All target genomes</option>{[...targets].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="text-xs">Minimum genome support<input type="number" min="1" className={`${input} block w-full mt-1`} value={state.filters.minSupport} onChange={event => setFilter({ minSupport: Math.max(1, Number(event.target.value) || 1) })} /></label>
                    <label className="text-xs">Minimum protein identity (%)<input type="number" min="0" max="100" step="any" placeholder="Any" className={`${input} block w-full mt-1`} value={state.filters.minIdentity} onChange={event => { const value = event.target.value; if (value === '' || Number(value) >= 0 && Number(value) <= 100) setFilter({ minIdentity: value }) }} /></label>
                    <label className="text-xs">Minimum coverage (%)<input type="number" min="0" max="100" step="any" placeholder="Any" className={`${input} block w-full mt-1`} value={state.filters.minCoverage} onChange={event => { const value = event.target.value; if (value === '' || Number(value) >= 0 && Number(value) <= 100) setFilter({ minCoverage: value }) }} /></label>
                    <label className="text-xs">Detail-table sort<select className={`${input} block w-full mt-1`} value={state.filters.sortKey} onChange={event => setFilter({ sortKey: event.target.value })}><option value="score">Best-hit type, then score</option><option value="query_perc_id">Protein identity</option><option value="query_perc_cov">Coverage</option><option value="ref_gene_stable_id">Hit gene ID</option><option value="ref_gene_name">Hit symbol</option></select></label>
                    <label className="text-xs">Sort direction<select className={`${input} block w-full mt-1`} value={state.filters.direction} onChange={event => setFilter({ direction: event.target.value })}><option value="desc">Highest first</option><option value="asc">Lowest first</option></select></label>
                </div>
                <fieldset><legend className="text-xs font-semibold mb-2">Homology types</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{allTypes.map(type => <label key={type} className="text-xs flex gap-2 items-center"><input type="checkbox" checked={state.filters.types === null || state.filters.types.includes(type)} onChange={() => { const selected = state.filters.types ?? allTypes; setFilter({ types: selected.includes(type) ? selected.filter(item => item !== type) : [...selected, type] }) }} />{typeLabel(type)}</label>)}<button className="text-xs underline" onClick={() => setFilter({ types: null })}>All types</button><button className="text-xs underline" onClick={() => setFilter({ types: [] })}>None</button></div></fieldset>
                <details><summary className="text-xs font-semibold cursor-pointer">Visible detail-table columns</summary><div className="flex flex-wrap gap-3 mt-2">{allColumns.map(column => <label key={column} className="text-xs flex gap-2"><input type="checkbox" checked={visibleColumns.includes(column)} onChange={() => dispatch({ type: 'columns', value: visibleColumns.includes(column) ? visibleColumns.filter(item => item !== column) : [...visibleColumns, column] })} />{columnLabel(column)}</label>)}<button className="text-xs underline" onClick={() => dispatch({ type: 'columns', value: allColumns })}>All columns</button><button className="text-xs underline" onClick={() => dispatch({ type: 'columns', value: null })}>Default columns</button></div></details>
            </div>}
        </section>
        <section ref={resultsRef} className={`flex flex-col min-h-[320px] rounded-xl border overflow-hidden ${surface} ${border}`} aria-label="Homology results">
            <div className={`shrink-0 flex items-stretch gap-1 overflow-x-auto px-3 pt-2 border-b ${border} ${scrollbarClass(light)} ${light ? 'bg-gray-100/80' : 'bg-gray-900/40'}`} role="tablist" aria-label="Homology result tables" onKeyDown={handleTabKey}><ResultTab selected={multipleGenomes && tab === 'summary'} disabled={!multipleGenomes} title={!multipleGenomes ? 'Summary becomes active with two or more genomes.' : undefined} isLight={light} onClick={() => dispatch({ type: 'tab', key: 'summary' })}><span className="px-1 py-1.5 text-xs whitespace-nowrap font-semibold">Summary matrix</span></ResultTab>{genomes.filter(genome => { const panel = state.panels[getGenomeKey(genome)]; return genomes.length === 1 || panel?.status === 'ready' && panel.data.resolved_genes.length }).map(genome => {
                const key = getGenomeKey(genome)
                const panel = state.panels[key]
                return <ResultTab key={key} selected={tab === key} isLight={light} color={colors(genome)} label={`${genomeLabel(genome)}${panel?.data ? ` (${panel.data.total_rows.toLocaleString()})` : ''}`} onClick={() => dispatch({ type: 'tab', key })}><Badge genome={genome} color={colors(genome)} isLight={light} compact selected={tab === key} /></ResultTab>
            })}</div>
            {/* Every tab reserves the same row viewport, including loading/empty states. */}
            <div id="homology-result-panel" role="tabpanel" className="flex flex-col flex-1 min-h-0" aria-label={tab === 'summary' ? 'Summary matrix' : genomeLabel(activeGenome)}>{tab === 'summary' ? <ComparisonMatrix comparison={comparison} state={state} dispatch={dispatch} openEvidence={openEvidence} colors={colors} isLight={light} surface={surface} muted={muted} border={border} /> : <ResultsTable genome={activeGenome} panel={activePanel} state={state} dispatch={dispatch} localGenomes={localGenomes} activeGenomes={genomes} onOpenGene={onOpenGene} isLight={light} muted={muted} border={border} />}</div>
        </section>
        <p className={`text-xs ${muted}`}>“No hit reported” describes the TSV evidence for the resolved gene. It does not establish biological absence. Genomes with no resolved genes or unavailable data are excluded from the comparison denominator.</p>
    </div>
}
