// Isolated development fixture: every API request is synthetic. No user files,
// configuration, notes or saved sessions are read or written.
import { Profiler, StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import GenomeBrowserView from '../src/components/genome-browser/GenomeBrowserView.jsx'
import GenomeBrowser from '../src/components/genome-browser/GenomeBrowser.jsx'
import { TutorialProvider } from '../src/hooks/useTutorial.jsx'
import { NoteStoreProvider } from '../src/hooks/useNoteStore.jsx'
import { describeBrowserViewport } from '../src/utils/browserTutorialControls.js'
import '../src/index.css'

const params = new URLSearchParams(location.search)
if (params.has('navigation')) {
    document.getElementById('root').style.cssText = 'height:100vh; overflow-y:auto; padding:24px'
}
const count = Number(params.get('n') || 4)
const species = Array.from({ length: count }, (_, i) => ({
    species_key: `test_${i}`, species: `Test ${i}`, assembly: `ASM${i}`,
    files: { gff3: `/synthetic/${i}.gff3` },
}))
const config = { active_species: species, ref_gff: species[0].files.gff3, remember_browser_tracks: false }
const genes = Array.from({ length: 1500 }, (_, i) => ({
    id: `gene${i}`, name: `GENE${i}`, chrom: params.has('navigation') && i < 150 ? '2' : '1', start: 1000 + i * 1800,
    end: 2400 + i * 1800, strand: i % 2 ? '+' : '-', biotype: 'protein_coding',
}))
window.requests = []
window.fetch = async (input) => {
    const url = new URL(String(input), location.href)
    window.requests.push(url.pathname)
    let data = []
    let status = 200
    if (url.pathname.endsWith('/regions')) data = [{ chrom: '1', start: 1, end: 3000000, length: 3000000, gene_count: genes.length }]
    if (url.pathname.endsWith('/regions') && params.has('navigation')) data.push({ ...data[0], chrom: '2' })
    if (url.pathname.endsWith('/index-status')) data = { state: 'ready' }
    if (url.pathname.endsWith('/default_locus')) data = { chrom: '1', start: 900000, end: 1100000, chrom_length: 3000000 }
    if (url.pathname.endsWith('/resolve_id')) data = { gene: genes.find((gene) => gene.id === url.searchParams.get('query')) || null }
    if (url.pathname.endsWith('/resolve_id') && window.buildingGeneId === url.searchParams.get('query') && window.buildingResponses > 0) {
        window.buildingResponses--
        status = 425
        data = {}
    }
    if (url.pathname.endsWith('/genes')) data = genes
    if (url.pathname.endsWith('/tracks')) data = { tracks: [], groups: [] }
    if (url.pathname.endsWith('/session-tracks')) data = { genomes: {} }
    if (url.pathname.endsWith('/transcripts')) {
        const gene = genes.find((g) => g.id === url.searchParams.get('gene_id'))
        data = gene ? Array.from({ length: 8 }, (_, i) => ({
            id: `${gene.id}tx${i}`, start: gene.start, end: gene.end, strand: gene.strand,
            is_canonical: i === 0,
            exons: [{ start: gene.start, end: gene.start + 200 }, { start: gene.end - 200, end: gene.end }],
        })) : []
    }
    if (url.pathname.endsWith('/sequence')) {
        const start = Number(url.searchParams.get('start')), end = Number(url.searchParams.get('end'))
        data = { start, end, sequence: 'ACGT'.repeat(Math.ceil((end - start) / 4)).slice(0, end - start) }
    }
    // Model asynchronous I/O rather than an unlimited chain of resolved promises.
    if (url.pathname.endsWith('/regions') && window.navigationRegionDelay) await new Promise((resolve) => setTimeout(resolve, window.navigationRegionDelay))
    if (url.pathname.endsWith('/default_locus') && window.navigationDefaultDelay) await new Promise((resolve) => setTimeout(resolve, window.navigationDefaultDelay))
    if (url.pathname.endsWith('/resolve_id') && url.searchParams.get('query') === window.slowGeneId) await new Promise((resolve) => setTimeout(resolve, 500))
    if (!params.has('instant')) await new Promise((resolve) => setTimeout(resolve, 2))
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
if (params.has('no-observer')) window.IntersectionObserver = undefined
const resetMetrics = () => { window.metrics = { commits: [], paints: {} }; window.requests = [] }
resetMetrics()
const fillRect = CanvasRenderingContext2D.prototype.fillRect
CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
    if (x === 0 && y === 0 && width > 500) {
        const key = this.canvas.closest('[data-focus-panel-key]')?.dataset.focusPanelKey
        if (key) window.metrics.paints[key] = (window.metrics.paints[key] || 0) + 1
    }
    return fillRect.call(this, x, y, width, height)
}
const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, message) => { if (!condition) throw new Error(message) }
const surfaces = () => Array.from(document.querySelectorAll('[data-browser-canvas-surface]'))
const positions = () => surfaces().map((node) => describeBrowserViewport(node.dataset.focusPanelKey))
const span = (p) => p.end - p.start
// Mirrors useNearViewport's margin: panels inside it follow linked input live,
// panels beyond it are held and catch up within OFFSCREEN_LINK_INTERVAL_MS.
const nearScreen = () => surfaces().map((node) => {
    const rect = node.getBoundingClientRect()
    return rect.bottom > -600 && rect.top < innerHeight + 600
})
const near = (a, b) => Math.abs(a - b) < 0.01
const setLinks = async (pan, zoom = pan) => {
    for (const [id, enabled] of [['browser-pan', pan], ['browser-zoom', zoom]]) {
        const button = document.querySelector(`[data-tour-id="${id}"]`)
        if (button.dataset.tutorialEngaged !== String(enabled)) button.click()
    }
    await wait()
}
const wheel = (index, deltaX, deltaY = 0, ctrlKey = false) => {
    const node = surfaces()[index], rect = node.getBoundingClientRect()
    node.dispatchEvent(new WheelEvent('wheel', {
        deltaX, deltaY, ctrlKey, clientX: rect.left + 500, clientY: rect.top + 40,
        bubbles: true, cancelable: true,
    }))
}
function App() {
    const [, setViewport] = useState(null)
    const [options, setOptions] = useState({})
    useEffect(() => {
        window.updatePanel = (patch) => setOptions((previous) => ({ ...previous, ...patch }))
    }, [])
    return params.has('export') ? <>
        <div style={{ height: 2200 }} />
        <GenomeBrowser genome="export-test" screenshotTargetId="export-test" showSequenceTrack
            onScreenshotTargetChange={(target) => { window.exportTarget = target }} {...options} />
        <div style={{ height: 1500 }} />
    </> : <Profiler id="browser" onRender={(_id, _phase, duration) => window.metrics.commits.push(duration)}>
        <GenomeBrowserView config={config} onRefViewportChange={setViewport}
            onIncomingGeneConsumed={(entry) => {
                window.consumedGeneEntry = entry
                setOptions((previous) => previous.incomingGene === entry ? { ...previous, incomingGene: null } : previous)
            }} {...options} />
    </Profiler>
}
const tree = <TutorialProvider><NoteStoreProvider><App /></NoteStoreProvider></TutorialProvider>
// `strict` matches main.jsx: development StrictMode renders and memoizes twice.
createRoot(document.getElementById('root')).render(params.has('strict') ? <StrictMode>{tree}</StrictMode> : tree)
window.fixtureReady = () => surfaces().length === (params.has('export') ? 1 : count)
    && positions().every((p) => p?.ready)
