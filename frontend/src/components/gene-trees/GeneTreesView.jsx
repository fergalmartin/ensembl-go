import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { API_BASE } from '../../backendRuntime'
import { resolveBrowsingControls } from '../../utils/browsingControls.js'
import { getAssemblyAccession, normalizeGenomeRecord } from '../../utils/genomeIdentity'
import { genomeForAssembly } from '../alignment-explorer/associations.js'
import { genomeColorResolver } from '../../genomeColorSchemes'
import { genomePillColors } from '../../utils/genomePillColors'
import DrawerChevron from '../DrawerChevron'
import { menuPosition, useMenuDismiss } from '../alignment-explorer/menuAnchor.js'
import TreeCanvas from './TreeCanvas.jsx'
import { CollectionDetailsDialog, LibraryDialog, LinkGenomesDialog, LoadTreeDialog } from './dialogs.jsx'
import { api, downloadText, formatBytes, loadPreference, loadViewState, query, savePreference, saveViewState } from './data.js'
import { PALETTES, linkStatus } from './paintTree.js'
import { layoutTree } from './treeLayout.js'
import {
  cladeTitle, defaultView, expandAll, expandEvents, expandSubtree, findLeaves, focusOn, indexTree,
  leafGeneLabel, leafSpeciesLabel, pathToRoot, showSubtree, toggleCollapsed, toggleFlipped,
} from './treeModel.js'
import './geneTrees.css'

const CLICK_MODES = [
  { id: 'toggle', label: 'Collapse or expand', hint: 'One click opens or folds a clade' },
  { id: 'expand', label: 'Expand everything below', hint: 'Open a clade and every clade inside it' },
  { id: 'focus', label: 'Focus', hint: 'Open the path to a node and fold everything else' },
  { id: 'flip', label: 'Flip', hint: 'Swap the order of a node’s branches' },
]
const HOVER_CARD_DELAY_MS = 2000
const EVENT_LABELS = { speciation: 'Speciation', duplication: 'Gene duplication', dubious: 'Ambiguous', gene_split: 'Gene split' }
const STATUS_LABELS = {
  topbar: 'In a genome in the top bar', local: 'In a local genome not in the top bar',
  genome: 'Species is local, gene not found in its annotation', pending: 'Checking local proteins…',
  unresolved: 'Not in a local genome', none: 'Not in a local genome',
}

/** One menu hanging off a toolbar control, positioned and dismissed like the explorer's. */
function AnchoredMenu({ anchorRef, position, onClose, title, children, isLight = false }) {
  useMenuDismiss(Boolean(position), onClose, anchorRef, 'gt-menu')
  if (!position) return null
  return createPortal(
    <div className={`gt-menu gt-anchored${isLight ? ' light' : ''}`} style={position} role="dialog" aria-label={title}>
      <div className="gt-menu-heading">{title}</div>
      {children}
    </div>, document.body)
}

function Glyph({ kind }) {
  const common = { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true }
  if (kind === 'duplication') return <svg {...common}><circle cx="9" cy="5.5" r="3.2" className="gt-g-dup" /><circle cx="9" cy="12.5" r="3.2" className="gt-g-dup" /></svg>
  if (kind === 'gene_split') return <svg {...common}><circle cx="9" cy="9" r="5" className="gt-g-split" /></svg>
  if (kind === 'dubious') return <svg {...common}><circle cx="9" cy="9" r="4" className="gt-g-dubious" /></svg>
  if (kind === 'topbar') return <svg {...common}><circle cx="9" cy="9" r="5" className="gt-g-linked-fill" /></svg>
  if (kind === 'local') return <svg {...common}><circle cx="9" cy="9" r="4.5" className="gt-g-local" /><circle cx="9" cy="9" r="1.8" className="gt-g-linked-fill" /></svg>
  if (kind === 'genome') return <svg {...common}><circle cx="9" cy="9" r="4.5" className="gt-g-genome" /></svg>
  if (kind === 'unresolved') return <svg {...common}><circle cx="9" cy="9" r="4.5" className="gt-g-none" /></svg>
  if (kind === 'focus') return <svg {...common}><circle cx="9" cy="9" r="6" className="gt-g-focus" /></svg>
  if (kind === 'collapsed') return <svg {...common}><rect x="1" y="4" width="16" height="10" rx="5" className="gt-g-pill" /></svg>
  return <svg {...common}><circle cx="9" cy="9" r="4" className="gt-g-speciation" /></svg>
}

function VerticalChevron({ pointsDown, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={pointsDown ? '6 9 12 15 18 9' : '18 15 12 9 6 15'} />
    </svg>
  )
}

/** A drawer section headed like the browser's focus drawer: title, chevron, rule, tools. */
function Section({ title, children, open: initiallyOpen = true, extra = null }) {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <section className="gt-section">
      <div className="gt-dh">
        <h3>{title}</h3>
        <button type="button" className="gt-dh-toggle" aria-expanded={open} onClick={() => setOpen(!open)}
          title={open ? `Hide ${title.toLowerCase()}` : `Show ${title.toLowerCase()}`}>
          <VerticalChevron pointsDown={!open} size={17} />
        </button>
        <div className="gt-dh-rule" />
        {extra}
      </div>
      {open ? <div className="gt-section-body">{children}</div> : null}
    </section>
  )
}

function KeyPill({ color, state, isLight }) {
  const style = genomePillColors(color || '#0099ff', { isLight, state })
  return <span className="gt-key-pill" style={{ background: style.backgroundColor, color: style.textColor, borderColor: style.borderColor }}>Aa</span>
}

function Stat({ value, label }) {
  return <div className="gt-stat"><strong>{Number(value || 0).toLocaleString()}</strong><span>{label}</span></div>
}

