import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import AnchoredMenu from './menus.jsx'
import LayerPanel from './LayerPanel.jsx'
import SelectionBar from './SelectionBar.jsx'
import LayerBar from './LayerBar.jsx'
import TreePicker from './TreePicker.jsx'
import TreeCycle from './TreeCycle.jsx'
import { DataViewMenu, NodesButton, ToolButton } from './ToolGroup.jsx'
import { FAMILY_PALETTE, FLANK_CHOICES, NEIGHBOUR_PALETTE, NEIGHBOURHOOD_FLANK, buildMatcher, groupColours, pairRows, sharedGroups, useNeighbourhoods } from './neighbourhoodData.js'
import { LAYER_TOOLS, TOOLS } from './tools.js'
import useWorkspace from './useWorkspace.js'
import {
  activeLayer, addFragments, addLayer, carryPicks, createFragment, duplicateLayer, forestStats, forestTree, layerStats, mergeLayers,
  removeLayer, replaceFragment, updateLayer,
} from './workspace.js'
import { extract, fragmentGrafts, graft, mergeWithGrafts, prune, splitAt, toNewick } from './subtreeOps.js'
import { API_BASE } from '../../backendRuntime'
import { resolveBrowsingControls } from '../../utils/browsingControls.js'
import { getAssemblyAccession, normalizeGenomeRecord } from '../../utils/genomeIdentity'
import { genomeForAssembly } from '../alignment-explorer/associations.js'
import { genomeColorPalette, genomeColorResolver } from '../../genomeColorSchemes'
import { genomePillColors } from '../../utils/genomePillColors'
import DrawerChevron from '../DrawerChevron'
import iconResetRaw from '../../assets/icons/icon_reset.svg?raw'
import TreeCanvas from './TreeCanvas.jsx'
import { CollectionDetailsDialog, LayerEditDialog, LibraryDialog, LinkGenomesDialog, LoadTreeDialog } from './dialogs.jsx'
import { api, downloadText, formatBytes, loadPreference, loadViewState, query, savePreference, saveViewState } from './data.js'
import { LABEL_GAP, NEIGHBOUR_ROW_PITCH, PALETTES, cladeGenomes, contentBounds, linkStatus, measureTerminal, neighbourColumnPx, neighbourhoodColumn, paintTree } from './paintTree.js'
import { MATCH_BY, agreement, compareLinks, currentCrossings, untangle } from './compareTrees.js'
import { ALIGNMENT_ROW_PITCH, ALIGNMENT_WIDTHS, INTRON_CAP_BP, alignmentColumn, conservationRamp, featuresAt, genomicAt } from './alignmentColumn.js'
import { ALIGNMENT_DEFAULTS, FLANK_CHOICES_BP, INTRON_EDGE_CHOICES, useTreeAlignment } from './alignmentData.js'
import { layoutTree } from './treeLayout.js'
import { arrivingView, carryView, composeColumns, isAlignmentView, isDataView, laneViews, scopeView, viewScope, withFragmentViews } from './dataColumns.js'
import {
  applyNodeMode, cladeLabel, cladeTitle, defaultView, descendants, emptyViewState, expandSubtree, findLeaves,
  focusOn, indexTree, leafGeneLabel, leafSpeciesLabel, pathsTo, pathToRoot, foldTo, mirrorClade, showSubtree, speciesCount, toggleCollapsed, toggleFlipped,
} from './treeModel.js'
import './geneTrees.css'

const HOVER_CARD_DELAY_MS = 2000
// A card opened by a click on the alignment stays until the pointer strays this far from it.
const CLICKED_CARD_STAY_PX = 40
// What floats over the top of the tree, for the canvas to keep clear: a layer's tool bar,
// and the gene of focus bar (as tall as the drawer's band, --gt-band-h).
const LAYER_BAR_INSET = 52
const FOCUS_BAR_H = 58
// The layer bar's second row, while two subtrees are compared.
const COMPARE_ROW_H = 40
const EVENT_LABELS = { speciation: 'Speciation', duplication: 'Gene duplication', dubious: 'Ambiguous', gene_split: 'Gene split' }
// The Neighbourhood data view's settings, as first shown: the Neighbourhood view's plain
// look, with links between rows by gene family.
const NEIGHBOUR_DEFAULTS = Object.freeze({ flank: NEIGHBOURHOOD_FLANK, colour: 'plain', links: 'on', match: 'family' })
// What an alignment run is doing, in words.
const ALIGN_PHASES = { queued: 'Waiting for another alignment to finish', starting: 'Starting', extracting: 'Reading sequences',
  aligning: 'Aligning with MAFFT', mapping: 'Placing exons on the alignment', saving: 'Saving' }
const MAFFT_STAGES = { distances: 'distances', tree: 'guide tree', progressive: 'progressive alignment', refining: 'refining' }
const FEATURE_WORDS = { cds: 'CDS', utr5: '5′ UTR', utr3: '3′ UTR', exon: 'Exon', intron: 'Intron', donor: 'Splice donor',
  acceptor: 'Splice acceptor', start_codon: 'Start codon', stop_codon: 'Stop codon' }
const kb = bp => (bp >= 1e6 ? `${(bp / 1e6).toFixed(1)} Mb` : bp >= 1000 ? `${Math.round(bp / 1000).toLocaleString()} kb` : `${bp} bp`)
const aboutSeconds = s => (s >= 90 ? `about ${Math.round(s / 60)} min` : `about ${Math.max(1, Math.round(s))} s`)

const STATUS_LABELS = {
  topbar: 'In a genome in the top bar', local: 'In a local genome not in the top bar',
  genome: 'Species is local, gene not found in its annotation', pending: 'Checking local proteins…',
  no_index: 'Species is local, but its annotation is not indexed',
  unresolved: 'Not in a local genome', none: 'Not in a local genome',
}

/** What a leaf's link says, for the hover card and the drawer: which genome, and why no gene. */
function statusText(link, status, leaf = null) {
  const genome = link?.genome_name || link?.assembly || 'Its genome'
  if (status === 'no_index') {
    return link?.annotation === false
      ? `${genome} is local, but its annotation is not downloaded`
      : `${genome} is local, but its annotation is not indexed, so its genes could not be looked up`
  }
  if (status === 'genome') {
    // Looked for and not there: usually the tree was built on another annotation of the
    // species (an older assembly, or another provider), whose gene IDs the local one lacks.
    const id = leaf?.gene_id || leaf?.protein_id
    return `${genome} is local, but ${id ? `${id} is` : 'this gene is'} not in its annotation — the tree may use another annotation of this species`
  }
  return STATUS_LABELS[status]
}

/** A shared group's name for the key: its family's tree name, else the name of a gene in it. */
function groupName(group, neighbours) {
  const family = group.startsWith('f:') ? neighbours.families?.get(group.slice(2)) : null
  if (family) return family.name
  for (const entry of neighbours.byLeafId.values()) {
    const gene = entry?.genes?.find(g => g.name && neighbours.matcher.group(g) === group)
    if (gene) return gene.name
  }
  return group.startsWith('f:') ? 'A gene family' : group.slice(2)
}

/**
 * The nodes of the subtrees showing one of `views` (a layer), or every node (the Original):
 * what a data view fetches its data for.
 */
function nodesShowing(display, layer, fragmentViews, views) {
  if (!layer || !display?.fragmentOf) return display?.nodes
  return display.nodes.filter(node => {
    const at = display.fragmentOf.get(node.id)
    return at && views.includes(fragmentViews.get(layer.fragments[at[0]]?.id))
  })
}

/** The branching down to every gene in a local genome, in the top bar or not (null if none). */
function localPathsOf(index, links, topbarAssemblies) {
  if (!index) return null
  const leaves = Object.keys(links).map(Number).filter(id => {
    const status = linkStatus(links[id], topbarAssemblies)
    return (status === 'topbar' || status === 'local') && id < index.nodes.length
  })
  return leaves.length ? pathsTo(index, leaves) : null
}