window.runNavigationChecks = async () => {
    const { getGenomeKey } = await import('../src/utils/genomeIdentity.js')
    const { findScrollHost, panelAlignmentAnchor, stickyControlsInset } = await import('../src/utils/browserScrollRail.js')
    const waitFor = async (predicate, message) => {
        for (let i = 0; i < 150; i++) {
            if (predicate()) return
            await wait(50)
        }
        throw new Error(message)
    }
    const focus = async (genome, id) => {
        const entry = { genomeKey: getGenomeKey(genome), gene: { id } }
        window.updatePanel({ incomingGene: entry, isActive: true })
        await waitFor(() => window.consumedGeneEntry === entry, 'Gene request was not consumed')
        await waitFor(() => {
            const view = describeBrowserViewport(entry.genomeKey)
            const gene = genes.find((gene) => gene.id === id)
            return view?.focus === gene.name && view.chrom === gene.chrom
                && view.start <= gene.start && view.end >= gene.end
        }, 'Gene was not focused and framed')
        await waitFor(() => {
            const anchor = panelAlignmentAnchor(document, entry.genomeKey)
            const scroller = findScrollHost(anchor)
            const root = document.querySelector('[data-browser-global-controls]')?.parentElement
            return anchor && scroller && Math.abs(anchor.getBoundingClientRect().top
                - scroller.getBoundingClientRect().top - stickyControlsInset(root)) <= 2
        }, 'Target genome did not align at the top')
    }
    await focus(species[count - 1], 'gene20')
    wheel(count - 1, 300)
    await wait(150)
    await focus(species[count - 1], 'gene20')

    // Add a panel while hidden and let resolution beat its own regions fetch.
    const added = { species_key: 'added', assembly: 'ADDED', files: { gff3: '/synthetic/added.gff3' } }
    window.navigationRegionDelay = 350
    window.updatePanel({ isActive: false, config: { ...config, active_species: [...species, added] } })
    await wait(50)
    await focus(added, 'gene40')
    window.navigationRegionDelay = 0

    // A default-locus request already in flight must also yield to navigation.
    const later = { species_key: 'later', assembly: 'LATER', files: { gff3: '/synthetic/later.gff3' } }
    window.navigationDefaultDelay = 700
    window.updatePanel({ config: { ...config, active_species: [...species, added, later] } })
    await waitFor(() => surfaces().length === count + 2, 'New panel did not mount')
    await wait(100)
    await focus(later, 'gene60')
    await wait(800)
    check(describeBrowserViewport(getGenomeKey(later)).focus === 'GENE60', 'Default locus displaced focus')
    const view = describeBrowserViewport(getGenomeKey(later))
    check(view.start <= genes[60].start && view.end >= genes[60].end, 'Default locus displaced gene viewport')
    window.navigationDefaultDelay = 0
    window.buildingGeneId = 'gene80'
    window.buildingResponses = 1
    await focus(later, 'gene80')
    window.slowGeneId = 'gene100'
    window.updatePanel({ incomingGene: { genomeKey: getGenomeKey(later), gene: { id: 'gene100' } } })
    await wait(50)
    await focus(later, 'gene120')
    await wait(600)
    check(describeBrowserViewport(getGenomeKey(later)).focus === 'GENE120', 'An older lookup displaced the latest request')
    const missing = { genomeKey: getGenomeKey(later), gene: { id: 'missing' } }
    window.updatePanel({ incomingGene: missing })
    await waitFor(() => window.consumedGeneEntry === missing, 'Failed lookup stayed pending')
    check(document.querySelector('[role="alert"]')?.textContent.includes('missing'), 'Missing gene error was not shown')
    check(describeBrowserViewport(getGenomeKey(later)).focus === 'GENE120', 'Missing gene displaced existing focus')
    return 'PASS chromosome switch, scroll alignment, repeat click, activation, startup races, index build, stale lookup, missing gene'
}
window.runBenchmark = async (linked = false) => {
    await setLinks(linked)
    resetMetrics()
    const frames = []
    let last = performance.now()
    for (let i = 0; i < 90; i++) {
        await new Promise(requestAnimationFrame)
        const now = performance.now()
        frames.push(now - last)
        last = now
        wheel(0, i % 30 < 15 ? 8 : -8)
    }
    await wait(300)
    const { commits, paints } = window.metrics
    return {
        genomes: count, linked, commits: commits.length,
        reactRenderMs: commits.reduce((a, b) => a + b, 0),
        frameP95Ms: frames.sort((a, b) => a - b)[Math.ceil(frames.length * 0.95) - 1],
        paints, requests: window.requests.length,
    }
}
window.runChecks = async () => {
    await setLinks(false)
    let before = positions()
    resetMetrics()
    wheel(0, 8)
    await wait()
    let after = positions()
    check(!near(before[0].start, after[0].start), 'Independent pan did not move')
    check(after.slice(1).every((p, i) => near(p.start, before[i + 1].start)), 'Independent pan moved siblings')
    check(Object.keys(window.metrics.paints).length === 1, 'Independent pan repainted unchanged siblings')
    if (count > 1) {
        await setLinks(true)
        wheel(0, 8)
        await wait()
        after = positions()
        let live = nearScreen()
        check(after.every((p, i) => !live[i] || near(p.start, after[0].start)), 'Linked pan lost synchronization on screen')
        await wait(300)
        after = positions()
        check(after.every((p) => near(p.start, after[0].start)), 'Off-screen linked panels did not catch up')
        const previousSpan = span(after[0])
        wheel(1, 0, -20)
        await wait(200)
        after = positions()
        live = nearScreen()
        check(span(after[0]) < previousSpan, 'Zoom did not change scale')
        check(after.every((p, i) => !live[i] || near(span(p), span(after[0]))), 'Linked zoom lost synchronization after changing source')
        await wait(300)
        after = positions()
        check(after.every((p) => near(span(p), span(after[0]))), 'Off-screen linked panels did not catch up with zoom')
        await setLinks(false, true)
        before = positions()
        wheel(0, 8)
        await wait()
        after = positions()
        check(after.slice(1).every((p, i) => near(p.start, before[i + 1].start)), 'Zoom-only lock moved sibling centers on pan')
    }
    if (count === 12) {
        const last = surfaces().at(-1), key = last.dataset.focusPanelKey
        check(!window.metrics.paints[key], 'Far off-screen panel was painted during linked movement')
        resetMetrics()
        last.scrollIntoView()
        await wait(300)
        check(window.metrics.paints[key] > 0, 'Scrolling did not repaint the newly visible panel')
        check(last.querySelector('canvas').clientHeight > 0, 'Off-screen suppression lost panel geometry')
    }
    return 'independent pan, linked pan/zoom, source switching, zoom-only lock and scroll checks passed'
}
window.runExportChecks = async () => {
    const canvas = surfaces()[0].querySelector('canvas')
    await window.exportTarget.buildExportSnapshot()
    const original = canvas.toDataURL()
    resetMetrics()
    window.updatePanel({ lockPan: true, externalPosition: { chrom: '1', start: 1500000, end: 1600000 } })
    await wait(300)
    check(near(positions()[0].start, 1500000), 'Hidden panel lost linked coordinates')
    if (!params.has('no-observer')) check(!window.metrics.paints['export-test'], 'Hidden panel painted before export')
    const snapshot = await window.exportTarget.buildExportSnapshot()
    const exportedPixels = canvas.toDataURL()
    check(snapshot.svgMarkup.includes('<svg'), 'Export is not SVG')
    check(exportedPixels !== original, 'Export used stale canvas pixels')
    surfaces()[0].scrollIntoView()
    await wait(300)
    check(canvas.toDataURL() === exportedPixels, 'Export differs from the visible rendering')
    check(canvas.width === Math.round(canvas.clientWidth * devicePixelRatio), 'High-DPI backing size changed')
    window.updatePanel({ isActive: false, externalPosition: { chrom: '1', start: 1510000, end: 1610000 } })
    await wait()
    resetMetrics()
    window.updatePanel({ externalPosition: { chrom: '1', start: 1520000, end: 1620000 } })
    await wait()
    check(!window.metrics.paints['export-test'], 'Inactive panel painted')
    window.updatePanel({ isActive: true })
    await wait()
    check(window.metrics.paints['export-test'] > 0, 'Reactivation did not repaint')
    return 'off-screen export, visible pixel parity, high-DPI sizing and reactivation checks passed'
}

window.runLinkedStress = async () => {
    await setLinks(true)
    for (let i = 0; i < 450; i++) {
        await new Promise(requestAnimationFrame)
        const source = Math.floor(i / 30) % count
        if (i % 90 === 0) surfaces()[source].scrollIntoView()
        wheel(source, i % 60 < 30 ? 14 : -14)
        if (i % 120 === 0) wheel(source, 0, i % 240 === 0 ? -8 : 8)
    }
    await wait(300)
    const current = positions()
    check(current.length === count && current.every((p) => p?.ready), 'Stress run lost panels')
    check(current.every((p) => near(p.start, current[0].start) && near(p.end, current[0].end)), 'Stress run lost synchronization')
    return '450 linked input frames with repeated source changes and scrolling passed'
}