export default function GeneTreesView({ theme = 'dark', config, genomes = [], topBarGenomes = genomes, onAddGenome, incoming, onIncomingConsumed }) {
  const isLight = theme === 'light'
  const palette = isLight ? PALETTES.light : PALETTES.dark
  const controls = resolveBrowsingControls(config)
  const canvasRef = useRef(null)
  const clickButton = useRef(null)

  const [collections, setCollections] = useState([])
  const [current, setCurrent] = useState(null) // { collectionId, treeId }
  const [treeData, setTreeData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [view, setView] = useState(null)
  const [focusLeaf, setFocusLeaf] = useState(-1)
  const [fitKey, setFitKey] = useState(0)
  const [layoutName, setLayoutName] = useState(() => loadPreference('layout', 'curved'))
  const [phylogram, setPhylogram] = useState(() => loadPreference('phylogram', false))
  const [flipH, setFlipH] = useState(false)
  const [flipV, setFlipV] = useState(false)
  const [alignLeaves, setAlignLeaves] = useState(() => loadPreference('alignLeaves', false))
  const [shape, setShape] = useState(() => loadPreference('shape', 'linear'))
  const [copied, setCopied] = useState(false)
  const hoverTimer = useRef(null)
  const hoverPending = useRef(null)
  const [clickMode, setClickMode] = useState(() => loadPreference('clickMode', 'toggle'))
  const [clickMenu, setClickMenu] = useState(null) // the open menu's position
  const [dialog, setDialog] = useState(null) // {kind, collection?}
  const [hover, setHover] = useState(null)
  const [menu, setMenu] = useState(null)
  const [contexts, setContexts] = useState({ loading: false, results: [] })
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState(null) // { text, results } for the last finished search
  const [searching, setSearching] = useState(null) // { text, slow } while a search is in flight
  const [searchOpen, setSearchOpen] = useState(false)
  const [jobs, setJobs] = useState([]) // imports this view is following
  const [legacy, setLegacy] = useState(null)
  const [libraryVersion, setLibraryVersion] = useState(0)
  const searchRequest = useRef(null)
  const searchInput = useRef(null)
  const [drawerOpen, setDrawerOpen] = useState(() => loadPreference('drawer', true))
  const localRecords = useRef(null)

  useEffect(() => savePreference('layout', layoutName), [layoutName])
  useEffect(() => savePreference('phylogram', phylogram), [phylogram])
  useEffect(() => savePreference('clickMode', clickMode), [clickMode])
  useEffect(() => savePreference('drawer', drawerOpen), [drawerOpen])
  useEffect(() => savePreference('alignLeaves', alignLeaves), [alignLeaves])
  useEffect(() => savePreference('shape', shape), [shape])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  // The details card waits for the pointer to rest on something for a couple of seconds,
  // rather than flashing up under every node the cursor crosses. The canvas withholds
  // hovers while the view is being zoomed or panned, so the wait only starts once the
  // view is still.
  const onCanvasHover = useCallback((hit, x, y) => {
    if (!hit) {
      clearTimeout(hoverTimer.current)
      hoverPending.current = null
      setHover(null)
      return
    }
    const same = hoverPending.current?.id === hit.item.id
    hoverPending.current = { id: hit.item.id, hit, x, y }
    setHover(prev => (prev ? (prev.hit.item.id === hit.item.id ? { hit, x, y } : null) : prev))
    if (!same) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = setTimeout(() => {
        const pending = hoverPending.current
        if (pending) setHover({ hit: pending.hit, x: pending.x, y: pending.y })
      }, HOVER_CARD_DELAY_MS)
    }
  }, [])

  const refreshCollections = useCallback(async () => {
    try {
      const result = await api('/datasets')
      setCollections(result.collections || [])
      return result.collections || []
    } catch (err) {
      setError(`The tree library could not be read: ${err.message}`)
      return []
    }
  }, [])

  const index = useMemo(() => (treeData ? indexTree(treeData) : null), [treeData])
  const links = useMemo(() => treeData?.links || {}, [treeData])
  const preferAssemblies = useMemo(() => [...new Set((topBarGenomes || []).map(g => getAssemblyAccession(g)).filter(Boolean))], [topBarGenomes])
  const topbarAssemblies = useMemo(() => new Set(preferAssemblies), [preferAssemblies])
  const prefer = preferAssemblies.join(',')

  const chooseFocus = useCallback((idx, data, geneIds) => {
    const candidates = findLeaves(idx, geneIds)
    if (!candidates.length) return -1
    const score = id => {
      const status = linkStatus(data.links?.[id], topbarAssemblies)
      return status === 'topbar' ? 0 : status === 'local' ? 1 : 2
    }
    return [...candidates].sort((a, b) => score(a) - score(b))[0]
  }, [topbarAssemblies])

  const openTree = useCallback(async (collectionId, treeId, target = null) => {
    setLoading(true)
    setError('')
    setMenu(null)
    try {
      const data = await api(`/datasets/${collectionId}/trees/${encodeURIComponent(treeId)}`)
      const idx = indexTree(data)
      const stored = loadViewState(collectionId, treeId)
      let focus = target?.geneIds?.length ? chooseFocus(idx, data, target.geneIds) : (stored?.focus ?? -1)
      if (focus >= idx.nodes.length) focus = -1
      const nextView = target?.geneIds?.length || !stored
        ? defaultView(idx, focus)
        : { collapsed: stored.collapsed, flipped: stored.flipped, root: stored.root < idx.nodes.length ? stored.root : 0 }
      setTreeData(data)
      setView(nextView)
      setFocusLeaf(focus)
      setCurrent({ collectionId, treeId })
      setFitKey(k => k + 1)
      savePreference('last', { collectionId, treeId })
    } catch (err) {
      setError(err.status === 404 ? 'That tree is no longer in the library.' : `The tree could not be opened: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [chooseFocus])

  // First visit: the library, then whatever was open last time.
  useEffect(() => {
    let cancelled = false
    refreshCollections().then(list => {
      if (cancelled || incoming) return
      const last = loadPreference('last', null)
      if (last && list.some(c => c.id === last.collectionId)) openTree(last.collectionId, last.treeId)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Another view asked for a gene's trees.
  useEffect(() => {
    if (!incoming?.geneId) return
    let cancelled = false
    api(`/search${query({ gene: incoming.geneId, genome: incoming.assembly })}`).then(result => {
      if (cancelled) return
      const first = result.results?.[0]
      if (first) openTree(first.collection_id, first.tree_id, { geneIds: [incoming.geneId] })
      else setNotice(`No loaded tree contains ${incoming.label || incoming.geneId}. Load one that does, or search by another identifier.`)
    }).catch(err => setError(err.message)).finally(() => onIncomingConsumed?.())
    return () => { cancelled = true }
  }, [incoming, onIncomingConsumed, openTree])

  // Protein maps are built in the background: ask again until the links settle.
  useEffect(() => {
    if (!treeData?.links_pending || !current) return undefined
    const timer = setTimeout(async () => {
      try {
        const data = await api(`/datasets/${current.collectionId}/trees/${encodeURIComponent(current.treeId)}`)
        setTreeData(prev => (prev && prev.tree_id === data.tree_id ? { ...prev, links: data.links, link_summary: data.link_summary, links_pending: data.links_pending } : prev))
      } catch { /* the next open will retry */ }
    }, 1500)
    return () => clearTimeout(timer)
  }, [treeData, current])

  useEffect(() => {
    if (current && view) saveViewState(current.collectionId, current.treeId, view, focusLeaf)
  }, [current, view, focusLeaf])


  const layout = useMemo(() => (index && view ? layoutTree(index, view, {
    layout: layoutName, phylogram: phylogram && treeData?.stats?.has_branch_lengths, flipHorizontal: flipH, flipVertical: flipV,
    alignLeaves, shape,
  }) : null), [index, view, layoutName, phylogram, flipH, flipV, alignLeaves, shape, treeData])

  // Each local genome's own colour, the one its top-bar pill is drawn in, so a local
  // gene in the tree is recognisably "that genome".
  const resolveColor = useMemo(() => genomeColorResolver(config), [config])
  const genomeColors = useMemo(() => {
    const map = new Map()
    for (const link of Object.values(links)) {
      if (link?.status !== 'linked') continue
      for (const candidate of [link, ...(link.candidates || [])]) {
        if (!candidate.assembly || map.has(candidate.assembly)) continue
        const record = genomeForAssembly(topBarGenomes, candidate.assembly) || genomeForAssembly(genomes, candidate.assembly)
          || { species_key: candidate.species_key, assembly: candidate.assembly, gca: candidate.assembly, provider: candidate.provider }
        map.set(candidate.assembly, resolveColor(record))
      }
    }
    return map
  }, [links, topBarGenomes, genomes, resolveColor])

  const focusPath = useMemo(() => (index && focusLeaf >= 0 ? new Set(pathToRoot(index, focusLeaf)) : null), [index, focusLeaf])
  const focusNode = index && focusLeaf >= 0 ? index.nodes[focusLeaf] : null
  const focusLink = focusLeaf >= 0 ? links[focusLeaf] : null

  // Every tree context holding the focus gene.
  useEffect(() => {
    if (!focusNode?.leaf) { setContexts({ loading: false, results: [] }); return undefined }
    const controller = new AbortController()
    const leaf = focusNode.leaf
    const params = focusLink?.status === 'linked'
      ? { gene: focusLink.gene.id, genome: focusLink.assembly, q: [leaf.gene_id, leaf.protein_id].filter(Boolean).join(' '), prefer }
      : { q: [leaf.gene_id, leaf.protein_id, leaf.transcript_id, leaf.other_id].filter(Boolean).join(' ') || leaf.label, prefer }
    setContexts(prev => ({ ...prev, loading: true }))
    api(`/search${query(params)}`, undefined, controller.signal)
      .then(result => setContexts({ loading: false, results: result.results || [] }))
      .catch(err => { if (err.name !== 'AbortError') setContexts({ loading: false, results: [] }) })
    return () => controller.abort()
  }, [focusNode, focusLink, prefer, libraryVersion])

  // Library-wide search: as you type (debounced), or at once on Enter or the button.
  // A search that is still running after a moment says so; one still going after two
  // seconds says that too, because a large library can take that long.
  const runSearch = useCallback(text => {
    const trimmed = text.trim()
    searchRequest.current?.controller.abort()
    clearTimeout(searchRequest.current?.slowTimer)
    if (trimmed.length < 2) { setSearching(null); setSearchResults(null); return }
    const controller = new AbortController()
    const slowTimer = setTimeout(() => setSearching(prev => (prev && prev.text === trimmed ? { ...prev, slow: true } : prev)), 2000)
    searchRequest.current = { controller, slowTimer }
    setSearching({ text: trimmed, slow: false })
    setSearchOpen(true)
    api(`/search${query({ q: trimmed, prefer })}`, undefined, controller.signal)
      .then(result => { setSearchResults({ text: trimmed, results: result.results || [] }); setSearching(null) })
      .catch(err => { if (err.name !== 'AbortError') { setSearchResults({ text: trimmed, results: [], error: err.message }); setSearching(null) } })
      .finally(() => clearTimeout(slowTimer))
  }, [prefer])
  useEffect(() => {
    const timer = setTimeout(() => runSearch(search), 350)
    return () => clearTimeout(timer)
  }, [search, runSearch])
  useEffect(() => () => searchRequest.current?.controller.abort(), [])
  useEffect(() => {
    if (!searchOpen) return undefined
    const away = event => { if (!event.target.closest?.('.gt-search')) setSearchOpen(false) }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [searchOpen])

  const openSearchResult = result => {
    const text = searchResults?.text || search.trim()
    setSearchOpen(false)
    setSearch('')
    // Local copies of the gene first, so the tree opens on the user's own gene.
    const ids = [...result.matches.map(m => m.gene_id || m.protein_id || m.label), text]
    openTree(result.collection_id, result.tree_id, { geneIds: ids })
  }
  const onSearchKey = event => {
    if (event.key === 'Escape') { setSearch(''); setSearchOpen(false); return }
    if (event.key !== 'Enter') return
    event.preventDefault()
    const text = search.trim()
    if (searchResults && searchResults.text === text && !searching && searchResults.results.length) openSearchResult(searchResults.results[0])
    else runSearch(text)
  }

  // Imports keep running when the dialog closes (or the view does): follow them here.
  const refreshJobs = useCallback(async () => {
    try {
      const result = await api('/jobs')
      setJobs(prev => {
        const known = new Map(prev.map(j => [j.id, j]))
        for (const job of result.jobs || []) {
          if (known.has(job.id) || ['queued', 'running'].includes(job.status)) known.set(job.id, { ...known.get(job.id), ...job })
        }
        return [...known.values()]
      })
    } catch { /* the backend restarted; the next poll will tell */ }
  }, [])
  useEffect(() => {
    refreshJobs()
    api('/legacy').then(result => setLegacy(result.legacy)).catch(() => {})
  }, [refreshJobs])
  const activeJobs = jobs.filter(j => ['queued', 'running'].includes(j.status))
  useEffect(() => {
    if (!activeJobs.length) return undefined
    const timer = setInterval(refreshJobs, 700)
    return () => clearInterval(timer)
  }, [activeJobs.length, refreshJobs])

  const focusGeneIds = useCallback(() => {
    const leaf = focusNode?.leaf
    if (!leaf) return []
    return [focusLink?.gene?.id, leaf.gene_id, leaf.protein_id, leaf.transcript_id, leaf.other_id].filter(Boolean)
  }, [focusNode, focusLink])

  // When an import finishes: refresh the library, say what happened, and open the tree
  // if it was a single one and nothing else is open.
  const settled = useRef(new Set())
  useEffect(() => {
    const done = jobs.filter(j => !['queued', 'running'].includes(j.status) && !settled.current.has(j.id))
    if (!done.length) return
    for (const job of done) settled.current.add(job.id)
    ;(async () => {
      const list = await refreshCollections()
      setLibraryVersion(v => v + 1)
      for (const job of done) {
        if (job.status === 'failed') { setError(`${job.name} could not be loaded: ${job.error || 'unknown error'}`); continue }
        if (job.status === 'cancelled') { setNotice(`Loading ${job.name} was cancelled.`); continue }
        const created = list.find(c => c.id === job.collection_id)
        if (!created) continue
        if (created.tree_count === 1 && !current) {
          const trees = await api(`/datasets/${created.id}/trees${query({ limit: 1 })}`)
          if (trees.trees?.[0]) openTree(created.id, trees.trees[0].tree_id, focusNode?.leaf ? { geneIds: focusGeneIds() } : null)
        } else {
          setNotice(`${created.name} is ready: ${created.tree_count.toLocaleString()} trees and ${created.leaf_count.toLocaleString()} genes indexed. Search for a gene to open its tree.`)
          searchInput.current?.focus()
        }
      }
      setJobs(prev => prev.filter(j => ['queued', 'running'].includes(j.status)))
      api('/legacy').then(result => setLegacy(result.legacy)).catch(() => {})
    })()
  }, [jobs, refreshCollections, current, openTree, focusNode, focusGeneIds])

  const switchContext = context => {
    openTree(context.collection_id, context.tree_id, { geneIds: [...focusGeneIds(), ...(context.matches || []).map(m => m.gene_id || m.label)] })
  }

  const act = useCallback((item, action) => {
    if (!index || !view) return
    if (item.kind === 'leaf') { setFocusLeaf(item.id); return }
    if (action === 'expand') setView(expandSubtree(index, view, item.id))
    else if (action === 'focus') setView(focusOn(index, view, item.id))
    else if (action === 'flip') setView(toggleFlipped(index, view, item.id))
    else setView(toggleCollapsed(index, view, item.id))
  }, [index, view])

  const onNodeClick = useCallback((item, mods) => {
    setMenu(null)
    if (mods.alt) act(item, 'expand')
    else if (mods.shift) act(item, 'focus')
    else act(item, clickMode)
  }, [act, clickMode])

  const addGenome = async assembly => {
    let genome = genomeForAssembly(topBarGenomes, assembly) || genomeForAssembly(genomes, assembly)
    if (!genome) {
      if (!localRecords.current) {
        try {
          const outputDir = String(config?.output_dir || '').trim()
          const response = outputDir ? await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(outputDir)}`) : null
          localRecords.current = response?.ok ? (await response.json()).map(item => normalizeGenomeRecord(item)) : []
        } catch { localRecords.current = [] }
      }
      genome = genomeForAssembly(localRecords.current, assembly)
    }
    if (!genome || !onAddGenome) { setNotice('That genome could not be found locally.'); return }
    const result = await onAddGenome(genome, 'gene_trees', { desired: 'selected' })
    setNotice(result?.ok === false ? (result.message || 'The genome could not be added to the top bar.') : `${genome.common_name || genome.scientific_name || assembly} is in the top bar.`)
  }

  const exportTree = async (format, node = null) => {
    if (!current) return
    const text = await api(`/datasets/${current.collectionId}/trees/${encodeURIComponent(current.treeId)}/export${query({ format, node })}`)
    downloadText(`${current.treeId}${node !== null ? `_node${node}` : ''}.${format === 'nhx' ? 'nhx' : 'nwk'}`, text)
  }

  const resetTree = () => {
    if (!index) return
    setView(defaultView(index, focusLeaf))
    setFlipH(false)
    setFlipV(false)
    setFitKey(k => k + 1)
  }

  const collection = current ? collections.find(c => c.id === current.collectionId) : null
  const stats = treeData?.stats || {}
  const summary = treeData?.link_summary || {}
  const shownRoot = view?.root ?? 0

  // ── rendering helpers ──

  const tooltip = (() => {
    if (!hover?.hit || menu) return null
    const { item } = hover.hit
    const node = item.node
    const rows = []
    let title = ''
    if (node.leaf) {
      const leaf = node.leaf
      title = leafSpeciesLabel(leaf) || leafGeneLabel(leaf)
      if (leaf.common_name && leaf.species) rows.push(['Species', leaf.species])
      if (leaf.symbol) rows.push(['Symbol', leaf.symbol])
      if (leaf.gene_id) rows.push(['Gene', leaf.gene_id])
      if (leaf.protein_id) rows.push(['Protein', leaf.protein_id])
      if (!leaf.gene_id && !leaf.protein_id && leaf.label) rows.push(['Label', leaf.label])
      if (node.branch_length != null) rows.push(['Branch length', Number(node.branch_length).toPrecision(3)])
      const link = links[item.id]
      rows.push(['Local', link?.status === 'linked' ? `${link.genome_name || link.assembly}${link.matched_by === 'symbol' ? ' (matched by symbol)' : ''}` : STATUS_LABELS[linkStatus(link, topbarAssemblies)]])
    } else {
      title = cladeTitle(index, item.id)
      if (node.taxon?.common_name) rows.push(['Common name', node.taxon.common_name])
      if (node.taxon?.mya) rows.push(['Age', `~${node.taxon.mya} million years`])
      if (node.event) rows.push(['Event', `${EVENT_LABELS[node.event] || node.event}${node.event_inferred ? ' (inferred)' : ''}`])
      rows.push(['Genes', index.leafCount[item.id].toLocaleString()])
      if (node.branch_length != null) rows.push(['Branch length', Number(node.branch_length).toPrecision(3)])
      if (node.support != null) rows.push(['Support', node.support])
      if (node.taxon?.inferred) rows.push(['Taxon', 'inferred from its species'])
    }
    const hint = hover.hit.part === 'folded' ? 'Too small to show at this zoom · click to zoom in' : node.leaf ? 'Click to focus this gene' : (item.kind === 'collapsed' ? 'Click to expand · ⌥-click opens everything' : `Click: ${CLICK_MODES.find(m => m.id === clickMode)?.label.toLowerCase()} · right-click for more`)
    const style = { left: Math.min(hover.x + 14, window.innerWidth - 300), top: Math.min(hover.y + 14, window.innerHeight - 200) }
    return createPortal(
      <div className={`gt-tooltip${isLight ? ' light' : ''}`} style={style}>
        <strong>{title}</strong>
        <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        <small>{hint}</small>
      </div>, document.body)
  })()

  const contextMenu = (() => {
    if (!menu) return null
    const item = menu.item
    const close = () => setMenu(null)
    const run = fn => () => { close(); fn() }
    const entries = []
    if (!item) {
      entries.push(['Expand all', () => setView(expandAll(view))])
      entries.push(['Reset tree', resetTree])
      entries.push(['Fit to view', () => canvasRef.current?.fit(focusLeaf)])
    } else if (item.kind === 'leaf') {
      const link = links[item.id]
      entries.push(['Focus this gene', () => setFocusLeaf(item.id)])
      if (link?.status === 'linked' && linkStatus(link, topbarAssemblies) === 'local') entries.push([`Add ${link.genome_name || link.assembly} to the top bar`, () => addGenome(link.assembly)])
      entries.push(['Copy identifier', () => navigator.clipboard?.writeText(leafGeneLabel(item.node.leaf))])
    } else {
      const collapsed = view.collapsed.has(item.id)
      entries.push([collapsed ? 'Expand' : 'Collapse', () => setView(toggleCollapsed(index, view, item.id))])
      entries.push(['Expand everything below', () => setView(expandSubtree(index, view, item.id))])
      entries.push(['Fold everything else', () => setView(focusOn(index, view, item.id))])
      entries.push(['Flip branches', () => setView(toggleFlipped(index, view, item.id))])
      if (item.id !== shownRoot) entries.push(['Show only this clade', () => { setView(showSubtree(expandSubtree(index, view, item.id), item.id)); setFitKey(k => k + 1) }])
      entries.push(['Export clade as Newick', () => exportTree('newick', item.id)])
      entries.push(['Export clade as NHX', () => exportTree('nhx', item.id)])
    }
    if (shownRoot !== 0) entries.push(['Show the whole tree', () => { setView(showSubtree(view, 0)); setFitKey(k => k + 1) }])
    const style = { left: Math.min(menu.x, window.innerWidth - 260), top: Math.min(menu.y, window.innerHeight - entries.length * 36 - 60) }
    return createPortal(
      <div className={`gt-menu gt-context${isLight ? ' light' : ''}`} style={style} role="menu"
        onPointerDown={e => e.stopPropagation()}>
        {item ? <div className="gt-menu-heading">{item.node.leaf ? leafSpeciesLabel(item.node.leaf) || leafGeneLabel(item.node.leaf) : cladeTitle(index, item.id)}</div> : null}
        {entries.map(([label, fn]) => <button key={label} type="button" role="menuitem" onClick={run(fn)}>{label}</button>)}
      </div>, document.body)
  })()

  useEffect(() => {
    if (!menu) return undefined
    const away = event => { if (!event.target.closest?.('.gt-context')) setMenu(null) }
    const key = event => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key) }
  }, [menu])

  const focusLeafData = focusNode?.leaf
  const focusStatus = linkStatus(focusLink, topbarAssemblies)
  const otherContexts = contexts.results.filter(c => !(c.collection_id === current?.collectionId && c.tree_id === current?.treeId))

  return (
    <div className={`gene-trees${isLight ? ' light' : ''}`} data-tour-id="gene-trees-view">
      <div className="gt-top">
        <div className="gt-search">
          <input ref={searchInput} type="search" value={search} placeholder="Find trees by gene symbol, gene or protein ID, or tree ID" aria-label="Find trees"
            onChange={e => setSearch(e.target.value)} onKeyDown={onSearchKey} onFocus={() => { if (searchResults || searching) setSearchOpen(true) }} />
          <button type="button" className={`gt-search-go${searching ? ' busy' : ''}`} onClick={() => runSearch(search)}
            aria-label="Search" title="Search the tree library">
            {searching ? <span className="gt-spinner" aria-hidden="true" /> : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            )}
          </button>
          {searchOpen && (searching || searchResults) && search.trim().length >= 2 ? (
            <div className="gt-search-results" role="listbox" aria-busy={Boolean(searching)}>
              {searching ? (
                <p className="gt-searching"><span className="gt-spinner" aria-hidden="true" />
                  {searching.slow ? `Still searching for “${searching.text}”… large libraries can take a few seconds.` : `Searching for “${searching.text}”…`}</p>
              ) : null}
              {searchResults && !(searching && searchResults.text !== searching.text && !searchResults.results.length) ? (
                <div className={searching ? 'gt-stale' : ''}>
                  {searchResults.error ? <p className="gt-error">{searchResults.error}</p> : null}
                  {searchResults.results.length ? searchResults.results.map(result => {
                    const local = result.matches.filter(m => m.rank < 9)
                    const others = result.matches.filter(m => m.rank >= 9)
                    return (
                      <button key={`${result.collection_id}:${result.tree_id}`} type="button" role="option" aria-selected="false" onClick={() => openSearchResult(result)}>
                        <strong>{result.tree_name}</strong>
                        <span>{[result.collection_name, result.method, `${result.leaf_count.toLocaleString()} genes`, result.species_count ? `${result.species_count} species` : ''].filter(Boolean).join(' · ')}</span>
                        {local.length ? <em className="gt-local-match">{local.slice(0, 3).map(m => `${m.genome_name || m.species}: ${m.gene_id || m.label}`).join(' · ')}</em> : null}
                        {others.length ? <em>{others.slice(0, local.length ? 3 : 4).map(m => (m.species ? `${m.species}: ${m.symbol || m.gene_id || m.label}` : (m.gene_id || m.label))).join(' · ')}{result.match_count > result.matches.length ? ` · +${result.match_count - result.matches.length} more` : ''}</em> : null}
                      </button>
                    )
                  }) : (!searching ? <p className="gt-muted">No loaded tree contains “{searchResults.text}”.{prefer ? '' : ' Genes in genomes in the top bar are also searched by symbol.'}</p> : null)}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <button type="button" onClick={() => setDialog({ kind: 'library' })}>Library{collections.length ? ` (${collections.length})` : ''}</button>
        <button type="button" onClick={() => setDialog({ kind: 'load' })}>Load trees…</button>
        <span className="gt-spacer" />
        <span ref={clickButton}>
          <button type="button" aria-expanded={Boolean(clickMenu)} disabled={!treeData}
            onClick={() => setClickMenu(clickMenu ? null : menuPosition(clickButton.current, 320, 'gt'))}>
            Click: {CLICK_MODES.find(m => m.id === clickMode)?.label} ▾
          </button>
        </span>
        <button type="button" onClick={resetTree} disabled={!treeData}>Reset tree</button>
      </div>
      <AnchoredMenu isLight={isLight} anchorRef={clickButton} position={clickMenu} onClose={() => setClickMenu(null)} title="A click on a clade will…">
        {CLICK_MODES.map(mode => (
          <button key={mode.id} type="button" className={`gt-menu-option${mode.id === clickMode ? ' selected' : ''}`}
            onClick={() => { setClickMode(mode.id); setClickMenu(null) }}>
            <strong>{mode.label}</strong><span>{mode.hint}</span>
          </button>
        ))}
        <p className="gt-muted">Whatever is chosen: ⌥-click expands everything below, ⇧-click folds everything else, right-click lists every action.</p>
      </AnchoredMenu>

      {activeJobs.map(job => {
        const percent = job.fraction != null ? Math.round(job.fraction * 100) : null
        const phase = job.phase === 'finishing' ? 'Finishing the index…' : job.phase === 'removing' ? 'Cancelling…'
          : job.status === 'queued' ? 'Waiting for the current import to finish…' : 'Indexing'
        const eta = job.eta != null && job.eta > 3 ? (job.eta > 90 ? `about ${Math.round(job.eta / 60)} min left` : `about ${Math.round(job.eta)} s left`) : ''
        return (
          <div key={job.id} className="gt-job" role="status">
            <div className="gt-job-text">
              <strong>{phase} {job.name}</strong>
              <span>{[job.trees ? `${job.trees.toLocaleString()} trees` : '', job.leaves ? `${job.leaves.toLocaleString()} genes` : '',
                job.bytes_total ? `${percent ?? 0}% of ${formatBytes(job.bytes_total)} read` : '', eta].filter(Boolean).join(' · ') || 'Starting…'}</span>
            </div>
            <div className="gt-progress" aria-hidden="true"><div style={{ width: `${percent ?? 2}%` }} /></div>
            <button type="button" onClick={() => api(`/jobs/${job.id}/cancel`, {}).then(refreshJobs)}>Cancel</button>
          </div>
        )
      })}
      {legacy && !activeJobs.length ? (
        <div className="gt-notice gt-legacy">
          <span>
            An earlier version of the tree library is still on disk ({formatBytes(legacy.size)}): {legacy.collections.map(c => `${c.name} (${Number(c.tree_count).toLocaleString()} trees)`).join(', ')}.
            {' '}The new index is much smaller and searches faster.
            {legacy.collections.some(c => !c.source_exists) ? ' Some original files have moved, so those collections need loading again by hand.' : ''}
          </span>
          <span className="gt-row">
            {legacy.collections.some(c => c.source_exists) && !collections.some(c => legacy.collections.some(l => l.name === c.name)) ? (
              <button type="button" className="primary" onClick={() => api('/legacy/reindex', {}).then(refreshJobs)}>Re-index from the original files</button>
            ) : null}
            <button type="button" onClick={async () => {
              if (!window.confirm(`Delete the earlier tree library (${formatBytes(legacy.size)})? Your original tree files are not touched, and anything re-indexed stays.`)) return
              await api('/legacy', undefined, undefined, 'DELETE')
              setLegacy(null)
            }}>Remove the old library</button>
          </span>
        </div>
      ) : null}
      {notice ? <div className="gt-notice"><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button></div> : null}
      {error ? <div className="gt-notice error"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button></div> : null}

      <div className="gt-body">
        <div className="gt-main">
        {treeData ? (
          <div className="gt-contexts" aria-live="polite">
            {focusLeafData ? (
              <>
                <span className="gt-contexts-gene">
                  <Glyph kind="focus" />
                  <strong>{focusLeafData.symbol || focusLink?.gene?.name || leafGeneLabel(focusLeafData)}</strong>
                  <span>{leafSpeciesLabel(focusLeafData)}</span>
                </span>
                <span className="gt-contexts-label">{contexts.loading ? 'Looking for other trees…' : contexts.results.length > 1 ? `In ${contexts.results.length} trees:` : 'Only in this tree'}</span>
                <div className="gt-context-chips">
                  {contexts.results.length > 1 ? contexts.results.map(context => {
                    const active = context.collection_id === current?.collectionId && context.tree_id === current?.treeId
                    return (
                      <button key={`${context.collection_id}:${context.tree_id}`} type="button" className={`gt-chip${active ? ' selected' : ''}`}
                        aria-pressed={active} onClick={() => !active && switchContext(context)}
                        title={[context.collection_name, context.method, context.tags?.join(', ')].filter(Boolean).join(' · ')}>
                        <strong>{context.collection_name}</strong>
                        <span>{context.tree_name !== context.collection_name ? `${context.tree_name} · ` : ''}{context.leaf_count} genes{context.species_count ? ` · ${context.species_count} species` : ''}</span>
                      </button>
                    )
                  }) : null}
                  {otherContexts.length === 0 && !contexts.loading ? <span className="gt-muted gt-contexts-hint">Load another tree containing this gene to compare contexts.</span> : null}
                </div>
              </>
            ) : <span className="gt-muted">Click a gene to focus it; the other trees it is in appear here.</span>}
          </div>
        ) : null}
        <div className="gt-stage" data-screenshot-capture="view">
          {treeData && layout ? (
            <TreeCanvas
              ref={canvasRef}
              index={index}
              layout={layout}
              links={links}
              focusId={focusLeaf}
              focusPath={focusPath}
              palette={palette}
              topbarAssemblies={topbarAssemblies}
              controls={controls}
              fitKey={`${fitKey}:${layoutName}:${phylogram}:${shape}`}
              focusRowId={focusLeaf}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={item => { if (item.kind !== 'leaf') setView(expandSubtree(index, view, item.id)) }}
              onNodeContextMenu={(item, x, y) => setMenu({ item, x, y })}
              onHover={onCanvasHover}
              genomeColors={genomeColors}
              ariaLabel={`Gene tree ${treeData.name || ''}`}
            />
          ) : (
            <div className="gt-empty">
              {loading ? <p>Opening the tree…</p> : activeJobs.length && !collections.some(c => c.status === 'ready') ? (
                <>
                  <h2>Indexing your trees</h2>
                  <p>Progress is shown above. When it finishes, search for a gene to open the trees that hold it; your own genomes' copies come first.</p>
                </>
              ) : (
                <>
                  <h2>{collections.length ? 'Choose a tree' : 'Load a gene tree'}</h2>
                  <p>Gene trees from Ensembl Compara (NHX, JSON or EMF dumps), OrthoFinder, IQ-TREE, RAxML or any Newick file. Leaves that are genes in your local genomes are linked to them.</p>
                  <div className="gt-row gt-center">
                    <button type="button" className="primary" onClick={() => setDialog({ kind: 'load' })}>Load trees…</button>
                    {collections.length ? <button type="button" onClick={() => setDialog({ kind: 'library' })}>Open the library</button> : null}
                  </div>
                </>
              )}
            </div>
          )}
          {loading && treeData ? <div className="gt-loading">Opening…</div> : null}
          {treeData && shownRoot !== 0 ? (
            <button type="button" className="gt-floating" onClick={() => { setView(showSubtree(view, 0)); setFitKey(k => k + 1) }}>
              Showing {cladeTitle(index, shownRoot)} · show the whole tree
            </button>
          ) : null}
        </div>
        </div>

        {treeData ? (
          <aside className={`gt-drawer${drawerOpen ? '' : ' rail'}`} aria-label="Tree details">
            <div className="gt-band">
              <button type="button" className="gt-band-toggle" onClick={() => setDrawerOpen(!drawerOpen)}
                title={drawerOpen ? 'Hide the tree panel' : 'Show the tree panel'} aria-expanded={drawerOpen}>
                <DrawerChevron pointsRight={drawerOpen} size={20} />
              </button>
              {drawerOpen ? (
                <div className="gt-band-text">
                  <div className="gt-band-line">
                    <strong>{focusLeafData ? (focusLeafData.symbol || focusLink?.gene?.name || leafGeneLabel(focusLeafData)) : treeData.name}</strong>
                    <span>{focusLeafData ? leafSpeciesLabel(focusLeafData) : `${(stats.genes || 0).toLocaleString()} genes`}</span>
                  </div>
                  {focusLeafData ? (
                    <div className="gt-band-line">
                      <span className="gt-mono">{focusLink?.gene?.id || focusLeafData.gene_id || focusLeafData.protein_id || focusLeafData.label}</span>
                      <button type="button" className="gt-band-icon" title="Copy the gene ID" onClick={() => {
                        navigator.clipboard?.writeText(focusLink?.gene?.id || focusLeafData.gene_id || focusLeafData.protein_id || focusLeafData.label)
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1200)
                      }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="16" rx="2.2" /><path d="M9 3h6v4H9z" /></svg>
                      </button>
                      {copied ? <span className="gt-band-feedback">Copied</span> : null}
                    </div>
                  ) : <div className="gt-band-line"><span>No gene focused</span></div>}
                </div>
              ) : null}
            </div>
            {drawerOpen ? (
            <div className="gt-drawer-body">
            <Section title="Tree">
              <div className="gt-tree-title">
                <strong>{treeData.name}</strong>
                <span>{collection?.name}{collection?.method ? ` · ${collection.method}` : ''}</span>
                {collection?.tags?.length ? <span className="gt-tags">{collection.tags.map(tag => <em key={tag}>{tag}</em>)}</span> : null}
              </div>
              <div className="gt-stats">
                <Stat value={stats.genes} label="genes" />
                <Stat value={stats.species} label="species" />
                <Stat value={stats.speciation} label="speciation nodes" />
                <Stat value={stats.duplication} label="duplication nodes" />
                <Stat value={stats.dubious} label="ambiguous nodes" />
                <Stat value={stats.gene_split} label="gene split events" />
              </div>
              {stats.events_inferred ? <p className="gt-muted">Events were inferred from species overlap; the file did not mark them.</p> : null}
              <p className="gt-linked-summary">
                <Glyph kind="topbar" /> {(summary.linked || 0).toLocaleString()} gene{summary.linked === 1 ? '' : 's'} in local genomes
                {summary.genome ? <><br /><Glyph kind="genome" /> {summary.genome} in a local species but not found</> : null}
                {treeData.links_pending ? <><br /><span className="gt-muted">Checking protein identifiers…</span></> : null}
              </p>
              <div className="gt-row">
                {collection ? <button type="button" onClick={() => setDialog({ kind: 'links', collection })}>Link genomes…</button> : null}
                {collection ? <button type="button" onClick={() => setDialog({ kind: 'details', collection })}>Details</button> : null}
                <button type="button" onClick={() => exportTree('newick')}>Export</button>
              </div>
            </Section>

            <Section title="Layout">
              <div className="gt-option-row">
                <span className="gt-option-label">Shape</span>
                <div className="gt-radio-row" role="radiogroup" aria-label="Tree shape">
                  {[['linear', 'Linear'], ['radial', 'Radial']].map(([id, label]) => (
                    <label key={id}><input type="radio" name="gt-shape" checked={shape === id} onChange={() => setShape(id)} />{label}</label>
                  ))}
                </div>
              </div>
              <div className="gt-option-row">
                <span className="gt-option-label">Branches</span>
                <div className="gt-radio-row" role="radiogroup" aria-label="Branch style">
                  {[['curved', 'Curved'], ['rectangular', 'Rectangular']].map(([id, label]) => (
                    <label key={id}><input type="radio" name="gt-layout" checked={layoutName === id} onChange={() => setLayoutName(id)} />{label}</label>
                  ))}
                </div>
              </div>
              <label className="gt-check"><input type="checkbox" checked={phylogram} disabled={!stats.has_branch_lengths} onChange={e => setPhylogram(e.target.checked)} />
                Phylogram {stats.has_branch_lengths ? <small>branch lengths to scale</small> : <small>no branch lengths in this tree</small>}</label>
              <label className="gt-check"><input type="checkbox" checked={flipH} onChange={e => setFlipH(e.target.checked)} />{shape === 'radial' ? 'Mirror left to right' : 'Root on the right'}</label>
              <label className="gt-check"><input type="checkbox" checked={alignLeaves} onChange={e => setAlignLeaves(e.target.checked)} />
                Align leaves <small>{shape === 'radial' ? 'tips on the outer circle' : flipH ? 'labels in one column on the left' : 'labels in one column on the right'}</small></label>
              <label className="gt-check"><input type="checkbox" checked={flipV} onChange={e => setFlipV(e.target.checked)} />{shape === 'radial' ? 'Mirror top to bottom' : 'Upside down'}</label>
            </Section>

            <Section title="Nodes">
              <div className="gt-row">
                <button type="button" onClick={() => setView(expandAll(view))}>Expand all</button>
                <button type="button" disabled={focusLeaf < 0} onClick={() => setView(focusOn(index, view, focusLeaf))}>Fold to focus</button>
                <button type="button" disabled={!stats.duplication} onClick={() => setView(expandEvents(index, view, ['duplication']))}>Open duplications</button>
              </div>
              <ul className="gt-key">
                <li><Glyph kind="speciation" />Speciation</li>
                <li><Glyph kind="duplication" />Gene duplication</li>
                <li><Glyph kind="gene_split" />Gene split</li>
                <li><Glyph kind="dubious" />Ambiguous</li>
                <li><Glyph kind="collapsed" />Folded clade, with its gene count</li>
              </ul>
            </Section>

            <Section title="Genes">
              {focusLeafData ? (
                <div className="gt-focus-card">
                  <strong>{leafSpeciesLabel(focusLeafData) || 'Selected gene'}</strong>
                  <dl>
                    {focusLeafData.symbol || focusLink?.gene?.name ? <div><dt>Symbol</dt><dd>{focusLeafData.symbol || focusLink?.gene?.name}</dd></div> : null}
                    {focusLeafData.gene_id || focusLink?.gene?.id ? <div><dt>Gene</dt><dd className="gt-mono">{focusLeafData.gene_id || focusLink.gene.id}</dd></div> : null}
                    {focusLeafData.protein_id ? <div><dt>Protein</dt><dd className="gt-mono">{focusLeafData.protein_id}</dd></div> : null}
                    {focusLink?.gene ? <div><dt>Location</dt><dd className="gt-mono">{focusLink.gene.chrom}:{Number(focusLink.gene.start).toLocaleString()}-{Number(focusLink.gene.end).toLocaleString()}</dd></div> : (focusLeafData.location ? <div><dt>Location</dt><dd className="gt-mono">{focusLeafData.location}</dd></div> : null)}
                    <div><dt>Local</dt><dd><Glyph kind={focusStatus === 'none' ? 'unresolved' : focusStatus} /> {focusLink?.status === 'linked' ? `${focusLink.genome_name || focusLink.assembly}${focusLink.matched_by === 'symbol' ? ' · matched by symbol' : ''}` : STATUS_LABELS[focusStatus]}</dd></div>
                  </dl>
                  {focusStatus === 'local' ? <button type="button" onClick={() => addGenome(focusLink.assembly)}>Add genome to the top bar</button> : null}
                </div>
              ) : <p className="gt-muted">Click a gene to focus it and see the other trees it is in.</p>}
              <ul className="gt-key">
                <li><Glyph kind="focus" />Focus gene</li>
                <li><KeyPill color={genomeColors.values().next().value} state="active" isLight={isLight} />In a genome in the top bar, in its colour</li>
                <li><KeyPill color={genomeColors.values().next().value} state="inactive" isLight={isLight} />In a local genome not in the top bar</li>
                <li><Glyph kind="genome" />Local species, gene not found</li>
                <li><Glyph kind="unresolved" />Not local</li>
              </ul>
            </Section>
            </div>
            ) : null}
          </aside>
        ) : null}
      </div>

      {tooltip}
      {contextMenu}

      {dialog?.kind === 'load' ? (
        <LoadTreeDialog theme={theme} config={config} onClose={() => setDialog(null)} onStarted={job => {
          setDialog(null)
          setJobs(prev => [...prev.filter(j => j.id !== job.id), job])
          refreshJobs()
        }} />
      ) : null}
      {dialog?.kind === 'library' ? (
        <LibraryDialog collections={collections} current={current} onClose={() => setDialog(null)}
          onLoad={() => setDialog({ kind: 'load' })}
          onOpenTree={(collectionId, treeId) => { setDialog(null); openTree(collectionId, treeId) }}
          onEdit={c => setDialog({ kind: 'details', collection: c })}
          onLinks={c => setDialog({ kind: 'links', collection: c })}
          onDelete={async c => {
            if (!window.confirm(`Remove “${c.name}” (${c.tree_count} trees) from the library? The original files are not touched.`)) return
            await api(`/datasets/${c.id}`, undefined, undefined, 'DELETE')
            if (current?.collectionId === c.id) { setTreeData(null); setCurrent(null); setView(null); setFocusLeaf(-1) }
            await refreshCollections()
          }} />
      ) : null}
      {dialog?.kind === 'details' ? (
        <CollectionDetailsDialog collection={dialog.collection} onClose={() => setDialog(null)} onSaved={async () => { setDialog(null); await refreshCollections() }} />
      ) : null}
      {dialog?.kind === 'links' ? (
        <LinkGenomesDialog collection={dialog.collection} onClose={() => setDialog(null)} onSaved={async () => {
          setDialog(null)
          await refreshCollections()
          if (current) openTree(current.collectionId, current.treeId, focusNode?.leaf ? { geneIds: focusGeneIds() } : null)
        }} />
      ) : null}
    </div>
  )
}

