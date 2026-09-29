import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import AnchoredMenu from './menus.jsx'
import LayerPanel from './LayerPanel.jsx'
import SelectionBar from './SelectionBar.jsx'
import LayerBar from './LayerBar.jsx'
import TreePicker from './TreePicker.jsx'
import TreeCycle from './TreeCycle.jsx'
import { CladeMenu, DataViewMenu, LayerSwitcher, ToolButton, UndoRedo } from './ToolGroup.jsx'
import { NEIGHBOURHOOD_FLANK, sharedColours, useNeighbourhoods } from './neighbourhoodData.js'
import { LAYER_TOOLS, TOOLS } from './tools.js'
import useWorkspace from './useWorkspace.js'
import {
  activeLayer, addFragments, addLayer, createFragment, duplicateLayer, forestStats, forestTree, layerStats, mergeLayers,
  removeLayer, replaceFragment, updateLayer,
} from './workspace.js'
import { extract, fragmentGrafts, graft, mergeWithGrafts, prune, reroot, splitAt, toNewick } from './subtreeOps.js'
import { API_BASE } from '../../backendRuntime'
import { resolveBrowsingControls } from '../../utils/browsingControls.js'
import { getAssemblyAccession, normalizeGenomeRecord } from '../../utils/genomeIdentity'
import { genomeForAssembly } from '../alignment-explorer/associations.js'
import { genomeColorResolver } from '../../genomeColorSchemes'
import { genomePillColors } from '../../utils/genomePillColors'
import DrawerChevron from '../DrawerChevron'
import iconResetRaw from '../../assets/icons/icon_reset.svg?raw'
import TreeCanvas from './TreeCanvas.jsx'
import { CollectionDetailsDialog, LibraryDialog, LinkGenomesDialog, LoadTreeDialog } from './dialogs.jsx'
import { api, downloadText, formatBytes, loadPreference, loadViewState, query, savePreference, saveViewState } from './data.js'
import { NEIGHBOUR_COLUMN_PX, PALETTES, contentBounds, linkStatus, paintTree } from './paintTree.js'
import { layoutTree } from './treeLayout.js'
import {
  cladeLabel, cladeTitle, defaultView, descendants, emptyViewState, expandAll, expandEvents, expandSubtree, findLeaves, focusOn, indexTree,
  leafGeneLabel, leafSpeciesLabel, pathToRoot, showSubtree, speciesCount, toggleCollapsed, toggleFlipped,
} from './treeModel.js'
import './geneTrees.css'