function Glyph({ kind }) {
  const common = { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': true }
  if (kind === 'duplication') return <svg {...common}><circle cx="9" cy="5.5" r="3.2" className="gt-g-dup" /><circle cx="9" cy="12.5" r="3.2" className="gt-g-dup" /></svg>
  if (kind === 'gene_split') return <svg {...common}><circle cx="9" cy="9" r="5" className="gt-g-split" /></svg>
  if (kind === 'dubious') return <svg {...common}><circle cx="9" cy="9" r="4" className="gt-g-dubious" /></svg>
  if (kind === 'topbar') return <svg {...common}><circle cx="9" cy="9" r="5" className="gt-g-linked-fill" /></svg>
  if (kind === 'local') return <svg {...common}><circle cx="9" cy="9" r="4.5" className="gt-g-local" /><circle cx="9" cy="9" r="1.8" className="gt-g-linked-fill" /></svg>
  if (kind === 'genome') return <svg {...common}><circle cx="9" cy="9" r="4.5" className="gt-g-genome" /></svg>
  if (kind === 'no_index') return <svg {...common}><circle cx="9" cy="9" r="4.5" className="gt-g-genome gt-g-noindex" /></svg>
  if (kind === 'unresolved') return <svg {...common}><circle cx="9" cy="9" r="4.5" className="gt-g-none" /></svg>
  if (kind === 'focus') return <svg {...common}><circle cx="9" cy="9" r="6" className="gt-g-focus" /></svg>
  if (kind === 'collapsed') return <svg {...common}><rect x="1" y="4" width="16" height="10" rx="5" className="gt-g-pill" /></svg>
  if (kind === 'collapsed_topbar' || kind === 'collapsed_local') {
    return <svg {...common}><rect x="3" y="5.5" width="12" height="7" rx="3.5" className="gt-g-pill" />
      <rect x="1.25" y="3.75" width="15.5" height="10.5" rx="5.25" className={kind === 'collapsed_topbar' ? 'gt-g-ring-topbar' : 'gt-g-ring-local'} /></svg>
  }
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

// The data view shown, for this session only. A relaunch opens on the Original tree, fitted,
// where a data view is mostly a gap (most leaves unlinked) with the names pushed past it; so
// a new session starts with none, and switching to another view and back keeps it.
let sessionDataView = 'off'
try { localStorage.removeItem('gene-trees:dataView') } catch { /* it was only ever a preference */ }

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
  const [picks, setPicks] = useState({ key: '', ids: new Set() })
  const [selectionDrag, setSelectionDrag] = useState(null)
  const [layerDrag, setLayerDrag] = useState(null) // a fragment being dragged by Move, Merge or Graft
  // The subtree whose name is being typed over its tag (the Rename tool), by fragment id.
  const [naming, setNaming] = useState(null)
  // Compare: the first subtree picked, while the second is being chosen.
  const [comparePick, setComparePick] = useState(null)
  // Each layer's flips from before its comparison untangled them, to put back when it ends.
  const flipsBeforeCompare = useRef({})
  const drawerBody = useRef(null)
  const lastFocusGenes = useRef([])
  const [fitKey, setFitKey] = useState(0)
  // Where the user was in each thing shown (a tree's Original, each layer), so switching
  // away and back returns them there. For this visit only; kept by the canvas.
  const cameras = useRef(new Map())
  const [layoutName, setLayoutName] = useState(() => loadPreference('layout', 'curved'))
  const [phylogram, setPhylogram] = useState(() => loadPreference('phylogram', false))
  const [flipH, setFlipH] = useState(false)
  const [alignLeaves, setAlignLeaves] = useState(() => loadPreference('alignLeaves', false))
  const [shape, setShape] = useState(() => loadPreference('shape', 'linear'))
  // A data view beside the leaves (the Neighbourhood view's synteny), or 'off'.
  const [dataView, setDataView] = useState(() => sessionDataView)
  // The Nodes button's state (tools.js NODE_MODES): what pressing it applies. Only pressing it
  // or choosing a state applies one — a tree opens as it always does. `highlighted`: the tree
  // (display key) Highlight local was applied to, the only one it fades.
  const [nodeMode, setNodeMode] = useState(() => loadPreference('nodeMode', 'expand-all'))
  const [highlighted, setHighlighted] = useState('')
  // The Neighbourhood view's own settings: genes each side, colouring, links, and how
  // genes in different rows are matched.
  const [neighbourOpts, setNeighbourOpts] = useState(() => ({ ...NEIGHBOUR_DEFAULTS, ...loadPreference('neighbourhood', {}) }))
  const setNeighbourOpt = useCallback((key, value) => setNeighbourOpts(opts => ({ ...opts, [key]: value })), [])
  // The aligned-transcript columns' settings: the region aligned, which transcript, the width.
  const [alignOpts, setAlignOpts] = useState(() => ({ ...ALIGNMENT_DEFAULTS, ...loadPreference('alignment', {}) }))
  const setAlignOpt = useCallback((key, value) => setAlignOpts(opts => ({ ...opts, [key]: value })), [])
  // Where along the alignment the column is looking, shared by the alignment columns and
  // moved by the column's own gestures (so a pan repaints, not re-renders).
  const alignView = useRef({ c0: 0, c1: 0 })
  const alignViewSequence = useRef({ c0: 0, c1: 0 }) // Sequence's own, while Structure shows beside it
  const [copied, setCopied] = useState(false)
  const hoverTimer = useRef(null)
  const clickedCard = useRef(null) // where an alignment card was opened by a click
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
  useEffect(() => { sessionDataView = dataView }, [dataView])
  useEffect(() => savePreference('neighbourhood', neighbourOpts), [neighbourOpts])
  useEffect(() => savePreference('alignment', alignOpts), [alignOpts])
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  // The details card waits for the pointer to rest on something for a couple of seconds,
  // rather than flashing up under every node the cursor crosses. The canvas withholds
  // hovers while the view is being zoomed or panned, so the wait only starts once the
  // view is still.
  const onCanvasHover = useCallback((hit, x, y) => {
    // A card opened by a click stays put while the pointer stays near it. It goes when the
    // pointer strays, the view moves (a hover of null, no position) or the pointer leaves.
    const clicked = clickedCard.current
    if (clicked) {
      if (x !== undefined && Math.hypot(x - clicked.x, y - clicked.y) <= CLICKED_CARD_STAY_PX) return
      clickedCard.current = null
      setHover(null)
    }
    // Over an alignment the card waits for a click (onColumnClick): crossing the bases on the
    // way somewhere, or resting there between pans, it kept popping up.
    if (hit?.fromColumn && hit.part === 'alignment') {
      clearTimeout(hoverTimer.current)
      hoverPending.current = null
      return
    }
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

  const onColumnClick = useCallback((hit, x, y) => {
    if (hit.part !== 'alignment') return
    clearTimeout(hoverTimer.current)
    hoverPending.current = null
    clickedCard.current = { x, y }
    setHover({ hit, x, y })
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
  // A name half-typed is let go when what is shown changes (its text box goes with the view).
  const [namingKey, setNamingKey] = useState(displayKey)
  if (namingKey !== displayKey) { setNamingKey(displayKey); setNaming(null) }
  const index = useMemo(() => (display ? indexTree(display) : null), [display])
  const links = useMemo(() => display?.links || {}, [display])
  const view = layer ? (layerViews[layer.id] || emptyViewState()) : origView
  const setView = useCallback(next => {
    if (layer) setLayerViews(prev => ({ ...prev, [layer.id]: next }))
    else setOrigView(next)
  }, [layer])
  const focusLeaf = focus.key === displayKey && index && focus.id < index.nodes.length ? focus.id : -1
  // Two subtrees of this layer being compared, while both are still in it.
  const comparing = layer?.compare && layer.fragments.some(f => f.id === layer.compare.a) && layer.fragments.some(f => f.id === layer.compare.b)
    ? layer.compare : null
  const comparePicking = tool === 'compare' && layer ? comparePick : null
  const setFocusLeaf = useCallback(id => setFocus({ key: displayKey, id }), [displayKey])
  // In a layer, picks follow its edits: those whose subtree an edit changed are dropped, so
  // removing what was picked leaves nothing picked (and the selection bar goes).
  const picked = useMemo(() => {
    if (picks.key !== displayKey || !picks.ids.size) return null
    const ids = layer ? carryPicks(picks.ids, picks.fragments, layer.fragments) : picks.ids
    return ids.size ? ids : null
  }, [picks, displayKey, layer])
  const layerFragments = layer?.fragments
  const setPicked = useCallback(ids => setPicks({ key: displayKey, ids: new Set(ids), fragments: layerFragments }), [displayKey, layerFragments])
  const preferAssemblies = useMemo(() => [...new Set((topBarGenomes || []).map(g => getAssemblyAccession(g)).filter(Boolean))], [topBarGenomes])
  const topbarAssemblies = useMemo(() => new Set(preferAssemblies), [preferAssemblies])
  // The branching down to every gene in a local genome (in the top bar or not): what
  // Expand to local opens, Collapse to local keeps open, and Highlight local lights.
  const localPaths = useMemo(() => localPathsOf(index, links, topbarAssemblies), [index, links, topbarAssemblies])
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
      // A gene of focus only when one is asked for (a gene carried from another view or tree),
      // or, coming back to the view, the one the user left. A tree opened from a search or
      // the library opens with none.
      let focus = target?.geneIds?.length ? chooseFocus(idx, data, target.geneIds) : restore ? (stored?.focus ?? -1) : -1
      if (focus >= idx.nodes.length) focus = -1
      // With none, the gene focused before is let go too, so a layer does not bring it back.
      if (focus < 0) lastFocusGenes.current = []
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
  // The data views on show (linear layout only). The Original shows one, or none; in a layer
  // each subtree shows its own (`fragment.dataView`, see dataColumns.js).
  const fragmentViews = useMemo(() => new Map((layer?.fragments || []).map(f => [f.id, isDataView(f.dataView) ? f.dataView : 'off'])), [layer])
  const shownViews = useMemo(() => {
    if (shape !== 'linear') return new Set()
    if (!layer) return new Set(isDataView(dataView) ? [dataView] : [])
    return new Set([...fragmentViews.values()].filter(isDataView))
  }, [shape, layer, dataView, fragmentViews])
  const viewsKey = [...shownViews].sort().join(',')
  // A details card belongs to what was under the pointer: gone when the tree, layer or views change.
  useEffect(() => { clearTimeout(hoverTimer.current); hoverPending.current = null; clickedCard.current = null; setHover(null) }, [displayKey, viewsKey])
  // The nodes each kind of view covers: in a layer, only the subtrees showing it.
  const neighbourNodes = useMemo(() => nodesShowing(display, layer, fragmentViews, ['neighbourhood']), [display, layer, fragmentViews])
  const alignNodes = useMemo(() => nodesShowing(display, layer, fragmentViews, ['structure', 'sequence']), [display, layer, fragmentViews])
  // The Neighbourhood column: for the leaves linked to local genes.
  const showNeighbourhoods = shownViews.has('neighbourhood')
  const flank = FLANK_CHOICES.includes(neighbourOpts.flank) ? neighbourOpts.flank : NEIGHBOURHOOD_FLANK
  const neighbourData = useNeighbourhoods(neighbourNodes, links, showNeighbourhoods, flank)
  const neighbours = useMemo(() => {
    if (!showNeighbourhoods) return null
    const matcher = buildMatcher(neighbourData.byLeafId, neighbourOpts.match)
    const { rows, order } = sharedGroups(neighbourData.byLeafId, matcher)
    // Which genes link between two rows, worked out once per pair of rows on show.
    const pairs = new Map()
    const pairsFor = (upperId, lowerId, upper, lower) => {
      const key = `${upperId}|${lowerId}`
      if (!pairs.has(key)) pairs.set(key, pairRows(upper, lower, matcher))
      return pairs.get(key)
    }
    return { ...neighbourData, flank, matcher, rows, order, colours: groupColours(order, neighbourOpts.colour, isLight),
      colourMode: neighbourOpts.colour, links: neighbourOpts.links === 'on', pairsFor }
  }, [showNeighbourhoods, neighbourData, flank, neighbourOpts, isLight])
  // Plain words throughout: say what a choice does, not how it works.
  const plainBlue = isLight ? '#0099ff' : '#3b82f6', plainOrange = isLight ? '#f97316' : '#fb923c'
  const neighbourOptions = [
    { id: 'flank', label: 'Genes on each side', value: flank, onChange: v => setNeighbourOpt('flank', v),
      choices: FLANK_CHOICES.map(n => ({ id: n, label: String(n) })) },
    { id: 'match', label: 'Treat genes as related when they share', value: neighbourOpts.match, onChange: v => setNeighbourOpt('match', v),
      choices: [
        { id: 'family', label: 'A gene family', hint: 'They are in the same gene tree' },
        { id: 'symbol', label: 'A name', hint: 'They have the same gene symbol' },
      ],
      note: neighbourOpts.match === 'family' ? 'Genes that aren’t in any of your trees are matched by name instead.' : null },
    { id: 'links', kind: 'check', label: 'Link related genes', checked: neighbourOpts.links === 'on',
      onChange: on => setNeighbourOpt('links', on ? 'on' : 'off'),
      hint: neighbourOpts.match === 'family' ? 'A solid line means same family, a dashed line same name.' : 'A dashed line joins genes with the same name.' },
    { id: 'colour', label: 'Colour', value: neighbourOpts.colour, onChange: v => setNeighbourOpt('colour', v),
      choices: [
        { id: 'plain', label: 'Plain', hint: 'As in the Neighbourhood view', swatch: [plainBlue, plainOrange, plainBlue] },
        { id: 'top', label: 'Most common', hint: `The ${FAMILY_PALETTE.dark.length} most common ${neighbourOpts.match === 'family' ? 'families' : 'genes'} stand out`,
          swatch: FAMILY_PALETTE[isLight ? 'light' : 'dark'] },
        { id: 'all', label: 'All repeated', hint: 'Anything found in more than one row', swatch: NEIGHBOUR_PALETTE.slice(0, 5) },
      ] },
  ]
  // The Structure and Sequence columns: each linked leaf's transcript in the columns of one
  // alignment, drawn as a gene model or as its bases. Both share the alignment (in a layer, of
  // every subtree showing either) and, one at a time, the view along it.
  const showStructure = shownViews.has('structure') || shownViews.has('sequence')
  const showStructureModel = shownViews.has('structure'), showSequence = shownViews.has('sequence')
  const alignWidth = ALIGNMENT_WIDTHS[alignOpts.width] || ALIGNMENT_WIDTHS.m
  const alignment = useTreeAlignment(alignNodes, links, alignOpts, showStructure, layer ? layer.name : treeData?.name || 'gene tree')
  const alignOptions = [
    { id: 'region', label: 'Align', value: alignOpts.region, onChange: v => setAlignOpt('region', v),
      choices: [
        { id: 'exons', label: 'Exons', hint: `With ${alignOpts.intron_edge} bases of each intron's ends` },
        { id: 'genomic', label: 'Whole gene', hint: 'Introns and all: slower, and much longer' },
      ] },
    { id: 'flank', label: 'Bases beyond the transcript', value: alignOpts.flank, onChange: v => setAlignOpt('flank', v),
      choices: FLANK_CHOICES_BP.map(n => ({ id: n, label: String(n) })) },
    ...(alignOpts.region === 'exons' ? [{ id: 'edge', label: 'Intron bases kept at each end', value: alignOpts.intron_edge,
      onChange: v => setAlignOpt('intron_edge', v), choices: INTRON_EDGE_CHOICES.map(n => ({ id: n, label: String(n) })) }] : []),
    { id: 'transcript', label: 'Transcript', value: alignOpts.transcript, onChange: v => setAlignOpt('transcript', v),
      choices: [
        { id: 'canonical', label: 'Canonical', hint: 'Each gene’s canonical transcript' },
        { id: 'tree', label: 'The tree’s', hint: 'The one the tree was built from, where it says' },
      ] },
    { id: 'colour', label: 'Colour', value: alignOpts.colour || 'features', onChange: v => setAlignOpt('colour', v),
      choices: [
        { id: 'features', label: 'Features', hint: 'Coding, UTR, introns and splice sites, as the genome browser colours them' },
        { id: 'conservation', label: 'Conservation', hint: 'Each base by how many of the genes share it, blue for few to red for all',
          swatch: conservationRamp().filter((_, i) => i % 6 === 0).concat(conservationRamp().slice(-1)) },
      ] },
    { id: 'width', label: 'Column width', value: alignOpts.width, onChange: v => setAlignOpt('width', v),
      choices: [{ id: 's', label: 'Narrow' }, { id: 'm', label: 'Medium' }, { id: 'l', label: 'Wide' }] },
  ]
  const structureOptions = [
    { id: 'boundaries', kind: 'check', label: 'Mark shared exon boundaries', checked: alignOpts.boundaries !== false,
      onChange: on => setAlignOpt('boundaries', on), hint: 'A splice boundary other genes have at the same aligned position gets a white edge, bolder the more genes share it.' },
    ...alignOptions,
  ]
  const sequenceOptions = [
    { id: 'differences', kind: 'check', label: 'Show differences only', checked: Boolean(alignOpts.differences),
      onChange: on => setAlignOpt('differences', on), hint: 'Bases that agree with the consensus fade, so changes stand out.' },
    ...alignOptions,
  ]
  const widthOf = useCallback(v => (v === 'neighbourhood' ? neighbourColumnPx(flank) : isAlignmentView(v) ? alignWidth : 0), [flank, alignWidth])
  const layout = useMemo(() => {
    if (!index || !view) return null
    const views = [...shownViews]
    const lay = layoutTree(index, view, {
      layout: layoutName, phylogram: phylogram && displayStats.has_branch_lengths, flipHorizontal: flipH,
      alignLeaves, shape, dataColumn: Math.max(0, ...views.map(widthOf)),
      // Rows a little further apart while a column shows, so links between them have room
      // (in a layer, as far apart as the roomiest view on show needs, so rows still line up).
      rowPitch: views.length ? Math.max(...views.map(v => (v === 'neighbourhood' ? NEIGHBOUR_ROW_PITCH : ALIGNMENT_ROW_PITCH))) : undefined,
      // How far past its tips each subtree's own column reaches (at zoom 1), so an arranged
      // subtree that gains one pushes its neighbours along rather than growing into them.
      fragmentExtra: layer && views.length ? id => widthOf(fragmentViews.get(id)) : undefined,
      // Comparing, facing: the second subtree points back at the first, its root on the right.
      mirrorFragments: comparing?.facing && shape !== 'radial' ? new Set([comparing.b]) : undefined,
    })
    // A layer's subtrees each push their labels past their own view's column, or none.
    if (layer && lay.forest && views.length) {
      lay.laneViews = laneViews(lay, id => fragmentViews.get(id))
      lay.laneOffsets = lay.laneViews.map(widthOf)
    }
    return lay
  }, [index, view, layoutName, phylogram, flipH, alignLeaves, shape, displayStats, shownViews, widthOf, layer, fragmentViews, comparing?.facing, comparing?.b])

  const column = useMemo(() => {
    const neighbourCol = showNeighbourhoods && neighbours ? neighbourhoodColumn(neighbours) : null
    const alignCol = (mode, viewState) => alignmentColumn({ data: alignment.data, pending: alignment.pending, failed: alignment.failed,
      view: viewState, widthPx: alignWidth, isLight, mode, differences: Boolean(alignOpts.differences),
      boundaries: alignOpts.boundaries !== false, colour: alignOpts.colour || 'features' })
    if (!layer) {
      if (neighbourCol) return neighbourCol
      if (showStructure) return alignCol(dataView, alignView.current)
      return null
    }
    if (!layout?.laneViews) return null
    const lanesOf = v => new Set(layout.laneViews.flatMap((lv, lane) => (lv === v ? [lane] : [])))
    // Structure and Sequence side by side each keep their own place along the alignment.
    return composeColumns([
      { column: neighbourCol, lanes: lanesOf('neighbourhood') },
      { column: showStructureModel ? alignCol('structure', alignView.current) : null, lanes: lanesOf('structure') },
      { column: showSequence ? alignCol('sequence', showStructureModel ? alignViewSequence.current : alignView.current) : null, lanes: lanesOf('sequence') },
    ])
  }, [layer, layout, showNeighbourhoods, neighbours, showStructure, showStructureModel, showSequence, alignment.data, alignment.pending,
    alignment.failed, alignWidth, isLight, dataView, alignOpts.differences, alignOpts.boundaries, alignOpts.colour])

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
    setSearchOpen(false)
    setSearch('')
    // Opening a tree from a search picks no gene of focus: the user chooses one by clicking.
    openTree(result.collection_id, result.tree_id)
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
          if (trees.trees?.[0]) openTree(created.id, trees.trees[0].tree_id)
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
    // Clicking the focused gene again lets it go. The focus bar floats over the top of the
    // tree rather than pushing it down, so the view only moves when the bar would cover the
    // gene just clicked.
    if (item.kind === 'leaf') {
      if (item.id === focusLeaf) { setFocusLeaf(-1); return }
      setFocusLeaf(item.id)
      canvasRef.current?.reveal(item.id, (layer ? LAYER_BAR_INSET + (layer.compare ? COMPARE_ROW_H : 0) : 0) + FOCUS_BAR_H)
      return
    }
    if (action === 'expand') setView(expandSubtree(index, view, item.id))
    else if (action === 'focus') setView(focusOn(index, view, item.id))
    else if (action === 'flip') setView(toggleFlipped(index, view, item.id))
    else setView(toggleCollapsed(index, view, item.id))
  }, [index, view, setView, setFocusLeaf, focusLeaf, layer])

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
    if (result?.ok === false) setNotice(result.message || 'The genome could not be added to the top bar.')
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
    setFitKey(k => k + 1)
  }

  // ── subtree layers ──

  const setTool = useCallback(next => setToolState(next), [])
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
  const picksAsFragments = useCallback(ids => {
    if (!ids?.size || !index) return []
    const collapsed = view?.collapsed || new Set()
    if (!layer) {
      if (!treeData || !current) return []
      const folded = [...ids].filter(id => collapsed.has(id))
      const source = { collectionId: current.collectionId, treeId: current.treeId, treeName: treeData.name }
      return extract(treeData.nodes, ids, { folded, srcTree: `${current.collectionId}:${current.treeId}`, links: treeData.links })
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
      for (const nodes of extract(fragment.nodes, sel.ids, { folded: sel.folded })) out.push({ nodes, source: fragment.source, view: fragment.dataView })
    }
    return out
  }, [index, view, layer, treeData, current, forest])

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

  const copyPicks = useCallback(target => {
    const pieces = picksAsFragments(picked)
    if (!pieces.length) { setNotice('Nothing with a gene in it is picked: pick some leaves, or a clade.'); return }
    commit(w => {
      let next = w
      let id = target
      if (target === 'new' || !w.layers.some(l => l.id === target)) {
        const made = addLayer(w)
        next = made.ws
        id = made.layer.id
      }
      // Each arrives showing the layer's data view, if all its subtrees share one; into an
      // empty layer, the view it showed where it came from (see dataColumns.js).
      const already = next.layers.find(l => l.id === id)?.fragments || []
      next = addFragments(next, id, pieces.map(p => carryView(createFragment(p.nodes, p.source), arrivingView(already, layer ? p.view : dataView))))
      return { ...next, active: id, original: false }
    })
    clearPicks()
    setToolState('explore')
    setFitKey(k => k + 1)
  }, [picksAsFragments, picked, commit, clearPicks, layer, dataView])

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

  // ── Compare: two subtrees of a layer facing each other, lines between matching genes ──

  const fragmentRootId = useCallback(fragmentId => (forest ? forest.nodes.findIndex(n => n.fragRoot === fragmentId) : -1), [forest])
  // The lines and where the trees agree (compareTrees.js), for the canvas to draw.
  const compareModel = useMemo(() => {
    if (!comparing || !index || shape === 'radial') return null
    const rootA = fragmentRootId(comparing.a), rootB = fragmentRootId(comparing.b)
    if (rootA < 0 || rootB < 0) return null
    const { links, partners, onlyA, onlyB } = compareLinks(index, rootA, rootB, comparing.by || 'species')
    const agree = agreement(index, rootA, rootB, links)
    const showConflict = comparing.disagreement !== false
    const warn = isLight ? '#d08a00' : '#f5b942'
    const plain = isLight ? '#5d8fc4' : '#7ea7d6'
    const coloured = links.map(link => ({ ...link,
      color: !showConflict ? plain
        : agree.groups.has(link.a) ? NEIGHBOUR_PALETTE[agree.groups.get(link.a) % NEIGHBOUR_PALETTE.length]
          : agree.unsettled.has(link.a) ? warn : plain }))
    // What a hovered node lights: a leaf, its partners; a clade, its matched leaves' partners
    // and, when the other tree has the very same clade, that clade too.
    const lit = new Map()
    const partnersOf = id => {
      if (lit.has(id)) return lit.get(id)
      const out = new Set()
      if (index.nodes[id] && !index.nodes[id].virtual) {
        const under = index.nodes[id].children.length ? descendants(index, id) : [id]
        for (const leaf of under) {
          const others = partners.get(leaf)
          if (!others) continue
          out.add(leaf)
          for (const other of others) out.add(other)
        }
        if (agree.counterpart.has(id)) out.add(agree.counterpart.get(id))
      }
      lit.set(id, out)
      return out
    }
    return { rootA, rootB, links: coloured, partners, partnersOf, agree, onlyA, onlyB, facing: Boolean(comparing.facing), scaleX: comparing.scaleX || 1,
      conflict: showConflict ? agree.conflict : new Set(), conflictColor: warn,
      ambiguousColor: isLight ? '#8193a8' : '#6d7f96', faded: new Set([...onlyA, ...onlyB]) }
  }, [comparing, index, shape, fragmentRootId, isLight])
  const compareCrossings = useMemo(() => (compareModel && view
    ? currentCrossings(index, view, compareModel.rootA, compareModel.rootB, compareModel.links) : 0), [compareModel, index, view])

  // Facing: the first subtree where the layer starts, the second to its right with its root on
  // the right, room between them for both sets of labels and the lines; every other subtree
  // stacked underneath. Labels keep their size at any zoom, so the room for them is laid out
  // for one horizontal scale (`scaleX`: the one at which the pair just fills the view's width,
  // at most 1), and while they face each other the view never goes narrower than that.
  const measureCtx = useRef(null)
  const facingPlaces = useCallback((a, b) => {
    if (!layout?.fragmentBoxes || !index) return null
    const boxes = layout.fragmentBoxes
    const boxA = boxes.get(a), boxB = boxes.get(b)
    if (!boxA || !boxB) return null
    const ctx = measureCtx.current || (measureCtx.current = document.createElement('canvas').getContext('2d'))
    const laneOf = id => layout.byId.get(fragmentRootId(id))?.lane
    const widest = id => {
      const lane = laneOf(id)
      let most = 0
      for (const item of layout.items) {
        if (item.lane !== lane || item.kind === 'internal') continue
        most = Math.max(most, measureTerminal(ctx, index, item, null).width)
      }
      return most + LABEL_GAP + (layout.laneOffsets?.[lane] || 0)
    }
    const dir = flipH ? -1 : 1
    const all = [...boxes.values()]
    const top = Math.min(...all.map(box => box.y))
    const start = dir > 0 ? Math.min(...all.map(box => box.x)) : Math.max(...all.map(box => box.x))
    const labels = widest(a) + 180 + widest(b)
    const viewWidth = canvasRef.current?.canvas()?.clientWidth || 1200
    const scaleX = Math.min(1, Math.max(0.2, (viewWidth - 120 - labels) / Math.max(1, boxA.w + boxB.w)))
    const gap = labels / scaleX
    const places = {
      [a]: { x: start, y: top, w: boxA.w, h: boxA.h },
      [b]: { x: start + dir * (boxA.w + gap + boxB.w), y: top, w: boxB.w, h: boxB.h },
    }
    let cursor = top + Math.max(boxA.h, boxB.h) + layout.pitch * 4
    for (const fragment of layer.fragments) {
      if (fragment.id === a || fragment.id === b) continue
      const box = boxes.get(fragment.id)
      if (!box) continue
      places[fragment.id] = { x: start, y: cursor, w: box.w, h: box.h }
      cursor += box.h + layout.pitch * 3
    }
    return { places, scaleX }
  }, [layout, index, fragmentRootId, flipH, layer])
  const placedNow = useCallback(() => Object.fromEntries((layer?.fragments || []).map(f => [f.id, f.pos || null])), [layer])
  const withPlaces = (fragments, places) => fragments.map(f => {
    if (!(f.id in places)) return f
    const next = { ...f }
    if (places[f.id]) next.pos = places[f.id]
    else delete next.pos
    return next
  })

  const untangleCompare = useCallback((model = compareModel) => {
    if (!model || !index || !view) return
    const result = untangle(index, view, model.rootA, model.rootB, model.links, model.partners)
    if (result.after < result.before) setView(result.view)
  }, [compareModel, index, view, setView])

  const startCompare = useCallback((a, b) => {
    if (!layer || a === b || shape === 'radial') return
    const facing = facingPlaces(a, b)
    const saved = placedNow()
    commit(w => updateLayer(w, layer.id, l => ({ ...l,
      fragments: facing ? withPlaces(l.fragments, facing.places) : l.fragments,
      compare: { a, b, by: l.compare?.by || 'species', facing: Boolean(facing), scaleX: facing?.scaleX ?? 1,
        disagreement: l.compare?.disagreement !== false, saved } })))
    // Lines that cross least from the start: the flips it changes are put back at the end.
    flipsBeforeCompare.current[layer.id] = view?.flipped || new Set()
    const rootA = fragmentRootId(a), rootB = fragmentRootId(b)
    if (index && view && rootA >= 0 && rootB >= 0) {
      const { links, partners } = compareLinks(index, rootA, rootB, layer.compare?.by || 'species')
      const result = untangle(index, view, rootA, rootB, links, partners)
      if (result.after < result.before) setView(result.view)
    }
    setComparePick(null)
    setFitKey(k => k + 1)
  }, [layer, shape, facingPlaces, placedNow, commit, view, index, fragmentRootId, setView])

  const setCompare = useCallback(change => {
    if (!layer || !comparing) return
    commit(w => updateLayer(w, layer.id, l => ({ ...l, compare: { ...l.compare, ...change } })))
  }, [layer, comparing, commit])

  // Facing ⇄ as the user had them: facing keeps where they were, to put them back.
  const setFacing = useCallback(facing => {
    if (!layer || !comparing || facing === Boolean(comparing.facing)) return
    if (facing) {
      const arranged = facingPlaces(comparing.a, comparing.b)
      if (!arranged) return
      const saved = placedNow()
      commit(w => updateLayer(w, layer.id, l => ({ ...l, fragments: withPlaces(l.fragments, arranged.places),
        compare: { ...l.compare, facing: true, scaleX: arranged.scaleX, saved } })))
    } else {
      commit(w => updateLayer(w, layer.id, l => ({ ...l, fragments: withPlaces(l.fragments, l.compare.saved || {}), compare: { ...l.compare, facing: false } })))
    }
    setFitKey(k => k + 1)
  }, [layer, comparing, facingPlaces, placedNow, commit])

  const swapCompare = useCallback(() => {
    if (!layer || !comparing) return
    const a = comparing.b, b = comparing.a
    const arranged = comparing.facing ? facingPlaces(a, b) : null
    commit(w => updateLayer(w, layer.id, l => ({ ...l, fragments: arranged ? withPlaces(l.fragments, arranged.places) : l.fragments,
      compare: { ...l.compare, a, b, ...(arranged ? { scaleX: arranged.scaleX } : {}) } })))
    setFitKey(k => k + 1)
  }, [layer, comparing, facingPlaces, commit])

  const endCompare = useCallback(() => {
    if (!layer?.compare) return
    commit(w => updateLayer(w, layer.id, l => {
      const next = { ...l, fragments: l.compare.facing ? withPlaces(l.fragments, l.compare.saved || {}) : l.fragments }
      delete next.compare
      return next
    }))
    const flips = flipsBeforeCompare.current[layer.id]
    if (flips && view) setView({ ...view, flipped: flips })
    delete flipsBeforeCompare.current[layer.id]
    setComparePick(null)
    if (tool === 'compare') setToolState('explore')
    setFitKey(k => k + 1)
  }, [layer, commit, view, setView, tool])

  // The layer bar's Compare: ends a comparison; with just two subtrees starts one at once;
  // otherwise picks them, one click each.
  const pressCompare = useCallback(() => {
    if (!layer) return
    if (comparing) { endCompare(); return }
    if (tool === 'compare') { setToolState('explore'); setComparePick(null); return }
    if (layer.fragments.length === 2) { startCompare(layer.fragments[0].id, layer.fragments[1].id); return }
    setComparePick(null)
    setTool('compare')
  }, [layer, comparing, endCompare, tool, startCompare, setTool])

  const compareBar = comparing ? (() => {
    const name = id => {
      const root = fragmentRootId(id)
      const fragment = layer.fragments.find(f => f.id === id)
      return root >= 0 && index ? fragmentTitle(index, root, fragment) : 'Subtree'
    }
    const st = compareModel?.agree.stats
    const linked = compareModel ? compareModel.links.length : 0
    const ambiguous = compareModel ? compareModel.links.filter(l => !l.oneToOne).length : 0
    return {
      a: name(comparing.a), b: name(comparing.b), by: comparing.by || 'species', facing: Boolean(comparing.facing),
      disagreement: comparing.disagreement !== false, matchChoices: MATCH_BY,
      stats: st ? [
        { text: `${linked.toLocaleString()} linked`, title: `${st.matched} genes matched one to one${ambiguous ? `, ${ambiguous} lines between copies of the same species (dashed)` : ''}${compareModel.onlyA.length + compareModel.onlyB.length ? `; ${compareModel.onlyA.length + compareModel.onlyB.length} genes with no match (faded)` : ''}` },
        { text: `${st.shared} of ${Math.max(st.cladesA, st.cladesB)} clades shared`, title: 'Clades (branches, ignoring the root) found in both trees, counting only genes matched one to one' },
        ...(st.conflictA + st.conflictB ? [{ text: `${st.conflictA + st.conflictB} conflicting`, warn: true, title: `Clades in one tree but not the other: ${st.conflictA} on the left, ${st.conflictB} on the right (dashed)` }] : []),
        { text: `${compareCrossings.toLocaleString()} crossing${compareCrossings === 1 ? '' : 's'}`, title: 'Lines that cross. Untangle flips branches to bring this down.' },
      ] : [],
      onSwap: swapCompare, onBy: by => setCompare({ by }), onFacing: setFacing, onUntangle: () => untangleCompare(),
      onDisagreement: on => setCompare({ disagreement: on }), onEnd: endCompare,
    }
  })() : null

  const onLayerAction = useCallback(async action => {
    if (!layer) return
    // The Rename tool: the subtree's name tag becomes a text box (TreeCanvas `naming`).
    if (action.type === 'rename') { setNaming(action.fragmentId); return }
    // Compare: the first subtree clicked, then the second.
    if (action.type === 'compare-pick') {
      if (!comparePick) setComparePick(action.fragmentId)
      else if (comparePick === action.fragmentId) setComparePick(null)
      else { startCompare(comparePick, action.fragmentId); setToolState('explore') }
      return
    }
    const find = id => layer.fragments.find(f => f.id === id)
    const at = id => {
      const where = forest.fragmentOf.get(id)
      return where ? { fragment: layer.fragments[where[0]], nodeId: where[1] } : null
    }
    const edit = fn => commit(w => updateLayer(w, layer.id, l => ({ ...l, fragments: fn(l.fragments) })))
    // Once a layer has been arranged, every fragment is pinned where it stands: an edit to
    // one never sends the others elsewhere. The first move pins them all. Each edit pins them
    // afresh, where they are drawn and at the size they are drawn (see placeFragments), so
    // gaps kept for a subtree that has grown are kept from here on as they now are.
    const arranged = action.type === 'move' || layer.fragments.some(f => f.pos)
    const pin = list => (arranged && action.places
      ? list.map(f => (action.places[f.id] ? { ...f, pos: action.places[f.id] } : f))
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
        // It shows the data view of the subtree it was dropped on, as do any leftover pieces.
        const merged = carryView(createFragment(result.fragment, into.source, '', rest[at].pos || null), into.dataView)
        rest.splice(at, 1, merged, ...result.leftovers.map(nodes => carryView(createFragment(nodes, into.source), into.dataView)))
        return rest
      })
      // Only worth saying when the result is not what the drop suggests.
      const left = result.leftovers.length
      if (left) setNotice(`${left} grafted piece${left === 1 ? '' : 's'} had no place in the merged tree, so ${left === 1 ? 'it was' : 'they were'} kept as separate subtree${left === 1 ? '' : 's'}.`)
    } else if (action.type === 'graft') {
      const moving = find(action.fragmentId)
      const target = at(action.nodeId)
      if (!moving || !target || target.fragment.id === moving.id) return
      const joined = graft(moving.nodes, target.fragment.nodes, target.nodeId, { onBranch: true })
      edit(prior => pin(prior).filter(f => f.id !== moving.id)
        .map(f => (f.id === target.fragment.id ? carryView(createFragment(joined, f.source, '', f.pos || null), f.dataView) : f)))
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
        // Both halves go on showing the data view the subtree showed.
        const clade = carryView(createFragment(pieces[1], target.fragment.source, '', placed ? action.cladePos : null), target.fragment.dataView)
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
  }, [layer, forest, commit, loadSource, comparePick, startCompare])

  // A subtree put somewhere with no size recorded yet (a piece just cut off, what is left
  // after a removal, a layer arranged before sizes were kept) takes the size it is drawn at
  // now, so from here on it pushes its neighbours as it grows. Not an edit: not undone.
  useEffect(() => {
    const boxes = layout?.fragmentBoxes
    if (!layer || !boxes || !layer.fragments.some(f => f.pos && f.pos.w === undefined && boxes.has(f.id))) return
    const sized = f => (f.pos && f.pos.w === undefined && boxes.has(f.id) ? { ...f, pos: { ...f.pos, w: boxes.get(f.id).w, h: boxes.get(f.id).h } } : f)
    patch(w => updateLayer(w, layer.id, l => ({ ...l, fragments: l.fragments.map(sized) })))
  }, [layer, layout, patch])

  const onLayerDrag = useCallback(event => {
    setLayerDrag(event.phase === 'end' ? null : { x: event.clientX, y: event.clientY, tool: event.tool, fragmentId: event.fragmentId, target: event.target, snapped: event.snapped })
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


  // The Nodes button: pressing it applies its state to what is showing; choosing a state
  // from its list selects it and applies it. Either way the view is refitted.
  const applyNodes = mode => {
    setNodeMode(mode)
    savePreference('nodeMode', mode)
    setHighlighted(mode === 'highlight-local' ? displayKey : '')
    if (!index || !view) return
    setView(applyNodeMode(index, view, mode, localPaths))
    setFitKey(k => k + 1)
    if (mode === 'select-local' && localPaths) {
      // The local genes and every branch between them: one connected piece, which a copy
      // takes as a single subtree. (Not a subtree layer's invisible root.)
      setPicked([...localPaths].filter(id => !index.nodes[id].virtual))
    }
  }

  // Pressing the Nodes button: Highlight local, while it lights this tree, turns off;
  // anything else applies the state selected.
  const highlighting = nodeMode === 'highlight-local' && highlighted === displayKey && Boolean(localPaths)
  const pressNodes = () => (highlighting ? setHighlighted('') : applyNodes(nodeMode))

  // The Data view button: in a layer it acts on the subtrees the picks touch, or on every
  // subtree; the Original has the one view. A view is a view setting: saved, not undone.
  const dataScope = useMemo(() => (layer ? viewScope(layer, forest?.fragmentOf, picked) : null), [layer, forest, picked])
  const dataValue = layer ? scopeView(layer, dataScope.ids) : dataView
  const dataScopeLabel = (() => {
    if (!layer) return ''
    const count = dataScope.ids.length
    if (!count) return 'No subtrees in this layer yet'
    if (dataScope.selected && count === 1) {
      const fragment = layer.fragments.find(f => f.id === dataScope.ids[0])
      const root = forest?.nodes.find(n => n.fragRoot === fragment?.id)
      return `Applies to ${root && index ? fragmentTitle(index, root.id, fragment) : 'the selected subtree'} (selected)`
    }
    if (dataScope.selected) return `Applies to the ${count} selected subtrees`
    return count === 1 ? 'Applies to the subtree in this layer' : `Applies to all ${count} subtrees · select subtrees to change only those`
  })()
  const chooseDataView = next => {
    if (!layer) { setDataView(next); return }
    patch(w => updateLayer(w, layer.id, l => withFragmentViews(l, dataScope.ids, next)))
  }

  // A face of the Cycle drum: a layer's tree (or the Original) fitted into the preview,
  // drawn with the view's own layout settings and folds.
  const paintPreview = useCallback((ctx, id, width, height) => {
    ctx.fillStyle = palette.bg
    ctx.fillRect(0, 0, width, height)
    const source = id === 'original' ? treeData : forestTree(ws.layers.find(l => l.id === id))
    if (!source?.nodes?.length || source.nodes.length < 2) return
    const idx = indexTree(source)
    const previewView = id === 'original' ? (origView || emptyViewState()) : (layerViews[id] || emptyViewState())
    const lay = layoutTree(idx, previewView, { layout: layoutName, phylogram, shape, alignLeaves, flipHorizontal: flipH })
    const cache = new Map()
    const b = contentBounds(ctx, idx, lay, cache)
    const pad = 18
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY)
    const k = Math.min((width - pad * 2) / bw, (height - pad * 2) / bh)
    const t = { k, kx: k, x: pad - b.minX * k + (width - pad * 2 - bw * k) / 2, y: pad - b.minY * k + (height - pad * 2 - bh * k) / 2 }
    paintTree(ctx, { layout: lay, index: idx, t, width, height, palette, links: source.links || {}, topbarAssemblies, genomeColors,
      labelCache: cache, noClear: true })
  }, [palette, treeData, ws.layers, origView, layerViews, layoutName, phylogram, shape, alignLeaves, flipH, topbarAssemblies, genomeColors])

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
    if (drag.tool === 'move') {
      return { title: name, detail: drag.snapped ? 'Lined up with the subtree beside it · hold ⌥ to place freely' : 'Release to put it here · Esc puts it back' }
    }
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
    if (tool === 'fold') {
      // Fold the tree down to the node clicked; a subtree's name tag stands for its root.
      const item = target.kind === 'fragment' ? layout?.items.find(i => i.node.fragRoot === target.fragmentId)
        : target.kind === 'node' ? target.item : null
      if (item) { setView(foldTo(index, view, item.id)); setFitKey(k => k + 1) }
      return
    }
    if (tool === 'expand') {
      // Open everything below the node clicked; a subtree's name tag stands for its root.
      const item = target.kind === 'fragment' ? layout?.items.find(i => i.node.fragRoot === target.fragmentId)
        : target.kind === 'node' ? target.item : null
      if (item && item.kind !== 'leaf') { setView(expandSubtree(index, view, item.id)); setFitKey(k => k + 1) }
      return
    }
    if (tool === 'flip') {
      // Flip mirrors the clade under a node, down to its leaves; a subtree's name tag stands for its root.
      const item = target.kind === 'fragment' ? layout?.items.find(i => i.node.fragRoot === target.fragmentId)
        : target.kind === 'node' ? target.item : null
      if (item?.kind === 'internal') setView(mirrorClade(index, view, item.id))
      return
    }
    if (target.kind === 'fragment') {
      // A subtree's name tag picks all of it; pressed again while it is all picked, it clears.
      const item = layout?.items.find(i => i.node.fragRoot === target.fragmentId)
      if (!item) return
      const whole = [item.id, ...descendants(index, item.id)]
      if (picked && whole.every(id => picked.has(id))) clearPicks()
      else setPicked(new Set(whole))
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
  }, [tool, layout, index, view, setView, picked, setPicked, clearPicks])

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
      // Lit while the whole subtree is picked (as its name tag's click picks it).
      const picking = Boolean(picked?.has(item.id)) && descendants(index, item.id).every(id => picked.has(id))
      // Compare: the subtree picked first, and the two being compared, say which side they are.
      const side = comparePicking === item.fragRoot ? '1' : comparing ? (comparing.a === item.fragRoot ? '1' : comparing.b === item.fragRoot ? '2' : '') : ''
      tags.set(item.fragRoot, { label: `${side ? `${side} · ` : ''}${fragmentTitle(index, item.id, fragment, true)}`, color: layer.color,
        lifted: layerDrag?.fragmentId === item.fragRoot, picked: picking, editing: naming === item.fragRoot })
    }
    return tags
  }, [layer, index, layerDrag?.fragmentId, picked, naming, comparePicking, comparing])
  // What the Rename tool's text box starts from: the subtree's own name, with its automatic
  // one (the clade's name, or its genes and species) shown when that is empty.
  const namingBox = (() => {
    const fragment = naming && layer?.fragments.find(f => f.id === naming)
    const root = fragment && forest?.nodes.find(n => n.fragRoot === naming)
    if (!root || !index) return null
    return { fragmentId: naming, initial: fragment.name || '', color: layer.color,
      placeholder: fragmentTitle(index, root.id, { ...fragment, name: '' }) }
  })()

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
      const group = neighbours?.matcher?.group(gene) || ''
      const shared = group ? neighbours?.rows?.get(group) || 0 : 0
      const centre = gene.id === entry.center
      const family = gene.families?.length ? neighbours?.families?.get(String(gene.families[0])) : null
      const style = { left: Math.min(hover.x + 14, window.innerWidth - 300), top: Math.min(hover.y + 14, window.innerHeight - 200) }
      const neighbourRows = [
        ['Gene', gene.id],
        ['Location', `${entry.chrom || '?'}:${gene.start.toLocaleString()}-${gene.end.toLocaleString()}`],
        ['Biotype', gene.biotype || 'protein_coding'],
        ['Genome', leafSpeciesLabel(node.leaf) || links[item.id]?.genome_name || ''],
      ]
      if (family) neighbourRows.push(['Family', `${family.name}${family.collection ? ` · ${family.collection}` : ''}`])
      else if (neighbours?.matcher?.by === 'family') neighbourRows.push(['Family', group.startsWith('f:') ? 'Not in your trees; matched by name' : 'Not in any of your trees'])
      if (entry.flipped) neighbourRows.push(['Shown', 'Flipped, so the tree’s gene points right'])
      return createPortal(
        <div className={`gt-tooltip${isLight ? ' light' : ''}`} style={style}>
          <strong>{gene.name || gene.id}</strong>
          <dl>{neighbourRows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <small>{centre ? 'The gene from the tree' : shared > 1 ? `${group.startsWith('f:') ? 'Its family is' : 'A gene with this name is'} in ${shared} rows` : 'Only in this row'}</small>
        </div>, document.body)
    }
    if (hover.hit.part === 'alignment') {
      // A place in an alignment column: which transcript, and what is there — an exon (how
      // many genes share its boundaries), a left-out intron, or a base.
      const { row, column: at, exon, cut } = hover.hit
      const where = at == null ? null : genomicAt(row, at)
      const alignRows = [
        ['Transcript', row.transcript_id],
        ['Genome', leafSpeciesLabel(node.leaf) || row.genome_name || row.assembly],
      ]
      let heading = `${row.gene_symbol || row.gene_id} · ${row.strand === '-' ? 'minus strand, shown 5′→3′' : 'plus strand'}`
      if (cut) {
        heading = `Intron · ${cut.bp.toLocaleString()} bp`
        alignRows.push(['Location', `${row.chrom}:${Number(cut.start - (row.region?.intron_edge || 0)).toLocaleString()}-${Number(cut.end + (row.region?.intron_edge || 0)).toLocaleString()}`])
        alignRows.push(['Aligned', `${row.region?.intron_edge || 0} bases at each end; ${cut.removed.toLocaleString()} left out`])
      } else {
        if (exon) {
          const coding = featuresAt(row, exon.start).some(f => f.type === 'cds') || featuresAt(row, exon.end).some(f => f.type === 'cds')
          alignRows.push(['Exon', `${exon.index + 1} of ${hover.hit.exonCount}${coding ? '' : ' · non-coding'}`])
          const others = hover.hit.rows - 1
          const shares = [['5′ boundary', exon.index > 0 ? hover.hit.shared.start : null], ['3′ boundary', exon.index < hover.hit.exonCount - 1 ? hover.hit.shared.end : null]]
          for (const [label, n] of shares) {
            if (n == null) continue
            alignRows.push([label, n ? `Lines up with ${n} of ${others} other gene${others === 1 ? '' : 's'}` : 'Not shared at this aligned position'])
          }
          const exonShare = column?.rowShare?.(row, exon.start, exon.end + 1)
          if (exonShare != null) alignRows.push(['Exon agreement', `This gene’s bases across it are shared by ${Math.round(exonShare * 100)}% of the genes, on average`])
        }
        const found = featuresAt(row, at).map(f => f.type).filter(type => FEATURE_WORDS[type])
        const what = found.length ? FEATURE_WORDS[found[found.length - 1]] : where ? (where.kind.startsWith('flank') ? 'Flank' : 'Intron') : null
        alignRows.push(['Column', `${(at + 1).toLocaleString()} of ${(alignment.data?.length || 0).toLocaleString()}`])
        alignRows.push(['Here', where ? `${where.chrom}:${where.position.toLocaleString()} · ${where.base} · ${what}` : 'A gap: other genes have sequence here'])
        const shared = where ? column?.baseShare?.(row, at) : null
        if (where) alignRows.push(['Shared by', shared ? `${shared.count} of the ${shared.present} genes with a base here have ${where.base}` : 'Too few genes have a base here to compare'])
      }
      alignRows.push(['Identity', `${Math.round(row.identity || 0)}% to the consensus`])
      const style = { left: Math.min(hover.x + 14, window.innerWidth - 300), top: Math.min(hover.y + 14, window.innerHeight - 200) }
      return createPortal(
        <div className={`gt-tooltip${isLight ? ' light' : ''}`} style={style}>
          <strong>{heading}</strong>
          <dl>{alignRows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <small>Click anywhere on the alignment for its details; zoom over it to stretch it, pan left and right to move along it</small>
        </div>, document.body)
    }
    if (node.leaf) {
      const leaf = node.leaf
      title = leafSpeciesLabel(leaf) || leafGeneLabel(leaf)
      if (leaf.common_name && leaf.species) rows.push(['Species', leaf.species])
      const link = links[item.id]
      // What the tree file says, filled in from the local annotation where it says nothing.
      const symbol = leaf.symbol || link?.gene?.name
      const geneId = leaf.gene_id || link?.gene?.id
      if (symbol) rows.push(['Symbol', symbol])
      if (geneId) rows.push(['Gene', geneId])
      if (leaf.protein_id) rows.push(['Protein', leaf.protein_id])
      if (!geneId && !leaf.protein_id && leaf.label) rows.push(['Label', leaf.label])
      if (link?.gene?.chrom) rows.push(['Location', `${link.gene.chrom}:${Number(link.gene.start).toLocaleString()}-${Number(link.gene.end).toLocaleString()}`])
      else if (leaf.location) rows.push(['Location', leaf.location])
      if (node.branch_length != null) rows.push(['Branch length', Number(node.branch_length).toPrecision(3)])
      rows.push(['Local', link?.status === 'linked' ? `${link.genome_name || link.assembly}${link.matched_by === 'symbol' ? ' (matched by symbol)' : ''}` : statusText(link, linkStatus(link, topbarAssemblies), leaf)])
    } else {
      title = cladeTitle(index, item.id)
      if (node.taxon?.common_name) rows.push(['Common name', node.taxon.common_name])
      if (node.taxon?.mya) rows.push(['Age', `~${node.taxon.mya} million years`])
      if (node.event) rows.push(['Event', `${EVENT_LABELS[node.event] || node.event}${node.event_inferred ? ' (inferred)' : ''}`])
      rows.push(['Genes', index.leafCount[item.id].toLocaleString()])
      // The user's genomes in this clade, as the chips on a folded clade's label show them.
      const held = cladeGenomes(index, item.id, links, topbarAssemblies)
      if (held.length) {
        const named = held.slice(0, 6).map(g => `${g.link?.genome_name || g.assembly} (${g.count.toLocaleString()})`)
        rows.push(['Local genes', named.join(' · ') + (held.length > 6 ? ` · +${held.length - 6} more` : '')])
      }
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
          <input ref={searchInput} type="search" value={search} placeholder="Find a tree by gene or ID" title="Search by gene symbol, gene or protein ID, or tree ID" aria-label="Find trees"
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
        <button type="button" onClick={() => setDialog({ kind: 'library' })}>Library</button>
        <button type="button" onClick={() => setDialog({ kind: 'load' })}>Load trees</button>
        <ToolButton tool={activeTool} onTool={setTool} inLayer={Boolean(layer)} isLight={isLight} />
        <NodesButton mode={nodeMode} highlighting={highlighting} onMode={applyNodes} onPress={pressNodes} hasLocal={Boolean(localPaths)} isLight={isLight} />
        <DataViewMenu value={dataValue} onChange={chooseDataView} scope={dataScopeLabel} isLight={isLight} views={[
          { id: 'neighbourhood', label: 'Neighbourhood', hint: `The genes next to each gene you have locally · ${flank} each side`,
            disabled: shape === 'radial', note: 'Data views are shown in the linear layout', options: neighbourOptions },
          { id: 'structure', label: 'Transcript structure', hint: 'Each local gene’s transcript, aligned so exons line up',
            disabled: shape === 'radial', note: 'Data views are shown in the linear layout', options: structureOptions },
          { id: 'sequence', label: 'Aligned sequence', hint: 'The same alignment, base by base, coloured by feature',
            disabled: shape === 'radial', note: 'Data views are shown in the linear layout', options: sequenceOptions },
        ]} />
        <span className="gt-spacer" />
        <TreeCycle entries={allLayers} active={layer ? layer.id : 'original'} onChoose={switchDisplay} paint={paintPreview} isLight={isLight} />
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
      {showStructure && display ? (() => {
        const { status, plan, job, error, genes } = alignment
        const est = plan?.estimate
        const failedCount = plan?.failed?.length || 0
        const unusable = failedCount ? ` ${failedCount} linked gene${failedCount === 1 ? '' : 's'} can't be drawn (see the Legend).` : ''
        if (status === 'too-few') {
          return <div className="gt-notice gt-align-bar"><span>Aligning needs at least two genes linked to your local genomes{genes ? ` (this tree has ${genes})` : ''}.</span></div>
        }
        if (status === 'planning' || status === 'loading') {
          return <div className="gt-notice gt-align-bar"><span className="gt-spinner" aria-hidden="true" /><span>{status === 'planning' ? `Looking for a stored alignment of ${genes} genes…` : 'Loading the alignment…'}</span></div>
        }
        if (status === 'error') {
          return <div className="gt-notice error gt-align-bar"><span>{error}</span><button type="button" onClick={alignment.retry}>Try again</button></div>
        }
        if (status === 'running') {
          const percent = Math.round((job?.fraction || 0) * 100)
          const phase = ALIGN_PHASES[job?.phase] || 'Aligning'
          const detail = job?.phase === 'extracting' && job.total ? `${job.done} of ${job.total} genes`
            : job?.phase === 'aligning' && job.stage && MAFFT_STAGES[job.stage]
              ? `${MAFFT_STAGES[job.stage]}${job.passes > 1 ? ` (pass ${job.pass} of ${job.passes})` : ''}${job.total ? ` · ${job.done} of ${job.total}` : ''}` : ''
          const elapsed = job?.started ? Math.round(Date.now() / 1000 - job.started) : 0
          return (
            <div className="gt-job gt-align-bar" role="status">
              <div className="gt-job-text">
                <strong>{phase} · {est?.rows ?? plan?.rows?.length ?? genes} genes</strong>
                <span>{[detail, `${percent}%`, elapsed > 2 ? `${elapsed} s` : ''].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="gt-progress" aria-hidden="true"><div style={{ width: `${Math.max(2, percent)}%` }} /></div>
              <button type="button" onClick={alignment.cancel}>Cancel</button>
            </div>
          )
        }
        if (status === 'needs-run' && est) {
          const big = est.level !== 'ok'
          return (
            <div className={`gt-notice gt-align-bar${big ? ' warn' : ''}`}>
              <span>
                No stored alignment of these {est.rows} transcripts ({kb(est.total_bp)}{alignOpts.region === 'exons' ? ', exons' : ', whole genes'}). Aligning takes {aboutSeconds(est.seconds)}.
                {big ? ` That's a lot of sequence${est.max_bp > 50_000 ? ` (the longest is ${kb(est.max_bp)})` : ''}: it could take much longer${alignOpts.region === 'genomic' ? '. Aligning exons only is far quicker' : ''}, or align a subtree in a layer.` : ''}
                {unusable}
              </span>
              <button type="button" className="primary" onClick={alignment.run}>Run alignment</button>
            </div>
          )
        }
        return null
      })() : null}
      {notice ? <div className="gt-notice"><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss">×</button></div> : null}
      {error ? <div className="gt-notice error"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss">×</button></div> : null}

      <div className="gt-body">
        <div className="gt-main">
        <div className={`gt-stage${focusLeafData ? ' has-focus-bar' : ''}`} data-screenshot-capture="view">
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
            {focusStatus === 'local' ? <button type="button" className="gt-focus-add" onClick={() => addGenome(focusLink.assembly)}
              title={`Add ${focusLink.genome_name || focusLink.assembly} to the top bar`}>Add genome to the top bar</button> : null}
            {treeChoices.length > 1 ? <TreePicker choices={treeChoices} onPick={pickTree} isLight={isLight} /> : null}
            <button type="button" className="gt-unfocus" onClick={clearFocus} title="Clear the gene of focus" aria-label="Clear the gene of focus">✕</button>
          </div>
        ) : null}
          {layer && !layer.fragments.length ? (
            <div className="gt-empty">
              <h2>{layer.name} is empty</h2>
              <p>Go back to a tree (the Original in the Layers list, or Cycle), select parts of it with <strong>Free select</strong> or <strong>Clade select</strong>, and drag them here, or use <strong>Copy to layer</strong>.</p>
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
              lit={highlighting ? localPaths : null}
              controls={controls}
              fitKey={`${fitKey}:${layoutName}:${phylogram}:${shape}`}
              focusRowId={focusLeaf}
              onNodeClick={onNodeClick}
              onHover={onCanvasHover}
              onColumnClick={onColumnClick}
              genomeColors={genomeColors}
              ariaLabel={`Gene tree ${layer ? layer.name : treeData?.name || ''}`}
              tool={activeTool}
              onLayerAction={onLayerAction}
              insetTop={(layer ? LAYER_BAR_INSET + (compareBar ? COMPARE_ROW_H : 0) : 0) + (focusLeafData ? FOCUS_BAR_H : 0)}
              column={column}
              onLayerDrag={onLayerDrag}
              canMerge={mergeVerdict}
              picked={picked}
              fragmentTags={fragmentTags}
              naming={namingBox}
              compare={compareModel}
              comparePick={comparePicking ? 2 : 1}
              onNamed={(fragmentId, name) => { setNaming(null); if (name !== null) renameFragment(fragmentId, name) }}
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
                    <button type="button" className="primary" onClick={() => setDialog({ kind: 'load' })}>Load trees</button>
                    {collections.length ? <button type="button" onClick={() => setDialog({ kind: 'library' })}>Open the library</button> : null}
                  </div>
                </>
              )}
            </div>
          )}
          {loading && treeData ? <div className="gt-loading">Opening…</div> : null}
          {layer && layout ? (
            <LayerBar layer={layer} tool={activeTool} onTool={setTool} radial={shape === 'radial'} isLight={isLight}
              arranged={layer.fragments.some(f => f.pos) && !comparing?.facing} onRestack={restack}
              subtrees={layer.fragments.length} comparing={Boolean(comparing)} onCompare={pressCompare} compare={compareBar}
              canUndo={canUndo} canRedo={canRedo} onUndo={() => undo(false)} onRedo={() => undo(true)} />
          ) : null}
          {picked ? (
            <SelectionBar genes={pickCounts.genes} pieces={pickCounts.pieces} layers={allLayers} activeId={layer ? layer.id : 'original'}
              inLayer={Boolean(layer)} onCopy={copyPicks} onDuplicate={() => layer && copyPicks(layer.id)}
              onClear={clearPicks} isLight={isLight} />
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
                onEdit={id => setDialog({ kind: 'layer', layerId: id })}
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
                {summary.genome ? <><br /><Glyph kind="genome" /> {summary.genome} in a local species, but not in its annotation</> : null}
                {summary.no_index ? <><br /><Glyph kind="no_index" /> {summary.no_index} in a local species whose annotation is not indexed</> : null}
                {treeData?.links_pending ? <><br /><span className="gt-muted">Checking protein identifiers…</span></> : null}
              </p>}
              <div className="gt-row">
                {!layer && collection ? <button type="button" onClick={() => setDialog({ kind: 'links', collection })}>Link genomes…</button> : null}
                {!layer && collection ? <button type="button" onClick={() => setDialog({ kind: 'details', collection })}>Details</button> : null}
                <button type="button" onClick={() => (layer ? exportNodes(layer.name, layer.fragments.map(f => f.nodes)) : exportTree('newick'))}>Export</button>
                {!layer ? <button type="button" onClick={resetTree} disabled={!treeData}
                  title="Undo folds and flips, and go back to the tree as it first opened">Reset tree</button> : null}
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
            </Section>

            <Section title="Legend">
              <h4 className="gt-legend-heading">Nodes</h4>
              <ul className="gt-key">
                <li><Glyph kind="speciation" />Speciation</li>
                <li><Glyph kind="duplication" />Gene duplication</li>
                <li><Glyph kind="gene_split" />Gene split</li>
                <li><Glyph kind="dubious" />Ambiguous</li>
                <li><Glyph kind="collapsed" />Folded clade, with its gene count</li>
                <li><Glyph kind="collapsed_topbar" />Folded clade with genes in a top-bar genome</li>
                <li><Glyph kind="collapsed_local" />Folded clade with genes only in other local genomes</li>
              </ul>
              <h4 className="gt-legend-heading">Genes</h4>
              <ul className="gt-key">
                <li><Glyph kind="focus" />Focus gene</li>
                <li><KeyPill color={genomeColors.values().next().value} state="active" isLight={isLight} />In a genome in the top bar, in its colour</li>
                <li><KeyPill color={genomeColors.values().next().value} state="inactive" isLight={isLight} />In a local genome not in the top bar</li>
                <li><Glyph kind="genome" />Local species, gene not in its annotation</li>
                <li><Glyph kind="no_index" />Local species, annotation not indexed</li>
                <li><Glyph kind="unresolved" />Not local</li>
              </ul>
              {showNeighbourhoods ? <h4 className="gt-legend-heading">Neighbourhood</h4> : null}
              {showNeighbourhoods ? (
                <ul className="gt-key">
                  <li><i className="gt-key-arrow centre" />The gene from the tree</li>
                  <li><i className="gt-key-arrow" />{neighbourOpts.colour === 'plain' ? 'A nearby gene' : 'Any other nearby gene'}</li>
                  {neighbourOpts.colour === 'top' && neighbours?.order?.length ? neighbours.order.slice(0, neighbours.colours.size).map(group => (
                    <li key={group}><i className="gt-key-arrow" style={{ background: neighbours.colours.get(group) }} />{groupName(group, neighbours)} · {neighbours.rows.get(group)} rows</li>
                  )) : null}
                  {neighbourOpts.colour === 'all' ? <li><span className="gt-key-swatches">{[...neighbours?.colours?.values() || []].slice(0, 4).map((c, i) => <i key={i} style={{ background: c }} />)}</span>Found in more than one row</li> : null}
                  {neighbourOpts.links === 'on' ? <>
                    {neighbourOpts.match === 'family' ? <li><i className="gt-key-link" />Same gene family</li> : null}
                    <li><i className="gt-key-link symbol" />Same name</li>
                  </> : null}
                </ul>
              ) : null}
              {showStructure ? <h4 className="gt-legend-heading">{showStructureModel && showSequence ? 'Transcript structure and sequence' : showSequence ? 'Aligned sequence' : 'Transcript structure'}</h4> : null}
              {showStructure && column?.conservation ? (
                <div className="gt-heat-key">
                  <div className="gt-heat-bar" style={{ background: `linear-gradient(to right, ${column.conservation.ramp.join(', ')})` }} />
                  <div className="gt-heat-ends"><span>0%</span><span>50%</span><span>100%</span></div>
                  <p className="gt-muted">Each base by the share of genes with the same base in its column: where five of six agree, their bases are 5/6 and the odd one out 1/6. Zoomed out, and along the structures, a gene’s bases are averaged, so a gene that differs where others agree reads cooler there. Observed agreement, not a constraint score. Grey: too few genes to compare.</p>
                </div>
              ) : null}
              {showSequence && !column?.conservation ? (
                <ul className="gt-key">
                  <li><i className="gt-key-exon cds-stripes" />Coding (CDS), a shade a codon</li>
                  <li><i className="gt-key-exon utr" />Untranslated (UTR)</li>
                  <li><i className="gt-key-exon intron" />Intron</li>
                  <li><i className="gt-key-exon splice" />Splice site</li>
                  <li><i className="gt-key-exon start" />Start codon <i className="gt-key-exon stop" />Stop</li>
                  {alignOpts.differences ? <li><i className="gt-key-exon faded" />Agrees with the consensus</li> : null}
                </ul>
              ) : null}
              {showStructure ? (
                <>
                  <ul className="gt-key" hidden={!showStructureModel}>
                    {column?.conservation ? <li><i className="gt-key-box coding" style={{ background: column.conservation.ramp[column.conservation.ramp.length - 1] }} />Exons filled by agreement; non-coding (UTR) paler</li> : <>
                      <li><i className="gt-key-box coding" />Coding exon</li>
                      <li><i className="gt-key-box" />Non-coding (UTR)</li>
                    </>}
                    <li><i className="gt-key-exon line" />Intron, drawn to scale up to {INTRON_CAP_BP} bp; longer ones are labelled with their length</li>
                    <li><i className="gt-key-exon dotted" />Flank beyond the transcript</li>
                    <li><i className="gt-key-exon gap" />A gap in an exon: bases other genes have there</li>
                    {alignOpts.boundaries !== false ? <li><i className="gt-key-box coding shared" />Splice boundary other genes share, on the alignment</li> : null}
                    <li><i className="gt-key-box lit" />Hovered exon, and exons sharing its boundaries</li>
                  </ul>
                  {alignment.data ? (
                    <p className="gt-muted gt-align-note">
                      {alignment.data.transcripts} transcripts, {alignment.data.length.toLocaleString()} alignment columns
                      {alignment.data.strategy ? ` · MAFFT ${alignment.data.strategy}` : ''}. Shown 5′→3′, minus-strand genes turned round.
                    </p>
                  ) : null}
                  {alignment.plan?.failed?.length ? (
                    <details className="gt-align-failed">
                      <summary>{alignment.plan.failed.length} linked gene{alignment.plan.failed.length === 1 ? '' : 's'} not drawn</summary>
                      <ul>{alignment.plan.failed.map(f => <li key={f.gene}><strong>{f.gene.split(':').slice(1).join(':')}</strong> {f.reason}</li>)}</ul>
                    </details>
                  ) : null}
                </>
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

      {dialog?.kind === 'layer' && ws.layers.some(l => l.id === dialog.layerId) ? (
        <LayerEditDialog layer={ws.layers.find(l => l.id === dialog.layerId)} theme={theme} palette={genomeColorPalette(config)}
          onColor={color => commit(w => updateLayer(w, dialog.layerId, l => ({ ...l, color })))}
          onRename={name => commit(w => updateLayer(w, dialog.layerId, l => ({ ...l, name })))}
          onClose={() => setDialog(null)} />
      ) : null}
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