const HOVER_CARD_DELAY_MS = 2000
const EVENT_LABELS = { speciation: 'Speciation', duplication: 'Gene duplication', dubious: 'Ambiguous', gene_split: 'Gene split' }
const STATUS_LABELS = {
  topbar: 'In a genome in the top bar', local: 'In a local genome not in the top bar',
  genome: 'Species is local, gene not found in its annotation', pending: 'Checking local proteins…',
  unresolved: 'Not in a local genome', none: 'Not in a local genome',
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
function Section({ title, children, open: initiallyOpen = true, extra = null, forceOpen = false }) {
  const [openState, setOpen] = useState(initiallyOpen)
  const open = openState || forceOpen
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
  return <span className="gt-key-pill" style={{ background: style.backgroundColor, color: style.textColor, borderColor: style.borderColor,
    borderStyle: state === 'inactive' ? 'dashed' : 'solid' }}>Aa</span>
}

function Stat({ value, label }) {
  return <div className="gt-stat"><strong>{Number(value || 0).toLocaleString()}</strong><span>{label}</span></div>
}

// The genome browser's re-centre mark, from the same file its focus bar draws it from.
const RESET_ICON_PATH_D = (String(iconResetRaw).match(/<path[^>]*\sd=(['"])(.*?)\1/i) || [])[2] || ''

const sameSource = (a, b) => a?.collectionId === b?.collectionId && a?.treeId === b?.treeId

/** A fragment's name: the user's, else a lone leaf's species, else the clade's name (or its species count). */
function fragmentTitle(index, id, fragment, withGenes = false) {
  const leaf = index.nodes[id]?.leaf
  if (leaf) return fragment?.name || [leafSpeciesLabel(leaf), leaf.symbol || leafGeneLabel(leaf)].filter(Boolean).join(' · ') || 'Gene'
  const genes = index.leafCount[id]
  const base = fragment?.name || cladeLabel(index, id) || `${speciesCount(index, id).toLocaleString()} species`
  return withGenes ? `${base} · ${genes.toLocaleString()} genes` : base
}

export default function GeneTreesView({ theme = 'dark', config, genomes = [], topBarGenomes = genomes, onAddGenome, incoming, onIncomingConsumed }) {
  const isLight = theme === 'light'
  const palette = isLight ? PALETTES.light : PALETTES.dark
  const controls = resolveBrowsingControls(config)
  const canvasRef = useRef(null)

  const [collections, setCollections] = useState([])
  const [current, setCurrent] = useState(null) // { collectionId, treeId }
  const [treeData, setTreeData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [origView, setOrigView] = useState(null)
  const [layerViews, setLayerViews] = useState({})
  const [focus, setFocus] = useState({ key: '', id: -1 })
  // Subtree layers (see workspace.js): which tree is showing — the Original or a layer —
  // and the tools that cut and join them.
  const { ws, commit, patch, undo, canUndo, canRedo } = useWorkspace()
  const [tool, setToolState] = useState('explore')
  const [lastTool, setLastTool] = useState('select')
  const [picks, setPicks] = useState({ key: '', ids: new Set() })
  const [wholeClades, setWholeClades] = useState(false)
  const [selectionDrag, setSelectionDrag] = useState(null)
  const [layerDrag, setLayerDrag] = useState(null) // a fragment being dragged by Move, Merge or Graft
  const drawerBody = useRef(null)
  const lastFocusGenes = useRef([])
  const [fitKey, setFitKey] = useState(0)
  // Where the user was in each thing shown (a tree's Original, each layer), so switching
  // away and back returns them there. For this visit only; kept by the canvas.
  const cameras = useRef(new Map())
  const [layoutName, setLayoutName] = useState(() => loadPreference('layout', 'curved'))
  const [phylogram, setPhylogram] = useState(() => loadPreference('phylogram', false))
  const [flipH, setFlipH] = useState(false)
  const [flipV, setFlipV] = useState(false)
  const [alignLeaves, setAlignLeaves] = useState(() => loadPreference('alignLeaves', false))
  const [shape, setShape] = useState(() => loadPreference('shape', 'linear'))
  // A data view beside the leaves (the Neighbourhood view's synteny), or 'off'.
  const [dataView, setDataView] = useState(() => loadPreference('dataView', 'off'))
  const [copied, setCopied] = useState(false)
  const hoverTimer = useRef(null)
  const hoverPending = useRef(null)
  const [dialog, setDialog] = useState(null) // {kind, collection?}
  const [hover, setHover] = useState(null)
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
  useEffect(() => savePreference('drawer', drawerOpen), [drawerOpen])
  useEffect(() => savePreference('alignLeaves', alignLeaves), [alignLeaves])
  useEffect(() => savePreference('shape', shape), [shape])
  useEffect(() => savePreference('dataView', dataView), [dataView])
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

  // What is showing: the Original tree, or the active layer drawn as one forest.
  const layer = activeLayer(ws)
  const forest = useMemo(() => (layer ? forestTree(layer) : null), [layer])
  const display = layer ? forest : treeData
  // A layer tool only means something in a layer: anywhere else the canvas explores.
  const activeTool = !layer && LAYER_TOOLS.some(t => t.id === tool) ? 'explore' : tool
  const displayKey = layer ? `l:${layer.id}` : current ? `o:${current.collectionId}:${current.treeId}` : ''
  const index = useMemo(() => (display ? indexTree(display) : null), [display])
  const links = useMemo(() => display?.links || {}, [display])
  const view = layer ? (layerViews[layer.id] || emptyViewState()) : origView
  const setView = useCallback(next => {
    if (layer) setLayerViews(prev => ({ ...prev, [layer.id]: next }))
    else setOrigView(next)
  }, [layer])
  const focusLeaf = focus.key === displayKey && index && focus.id < index.nodes.length ? focus.id : -1
  const setFocusLeaf = useCallback(id => setFocus({ key: displayKey, id }), [displayKey])
  const picked = picks.key === displayKey && picks.ids.size ? picks.ids : null
  const setPicked = useCallback(ids => setPicks({ key: displayKey, ids: new Set(ids) }), [displayKey])
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

  const openTree = useCallback(async (collectionId, treeId, target = null, { restore = false } = {}) => {
    setLoading(true)
    setError('')
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
      setOrigView(nextView)
      setFocus({ key: `o:${collectionId}:${treeId}`, id: focus })
      setCurrent({ collectionId, treeId })
      // Opening a tree shows it: leave whichever layer was showing (but coming back to the
      // view restores both the last tree and the last layer).
      if (!restore) patch(w => (w.original ? w : { ...w, original: true }))
      setFitKey(k => k + 1)
      savePreference('last', { collectionId, treeId })
    } catch (err) {
      setError(err.status === 404 ? 'That tree is no longer in the library.' : `The tree could not be opened: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [chooseFocus, patch])

  // First visit: the library, then whatever was open last time.
  useEffect(() => {
    let cancelled = false
    refreshCollections().then(list => {
      if (cancelled || incoming) return
      const last = loadPreference('last', null)
      if (last && list.some(c => c.id === last.collectionId)) openTree(last.collectionId, last.treeId, null, { restore: true })
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
    if (current && origView && !layer) saveViewState(current.collectionId, current.treeId, origView, focusLeaf)
  }, [current, origView, focusLeaf, layer])

  // The focus follows its gene from the Original into a layer and back: whichever copy of
  // it the tree now showing holds.
  useEffect(() => {
    if (!index || !displayKey || focus.key === displayKey) return
    const [found] = lastFocusGenes.current.length ? findLeaves(index, lastFocusGenes.current) : []
    setFocus({ key: displayKey, id: found ?? -1 })
  }, [index, displayKey, focus.key])


  const displayStats = useMemo(() => (layer ? forestStats(forest.nodes) : treeData?.stats || {}), [layer, forest, treeData])
  // The Neighbourhood column: shown in the linear layout, for the leaves linked to local genes.
  const showNeighbourhoods = dataView === 'neighbourhood' && shape === 'linear'
  const neighbourData = useNeighbourhoods(display?.nodes, links, showNeighbourhoods)
  const neighbours = useMemo(() => (showNeighbourhoods
    ? { ...neighbourData, ...sharedColours(neighbourData.byLeafId) } : null), [showNeighbourhoods, neighbourData])
  const layout = useMemo(() => (index && view ? layoutTree(index, view, {
    layout: layoutName, phylogram: phylogram && displayStats.has_branch_lengths, flipHorizontal: flipH, flipVertical: flipV,
    alignLeaves, shape, dataColumn: showNeighbourhoods ? NEIGHBOUR_COLUMN_PX : 0,
  }) : null), [index, view, layoutName, phylogram, flipH, flipV, alignLeaves, shape, displayStats, showNeighbourhoods])

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
  useEffect(() => { if (focusNode?.leaf) lastFocusGenes.current = focusGeneIds() }, [focusNode, focusGeneIds])

  // The same gene can be in a layer more than once (two copies of one clade, say): every
  // copy on show is the focus, drawn and labelled as such, its path lit and never folded.
  const focusTwins = useMemo(() => {
    if (!index || focusLeaf < 0) return null
    const ids = focusGeneIds()
    const found = ids.length ? findLeaves(index, ids).filter(id => id !== focusLeaf) : []
    return found.length ? new Set(found) : null
  }, [index, focusLeaf, focusGeneIds])
  const focusPath = useMemo(() => {
    if (!index || focusLeaf < 0) return null
    const path = new Set(pathToRoot(index, focusLeaf))
    for (const id of focusTwins || []) for (const up of pathToRoot(index, id)) path.add(up)
    return path
  }, [index, focusLeaf, focusTwins])
  // Where the focus gene is in a layer: one entry per fragment holding a copy, to go between.
  const focusCopies = useMemo(() => {
    if (!layer || !forest || focusLeaf < 0) return []
    return [focusLeaf, ...(focusTwins || [])].map(id => {
      const at = forest.fragmentOf.get(id)
      const fragment = at ? layer.fragments[at[0]] : null
      const root = forest.nodes.find(n => n.fragRoot === fragment?.id)
      return { id, fragment, name: root && index ? fragmentTitle(index, root.id, fragment) : 'Subtree' }
    }).sort((a, b) => layer.fragments.indexOf(a.fragment) - layer.fragments.indexOf(b.fragment))
      // Two copies of one clade share a name: number them, so the chips can be told apart.
      .map((copy, i, all) => (all.filter(c => c.name === copy.name).length > 1
        ? { ...copy, name: `${copy.name} (${all.slice(0, i + 1).filter(c => c.name === copy.name).length})` } : copy))
  }, [layer, focusTwins, forest, focusLeaf, index])

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
  }, [index, view, setView, setFocusLeaf])

  const onNodeClick = useCallback((item, mods) => {
    if (mods.alt) act(item, 'expand')
    else if (mods.shift) act(item, 'focus')
    else act(item, 'toggle')
  }, [act])

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
    setView(layer ? emptyViewState() : defaultView(index, focusLeaf))
    setFlipH(false)
    setFlipV(false)
    setFitKey(k => k + 1)
  }

  // ── subtree layers ──

  const setTool = useCallback(next => {
    setToolState(next)
    // The tool button's face remembers the last of its own tools, not the layer bar's.
    if (next !== 'explore' && TOOLS.some(t => t.id === next)) setLastTool(next)
  }, [])
  const clearPicks = useCallback(() => setPicks({ key: '', ids: new Set() }), [])

  const layerSummary = l => {
    const stats = layerStats(l)
    if (!stats.fragments) return 'Empty · drop subtrees here'
    return `${stats.fragments} subtree${stats.fragments === 1 ? '' : 's'} · ${stats.genes.toLocaleString()} genes${stats.grafts ? ` · ${stats.grafts} graft${stats.grafts === 1 ? '' : 's'}` : ''}`
  }
  const allLayers = useMemo(() => [
    { id: 'original', name: treeData?.name ? `Original · ${treeData.name}` : 'Original', color: '#b9c5d9',
      summary: treeData ? `${(treeData.stats?.genes || 0).toLocaleString()} genes · never changed` : 'No tree open' },
    ...ws.layers.map(l => ({ ...l, summary: layerSummary(l) })),
  ], [ws.layers, treeData])

  const switchDisplay = useCallback(id => {
    clearPicks()
    // No refit: the canvas puts the user back wherever they last were in that layer.
    patch(w => (id === 'original' ? { ...w, original: true } : { ...w, active: id, original: false }))
  }, [patch, clearPicks])
  const newLayer = useCallback(() => {
    commit(w => addLayer(w).ws)
    setFitKey(k => k + 1)
  }, [commit])

  // What is picked, turned into fragments: copied out of the Original, or out of the
  // layer's own fragments (keeping where each node first came from).
  const picksAsFragments = useCallback((ids, { whole = wholeClades } = {}) => {
    if (!ids?.size || !index) return []
    const collapsed = view?.collapsed || new Set()
    if (!layer) {
      if (!treeData || !current) return []
      const folded = [...ids].filter(id => collapsed.has(id))
      const source = { collectionId: current.collectionId, treeId: current.treeId, treeName: treeData.name }
      return extract(treeData.nodes, ids, { wholeClades: whole, folded, srcTree: `${current.collectionId}:${current.treeId}`, links: treeData.links })
        .map(nodes => ({ nodes, source }))
    }
    const byFragment = new Map()
    for (const id of ids) {
      const at = forest.fragmentOf.get(id)
      if (!at) continue
      if (!byFragment.has(at[0])) byFragment.set(at[0], { ids: [], folded: [] })
      byFragment.get(at[0]).ids.push(at[1])
      if (collapsed.has(id)) byFragment.get(at[0]).folded.push(at[1])
    }
    const out = []
    for (const [f, sel] of byFragment) {
      const fragment = layer.fragments[f]
      for (const nodes of extract(fragment.nodes, sel.ids, { wholeClades: whole, folded: sel.folded })) out.push({ nodes, source: fragment.source })
    }
    return out
  }, [index, view, layer, treeData, current, forest, wholeClades])

  const pickCounts = useMemo(() => {
    if (!picked || !index) return { genes: 0, pieces: 0, single: -1 }
    // A collapsed pill stands for its whole clade; count each gene once however it was picked.
    const genes = new Set()
    const roots = []
    for (const id of picked) {
      const node = index.nodes[id]
      if (!node) continue
      if (node.leaf) genes.add(id)
      else if (view?.collapsed?.has(id)) for (const d of descendants(index, id)) { if (index.nodes[d].leaf) genes.add(d) }
      if (!picked.has(index.parent[id])) roots.push(id)
    }
    return { genes: genes.size, pieces: roots.length, single: roots.length === 1 ? roots[0] : -1 }
  }, [picked, index, view])
  const pickSummary = `${pickCounts.genes.toLocaleString()} genes · ${picked?.size || 0} picks`

  const copyPicks = useCallback(target => {
    const pieces = picksAsFragments(picked)
    if (!pieces.length) { setNotice('Nothing with a gene in it is picked: pick some leaves, or a clade.'); return }
    let targetName = ''
    commit(w => {
      let next = w
      let id = target
      if (target === 'new' || !w.layers.some(l => l.id === target)) {
        const made = addLayer(w)
        next = made.ws
        id = made.layer.id
      }
      targetName = next.layers.find(l => l.id === id)?.name || ''
      next = addFragments(next, id, pieces.map(p => createFragment(p.nodes, p.source)))
      return { ...next, active: id, original: false }
    })
    clearPicks()
    setToolState('explore')
    setFitKey(k => k + 1)
    const genes = pieces.reduce((n, p) => n + p.nodes.filter(x => x.leaf).length, 0)
    setNotice(`Copied ${genes.toLocaleString()} gene${genes === 1 ? '' : 's'} in ${pieces.length} subtree${pieces.length === 1 ? '' : 's'} into ${targetName}.`)
  }, [picksAsFragments, picked, commit, clearPicks])

  // Operations inside a layer act on the fragment a drawn node belongs to.
  const inFragment = useCallback(id => {
    const at = forest?.fragmentOf.get(id)
    return at ? { fragment: layer.fragments[at[0]], nodeId: at[1] } : null
  }, [forest, layer])

  const removePicks = useCallback(() => {
    if (!layer || !picked) return
    const byFragment = new Map()
    for (const id of picked) {
      const at = inFragment(id)
      if (!at) continue
      if (!byFragment.has(at.fragment.id)) byFragment.set(at.fragment.id, { fragment: at.fragment, ids: [] })
      byFragment.get(at.fragment.id).ids.push(at.nodeId)
    }
    commit(w => {
      let next = w
      for (const { fragment, ids } of byFragment.values()) next = replaceFragment(next, layer.id, fragment.id, [prune(fragment.nodes, ids)])
      return next
    })
    clearPicks()
  }, [layer, picked, inFragment, commit, clearPicks])

  const splitNode = useCallback(id => {
    const at = inFragment(id)
    if (!at || at.nodeId === 0) { setNotice('Split cuts below a subtree’s root: click a node inside it.'); return }
    commit(w => replaceFragment(w, layer.id, at.fragment.id, splitAt(at.fragment.nodes, at.nodeId)))
    clearPicks()
  }, [inFragment, commit, layer, clearPicks])

  const rerootNode = useCallback(id => {
    const at = inFragment(id)
    if (!at || at.nodeId === 0) return
    commit(w => replaceFragment(w, layer.id, at.fragment.id, [reroot(at.fragment.nodes, at.nodeId)]))
    clearPicks()
    setNotice('Re-rooted. Clade names along the old root path were cleared: they no longer describe their clades.')
  }, [inFragment, commit, layer, clearPicks])


  // ── a subtree layer's tools (the bar over the layer) ──

  // A fragment's source tree, for merging as it is joined there: the one open, or fetched.
  const loadSource = useCallback(async source => {
    if (!source) return null
    if (treeData && current?.collectionId === source.collectionId && current?.treeId === source.treeId) return treeData
    try {
      return await api(`/datasets/${source.collectionId}/trees/${encodeURIComponent(source.treeId)}`)
    } catch {
      setError(`The tree ${source.treeName || source.treeId} is no longer in the library, so its subtrees can't be merged as it joins them.`)
      return null
    }
  }, [treeData, current])

  const fragmentName = useCallback(fragment => {
    const root = forest?.nodes.find(n => n.fragRoot === fragment?.id)
    return root && index ? fragmentTitle(index, root.id, fragment) : (fragment?.name || 'the subtree')
  }, [forest, index])

  // Merging follows one original tree, so two fragments merge only if they came from the same one.
  const mergeVerdict = useCallback((fromId, intoId) => {
    const from = layer?.fragments.find(f => f.id === fromId)
    const into = layer?.fragments.find(f => f.id === intoId)
    if (!from || !into) return { ok: false, why: '' }
    if (sameSource(from.source, into.source)) return { ok: true }
    return { ok: false, why: `${fragmentName(from)} is from ${from.source?.treeName || 'another tree'} and ${fragmentName(into)} from ${into.source?.treeName || 'another'}: a merge follows one original tree. Graft them instead.` }
  }, [layer, fragmentName])

  const onLayerAction = useCallback(async action => {
    if (!layer) return
    const find = id => layer.fragments.find(f => f.id === id)
    const at = id => {
      const where = forest.fragmentOf.get(id)
      return where ? { fragment: layer.fragments[where[0]], nodeId: where[1] } : null
    }
    const edit = fn => commit(w => updateLayer(w, layer.id, l => ({ ...l, fragments: fn(l.fragments) })))
    // Once a layer has been arranged, every fragment is pinned where it stands: an edit to
    // one never sends the others elsewhere. The first move pins them all.
    const arranged = action.type === 'move' || layer.fragments.some(f => f.pos)
    const pin = list => (arranged && action.places
      ? list.map(f => (f.pos || !action.places[f.id] ? f : { ...f, pos: action.places[f.id] }))
      : list)
    if (action.type === 'move') {
      edit(list => pin(list).map(f => (f.id === action.fragmentId ? { ...f, pos: action.pos } : f)))
    } else if (action.type === 'merge') {
      if (!action.ok) { if (action.why) setNotice(action.why); return }
      const from = find(action.fragmentId), into = find(action.into)
      if (!from || !into) return
      const source = await loadSource(into.source)
      if (!source) return
      const result = mergeWithGrafts(source.nodes, [into.nodes, from.nodes], `${into.source.collectionId}:${into.source.treeId}`)
      if (!result.fragment) { setNotice('Nothing in these two subtrees has a place in their original tree, so there is nothing to merge.'); return }
      if (result.lost && !window.confirm(`${result.lost} gene${result.lost === 1 ? '' : 's'} can't be placed in ${into.source.treeName || 'the original tree'} and would be left out. Merge anyway?`)) return
      // A new subtree, standing where the one it was dropped on stood; the two it was made
      // from go. Grafted pieces with nowhere left to hang come back as subtrees of their own.
      edit(prior => {
        const rest = pin(prior).filter(f => f.id !== from.id)
        const at = rest.findIndex(f => f.id === into.id)
        const merged = createFragment(result.fragment, into.source, '', rest[at].pos || null)
        rest.splice(at, 1, merged, ...result.leftovers.map(nodes => createFragment(nodes, into.source)))
        return rest
      })
      setNotice(`Merged ${fragmentName(from)} with ${fragmentName(into)} as ${into.source.treeName || 'their tree'} joins them${result.duplicates ? ` (${result.duplicates} gene${result.duplicates === 1 ? ' was' : 's were'} in both and appear${result.duplicates === 1 ? 's' : ''} once)` : ''}${result.leftovers.length ? `; ${result.leftovers.length} grafted piece${result.leftovers.length === 1 ? '' : 's'} had nowhere to go and stand apart` : ''}.`)
    } else if (action.type === 'graft') {
      const moving = find(action.fragmentId)
      const target = at(action.nodeId)
      if (!moving || !target || target.fragment.id === moving.id) return
      const joined = graft(moving.nodes, target.fragment.nodes, target.nodeId, { onBranch: true })
      edit(prior => pin(prior).filter(f => f.id !== moving.id)
        .map(f => (f.id === target.fragment.id ? createFragment(joined, f.source, '', f.pos || null) : f)))
    } else if (action.type === 'cut') {
      const target = at(action.nodeId)
      if (!target || target.nodeId === 0) return
      const pieces = splitAt(target.fragment.nodes, target.nodeId)
      if (pieces.length < 2) return
      const placed = arranged
      edit(prior => {
        const list = pin(prior)
        const i = list.findIndex(f => f.id === target.fragment.id)
        const rest = { ...list[i], nodes: pieces[0], ...(placed && action.restPos ? { pos: action.restPos } : {}) }
        const clade = createFragment(pieces[1], target.fragment.source, '', placed ? action.cladePos : null)
        return [...list.slice(0, i), rest, clade, ...list.slice(i + 1)]
      })
    } else if (action.type === 'remove') {
      const target = at(action.nodeId)
      if (!target) return
      const left = action.whole ? null : prune(target.fragment.nodes, [target.nodeId])
      edit(prior => {
        const list = pin(prior)
        return left
          ? list.map(f => (f.id === target.fragment.id ? { ...f, nodes: left, ...(f.pos && action.restPos ? { pos: action.restPos } : {}) } : f))
          : list.filter(f => f.id !== target.fragment.id)
      })
    }
  }, [layer, forest, commit, loadSource, fragmentName])

  const onLayerDrag = useCallback(event => {
    setLayerDrag(event.phase === 'end' ? null : { x: event.clientX, y: event.clientY, tool: event.tool, fragmentId: event.fragmentId, target: event.target })
  }, [])

  // The focus bar's re-centre: the gene of focus, in the middle of the view at a readable
  // zoom. Hidden in a fold, or outside the clade being shown, it is brought into view first.
  const pendingRecentre = useRef(-1)
  const recentreFocus = useCallback(() => {
    if (focusLeaf < 0 || !index) return
    if (layout?.byId?.has(focusLeaf)) { canvasRef.current?.recentre(focusLeaf); return }
    const path = new Set(pathToRoot(index, focusLeaf))
    const collapsed = new Set([...(view?.collapsed || [])].filter(id => !path.has(id)))
    pendingRecentre.current = focusLeaf
    setView({ ...view, collapsed, root: path.has(view?.root ?? 0) ? view.root : 0 })
  }, [focusLeaf, index, layout, view, setView])
  useEffect(() => {
    const id = pendingRecentre.current
    if (id >= 0 && layout?.byId?.has(id)) {
      pendingRecentre.current = -1
      canvasRef.current?.recentre(id)
    }
  }, [layout])

  // Every tree the focus gene is in, for the focus bar's list: its copies in this layer
  // first, then the tree it was copied from (or, in the Original, the one showing), then
  // the other trees in the library that hold it.
  const treeChoices = (() => {
    if (!focusNode?.leaf) return []
    const key = source => (source ? `${source.collectionId}:${source.treeId}` : '')
    const contextKey = c => `${c.collection_id}:${c.tree_id}`
    const choices = focusCopies.map(copy => ({
      key: `copy:${copy.id}`, kind: 'copy', id: copy.id, group: `In ${layer.name}`, label: copy.name, active: copy.id === focusLeaf,
      detail: `${copy.fragment?.nodes.filter(n => n.leaf).length ?? 0} genes · from ${copy.fragment?.source?.treeName || 'a tree'}`,
    }))
    // Where this copy of the gene came from: a grafted-in piece names its own tree.
    let origin = null
    if (layer) {
      const [collectionId, treeId] = String(forest?.nodes[focusLeaf]?.srcTree || '').split(':')
      const fragment = focusCopies.find(c => c.id === focusLeaf)?.fragment
      origin = collectionId && treeId ? { collectionId, treeId, treeName: fragment?.source?.treeId === treeId ? fragment.source.treeName : '' } : fragment?.source || null
    } else if (current) origin = { ...current, treeName: treeData?.name }
    const originContext = contexts.results.find(c => contextKey(c) === key(origin))
    if (origin) {
      choices.push({ key: `tree:${key(origin)}`, kind: 'original', source: origin, context: originContext, group: 'Original tree', active: !layer,
        label: originContext?.tree_name || origin.treeName || 'Original tree',
        detail: originContext ? `${originContext.collection_name} · ${originContext.leaf_count} genes` : 'The tree it was copied from' })
    }
    // Seen from the Original: the layers holding the gene come next, to go to its copies there.
    if (!layer) {
      const bare = value => String(value || '').replace(/^(.+?\d{5,})\.\d+$/, '$1').toUpperCase()
      const wanted = new Set(focusGeneIds().map(bare))
      const copiesIn = l => l.fragments.reduce((n, f) => n + f.nodes.filter(node => node.leaf
        && [node.leaf.gene_id, node.leaf.protein_id, node.leaf.transcript_id, node.leaf.other_id].some(v => v && wanted.has(bare(v)))).length, 0)
      for (const l of ws.layers) {
        const copies = wanted.size ? copiesIn(l) : 0
        if (copies) choices.push({ key: `layer:${l.id}`, kind: 'layer', layerId: l.id, group: 'Layers', active: false, label: l.name,
          detail: `${copies} ${copies === 1 ? 'copy' : 'copies'} · ${layerSummary(l)}` })
      }
    }
    for (const c of contexts.results) {
      if (contextKey(c) === key(origin)) continue
      choices.push({ key: `tree:${contextKey(c)}`, kind: 'tree', context: c, group: 'Other trees', active: false, label: c.tree_name,
        detail: `${c.collection_name} · ${c.leaf_count} genes${c.species_count ? ` · ${c.species_count} species` : ''}` })
    }
    return choices
  })()

  // Going to one: a copy here is glided to; the tree open behind a layer is switched back
  // to and centred on the gene; any other tree is opened at it.
  const recentreWhenShown = useRef(false)
  useEffect(() => {
    // Once the tree switched to has found its copy of the gene: open any folds hiding it,
    // then glide to it (the re-centre button's own path).
    if (recentreWhenShown.current && focusLeaf >= 0 && layout) {
      recentreWhenShown.current = false
      recentreFocus()
    }
  }, [layout, focusLeaf, recentreFocus])
  const pickTree = choice => {
    if (choice.kind === 'copy') { setFocusLeaf(choice.id); canvasRef.current?.recentre(choice.id); return }
    if (choice.active) { recentreFocus(); return }
    if (choice.kind === 'original' && layer && current && sameSource(choice.source, current)) {
      recentreWhenShown.current = true
      switchDisplay('original')
      return
    }
    if (choice.kind === 'layer') {
      recentreWhenShown.current = true
      switchDisplay(choice.layerId)
      return
    }
    if (choice.context) switchContext(choice.context)
    else openTree(choice.source.collectionId, choice.source.treeId, { geneIds: focusGeneIds() })
  }

  // What the layer bar's Rename acts on: the subtree the selection is in, when it is all in one.
  const renameTarget = (() => {
    if (!layer || !picked?.size || !forest) return null
    let at = -1
    for (const id of picked) {
      const where = forest.fragmentOf.get(id)
      if (!where) continue
      if (at >= 0 && where[0] !== at) return null
      at = where[0]
    }
    if (at < 0) return null
    const fragment = layer.fragments[at]
    const root = forest.nodes.find(n => n.fragRoot === fragment.id)
    return { id: fragment.id, name: fragment.name || '', label: root && index ? fragmentTitle(index, root.id, fragment) : 'the subtree',
      auto: root && index ? fragmentTitle(index, root.id, { ...fragment, name: '' }) : 'Subtree' }
  })()

  // The control bar's Clade menu: what can be done with the selected clade (the root of a
  // selection that is one connected piece), where the right-click menu used to offer it.
  const selectedClade = pickCounts.single
  const cladeTarget = selectedClade >= 0 && index ? cladeTitle(index, selectedClade) : ''
  const showing = view?.root ?? 0
  const cladeItems = [
    { label: 'Show only this clade', disabled: selectedClade < 0 || selectedClade === showing || Boolean(index?.nodes[selectedClade]?.leaf),
      onClick: () => { setView(showSubtree(expandSubtree(index, view, selectedClade), selectedClade)); setFitKey(k => k + 1) } },
    { label: 'Show the whole tree', disabled: showing === 0, onClick: () => { setView(showSubtree(view, 0)); setFitKey(k => k + 1) } },
    { label: 'Flip branches', disabled: selectedClade < 0 || Boolean(index?.nodes[selectedClade]?.leaf),
      onClick: () => setView(toggleFlipped(index, view, selectedClade)) },
    { label: 'Export as Newick', disabled: !picked, onClick: () => exportNodes(cladeTarget || 'selection', picksAsFragments(picked).map(p => p.nodes), { nhx: false }) },
    { label: 'Export as NHX', disabled: !picked, onClick: () => exportNodes(cladeTarget || 'selection', picksAsFragments(picked).map(p => p.nodes)) },
  ]

  // A face of the Cycle drum: a layer's tree (or the Original) fitted into the preview,
  // drawn with the view's own layout settings and folds.
  const paintPreview = useCallback((ctx, id, width, height) => {
    ctx.fillStyle = palette.bg
    ctx.fillRect(0, 0, width, height)
    const source = id === 'original' ? treeData : forestTree(ws.layers.find(l => l.id === id))
    if (!source?.nodes?.length || source.nodes.length < 2) return
    const idx = indexTree(source)
    const previewView = id === 'original' ? (origView || emptyViewState()) : (layerViews[id] || emptyViewState())
    const lay = layoutTree(idx, previewView, { layout: layoutName, phylogram, shape, alignLeaves, flipHorizontal: flipH, flipVertical: flipV })
    const cache = new Map()
    const b = contentBounds(ctx, idx, lay, cache)
    const pad = 18
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY)
    const k = Math.min((width - pad * 2) / bw, (height - pad * 2) / bh)
    const t = { k, kx: k, x: pad - b.minX * k + (width - pad * 2 - bw * k) / 2, y: pad - b.minY * k + (height - pad * 2 - bh * k) / 2 }
    paintTree(ctx, { layout: lay, index: idx, t, width, height, palette, links: source.links || {}, topbarAssemblies, genomeColors,
      labelCache: cache, noClear: true })
  }, [palette, treeData, ws.layers, origView, layerViews, layoutName, phylogram, shape, alignLeaves, flipH, flipV, topbarAssemblies, genomeColors])

  // The focus bar's ✕, as the genome browser's: no gene in focus, here or in any layer.
  const clearFocus = () => {
    lastFocusGenes.current = []
    setFocusLeaf(-1)
  }

  // What the label beside a dragged fragment says: what releasing here would do.
  const layerDragText = drag => {
    const moving = layer?.fragments.find(f => f.id === drag.fragmentId)
    const name = moving ? fragmentName(moving) : 'The subtree'
    const target = drag.target
    if (drag.tool === 'move') return { title: name, detail: 'Release to put it here · Esc puts it back' }
    if (drag.tool === 'merge') {
      if (!target) return { title: name, detail: 'Drop it on another subtree from the same tree' }
      const into = layer.fragments.find(f => f.id === target.fragmentId)
      return target.ok
        ? { title: `Merge into ${fragmentName(into)}`, detail: `Release to join them as ${into?.source?.treeName || 'their tree'} does` }
        : { title: 'These can’t merge', detail: target.why }
    }
    if (drag.tool === 'graft') {
      if (!target) return { title: name, detail: 'Drop it on a branch, or on a root' }
      const where = target.root ? 'beside this subtree, under a new root' : `onto the branch to ${index ? fragmentTitle(index, target.nodeId, null) : 'here'}`
      return { title: `Graft ${name}`, detail: `Release to join it ${where}` }
    }
    return { title: name, detail: '' }
  }

  // A subtree's own name; an empty one hands it back to the automatic name.
  const renameFragment = useCallback((fragmentId, name) => {
    if (!layer) return
    const fragment = layer.fragments.find(f => f.id === fragmentId)
    if (!fragment || (fragment.name || '') === name) return
    commit(w => updateLayer(w, layer.id, l => ({ ...l, fragments: l.fragments.map(f => (f.id === fragmentId ? { ...f, name } : f)) })))
  }, [layer, commit])


  // Put every fragment back in the stack, in order.
  const restack = useCallback(() => {
    if (!layer) return
    commit(w => updateLayer(w, layer.id, l => ({ ...l, fragments: l.fragments.map(f => { const next = { ...f }; delete next.pos; return next }) })))
    setFitKey(k => k + 1)
  }, [layer, commit])

  const exportNodes = (name, list, { nhx = true } = {}) => {
    downloadText(`${name.replace(/[^\w.-]+/g, '_')}.${nhx ? 'nhx' : 'nwk'}`, list.map(nodes => toNewick(nodes, { nhx })).join('\n') + '\n')
  }

  // The canvas reports its tools here.
  const onMarquee = useCallback((ids, { shift }) => {
    if (!ids.size) return
    const next = new Set(picked && (shift || tool === 'select') ? picked : [])
    for (const id of ids) next.add(id)
    setPicked(next)
    // As in the Alignment Explorer: a finished selection hands back to Explore, so the
    // next press on it drags it out to a layer.
    setToolState('explore')
  }, [picked, tool, setPicked])

  const onToolClick = useCallback((target, mods) => {
    if (target.kind === 'fragment') {
      const item = layout?.items.find(i => i.node.fragRoot === target.fragmentId)
      if (item) setPicked(new Set([item.id, ...descendants(index, item.id)]))
      return
    }
    if (target.kind !== 'node') { if (tool !== 'explore') clearPicks(); return }
    const id = target.item.id
    if (tool === 'select') {
      const next = new Set(picked || [])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setPicked(next)
    } else if (tool === 'clade') {
      const clade = [id, ...descendants(index, id)]
      const next = new Set(mods.shift && picked ? picked : [])
      const already = picked?.has(id)
      for (const n of clade) { if (already && mods.shift) next.delete(n); else next.add(n) }
      setPicked(next)
    }
  }, [tool, layout, index, picked, setPicked, clearPicks])

  const dropTargetAt = (x, y) => {
    const element = document.elementFromPoint(x, y)?.closest?.('[data-selection-drop]')
    const target = element?.getAttribute('data-selection-drop')
    return target && !(layer && target === layer.id) ? target : null
  }
  const onDragOut = useCallback(event => {
    if (event.phase === 'cancel') { setSelectionDrag(null); return }
    if (!drawerOpen) setDrawerOpen(true)
    const target = dropTargetAt(event.clientX, event.clientY)
    if (event.phase === 'drop') {
      setSelectionDrag(null)
      if (target) copyPicks(target)
      return
    }
    // Scroll the drawer when the pointer nears its edges, so every layer can be reached.
    const body = drawerBody.current
    if (body) {
      const rect = body.getBoundingClientRect()
      if (event.clientX > rect.left) {
        if (event.clientY < rect.top + 35) body.scrollTop -= 12
        else if (event.clientY > rect.bottom - 35) body.scrollTop += 12
      }
    }
    // The picture of the lifted subtree arrives with the first move and rides along after.
    setSelectionDrag(prev => ({ x: event.clientX, y: event.clientY, target, image: event.image || prev?.image || null }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen, copyPicks, layer])

  // A click on something picked takes it out of the selection (a node taken by mistake, a
  // stretch of path not wanted); a folded clade, or an ⌥-click, takes all that is beneath it.
  const onUnpick = useCallback(({ id, clade }) => {
    if (!picked || !index) return
    const next = new Set(picked)
    next.delete(id)
    if (clade) for (const d of descendants(index, id)) next.delete(d)
    if (next.size) setPicked(next)
    else clearPicks()
  }, [picked, index, setPicked, clearPicks])

  // Keys: tools, undo, clearing and removing.
  useEffect(() => {
    const onKey = event => {
      const target = event.target
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        undo(event.shiftKey)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') {
        if (picked) clearPicks()
        else if (tool !== 'explore') setToolState('explore')
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && layer && picked) { event.preventDefault(); removePicks(); return }
      const key = event.key.toLowerCase()
      const chosen = TOOLS.find(t => t.key.toLowerCase() === key)
      if (chosen && (treeData || layer)) setTool(chosen.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, picked, tool, layer, removePicks, clearPicks, setTool, treeData])

  // Name tags for a layer's fragments (the painter records where it drew each).
  const fragmentTags = useMemo(() => {
    if (!layer || !index) return null
    const tags = new Map()
    for (const item of index.nodes) {
      if (!item.fragRoot) continue
      const fragment = layer.fragments.find(f => f.id === item.fragRoot)
      tags.set(item.fragRoot, { label: fragmentTitle(index, item.id, fragment, true), color: layer.color,
        lifted: layerDrag?.fragmentId === item.fragRoot })
    }
    return tags
  }, [layer, index, layerDrag?.fragmentId])

  const fragmentRows = layer ? layer.fragments.map(f => {
    const genes = f.nodes.filter(n => n.leaf).length
    const root = forest.nodes.find(n => n.fragRoot === f.id)
    const title = root && index ? fragmentTitle(index, root.id, f) : (f.name || 'Subtree')
    const auto = root && index ? fragmentTitle(index, root.id, { ...f, name: '' }) : 'Subtree'
    return { id: f.id, name: f.name, label: title, auto, grafts: fragmentGrafts(f.nodes),
      detail: `${genes.toLocaleString()} gene${genes === 1 ? '' : 's'} · from ${f.source?.treeName || 'a tree'}` }
  }) : []

  const collection = current ? collections.find(c => c.id === current.collectionId) : null
  const stats = displayStats
  const summary = treeData?.link_summary || {}
  const shownRoot = view?.root ?? 0

  // ── rendering helpers ──

  const tooltip = (() => {
    if (!hover?.hit) return null
    const { item } = hover.hit
    const node = item.node
    const rows = []
    let title = ''
    if (hover.hit.part === 'neighbour') {
      // A gene in the Neighbourhood column: what it is, where, and how many rows share it.
      const { gene, entry } = hover.hit
      const symbol = String(gene.name || '').trim().toLowerCase()
      const shared = symbol ? neighbours?.rows?.get(symbol) || 0 : 0
      const centre = gene.id === entry.center
      const style = { left: Math.min(hover.x + 14, window.innerWidth - 300), top: Math.min(hover.y + 14, window.innerHeight - 200) }
      const neighbourRows = [
        ['Gene', gene.id],
        ['Location', `${entry.chrom || '?'}:${gene.start.toLocaleString()}-${gene.end.toLocaleString()}`],
        ['Biotype', gene.biotype || 'protein_coding'],
        ['Genome', leafSpeciesLabel(node.leaf) || links[item.id]?.genome_name || ''],
      ]
      if (entry.flipped) neighbourRows.push(['Shown', 'reversed, so the tree gene points right'])
      return createPortal(
        <div className={`gt-tooltip${isLight ? ' light' : ''}`} style={style}>
          <strong>{gene.name || gene.id}</strong>
          <dl>{neighbourRows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <small>{centre ? 'The gene in this tree' : shared > 1 ? `Beside the tree gene in ${shared} genomes here` : 'Only beside the tree gene in this genome'}</small>
        </div>, document.body)
    }
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
    const hint = hover.hit.part === 'folded' ? 'Too small to show at this zoom · click to zoom in' : node.leaf ? 'Click to focus this gene' : (item.kind === 'collapsed' ? 'Click to expand · ⌥-click opens everything' : 'Click to fold or open · ⌥-click opens everything')
    const style = { left: Math.min(hover.x + 14, window.innerWidth - 300), top: Math.min(hover.y + 14, window.innerHeight - 200) }
    return createPortal(
      <div className={`gt-tooltip${isLight ? ' light' : ''}`} style={style}>
        <strong>{title}</strong>
        <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        <small>{hint}</small>
      </div>, document.body)
  })()


  const focusLeafData = focusNode?.leaf
  const focusStatus = linkStatus(focusLink, topbarAssemblies)

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
        <ToolButton tool={activeTool} lastTool={lastTool} onTool={setTool} inLayer={Boolean(layer)} isLight={isLight}
          pickSummary={picked ? pickSummary : ''} onClear={clearPicks} />
        <CladeMenu target={cladeTarget} items={cladeItems} isLight={isLight} />
        <DataViewMenu value={dataView} onChange={setDataView} isLight={isLight} views={[
          { id: 'neighbourhood', label: 'Neighbourhood', hint: `The genes around each local gene · ${NEIGHBOURHOOD_FLANK} either side`,
            disabled: shape === 'radial', note: 'Data views are shown in the linear layout' },
        ]} />
        <UndoRedo canUndo={canUndo} canRedo={canRedo} onUndo={() => undo(false)} onRedo={() => undo(true)} />
        <LayerSwitcher layers={allLayers} activeId={layer ? layer.id : 'original'} onSwitch={switchDisplay} onNew={newLayer} isLight={isLight} />
        <TreeCycle entries={allLayers} active={layer ? layer.id : 'original'} onChoose={switchDisplay} paint={paintPreview} isLight={isLight} />
        <button type="button" onClick={resetTree} disabled={!treeData}>Reset tree</button>
      </div>

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
        {focusLeafData ? (
          <div className="gt-contexts" aria-live="polite">
            <button type="button" className="gt-recentre" onClick={recentreFocus} data-tour-id="gene-trees-recenter"
              title="Re-centre on the gene of focus" aria-label="Re-centre on the gene of focus">
              <svg width="24" height="24" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d={RESET_ICON_PATH_D} fill="currentColor" /></svg>
            </button>
            <span className="gt-contexts-gene">
              <Glyph kind="focus" />
              <strong>{focusLeafData.symbol || focusLink?.gene?.name || leafGeneLabel(focusLeafData)}</strong>
              <span>{leafSpeciesLabel(focusLeafData)}</span>
            </span>
            {treeChoices.length > 1 ? <TreePicker choices={treeChoices} onPick={pickTree} isLight={isLight} /> : null}
            <button type="button" className="gt-unfocus" onClick={clearFocus} title="Clear the gene of focus" aria-label="Clear the gene of focus">✕</button>
          </div>
        ) : null}
        <div className="gt-stage" data-screenshot-capture="view">
          {layer && !layer.fragments.length ? (
            <div className="gt-empty">
              <h2>{layer.name} is empty</h2>
              <p>Go back to a tree (the layer switcher, or the Original in the drawer), pick parts of it with <strong>Select</strong> or <strong>Pick clade</strong>, and drag them here — or use <strong>Copy to layer</strong>.</p>
              <div className="gt-row gt-center"><button type="button" className="primary" onClick={() => switchDisplay('original')}>Back to the Original</button></div>
            </div>
          ) : display && layout ? (
            <TreeCanvas
              ref={canvasRef}
              index={index}
              layout={layout}
              links={links}
              focusId={focusLeaf}
              focusPath={focusPath}
              focusIds={focusTwins}
              palette={palette}
              topbarAssemblies={topbarAssemblies}
              controls={controls}
              fitKey={`${fitKey}:${layoutName}:${phylogram}:${shape}`}
              focusRowId={focusLeaf}
              onNodeClick={onNodeClick}
              onHover={onCanvasHover}
              genomeColors={genomeColors}
              ariaLabel={`Gene tree ${layer ? layer.name : treeData?.name || ''}`}
              tool={activeTool}
              onLayerAction={onLayerAction}
              insetTop={layer ? 52 : 0}
              neighbours={neighbours}
              onLayerDrag={onLayerDrag}
              canMerge={mergeVerdict}
              picked={picked}
              fragmentTags={fragmentTags}
              onMarquee={onMarquee}
              onToolClick={onToolClick}
              onDragOut={onDragOut}
              onUnpick={onUnpick}
              viewKey={displayKey}
              layoutSig={`${layoutName}:${phylogram}:${shape}`}
              cameras={cameras.current}
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
          {layer && layout ? (
            <LayerBar layer={layer} tool={activeTool} onTool={setTool} radial={shape === 'radial'} isLight={isLight}
              arranged={layer.fragments.some(f => f.pos)} onRestack={restack}
              canUndo={canUndo} canRedo={canRedo} onUndo={() => undo(false)} onRedo={() => undo(true)}
              renameTarget={renameTarget} onRename={renameFragment} />
          ) : null}
          {picked ? (
            <SelectionBar genes={pickCounts.genes} pieces={pickCounts.pieces} layers={allLayers} activeId={layer ? layer.id : 'original'}
              inLayer={Boolean(layer)} wholeClades={wholeClades} onWholeClades={setWholeClades} onCopy={copyPicks}
              onRemove={removePicks} onClear={clearPicks} singleNode={pickCounts.single >= 0}
              onSplit={() => splitNode(pickCounts.single)} onReroot={() => rerootNode(pickCounts.single)} isLight={isLight} />
          ) : null}
          {selectionDrag ? <div className="gt-selection-dim" /> : null}
          {display && shownRoot !== 0 ? (
            <button type="button" className="gt-floating" onClick={() => { setView(showSubtree(view, 0)); setFitKey(k => k + 1) }}>
              Showing {cladeTitle(index, shownRoot)} · show the whole tree
            </button>
          ) : null}
        </div>
        </div>

        {treeData || ws.layers.length ? (
          <aside className={`gt-drawer${drawerOpen ? '' : ' rail'}${selectionDrag ? ' is-selection-dragging' : ''}`} aria-label="Tree details">
            <div className="gt-band">
              <button type="button" className="gt-band-toggle" onClick={() => setDrawerOpen(!drawerOpen)}
                title={drawerOpen ? 'Hide the tree panel' : 'Show the tree panel'} aria-expanded={drawerOpen}>
                <DrawerChevron pointsRight={drawerOpen} size={20} />
              </button>
              {drawerOpen ? (
                <div className="gt-band-text">
                  <div className="gt-band-line">
                    <strong>{focusLeafData ? (focusLeafData.symbol || focusLink?.gene?.name || leafGeneLabel(focusLeafData)) : (layer ? layer.name : treeData?.name)}</strong>
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
            <div className="gt-drawer-body" ref={drawerBody}>
            <Section title="Layers" forceOpen={Boolean(selectionDrag)}>
              <LayerPanel layers={allLayers} activeId={layer ? layer.id : 'original'} dropTarget={selectionDrag?.target} dragging={Boolean(selectionDrag)}
                fragments={fragmentRows}
                onSwitch={switchDisplay} onNew={newLayer}
                onRename={(id, name) => commit(w => updateLayer(w, id, l => ({ ...l, name })))}
                onDelete={id => {
                  const target = ws.layers.find(l => l.id === id)
                  if (target?.fragments.length && !window.confirm(`Delete “${target.name}” and its ${target.fragments.length} subtree(s)? (⌘Z brings it back.)`)) return
                  commit(w => removeLayer(w, id))
                }}
                onDuplicate={id => commit(w => duplicateLayer(w, id))}
                onExport={id => { const l = ws.layers.find(x => x.id === id); if (l) exportNodes(l.name, l.fragments.map(f => f.nodes)) }}
                onMergeLayers={(from, to) => commit(w => mergeLayers(w, from, to))}
                onMoveFragment={(fragmentId, to) => commit(w => {
                  const from = w.layers.find(l => l.fragments.some(f => f.id === fragmentId))
                  if (!from || from.id === to) return w
                  const fragment = from.fragments.find(f => f.id === fragmentId)
                  const without = updateLayer(w, from.id, l => ({ ...l, fragments: l.fragments.filter(f => f.id !== fragmentId) }))
                  return addFragments(without, to, [fragment])
                })}
                onFragmentRename={renameFragment}
                onFragmentDelete={fragmentId => commit(w => updateLayer(w, layer.id, l => ({ ...l, fragments: l.fragments.filter(f => f.id !== fragmentId) })))}
                onFragmentExport={fragmentId => { const f = layer.fragments.find(x => x.id === fragmentId); if (f) exportNodes(f.name || 'subtree', [f.nodes]) }}
                onFragmentFocus={fragmentId => {
                  const item = layout?.items.find(i => i.node.fragRoot === fragmentId)
                  if (item) canvasRef.current?.zoomInto(item)
                }} />
            </Section>

            <Section title="Tree">
              {layer ? (
                <div className="gt-tree-title">
                  <strong><i className="gt-layer-dot" style={{ background: layer.color }} />{layer.name}</strong>
                  <span>Subtree layer · {layerSummary(layer)}</span>
                </div>
              ) : (
                <div className="gt-tree-title">
                  <strong>{treeData?.name}</strong>
                  <span>{collection?.name}{collection?.method ? ` · ${collection.method}` : ''}</span>
                  {collection?.tags?.length ? <span className="gt-tags">{collection.tags.map(tag => <em key={tag}>{tag}</em>)}</span> : null}
                </div>
              )}
              <div className="gt-stats">
                <Stat value={stats.genes} label="genes" />
                <Stat value={stats.species} label="species" />
                <Stat value={stats.speciation} label="speciation nodes" />
                <Stat value={stats.duplication} label="duplication nodes" />
                <Stat value={stats.dubious} label="ambiguous nodes" />
                <Stat value={stats.gene_split} label="gene split events" />
              </div>
              {stats.events_inferred ? <p className="gt-muted">Events were inferred from species overlap; the file did not mark them.</p> : null}
              {layer ? null : <p className="gt-linked-summary">
                <Glyph kind="topbar" /> {(summary.linked || 0).toLocaleString()} gene{summary.linked === 1 ? '' : 's'} in local genomes
                {summary.genome ? <><br /><Glyph kind="genome" /> {summary.genome} in a local species but not found</> : null}
                {treeData?.links_pending ? <><br /><span className="gt-muted">Checking protein identifiers…</span></> : null}
              </p>}
              <div className="gt-row">
                {!layer && collection ? <button type="button" onClick={() => setDialog({ kind: 'links', collection })}>Link genomes…</button> : null}
                {!layer && collection ? <button type="button" onClick={() => setDialog({ kind: 'details', collection })}>Details</button> : null}
                <button type="button" onClick={() => (layer ? exportNodes(layer.name, layer.fragments.map(f => f.nodes)) : exportTree('newick'))}>Export</button>
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
              ) : null}
              <ul className="gt-key">
                <li><Glyph kind="focus" />Focus gene</li>
                <li><KeyPill color={genomeColors.values().next().value} state="active" isLight={isLight} />In a genome in the top bar, in its colour</li>
                <li><KeyPill color={genomeColors.values().next().value} state="inactive" isLight={isLight} />In a local genome not in the top bar</li>
                <li><Glyph kind="genome" />Local species, gene not found</li>
                <li><Glyph kind="unresolved" />Not local</li>
              </ul>
              {showNeighbourhoods ? (
                <ul className="gt-key">
                  <li><i className="gt-key-arrow centre" />Neighbourhood: the gene in the tree</li>
                  <li><i className="gt-key-arrow shared" />A neighbour found beside it in several genomes</li>
                  <li><i className="gt-key-arrow" />A neighbour in this genome only</li>
                </ul>
              ) : null}
            </Section>
            </div>
            ) : null}
          </aside>
        ) : null}
      </div>

      {tooltip}
      {layerDrag ? createPortal(
        <div className={`gt-selection-ghost${isLight ? ' light' : ''}`} style={{ left: layerDrag.x + 16, top: layerDrag.y + 14 }}>
          <strong>{layerDragText(layerDrag).title}</strong>
          <span>{layerDragText(layerDrag).detail}</span>
        </div>, document.body) : null}
      {selectionDrag?.image ? createPortal((() => {
        // The lifted subtree follows the pointer from where it was taken hold of, shrinking
        // to a handy size as it comes away and a little more over somewhere it can drop.
        const image = selectionDrag.image
        const fit = Math.min(1, 420 / Math.max(1, image.width), 300 / Math.max(1, image.height))
        return (
          <div className={`gt-drag-subtree${isLight ? ' light' : ''}${selectionDrag.target ? ' over-target' : ''}`} aria-hidden="true"
            style={{ left: selectionDrag.x - image.grabX, top: selectionDrag.y - image.grabY, width: image.width, height: image.height,
              transformOrigin: `${image.grabX + 7}px ${image.grabY + 7}px`, '--gt-lift': fit }}>
            <img src={image.url} alt="" width={image.width} height={image.height} draggable={false} />
          </div>
        )
      })(), document.body) : null}
      {selectionDrag ? createPortal(
        <div className={`gt-selection-ghost${isLight ? ' light' : ''}`} style={{ left: selectionDrag.x + 16, top: selectionDrag.y + 14 }}>
          <strong>{pickCounts.genes.toLocaleString()} gene{pickCounts.genes === 1 ? '' : 's'}{pickCounts.pieces > 1 ? ` · ${pickCounts.pieces} pieces` : ''}</strong>
          <span>{selectionDrag.target === 'new' ? 'Release to create a new layer'
            : selectionDrag.target ? `Release to copy into ${ws.layers.find(l => l.id === selectionDrag.target)?.name || 'this layer'}`
              : 'Drop on a layer or ＋ New layer · Esc cancels'}</span>
        </div>, document.body) : null}

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

