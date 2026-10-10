import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import { FONT_MONO } from './utils/typography'
import { consumeRestoredSessionState, endSessionRestore, peekRestoredSessionState, registerSessionState } from './sessionResume.js'
import { useResumableState } from './hooks/useResumableState.js'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught an error:", error, info);
    this.setState({ info });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', background: 'red', color: 'white', whiteSpace: 'pre-wrap', zIndex: 9999, position: 'relative' }}>
          <h2>React Crash!</h2>
          <details style={{ whiteSpace: 'pre-wrap' }}>
            {this.state.error && this.state.error.toString()}
            <br />
            {this.state.info && this.state.info.componentStack}
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

import './App.css'
import useHomologyWorkspace from './components/homology/useHomologyWorkspace'
const AlignmentExplorerView = React.lazy(() => import('./components/alignment-explorer/AlignmentExplorerView'))
const SequenceView = React.lazy(() => import('./components/sequence-view/SequenceView'))
const GeneTreesView = React.lazy(() => import('./components/gene-trees/GeneTreesView'))
import { useTutorialHost } from './hooks/useTutorial'
import { resetTutorialWorkspace } from './tutorials/demoGenomeApi'
import { isTutorialSandboxActive, withoutTutorialSandboxFields } from './tutorials/sandbox'
import { PILLS_ROW_HEIGHT } from './components/SelectedSpeciesPillsBar'
import { getDownloadTasksSnapshot, subscribeDownloadTasks } from './utils/downloadTasksStore'
import { cycleSelection } from './utils/genomeWheel'
import {
  APP_BUTTON_META,
  DEFAULT_ACTIVE_APP_BUTTONS,
  TOP_BAR_COLUMN_STRIDE_PX,
  buildAppButtonLayout,
  isRearrangedFromDefault,
  normalizeActiveAppButtons,
} from './appButtonConfig'
import {
  loadAchievements,
  refreshAchievements,
  registerAchievementReconciler,
  setAchievementsContext,
  startAchievements,
  trackAchievement,
} from './achievements/tracker.js'
import {
  API_BASE,
  fetchBackendRuntimeStatus,
  getInitialBackendRuntime,
  retryBackendCheck,
  retryBackendLaunch,
  subscribeToBackendRuntime,
} from './backendRuntime'
import {
  DEFAULT_GENOME_COLOR,
  genomeColorResolver,
  normalizeCustomGenomeColors,
  normalizeGenomeColorAssignments,
  normalizeGenomeDefaultColor,
} from './genomeColorSchemes'
import { DEFAULT_BROWSING_CONTROL_SCHEME_ID } from './utils/browsingControls'
import {
  buildDefaultScreenshotName,
  buildDomNodeScreenshotSnapshot,
  measureScreenshotNode,
  subtreeContainsCanvas,
} from './utils/screenshotExport'
import {
  genomeKeysMatch,
  normalizeGenomeRecord,
  getAssemblyAccession,
  getAssemblyGenomeKey,
  normalizeGenomeProvider,
  MANUAL_PROVIDER,
} from './utils/genomeIdentity'
import {
  primaryGenomeForIndex,
  shouldAutoEnsurePrimaryIndex,
} from './utils/genomeIndexingPolicy'
import {
  basenameFromPath,
  buildGenomeLabel,
  buildGenomePillLabel,
  dedupeSpeciesList,
  dirnameFromPath,
  getViewActiveCapacity,
  reorderWithInsertPosition,
  sameStringArrayItems,
  speciesItemKey,
  speciesListsEqualByKey,
} from './app/genomeLists.js'
import { geneFocusSignature, mergeGeneFocus, updateGeneFocusMapEntry } from './app/geneFocus.js'
import {
  NEIGHBOURHOOD_FLANK_WINDOW_SIZE,
  SV_NO_ANCHOR_KEY,
  buildNeighbourhoodPairKey,
  mergeNeighbourhoodTrack,
} from './app/viewSpecies.js'
import {
  CONFIG_SAVE_NAV_WAIT_MS,
  PREVIOUS_SESSION_PLAYLIST_ID,
  SELECTOR_REFRESH_EVENT,
  holdScrollTop,
  readPendingSelectorGenomeIds,
  writePendingSelectorGenomeIds,
} from './app/appLayout.js'
import {
  buildPreviousSessionGenomes,
  isNextPreviousSessionPlaylist,
  isPreviousSessionPlaylist,
  withNextPreviousSessionGenomes,
} from './app/previousSessionPlaylist.js'
import { renderAppLayout } from './components/app-shell/AppLayout.jsx'
import { loadAppConfig } from './app/configLoading.js'
import { applyAppConfigCascade } from './app/configLoading.js'
import { runMultipleAlignment } from './app/featureAlignment.js'
import { resolveAlignmentInputs } from './app/featureAlignment.js'
import { changeAlignmentRowSetting } from './app/featureAlignment.js'
import { buildPairwiseOverlay } from './app/featureAlignment.js'
import { computeAlignmentDisplayRows } from './app/featureAlignment.js'
import { toggleSpeciesPill } from './app/genomeSelection.js'
import { changeStructuralVariationGenomeOrder } from './app/genomeSelection.js'
import { toggleStructuralVariationPill } from './app/genomeSelection.js'
import { applySelectorConfigChange } from './app/genomeSelection.js'
import { selectNeighbourhoodLink } from './app/neighbourhoodActions.js'
import { seedNeighbourhoodFromHomologyHit } from './app/neighbourhoodActions.js'
import { watchDownloadTasks } from './app/appEffects.js'
import { syncReferenceGeneFocus } from './app/appEffects.js'
import { restoreFocusFromSession } from './app/appEffects.js'
import { saveFallbackScreenshot } from './app/screenshots.js'
import { loadAlignmentWorkspace } from './app/featureAlignment.js'
import { saveAlignmentWorkspace } from './app/featureAlignment.js'
import { reorderSpeciesPills } from './app/genomeSelection.js'
import { loadPairLinks } from './app/neighbourhoodActions.js'
import { syncTargetGeneFocus } from './app/appEffects.js'

// The genome pills strip's padding, and the height that falls out of it. Kept in one
// place because two things depend on it: the strip's own style below, and the app
// organiser's drawer, whose header band is drawn to this height so that it lands exactly
// on the strip — same width, same top, same bottom.
const PILLS_STRIP_PADDING_TOP = 8
const PILLS_STRIP_PADDING_BOTTOM = 2
const PILLS_STRIP_PADDING_X = 8
const PILLS_STRIP_BORDER = 1
const PILLS_STRIP_HEIGHT =
  PILLS_ROW_HEIGHT + PILLS_STRIP_PADDING_TOP + PILLS_STRIP_PADDING_BOTTOM + PILLS_STRIP_BORDER

function FpsCounter() {
  const [fps, setFps] = useState(0)
  const frameTimesRef = useRef([])
  const rafRef = useRef(null)
  useEffect(() => {
    let active = true
    const tick = (now) => {
      if (!active) return
      const times = frameTimesRef.current
      times.push(now)
      while (times.length > 0 && now - times[0] > 1000) times.shift()
      setFps(times.length)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { active = false; if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])
  const color = fps >= 50 ? '#4ade80' : fps >= 30 ? '#fbbf24' : '#f87171'
  return (
    <div style={{
      position: 'fixed', top: 6, left: 6, zIndex: 9999,
      padding: '2px 7px', borderRadius: 4,
      background: 'rgba(0,0,0,0.72)', color,
      fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700,
      lineHeight: 1.5, pointerEvents: 'none', userSelect: 'none',
    }}>
      {fps} fps
    </div>
  )
}

function App() {
  const [backendRuntime, setBackendRuntime] = useState(() => getInitialBackendRuntime())
  const [backendSetupOpen, setBackendSetupOpen] = useState(false)
  const [alignment, setAlignment] = useState(null)
  const [alignmentOverlay, setAlignmentOverlay] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [recentItems, setRecentItems] = useState([])

  // Display options
  const [collapseIntrons, setCollapseIntrons] = useState(false)
  const [collapseSource, setCollapseSource] = useState('')
  const [refFlankBp, setRefFlankBp] = useState(100)
  const [tgtFlankBp, setTgtFlankBp] = useState(100)
  const [flankLocked, setFlankLocked] = useState(true)

  // Dual input state
  const [refInput, setRefInput] = useState('')
  const [tgtInput, setTgtInput] = useState('')
  const [refResolved, setRefResolved] = useState(null)   // { gene, transcripts, selectedTranscriptId, resolvedType }
  const [tgtResolved, setTgtResolved] = useState(null)
  const [refLoading, setRefLoading] = useState(false)
  const [tgtLoading, setTgtLoading] = useState(false)
  const [refError, setRefError] = useState(null)
  const [tgtError, setTgtError] = useState(null)

  // Genes selected in the genome browser (shared across views). Every view that
  // follows the gene of focus reads these, so they come back after a reload even
  // when the browser itself is not on screen to put its panels' focus back.
  const resumedFocus = useMemo(() => {
    const saved = peekRestoredSessionState('app.focus')
    return saved && typeof saved === 'object' ? saved : null
  }, [])
  const isGeneFocus = (gene) => Boolean(gene && typeof gene === 'object' && gene.id)
  const [browserRefGene, setBrowserRefGene] = useState(() => (isGeneFocus(resumedFocus?.ref) ? resumedFocus.ref : null))
  const [browserTgtGene, setBrowserTgtGene] = useState(() => (isGeneFocus(resumedFocus?.tgt) ? resumedFocus.tgt : null))
  const [browserGeneEntry, setBrowserGeneEntry] = useState(null)
  const handleBrowserGeneEntryConsumed = useCallback((entry) => {
    setBrowserGeneEntry((current) => current === entry ? null : current)
  }, [])
  const [browserRefViewport, commitBrowserRefViewport] = useState(null)
  // The browser reports its primary viewport on every frame of a pan, but only
  // the Structural Variation view reads it, and that view is not mounted while
  // the browser is on screen. Re-rendering all of App per frame bought nothing,
  // so reports land once the viewport has been still briefly. Clearing goes
  // through immediately and cancels a report still waiting to land.
  const browserRefViewportTimerRef = useRef(null)
  const setBrowserRefViewport = useCallback((viewport) => {
    window.clearTimeout(browserRefViewportTimerRef.current)
    browserRefViewportTimerRef.current = null
    commitBrowserRefViewport(viewport)
  }, [])
  const reportBrowserRefViewport = useCallback((viewport) => {
    window.clearTimeout(browserRefViewportTimerRef.current)
    browserRefViewportTimerRef.current = window.setTimeout(() => {
      browserRefViewportTimerRef.current = null
      commitBrowserRefViewport(viewport)
    }, 150)
  }, [])
  useEffect(() => () => window.clearTimeout(browserRefViewportTimerRef.current), [])
  const refResolveInFlightQueryRef = useRef('')
  const tgtResolveInFlightQueryRef = useRef('')
  const refLastResolvedQueryRef = useRef('')
  const tgtLastResolvedQueryRef = useRef('')

  // Snapshot of last-saved config for change detection
  const savedConfigRef = useRef(null)
  const persistedActiveButtonsRef = useRef('')
  const persistActiveButtonsTimerRef = useRef(null)
  const persistedGenomeColorsRef = useRef('')
  const persistGenomeColorsTimerRef = useRef(null)
  const persistConfigurationTimerRef = useRef(null)
  // The save started by leaving the configuration view, while it is still in flight, so
  // that a second view button pressed in the same moment joins it instead of starting
  // another one.
  const configSaveOnLeaveRef = useRef(null)
  const appOrganiserButtonRef = useRef(null)
  const appOrganiserPanelRef = useRef(null)
  const topBarScrollRef = useRef(null)
  const organiserScrollRef = useRef(null)
  const scrollLinkGuardRef = useRef(false)
  const selectorRefreshCompletedTaskIdsRef = useRef(new Set())

  // Whether initial config has been loaded from backend
  const [configLoaded, setConfigLoaded] = useState(false)

  // Incrementing keys to trigger selective browser track reloads
  const [refBrowserReloadKey, setRefBrowserReloadKey] = useState(0)
  const [tgtBrowserReloadKey, setTgtBrowserReloadKey] = useState(0)

  // Theme: 'dark' (default) or 'light'
  const [theme, setTheme] = useState('dark')
  const [screenshotMode, setScreenshotMode] = useState(false)
  const [genomePlaylistPopoverOpen, setGenomePlaylistPopoverOpen] = useState(false)
  const [genomePlaylistPopoverPosition, setGenomePlaylistPopoverPosition] = useState({ top: 0, right: 0 })
  const [appOrganiserOpen, setAppOrganiserOpen] = useState(false)
  const [topBarScroll, setTopBarScroll] = useState({ canLeft: false, canRight: false })
  const [applyingGenomePlaylistId, setApplyingGenomePlaylistId] = useState('')
  const [screenshotAvailabilityByView, setScreenshotAvailabilityByView] = useState({})
  const [selectedFallbackScreenshotTarget, setSelectedFallbackScreenshotTarget] = useState(null)
  const [mainContentNode, setMainContentNode] = useState(null)
  const [activeViewContentNode, setActiveViewContentNode] = useState(null)
  const screenshotActionButtonRef = useRef(null)
  const genomePlaylistActionButtonRef = useRef(null)
  const genomePlaylistPopoverRef = useRef(null)
  const fallbackScreenshotOverlayRef = useMemo(
    () => ({ current: mainContentNode }),
    [mainContentNode]
  )

  // Navigation: which view is active. A reload within the same launch puts the reader
  // back in the view they were in (see sessionResume.js); a fresh launch starts on Home.
  const [currentView, setCurrentViewState] = useState(() => {
    const saved = peekRestoredSessionState('app.view')
    return typeof saved === 'string' && saved ? saved : 'home'
  })
  // Every view shares the one scrolling page, so switching used to land the next view
  // wherever the last one had been scrolled to. A view now opens at the top, except the
  // genome browser, which stays mounted while hidden and goes back to where it was. Its
  // offset is read once, on the way out, not tracked while the reader scrolls.
  const mainContentNodeRef = useRef(null)
  mainContentNodeRef.current = mainContentNode
  const currentViewRef = useRef(currentView)
  currentViewRef.current = currentView
  const scrollTopByViewRef = useRef({})
  const setCurrentView = useCallback((nextView) => {
    const node = mainContentNodeRef.current
    if (node) scrollTopByViewRef.current[currentViewRef.current] = node.scrollTop
    setCurrentViewState(nextView)
  }, [])
  const scrolledForViewRef = useRef(currentView)
  useLayoutEffect(() => {
    if (scrolledForViewRef.current === currentView) return undefined
    scrolledForViewRef.current = currentView
    if (!mainContentNode) return undefined
    const target = currentView === 'genome_browser' ? (scrollTopByViewRef.current.genome_browser || 0) : 0
    mainContentNode.scrollTop = target
    // The browser's panels can come back shorter for a moment than they were.
    return target > 0 ? holdScrollTop(mainContentNode, target, { settleMs: 300, maxMs: 2000 }) : undefined
  }, [currentView, mainContentNode])
  // What the sequence view should open on when another view hands off to it. A
  // fresh object each time, so asking for the same gene twice still arrives as a
  // new request -- the same contract as browserLocationFocusByGenome.
  const [sequenceViewEntry, setSequenceViewEntry] = useState(null)
  const [explorerIncoming, setExplorerIncoming] = useState(null)
  // A gene another view wants shown in its gene trees: { geneId, assembly, label }.
  const [geneTreesIncoming, setGeneTreesIncoming] = useState(null)
  const [gettingStartedOutputDirDismissed, setGettingStartedOutputDirDismissed] = useState(false)
  const [outputDirNotification, setOutputDirNotification] = useState('')
  const previousViewRef = useRef('home')
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  const [draggedTopButtonId, setDraggedTopButtonId] = useState('')
  const [dragOverTopButtonId, setDragOverTopButtonId] = useState('')
  const [dragTopInsertPosition, setDragTopInsertPosition] = useState('before')
  const topBarDragMovedRef = useRef(false)

  // Alignment Action state (Run vs Load)
  const [alignmentAction, setAlignmentAction] = useState('Run')

  // Tracks the exact params of the alignment currently displayed so we can disable
  // the button when nothing has changed since the last run.
  const [loadedParams, setLoadedParams] = useState(null)

  // Multi-genome alignment state
  const [alignmentInputs, setAlignmentInputs] = useState([])
  const [multiAlignmentResult, setMultiAlignmentResult] = useState(null)
  const [loadedAlignmentBaselineByGenome, setLoadedAlignmentBaselineByGenome] = useState({})
  const [lastSuccessfulMultiAlignmentSignature, setLastSuccessfulMultiAlignmentSignature] = useState('')
  const [alignmentViewError, setAlignmentViewError] = useState(null)
  const [alignmentViewLoading, setAlignmentViewLoading] = useState(false)
  const [saveAlignmentModalOpen, setSaveAlignmentModalOpen] = useState(false)
  const [loadAlignmentModalOpen, setLoadAlignmentModalOpen] = useState(false)
  // The Feature Alignment as it was before the page reloaded, if it did (see
  // sessionResume.js): its rows and flanks, and where its result came from so the
  // result can be asked for again — from the backend's alignment cache for a run, or
  // from the saved file for a loaded one — rather than kept in the page.
  const resumedAlignmentRef = useRef(undefined)
  if (resumedAlignmentRef.current === undefined) {
    const saved = peekRestoredSessionState('alignment.workspace')
    resumedAlignmentRef.current = saved && typeof saved === 'object' && Array.isArray(saved.rows) ? saved : null
  }
  const resumedAlignment = resumedAlignmentRef.current
  const [alignmentGlobalFlanks, setAlignmentGlobalFlanks] = useState(() => (
    Number.isFinite(Number(resumedAlignment?.globalFlanks?.flank5)) && Number.isFinite(Number(resumedAlignment?.globalFlanks?.flank3))
      ? { flank5: Number(resumedAlignment.globalFlanks.flank5), flank3: Number(resumedAlignment.globalFlanks.flank3) }
      : { flank5: 100, flank3: 100 }
  ))
  const [alignmentGlobalFlanksLocked, setAlignmentGlobalFlanksLocked] = useState(() => resumedAlignment?.globalFlanksLocked ?? true)
  const [alignmentGlobalFlankMax, setAlignmentGlobalFlankMax] = useState(() => Number(resumedAlignment?.globalFlankMax) || 1000)
  const [alignmentSidebarCollapsed, setAlignmentSidebarCollapsed] = useState(() => Boolean(resumedAlignment?.sidebarCollapsed))
  // Where the result on screen came from: { kind: 'run', signature } or
  // { kind: 'loaded', name, genomeKeys }. Only read when a snapshot is taken.
  const alignmentResultSourceRef = useRef(null)
  // Rows still to be put back, and the result to ask for once they are.
  const pendingAlignmentRowsRef = useRef(resumedAlignment
    ? new Map(resumedAlignment.rows.filter((row) => row?.genome_key).map((row) => [row.genome_key, row]))
    : null)
  const pendingAlignmentResultRef = useRef(resumedAlignment?.result || null)
  const [alignmentRunSettings, setAlignmentRunSettings] = useState({
    profile: 'balanced',
    soft_warn_sequences: 6,
    hard_cap_sequences: 10,
    max_total_bp: 500000,
    timeout_sec: 300,
  })
  const [browserFocusByGenome, setBrowserFocusByGenome] = useState(() => (
    Object.fromEntries(Object.entries(resumedFocus?.byGenome || {}).filter(([, gene]) => isGeneFocus(gene)))
  ))
  // genomeKey -> { chrom, start, end } asked for from outside the browser — a
  // location note or alignment selection offering to take the reader to its
  // region. Consumed by the panel, which focuses it the same way a search does.
  const [browserLocationFocusByGenome, setBrowserLocationFocusByGenome] = useState({})
  // The genome the sequence view is reading, reported by the view itself: it
  // chooses its own, and the top bar has to light the same pill.
  const [sequenceGenomeKey, setSequenceGenomeKey] = useState('')
  const alignmentInputsRef = useRef(alignmentInputs)
  const alignmentResolveControllersRef = useRef({})
  const alignmentResolveRequestTokenRef = useRef({})

  // Configuration state. `userConfig` is what is really on disk; `config` below is what
  // the app runs on, which a tutorial can shadow without ever writing to the real one.
  const [userConfig, setUserConfig] = useState({
    working_dir: '',
    ref_fasta: '',
    ref_gff: '',
    target_fasta: '',
    target_gff: '',
    homologies_file: '',
    active_species: [],
    next_previous_session_genomes: [],
    manual_species: [],
    genome_file_overrides: {},
    genome_analysis_reports: {},
    deregistered_genome_keys: [],
    genome_playlists: [],
    selected_genome_playlist_id: '__all__',
    default_light_mode: false,
    dim_non_selected_genes: true,
    show_fps_counter: false,
    browsing_control_scheme: DEFAULT_BROWSING_CONTROL_SCHEME_ID,
    sv_hide_inactive_tracks: false,
    remember_browser_tracks: true,
    genome_default_color: DEFAULT_GENOME_COLOR,
    genome_colors: {},
    genome_color_palette: [],
    active_app_buttons: DEFAULT_ACTIVE_APP_BUTTONS,
  })

  // The real configuration is frozen for as long as a tutorial runs.
  //
  // Plenty of code here reads the current config, changes a field and writes the whole
  // thing back. During a tutorial "the current config" is the sandbox overlay, so those
  // writes would fold the tutorial's scratch directory into the user's real settings.
  // Rather than auditing every one of them, the single setter refuses. Anything the
  // tutorial genuinely needs to change lives in its override instead.
  const setConfig = useCallback((update) => {
    if (isTutorialSandboxActive()) return
    setUserConfig(update)
  }, [])

  // Lets a running tutorial follow the user between apps and move them itself.
  const tutorialRuntime = useTutorialHost({ currentView, theme, navigate: setCurrentView })

  // A tutorial runs in a sandbox: its own scratch output directory and its own set of
  // active genomes, layered over the user's configuration rather than replacing it.
  // Nothing here is ever written back, so quitting mid-tutorial leaves the real
  // configuration exactly as it was and the next launch needs no recovery.
  const {
    configOverride: tutorialConfig,
    updateSandboxConfig,
    toggleTutorialGenome,
  } = tutorialRuntime
  const config = useMemo(
    () => (tutorialConfig ? { ...userConfig, ...tutorialConfig } : userConfig),
    [tutorialConfig, userConfig]
  )

  const configRef = useRef(config)
  // The backend resolves genome keys against its saved configuration, so a view
  // that asks about a genome the moment it becomes active has to wait for the
  // save that told the backend about it. Holds the latest such save; it never
  // rejects.
  const genomeConfigSaveRef = useRef(Promise.resolve())
  const waitForGenomeConfigSave = useCallback(() => genomeConfigSaveRef.current, [])
  const [inactiveSelectedSpecies, setInactiveSelectedSpecies] = useState([])
  const sandboxInactiveSnapshotRef = useRef(null)
  const [dualViewFocus, setDualViewFocus] = useState({ primaryKey: '', secondaryKey: '' })
  // Structural Variation's choices of genomes and region, and where its viewport was,
  // come back after a reload like the rest of the session (see sessionResume.js).
  const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')
  const isString = (value) => typeof value === 'string'
  const [svFullyActiveSpeciesKeys, setSvFullyActiveSpeciesKeys] = useResumableState('sv.activeKeys', [], { isValid: isStringArray })
  const [svAnchorRegionId, setSvAnchorRegionId] = useResumableState('sv.anchorRegionId', '', { isValid: isString })
  const [svAnchorSpeciesKey, setSvAnchorSpeciesKey] = useResumableState('sv.anchorSpeciesKey', '', { isValid: isString })
  const [svSecondSpeciesKey, setSvSecondSpeciesKey] = useResumableState('sv.secondSpeciesKey', '', { isValid: isString })
  const [svThirdSpeciesKey, setSvThirdSpeciesKey] = useResumableState('sv.thirdSpeciesKey', '', { isValid: isString })
  const [svRegionExplicitlySelected, setSvRegionExplicitlySelected] = useResumableState('sv.regionExplicit', false, { isValid: (value) => typeof value === 'boolean' })
  const svSavedViewportRef = useRef(undefined)
  if (svSavedViewportRef.current === undefined) {
    const saved = peekRestoredSessionState('sv.viewport')
    svSavedViewportRef.current = saved?.refWindow ? saved : null
  }
  useEffect(() => {
    consumeRestoredSessionState('sv.viewport')
    return registerSessionState('sv.viewport', () => svSavedViewportRef.current || undefined)
  }, [])
  const [featureExplorerGenomeKey, setFeatureExplorerGenomeKey] = useState('')
  const dualViewFocusRef = useRef(dualViewFocus)
  const inactiveSelectedSpeciesRef = useRef(inactiveSelectedSpecies)
  const nextPreviousSessionSignatureRef = useRef('')
  const activeIndexBuildsRef = useRef(new Map())
  const ensuredGenomeIndexKeysRef = useRef(new Set())
  const suppressViewSyncRef = useRef(false)
  const shouldShowWindowsBackendSetup = backendRuntime.isElectron &&
    backendRuntime.platform === 'win32' &&
    backendRuntime.mode === 'wsl' &&
    (!backendRuntime.ready || backendSetupOpen)
  const shouldGateStartupFetch = backendRuntime.isElectron &&
    backendRuntime.platform === 'win32' &&
    backendRuntime.mode === 'wsl'

  const refSpecies = useMemo(
    () => config?.active_species?.find((species) => species.files?.gff3 === config?.ref_gff) || null,
    [config?.active_species, config?.ref_gff]
  )
  const tgtSpecies = useMemo(
    () => config?.active_species?.find((species) => species.files?.gff3 === config?.target_gff) || null,
    [config?.active_species, config?.target_gff]
  )
  const svActiveSpecies = useMemo(
    () => dedupeSpeciesList(config?.active_species || []),
    [config?.active_species]
  )
  const svActiveSpeciesByKey = useMemo(
    () => new Map(svActiveSpecies.map((species) => [speciesItemKey(species), species])),
    [svActiveSpecies]
  )
  const resolveSvActiveSpeciesForKey = useCallback((key) => {
    const wanted = String(key || '').trim()
    if (!wanted) return null
    return svActiveSpeciesByKey.get(wanted)
      || svActiveSpecies.find((species) => genomeKeysMatch(species, wanted))
      || null
  }, [svActiveSpecies, svActiveSpeciesByKey])
  const svAnchorSpecies = svAnchorSpeciesKey === SV_NO_ANCHOR_KEY
    ? null
    : (resolveSvActiveSpeciesForKey(svAnchorSpeciesKey) || svActiveSpecies[0] || null)
  const svSecondSpecies = svSecondSpeciesKey ? resolveSvActiveSpeciesForKey(svSecondSpeciesKey) : null
  const svThirdSpecies = svThirdSpeciesKey ? resolveSvActiveSpeciesForKey(svThirdSpeciesKey) : null
  const refGenomeKey = refSpecies ? speciesItemKey(refSpecies) : ''
  const tgtGenomeKey = tgtSpecies ? speciesItemKey(tgtSpecies) : ''

  const handleSvAlignmentAvailabilityChange = useCallback((speciesKeys) => {
    const next = Array.from(new Set((speciesKeys || []).filter(Boolean)))
    setSvFullyActiveSpeciesKeys((prev) => sameStringArrayItems(prev, next) ? prev : next)
  }, [])

  useEffect(() => {
    if (currentView !== 'structural_variation' && svFullyActiveSpeciesKeys.length) {
      setSvFullyActiveSpeciesKeys([])
    }
  }, [currentView, svFullyActiveSpeciesKeys.length])

  useEffect(() => {
    const activeKeys = new Set(svActiveSpecies.map((species) => speciesItemKey(species)))
    const knownSvSpecies = [
      ...svActiveSpecies,
      ...dedupeSpeciesList(inactiveSelectedSpeciesRef.current),
    ]
    const knownSvKeys = new Set([
      ...knownSvSpecies,
    ].map((species) => speciesItemKey(species)).filter(Boolean))
    const hasActiveSvKey = (key) => {
      const wanted = String(key || '').trim()
      return Boolean(wanted && (activeKeys.has(wanted) || svActiveSpecies.some((species) => genomeKeysMatch(species, wanted))))
    }
    const hasKnownSvKey = (key) => {
      const wanted = String(key || '').trim()
      return Boolean(wanted && (knownSvKeys.has(wanted) || knownSvSpecies.some((species) => genomeKeysMatch(species, wanted))))
    }
    const primaryActiveKey = svActiveSpecies[0] ? speciesItemKey(svActiveSpecies[0]) : ''

    if (svAnchorSpeciesKey && svAnchorSpeciesKey !== SV_NO_ANCHOR_KEY) {
      if (!hasActiveSvKey(svAnchorSpeciesKey)) {
        if (hasKnownSvKey(svAnchorSpeciesKey)) return
        setSvAnchorSpeciesKey(primaryActiveKey || '')
        setSvSecondSpeciesKey('')
        setSvThirdSpeciesKey('')
        setSvAnchorRegionId('')
        setSvRegionExplicitlySelected(false)
        setSvFullyActiveSpeciesKeys(primaryActiveKey ? [primaryActiveKey] : [])
        return
      }
      if (primaryActiveKey && svAnchorSpeciesKey !== primaryActiveKey) {
        setSvAnchorSpeciesKey(primaryActiveKey)
        setSvSecondSpeciesKey('')
        setSvThirdSpeciesKey('')
        setSvAnchorRegionId('')
        setSvRegionExplicitlySelected(false)
        setSvFullyActiveSpeciesKeys([primaryActiveKey])
        return
      }
    }

  }, [svActiveSpecies, svAnchorSpeciesKey, svSecondSpeciesKey, svThirdSpeciesKey])

  useEffect(() => {
    return window.electronAPI?.onBackendSetupRequested?.(() => setBackendSetupOpen(true))
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToBackendRuntime((nextRuntime) => {
      setBackendRuntime(nextRuntime)
    })

    fetchBackendRuntimeStatus()
      .then((nextRuntime) => {
        setBackendRuntime(nextRuntime)
      })
      .catch((err) => {
        console.error('Failed to fetch backend runtime status:', err)
      })

    return unsubscribe
  }, [])

  useEffect(() => {
    if (shouldGateStartupFetch && !backendRuntime.ready) return undefined
    // The backend is started alongside the window (run_ensembl_go.sh, or a backend
    // restarting after an edit) and may not be answering yet when the window first asks.
    // One failed request used to leave the app on its empty defaults for good — no
    // working directory, no genomes — until the next reload, which looks exactly like
    // lost settings. So keep asking until it answers; nothing is saved meanwhile, since
    // every write waits on `configLoaded`.
    let cancelled = false
    let timer = 0
    const attempt = async (tries) => {
      const loaded = await fetchConfig()
      if (cancelled) return
      if (loaded || isTutorialSandboxActive()) { fetchRecent(); return }
      timer = setTimeout(() => attempt(tries + 1), Math.min(2000, 250 + tries * 250))
    }
    attempt(0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [backendRuntime.ready, shouldGateStartupFetch])

  // Coming out of a tutorial, re-read the configuration and let the app derive itself
  // from it again. The stored configuration was never touched, but state derived from it
  // — which genomes are active, which are merely selected — was emptied for the sandbox
  // and has to be rebuilt from the real thing.
  // Keyed on the sandbox itself going away rather than on the tutorial stopping: a
  // finished tutorial still shows its completion card, and its overlay config is still
  // in force until the user dismisses it.
  // What the browser was looking at before a tutorial took over.
  //
  // The configuration override is enough to keep a tutorial out of the user's settings,
  // but the browser's focused gene is component state and not covered by it. Left alone,
  // a tutorial that focuses one of the demo genome's invented genes hands the session back
  // still focused on it — so the user returns to their own genomes with a gene none of
  // them contain pinned to the focus bar, and clearing it leaves the track blank until the
  // genome is toggled off and on again.
  //
  // Snapshotted rather than simply cleared, because a focus the user had before the
  // tutorial is theirs and should survive it, the same as everything else.
  const tutorialSandboxWasUpRef = useRef(false)
  const preTutorialBrowserFocusRef = useRef(null)
  useEffect(() => {
    const sandboxUp = Boolean(tutorialConfig)
    const tookOver = !tutorialSandboxWasUpRef.current && sandboxUp
    const handedBack = tutorialSandboxWasUpRef.current && !sandboxUp
    tutorialSandboxWasUpRef.current = sandboxUp

    if (tookOver) {
      preTutorialBrowserFocusRef.current = {
        refGene: browserRefGene,
        tgtGene: browserTgtGene,
        byGenome: browserFocusByGenome,
        refInput,
        tgtInput,
      }
    }

    if (handedBack) {
      const saved = preTutorialBrowserFocusRef.current
      preTutorialBrowserFocusRef.current = null
      setBrowserRefGene(saved?.refGene ?? null)
      setBrowserTgtGene(saved?.tgtGene ?? null)
      setBrowserFocusByGenome(saved?.byGenome ?? {})
      setRefInput(saved?.refInput ?? '')
      setTgtInput(saved?.tgtInput ?? '')
      fetchConfig()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tutorialConfig])

  // A tutorial cleans up after itself, but it cannot if the app was killed while one was
  // running. Sweeping on launch means an interrupted tutorial leaves nothing behind —
  // and since a tutorial never writes to the real configuration, there is nothing else to
  // undo: this session starts as the user left it.
  const sweptTutorialWorkspaceRef = useRef(false)
  useEffect(() => {
    const outputDir = userConfig?.output_dir
    if (!configLoaded || !outputDir || sweptTutorialWorkspaceRef.current) return
    sweptTutorialWorkspaceRef.current = true
    resetTutorialWorkspace(outputDir)
  }, [configLoaded, userConfig?.output_dir])

  useEffect(() => {
    configRef.current = config
  }, [config])

  // Selected-but-inactive genomes are React state rather than configuration. Give the
  // tutorial sandbox its own copy too, otherwise Genome Selector either leaks the
  // author's existing genomes into the scene or changes that real selection while the
  // author experiments with playlists.
  useEffect(() => {
    if (tutorialConfig) {
      if (sandboxInactiveSnapshotRef.current === null) {
        sandboxInactiveSnapshotRef.current = inactiveSelectedSpeciesRef.current
        setInactiveSelectedSpecies([])
      }
      return
    }
    if (sandboxInactiveSnapshotRef.current !== null) {
      const restored = sandboxInactiveSnapshotRef.current
      sandboxInactiveSnapshotRef.current = null
      setInactiveSelectedSpecies(restored)
    }
  }, [tutorialConfig])

  // Where the reader is, offered to the session snapshot (sessionResume.js). Read only
  // when a snapshot is taken — the page hiding, unloading or the machine sleeping — so
  // keeping it current is one assignment per render.
  const sessionStateRef = useRef(null)
  restoreFocusFromSession({
      alignmentGlobalFlankMax,
      alignmentGlobalFlanks,
      alignmentGlobalFlanksLocked,
      alignmentInputs,
      alignmentSidebarCollapsed,
      browserFocusByGenome,
      browserRefGene,
      browserTgtGene,
      config,
      configLoaded,
      currentView,
      dualViewFocus,
      inactiveSelectedSpecies,
      loadedAlignmentBaselineByGenome,
      mainContentNode,
      multiAlignmentResult,
      sessionStateRef,
  })
  useEffect(() => {
    consumeRestoredSessionState('app.focus')
    const unregisterView = registerSessionState('app.view', () => sessionStateRef.current.currentView)
    const unregisterFocus = registerSessionState('app.focus', () => {
      const state = sessionStateRef.current
      return { ref: state.browserRefGene, tgt: state.browserTgtGene, byGenome: state.browserFocusByGenome }
    })
    const unregisterGenomes = registerSessionState('app.genomes', () => {
      const state = sessionStateRef.current
      // Before the configuration has loaded there is nothing of the reader's to note;
      // the snapshot keeps what it had (sessionResume carries untaken values forward).
      if (!state.configLoaded) return undefined
      return {
        activeKeys: dedupeSpeciesList(state.config?.active_species || []).map(speciesItemKey).filter(Boolean),
        selectedPlaylistId: state.config?.selected_genome_playlist_id || '',
        inactiveSelected: dedupeSpeciesList(state.inactiveSelectedSpecies || []),
        viewFocus: state.dualViewFocus,
      }
    })
    consumeRestoredSessionState('alignment.workspace')
    const unregisterAlignment = registerSessionState('alignment.workspace', () => {
      const state = sessionStateRef.current
      return {
        rows: (state.alignmentInputs || []).map((row) => ({
          genome_key: row.genome_key,
          query: row.query || '',
          lastAutoQuery: row.lastAutoQuery || '',
          settings: row.settings || {},
        })),
        globalFlanks: state.alignmentGlobalFlanks,
        globalFlanksLocked: state.alignmentGlobalFlanksLocked,
        globalFlankMax: state.alignmentGlobalFlankMax,
        sidebarCollapsed: state.alignmentSidebarCollapsed,
        // Not the result itself, which can be large: where to get it again. A result
        // waiting to be asked for again is still the reader's.
        result: pendingAlignmentResultRef.current || (state.multiAlignmentResult ? alignmentResultSourceRef.current : null),
        baseline: state.loadedAlignmentBaselineByGenome,
      }
    })
    const unregisterScroll = registerSessionState('app.scroll', () => {
      const state = sessionStateRef.current
      const top = Math.round(state.mainContentNode?.scrollTop || 0)
      return top > 0 ? { view: state.currentView, top } : undefined
    })
    return () => {
      unregisterView()
      unregisterFocus()
      unregisterAlignment()
      unregisterGenomes()
      unregisterScroll()
    }
  }, [])

  // The first time the reader goes somewhere new after a reload, whatever has not been
  // restored by then belongs to the old session and is dropped.
  const restoredViewRef = useRef(currentView)
  useEffect(() => {
    if (currentView !== restoredViewRef.current) endSessionRestore()
  }, [currentView])

  // Put the page back where it was scrolled to. The content arrives in stages (the
  // browser's panels size themselves as their data lands), and the browser's scroll
  // anchoring shifts the offset as content above grows, so the offset is held until the
  // page has stopped changing height. Gives up the moment the reader scrolls, or after a
  // few seconds; it runs once, after a reload, and never otherwise.
  useEffect(() => {
    if (!configLoaded || !mainContentNode) return undefined
    const saved = peekRestoredSessionState('app.scroll')
    const target = Number(saved?.top)
    if (!saved || saved.view !== currentView || !(target > 0)) return undefined
    // Consumed only on finishing, not on cleanup, so StrictMode's rehearsal unmount
    // leaves it for the real mount.
    return holdScrollTop(mainContentNode, target, { onDone: () => consumeRestoredSessionState('app.scroll') })
    // Once, when the page is first ready; later view changes are the reader's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoaded, mainContentNode])

  useEffect(() => {
    if (!configLoaded) return undefined

    const flushConfig = () => {
      const currentConfig = configRef.current
      if (!currentConfig) return
      try {
        fetch(`${API_BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentConfig),
          keepalive: true,
        }).catch(() => {})
      } catch {
        // The app is unloading; there is nowhere useful to surface this.
      }
    }

    window.addEventListener('pagehide', flushConfig)
    window.addEventListener('beforeunload', flushConfig)
    return () => {
      window.removeEventListener('pagehide', flushConfig)
      window.removeEventListener('beforeunload', flushConfig)
    }
  }, [configLoaded])

  useEffect(() => {
    dualViewFocusRef.current = dualViewFocus
  }, [dualViewFocus])

  useEffect(() => {
    inactiveSelectedSpeciesRef.current = inactiveSelectedSpecies
  }, [inactiveSelectedSpecies])

  useEffect(() => {
    const validKeys = new Set(
      dedupeSpeciesList(config?.active_species || []).map((species) => speciesItemKey(species))
    )
    setBrowserFocusByGenome((prev) => {
      const next = {}
      let changed = false
      for (const [key, gene] of Object.entries(prev || {})) {
        if (!validKeys.has(key)) {
          changed = true
          continue
        }
        next[key] = gene
      }
      return changed ? next : prev
    })
  }, [config?.active_species])

  // Several alignment callbacks intentionally read the latest rows from a ref so
  // that async resolve completions cannot overwrite one another. Keep that ref in
  // sync before the browser paints: a passive effect leaves a short window where
  // a transcript is visibly selected but a Run/Go click still sees the old row.
  useLayoutEffect((...args) => watchDownloadTasks({ alignmentInputs, alignmentInputsRef }, ...args), [alignmentInputs])

  useEffect(() => {
    const inProgressStatuses = new Set(['pending', 'downloading'])

    // Rides the shared task poll rather than running its own: subscribing directly,
    // not through the hook, because none of this needs App itself to re-render.
    const refreshSelectorFromDownloadTasks = (tasks) => {
      try {
        if (!Array.isArray(tasks)) return

        const latestByGenomeKey = new Map()
        const newlyCompleted = []
        for (const task of tasks) {
          const genomeKey = getAssemblyGenomeKey(task)
          if (genomeKey) {
            if (!latestByGenomeKey.has(genomeKey)) latestByGenomeKey.set(genomeKey, [])
            latestByGenomeKey.get(genomeKey).push(task)
          }
          if (task?.status === 'completed' && task?.id && !selectorRefreshCompletedTaskIdsRef.current.has(task.id)) {
            selectorRefreshCompletedTaskIdsRef.current.add(task.id)
            newlyCompleted.push(task)
            // The backend records downloads for achievements itself; this is when
            // there is something new to pick up.
            if (task.file_type === 'fasta' || task.file_type === 'gff3') void refreshAchievements()
          }
          if (task?.file_type === 'homology' && (task?.status === 'completed' || task?.status === 'failed')) {
            const homologyTaskMap = neighbourhoodHomologyDownloadTaskByGenomeRef.current || {}
            const matchedGenomeKey = Object.keys(homologyTaskMap).find((gk) => homologyTaskMap[gk] === task.id)
            if (matchedGenomeKey) {
              const nextAvailability = task.status === 'completed' ? 'local' : 'download_failed'
              setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [matchedGenomeKey]: nextAvailability }))
              setNeighbourhoodHomologyDownloadTaskByGenome((prev) => {
                if (!Object.prototype.hasOwnProperty.call(prev || {}, matchedGenomeKey)) return prev
                const next = { ...prev }
                delete next[matchedGenomeKey]
                return next
              })
            }
          }
        }

        const pendingIds = readPendingSelectorGenomeIds()
        let pendingChanged = false
        for (const id of Array.from(pendingIds)) {
          const genomeTasks = latestByGenomeKey.get(id) || []
          const stillInProgress = genomeTasks.some((task) => inProgressStatuses.has(String(task?.status || '')))
          if (genomeTasks.length > 0 && stillInProgress) continue
          pendingIds.delete(id)
          pendingChanged = true
        }

        if (pendingChanged) {
          writePendingSelectorGenomeIds(pendingIds)
        }
        if ((pendingChanged || newlyCompleted.length > 0) && typeof window !== 'undefined') {
          window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
        }
      } catch {
        // Keep this silent; the visible Download view owns task error messaging.
      }
    }

    refreshSelectorFromDownloadTasks(getDownloadTasksSnapshot())
    return subscribeDownloadTasks(() => refreshSelectorFromDownloadTasks(getDownloadTasksSnapshot()))
  }, [])

  useEffect(() => {
    return () => {
      const controllers = alignmentResolveControllersRef.current || {}
      Object.values(controllers).forEach((controller) => {
        try { controller?.abort() } catch { }
      })
      alignmentResolveControllersRef.current = {}
      alignmentResolveRequestTokenRef.current = {}
    }
  }, [])

  useEffect(() => {
    return () => {
      if (persistActiveButtonsTimerRef.current) {
        clearTimeout(persistActiveButtonsTimerRef.current)
        persistActiveButtonsTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (persistGenomeColorsTimerRef.current) {
        clearTimeout(persistGenomeColorsTimerRef.current)
        persistGenomeColorsTimerRef.current = null
      }
    }
  }, [])

  // Persist app-button organizer changes immediately so selections survive restart.
  useEffect(() => {
    if (!configLoaded) return

    const normalizedButtons = normalizeActiveAppButtons(config.active_app_buttons)
    const serialized = JSON.stringify(normalizedButtons)
    if (serialized === persistedActiveButtonsRef.current) return

    if (persistActiveButtonsTimerRef.current) {
      clearTimeout(persistActiveButtonsTimerRef.current)
      persistActiveButtonsTimerRef.current = null
    }

    persistActiveButtonsTimerRef.current = setTimeout(async () => {
      persistActiveButtonsTimerRef.current = null
      const baseConfig = savedConfigRef.current || configRef.current || config
      const payload = { ...baseConfig, active_app_buttons: normalizedButtons }
      try {
        await fetch(`${API_BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        persistedActiveButtonsRef.current = serialized
        savedConfigRef.current = { ...(savedConfigRef.current || {}), active_app_buttons: normalizedButtons }
      } catch (e) {
        console.error('Failed to persist active app buttons:', e)
      }
    }, 180)

    return () => {
      if (persistActiveButtonsTimerRef.current) {
        clearTimeout(persistActiveButtonsTimerRef.current)
        persistActiveButtonsTimerRef.current = null
      }
    }
  }, [configLoaded, config.active_app_buttons])

  // Colours are changed from three different places — the configuration view's
  // default, the selector's per-genome swatch, its bulk control — and none of
  // them is a moment worth a full configuration save. Debounced together, as the
  // positional colour list was before them.
  const genomeColorState = useMemo(() => ({
    genome_default_color: normalizeGenomeDefaultColor(config.genome_default_color),
    genome_colors: normalizeGenomeColorAssignments(config.genome_colors),
    genome_color_palette: normalizeCustomGenomeColors(config.genome_color_palette),
  }), [config.genome_default_color, config.genome_colors, config.genome_color_palette])

  useEffect(() => {
    if (!configLoaded) return

    const serialized = JSON.stringify(genomeColorState)
    if (serialized === persistedGenomeColorsRef.current) return

    if (persistGenomeColorsTimerRef.current) {
      clearTimeout(persistGenomeColorsTimerRef.current)
      persistGenomeColorsTimerRef.current = null
    }

    persistGenomeColorsTimerRef.current = setTimeout(async () => {
      persistGenomeColorsTimerRef.current = null
      const payload = {
        ...(configRef.current || config),
        ...genomeColorState,
      }
      try {
        await fetch(`${API_BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        persistedGenomeColorsRef.current = serialized
        savedConfigRef.current = {
          ...(savedConfigRef.current || {}),
          ...payload,
        }
      } catch (e) {
        console.error('Failed to persist genome colours:', e)
      }
    }, 180)

    return () => {
      if (persistGenomeColorsTimerRef.current) {
        clearTimeout(persistGenomeColorsTimerRef.current)
        persistGenomeColorsTimerRef.current = null
      }
    }
  }, [configLoaded, genomeColorState])

  // Sync body background with theme to prevent white borders
  useEffect(() => {
    document.body.style.backgroundColor = theme === 'light' ? '#f3f4f6' : '#111827';
  }, [theme]);

  // Apply default theme from config when it first loads
  useEffect(() => {
    if (config.default_light_mode) {
      setTheme('light')
    }
  }, [config.default_light_mode])

  // Neighbourhood State
  const [neighbourhoodData, setNeighbourhoodData] = useState(null)
  const [neighbourhoodLoading, setNeighbourhoodLoading] = useState(false)
  const [neighbourhoodError, setNeighbourhoodError] = useState(null)
  const neighbourhoodRequestSeqRef = useRef(0)
  const neighbourhoodAbortRef = useRef(null)
  const [neighbourhoodQueryByGenome, setNeighbourhoodQueryByGenome] = useState({})
  const [neighbourhoodTracksByGenome, setNeighbourhoodTracksByGenome] = useState({})
  const [neighbourhoodLinksByPair, setNeighbourhoodLinksByPair] = useState({})
  const [neighbourhoodPairRequestByKey, setNeighbourhoodPairRequestByKey] = useState({})
  const [neighbourhoodLoadingByGenome, setNeighbourhoodLoadingByGenome] = useState({})
  const [neighbourhoodResolvingByGenome, setNeighbourhoodResolvingByGenome] = useState({})
  const [neighbourhoodErrorByGenome, setNeighbourhoodErrorByGenome] = useState({})
  const [neighbourhoodGenomeOrderKeys, setNeighbourhoodGenomeOrderKeys] = useResumableState('neighbourhood.order', [], { isValid: Array.isArray })
  const [neighbourhoodDisabledByGenome, setNeighbourhoodDisabledByGenome] = useResumableState('neighbourhood.disabled', {}, { isValid: (value) => Boolean(value) && typeof value === 'object' })
  const neighbourhoodTrackRequestSeqRef = useRef({})
  const neighbourhoodPairRequestSeqRef = useRef({})
  const neighbourhoodTrackAbortRef = useRef({})
  const neighbourhoodPairAbortRef = useRef({})
  const lastRefFocusKeyRef = useRef('')
  const lastTgtFocusKeyRef = useRef('')

  // Neighbourhood "Use Homology" state — real Ensembl Compara homology-link mode
  const [neighbourhoodUseHomology, setNeighbourhoodUseHomology] = useResumableState('neighbourhood.useHomology', false, { isValid: (value) => typeof value === 'boolean' })
  const [neighbourhoodHomologyFilters, setNeighbourhoodHomologyFilters] = useResumableState('neighbourhood.homologyFilters', {
    showRbh: true,
    showRegular: true,
    types: [],
    minIdentity: 0,
    minCoverage: 0,
  }, { isValid: (value) => Boolean(value) && typeof value === 'object' && Array.isArray(value.types) })
  const [neighbourhoodHomologyLinksByPair, setNeighbourhoodHomologyLinksByPair] = useState({})
  const [neighbourhoodHomologyAvailabilityByGenome, setNeighbourhoodHomologyAvailabilityByGenome] = useState({})
  const [neighbourhoodHomologyDownloadTaskByGenome, setNeighbourhoodHomologyDownloadTaskByGenome] = useState({})
  const [neighbourhoodHomologyError, setNeighbourhoodHomologyError] = useState('')
  const [neighbourhoodHomologyPairLoading, setNeighbourhoodHomologyPairLoading] = useState({})
  const [neighbourhoodNoHitGenomeKeys, setNeighbourhoodNoHitGenomeKeys] = useState([])
  const neighbourhoodAnchorResolutionAttemptRef = useRef({})
  const neighbourhoodQueryResolutionAttemptRef = useRef({})
  const neighbourhoodHomologyCheckedGenomeKeysRef = useRef(new Set())
  const neighbourhoodHomologyDownloadTaskByGenomeRef = useRef({})
  useEffect(() => {
    neighbourhoodHomologyDownloadTaskByGenomeRef.current = neighbourhoodHomologyDownloadTaskByGenome
  }, [neighbourhoodHomologyDownloadTaskByGenome])
  const neighbourhoodHomologyAvailabilityByGenomeRef = useRef({})
  useEffect(() => {
    neighbourhoodHomologyAvailabilityByGenomeRef.current = neighbourhoodHomologyAvailabilityByGenome
  }, [neighbourhoodHomologyAvailabilityByGenome])

  // Check alignment status (Run vs Load) when selected transcripts change
  useEffect(() => {
    if (currentView !== 'alignment') {
      setAlignmentAction('Run')
      return
    }
    const refTx = refResolved?.selectedTranscriptId
    const tgtTx = tgtResolved?.selectedTranscriptId
    if (!refTx || !tgtTx) { setAlignmentAction('Run'); return }

    const timer = setTimeout(async () => {
      try {
        const url = `${API_BASE}/api/align/check?transcript_id=${encodeURIComponent(refTx)}&target_transcript_id=${encodeURIComponent(tgtTx)}&ref_flank=${refFlankBp}&tgt_flank=${tgtFlankBp}`
        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          if (data.type) {
            setAlignmentAction(data.type.split(' ')[0]) // "Run" or "Load"
          }
        }
      } catch {
        setAlignmentAction('Run')
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [currentView, refResolved?.selectedTranscriptId, tgtResolved?.selectedTranscriptId, refFlankBp, tgtFlankBp])

  const fetchConfig = (...args) => loadAppConfig({
      nextPreviousSessionSignatureRef,
      persistedActiveButtonsRef,
      persistedGenomeColorsRef,
      savedConfigRef,
      setConfig,
      setConfigLoaded,
      setDualViewFocus,
      setInactiveSelectedSpecies,
  }, ...args)

  const fetchRecent = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/recent`)
      if (res.ok) {
        const data = await res.json()
        setRecentItems(data)
      }
    } catch (e) {
      console.error('Failed to fetch recent:', e)
    }
  }

  const loadNeighbourhoodTrack = useCallback(async (genomeKey, geneId) => {
    const key = String(genomeKey || '').trim()
    const anchorGeneId = String(geneId || '').trim()
    if (!key || !anchorGeneId) return null

    const prevController = neighbourhoodTrackAbortRef.current[key]
    if (prevController) {
      try { prevController.abort() } catch { }
    }
    const controller = new AbortController()
    neighbourhoodTrackAbortRef.current[key] = controller

    const reqSeq = (Number(neighbourhoodTrackRequestSeqRef.current[key]) || 0) + 1
    neighbourhoodTrackRequestSeqRef.current[key] = reqSeq
    setNeighbourhoodLoadingByGenome((prev) => ({ ...prev, [key]: true }))
    setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))

    try {
      const url = `${API_BASE}/api/neighbourhood?ref_genome=${encodeURIComponent(key)}&ref_gene_id=${encodeURIComponent(anchorGeneId)}&window_size=${NEIGHBOURHOOD_FLANK_WINDOW_SIZE}`
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.detail || 'Failed to load neighbourhood data')
      }
      const json = await res.json()
      if ((Number(neighbourhoodTrackRequestSeqRef.current[key]) || 0) !== reqSeq) return null
      const genes = Array.isArray(json?.reference_genes) ? json.reference_genes : []
      const centerGeneId = String(json?.center_ref_id || '').trim()
      const requestGeneId = String(json?.request_ref_gene_id || anchorGeneId).trim()
      setNeighbourhoodTracksByGenome((prev) => ({
        ...prev,
        [key]: mergeNeighbourhoodTrack(prev?.[key], genes, centerGeneId, requestGeneId, NEIGHBOURHOOD_FLANK_WINDOW_SIZE),
      }))
      setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))
      return json
    } catch (e) {
      if (e?.name === 'AbortError') return null
      if ((Number(neighbourhoodTrackRequestSeqRef.current[key]) || 0) !== reqSeq) return null
      console.error(`Neighbourhood track fetch error (${key}):`, e)
      setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: e?.message || 'Failed to load neighbourhood data' }))
      return null
    } finally {
      if ((Number(neighbourhoodTrackRequestSeqRef.current[key]) || 0) !== reqSeq) return
      if (neighbourhoodTrackAbortRef.current[key] === controller) {
        delete neighbourhoodTrackAbortRef.current[key]
      }
      setNeighbourhoodLoadingByGenome((prev) => ({ ...prev, [key]: false }))
    }
  }, [])

  const loadNeighbourhoodPairLinks = useCallback((...args) => loadPairLinks({
      neighbourhoodPairAbortRef,
      neighbourhoodPairRequestSeqRef,
      setNeighbourhoodHomologyLinksByPair,
      setNeighbourhoodHomologyPairLoading,
      setNeighbourhoodLinksByPair,
      setNeighbourhoodPairRequestByKey,
      setNeighbourhoodTracksByGenome,
  }, ...args), [])

  // Resolve a gene/transcript ID for either side
  const resolveInput = useCallback((...args) => resolveAlignmentInput({
      configRef,
      setRefError,
      setRefLoading,
      setRefResolved,
      setTgtError,
      setTgtLoading,
      setTgtResolved,
  }, ...args), [])

  const handleRefGeneSelect = useCallback((gene) => {
    if (gene?.name || gene?.id) {
      tutorialRuntime.emitSignal('browser.geneFocused', { gene: gene.name || gene.id })
    }
    setBrowserRefGene((prev) => {
      const next = mergeGeneFocus(prev, gene)
      return geneFocusSignature(prev) === geneFocusSignature(next) ? prev : next
    })
    if (refGenomeKey) {
      setBrowserFocusByGenome((prev) => updateGeneFocusMapEntry(prev, refGenomeKey, gene, browserRefGene))
    }
  }, [refGenomeKey, browserRefGene])

  const handleTgtGeneSelect = useCallback((gene) => {
    setBrowserTgtGene((prev) => {
      const next = mergeGeneFocus(prev, gene)
      return geneFocusSignature(prev) === geneFocusSignature(next) ? prev : next
    })
    if (tgtGenomeKey) {
      setBrowserFocusByGenome((prev) => updateGeneFocusMapEntry(prev, tgtGenomeKey, gene, browserTgtGene))
    }
  }, [tgtGenomeKey, browserTgtGene])

  const handleGenomeFocusGeneSelect = useCallback((genomeKey, gene) => {
    const key = String(genomeKey || '').trim()
    if (!key) return

    if (key === refGenomeKey) {
      handleRefGeneSelect(gene)
      if (gene?.name || gene?.id) {
        setRefInput(gene.name || gene.id)
      }
      return
    }

    if (key === tgtGenomeKey) {
      handleTgtGeneSelect(gene)
      if (gene?.name || gene?.id) {
        setTgtInput(gene.name || gene.id)
      }
      return
    }

    setBrowserFocusByGenome((prev) => updateGeneFocusMapEntry(prev, key, gene))
  }, [refGenomeKey, tgtGenomeKey, handleRefGeneSelect, handleTgtGeneSelect])

  const handleGenomeFocusLocationSelect = useCallback((genomeKey, location) => {
    const key = String(genomeKey || '').trim()
    if (!key || !location) return
    // A new object every time, so asking for the same region twice still
    // reaches the panel as a fresh request.
    setBrowserLocationFocusByGenome((prev) => ({ ...prev, [key]: { ...location } }))
  }, [])

  const handleClearAllFocusedGenes = useCallback(() => {
    setBrowserRefGene(null)
    setBrowserTgtGene(null)
    setBrowserFocusByGenome({})
  }, [])

  const handleNeighbourhoodLinkSelect = useCallback((...args) => selectNeighbourhoodLink({
      browserRefGene,
      browserTgtGene,
      handleGenomeFocusGeneSelect,
      refGenomeKey,
      setBrowserFocusByGenome,
      setBrowserRefGene,
      setBrowserTgtGene,
      setNeighbourhoodQueryByGenome,
      setRefInput,
      setTgtInput,
      tgtGenomeKey,
  }, ...args), [handleGenomeFocusGeneSelect, refGenomeKey, tgtGenomeKey, browserRefGene, browserTgtGene])

  const handleNeighbourhoodResolveGenome = useCallback(async (genomeKey, queryOverride = null) => {
    const key = String(genomeKey || '').trim()
    if (!key) return null
    const query = String(queryOverride != null ? queryOverride : neighbourhoodQueryByGenome?.[key] || '').trim()
    if (!query) return null

    setNeighbourhoodResolvingByGenome((prev) => ({ ...prev, [key]: true }))
    setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))
    try {
      const res = await fetch(`${API_BASE}/api/resolve_id?genome=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`)
      if (!res.ok) {
        // The row already says which genome it is, so a miss needs no genome key.
        if (res.status === 404) throw new Error(`'${query}' not found in this genome`)
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.detail || 'Not found')
      }
      const data = await res.json()
      const resolvedGene = data?.gene || null
      if (!resolvedGene?.id) throw new Error('No gene resolved')
      handleGenomeFocusGeneSelect(key, resolvedGene)
      const label = resolvedGene?.name || resolvedGene?.id || query
      setNeighbourhoodQueryByGenome((prev) => ({ ...prev, [key]: label }))
      setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))
      loadNeighbourhoodTrack(key, resolvedGene.id)
      return data
    } catch (e) {
      setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: e?.message || 'Resolve failed' }))
      return null
    } finally {
      setNeighbourhoodResolvingByGenome((prev) => ({ ...prev, [key]: false }))
    }
  }, [neighbourhoodQueryByGenome, handleGenomeFocusGeneSelect, loadNeighbourhoodTrack])

  const handleNeighbourhoodFlipGenome = useCallback((_genomeKey) => {
    // Flip state is currently local to the Neighbourhood view.
  }, [])

  useEffect(() => {
    const activeGenomes = dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3))
    const activeGenomeKeys = activeGenomes.map((species) => speciesItemKey(species)).filter(Boolean)
    const activeKeySet = new Set(activeGenomeKeys)
    setNeighbourhoodGenomeOrderKeys((prev) => {
      const current = Array.isArray(prev) ? prev : []
      const next = []
      const seen = new Set()
      for (const key of current) {
        if (!activeKeySet.has(key) || seen.has(key)) continue
        seen.add(key)
        next.push(key)
      }
      for (const key of activeGenomeKeys) {
        if (seen.has(key)) continue
        seen.add(key)
        next.push(key)
      }
      if (next.length === current.length && next.every((key, idx) => key === current[idx])) return prev
      return next
    })
    setNeighbourhoodDisabledByGenome((prev) => {
      const next = {}
      let changed = false
      for (const key of activeGenomeKeys) {
        if (prev?.[key]) next[key] = true
      }
      if (Object.keys(next).length !== Object.keys(prev || {}).length) changed = true
      if (!changed) {
        for (const [key, value] of Object.entries(next)) {
          if (Boolean(prev?.[key]) !== Boolean(value)) {
            changed = true
            break
          }
        }
      }
      return changed ? next : prev
    })
  }, [config?.active_species])

  const handleNeighbourhoodSwapAdjacent = useCallback((upperGenomeKey, lowerGenomeKey) => {
    const upperKey = String(upperGenomeKey || '').trim()
    const lowerKey = String(lowerGenomeKey || '').trim()
    if (!upperKey || !lowerKey || upperKey === lowerKey) return
    setNeighbourhoodGenomeOrderKeys((prev) => {
      const current = Array.isArray(prev) ? [...prev] : []
      const upperIdx = current.indexOf(upperKey)
      const lowerIdx = current.indexOf(lowerKey)
      if (upperIdx < 0 || lowerIdx < 0) return prev
      if (Math.abs(upperIdx - lowerIdx) !== 1) return prev
      const next = [...current]
      next[upperIdx] = lowerKey
      next[lowerIdx] = upperKey
      if (next.every((key, idx) => key === current[idx])) return prev
      return next
    })
  }, [])

  const handleNeighbourhoodToggleGenome = useCallback((genomeKey) => {
    const key = String(genomeKey || '').trim()
    if (!key) return
    setNeighbourhoodDisabledByGenome((prev) => {
      const currentlyDisabled = Boolean(prev?.[key])
      if (currentlyDisabled) {
        if (!Object.prototype.hasOwnProperty.call(prev || {}, key)) return prev
        const next = { ...(prev || {}) }
        delete next[key]
        return next
      }
      return { ...(prev || {}), [key]: true }
    })
  }, [])

  // Select a different transcript from the expanded list
  const selectTranscript = useCallback((side, transcriptId) => {
    const setSideResolved = side === 'ref' ? setRefResolved : setTgtResolved
    setSideResolved(prev => prev ? { ...prev, selectedTranscriptId: transcriptId } : prev)
  }, [])

  // Execute alignment
  const executeAlignment = async (refId, targetId) => {
    if (!refId || !targetId) return

    setLoading(true)
    setError(null)

    try {
      const alignPromise = fetch(`${API_BASE}/api/align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript_id: refId,
          target_transcript_id: targetId,
          ref_flank_bp: refFlankBp,
          tgt_flank_bp: tgtFlankBp
        })
      })

      const res = await alignPromise
      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.detail || 'Failed to load alignment')
      }

      const data = await res.json()
      setAlignment(data)

      setLoadedParams({ refId, targetId, refFlank: refFlankBp, tgtFlank: tgtFlankBp })
      fetchRecent()
    } catch (e) {
      setError(e.message)
      setAlignment(null)
      setMultiAlignmentResult(null)
      setLastSuccessfulMultiAlignmentSignature('')
      setAlignmentViewError(null)
    } finally {
      setLoading(false)
    }
  }

  // Run alignment with currently selected transcripts
  const handleRunAlignment = useCallback(() => {
    const refTx = refResolved?.selectedTranscriptId
    const tgtTx = tgtResolved?.selectedTranscriptId
    if (!refTx || !tgtTx) return
    executeAlignment(refTx, tgtTx)
  }, [refResolved?.selectedTranscriptId, tgtResolved?.selectedTranscriptId, refFlankBp, tgtFlankBp])

  // Load from history
  const loadFromHistory = async (refId, targetId) => {
    setRefInput(refId)
    setTgtInput(targetId)
    // Resolve both for UI display (fire and forget)
    resolveInput('ref', refId)
    resolveInput('tgt', targetId)
    // Execute immediately with known IDs
    executeAlignment(refId, targetId)
  }

  // Auto-populate alignment inputs when browser genes change
  useEffect((...args) => syncReferenceGeneFocus({
      browserRefGene,
      currentView,
      lastRefFocusKeyRef,
      refLastResolvedQueryRef,
      refResolveInFlightQueryRef,
      resolveInput,
      setAlignment,
      setBrowserRefGene,
      setError,
      setLoadedParams,
      setRefInput,
  }, ...args), [browserRefGene, currentView, resolveInput])

  useEffect((...args) => syncTargetGeneFocus({
      browserTgtGene,
      currentView,
      lastTgtFocusKeyRef,
      resolveInput,
      setAlignment,
      setBrowserTgtGene,
      setError,
      setLoadedParams,
      setTgtInput,
      tgtLastResolvedQueryRef,
      tgtResolveInFlightQueryRef,
  }, ...args), [browserTgtGene, currentView, resolveInput])

  // Auto-load neighbourhood rows from shared focus state for all active genomes.
  useEffect(() => {
    if (currentView !== 'neighbourhood') return

    const activeGenomesUnordered = dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3))
    const byGenomeKey = new Map(activeGenomesUnordered.map((species) => [speciesItemKey(species), species]))
    const activeGenomes = []
    const seenGenomeKeys = new Set()
    for (const key of neighbourhoodGenomeOrderKeys) {
      const species = byGenomeKey.get(key)
      if (!species || seenGenomeKeys.has(key)) continue
      seenGenomeKeys.add(key)
      activeGenomes.push(species)
    }
    for (const species of activeGenomesUnordered) {
      const key = speciesItemKey(species)
      if (!key || seenGenomeKeys.has(key)) continue
      seenGenomeKeys.add(key)
      activeGenomes.push(species)
    }
    const activeGenomeKeys = activeGenomes.map((species) => speciesItemKey(species)).filter(Boolean)
    const activeGenomeKeySet = new Set(activeGenomeKeys)
    const enabledGenomeKeys = activeGenomeKeys.filter((key) => !Boolean(neighbourhoodDisabledByGenome?.[key]))

    const getFocusGeneForGenome = (genomeKey) => {
      const key = String(genomeKey || '').trim()
      if (!key) return null
      if (key === refGenomeKey) return browserRefGene || browserFocusByGenome?.[key] || null
      if (key === tgtGenomeKey) return browserTgtGene || browserFocusByGenome?.[key] || null
      return browserFocusByGenome?.[key] || null
    }

    setNeighbourhoodTracksByGenome((prev) => {
      const next = {}
      for (const key of Object.keys(prev || {})) {
        if (activeGenomeKeySet.has(key)) next[key] = prev[key]
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodLoadingByGenome((prev) => {
      const next = {}
      for (const key of Object.keys(prev || {})) {
        if (activeGenomeKeySet.has(key)) next[key] = prev[key]
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodResolvingByGenome((prev) => {
      const next = {}
      for (const key of Object.keys(prev || {})) {
        if (activeGenomeKeySet.has(key)) next[key] = prev[key]
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodErrorByGenome((prev) => {
      const next = {}
      for (const key of Object.keys(prev || {})) {
        if (activeGenomeKeySet.has(key)) next[key] = prev[key]
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodQueryByGenome((prev) => {
      const next = {}
      let changed = false
      for (const key of activeGenomeKeys) {
        const focusGene = getFocusGeneForGenome(key)
        const fallback = focusGene ? String(focusGene.name || focusGene.id || '').trim() : ''
        const existing = String(prev?.[key] || '').trim()
        const value = fallback || existing
        if (value) next[key] = value
        if (value !== existing) changed = true
      }
      if (!changed && Object.keys(next).length === Object.keys(prev || {}).length) return prev
      return next
    })

    for (const key of Object.keys(neighbourhoodTrackAbortRef.current || {})) {
      if (activeGenomeKeySet.has(key)) continue
      try { neighbourhoodTrackAbortRef.current[key]?.abort() } catch { }
      delete neighbourhoodTrackAbortRef.current[key]
      delete neighbourhoodTrackRequestSeqRef.current[key]
    }

    for (const genomeKey of activeGenomeKeys) {
      if (Boolean(neighbourhoodDisabledByGenome?.[genomeKey])) continue
      const focusGene = getFocusGeneForGenome(genomeKey)
      const focusGeneId = String(focusGene?.id || '').trim()
      if (!focusGeneId) {
        setNeighbourhoodTracksByGenome((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev || {}, genomeKey)) return prev
          const next = { ...(prev || {}) }
          delete next[genomeKey]
          return next
        })
        continue
      }
      const loadedRequestGeneId = String(neighbourhoodTracksByGenome?.[genomeKey]?.requestGeneId || '').trim()
      const loadedWindowSize = Number(neighbourhoodTracksByGenome?.[genomeKey]?.windowSize || 0)
      if (loadedRequestGeneId === focusGeneId && loadedWindowSize >= NEIGHBOURHOOD_FLANK_WINDOW_SIZE) continue
      loadNeighbourhoodTrack(genomeKey, focusGeneId)
    }

    const validPairKeys = new Set()
    for (let idx = 0; idx < enabledGenomeKeys.length - 1; idx += 1) {
      const refKey = enabledGenomeKeys[idx]
      const tgtKey = enabledGenomeKeys[idx + 1]
      const pairKey = buildNeighbourhoodPairKey(refKey, tgtKey)
      if (!pairKey) continue
      validPairKeys.add(pairKey)
      const refFocusGeneId = String(getFocusGeneForGenome(refKey)?.id || '').trim()
      const tgtFocusGeneId = String(getFocusGeneForGenome(tgtKey)?.id || '').trim()
      if (!refFocusGeneId || !tgtFocusGeneId) {
        setNeighbourhoodLinksByPair((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev || {}, pairKey)) return prev
          const next = { ...(prev || {}) }
          delete next[pairKey]
          return next
        })
        setNeighbourhoodPairRequestByKey((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev || {}, pairKey)) return prev
          const next = { ...(prev || {}) }
          delete next[pairKey]
          return next
        })
        continue
      }
      const requestMeta = neighbourhoodPairRequestByKey?.[pairKey] || null
      if (
        String(requestMeta?.refGeneId || '').trim() === refFocusGeneId &&
        String(requestMeta?.targetGeneId || '').trim() === tgtFocusGeneId &&
        Number(requestMeta?.windowSize || 0) >= NEIGHBOURHOOD_FLANK_WINDOW_SIZE &&
        Boolean(requestMeta?.useHomology) === Boolean(neighbourhoodUseHomology)
      ) {
        continue
      }
      loadNeighbourhoodPairLinks({
        refGenomeKey: refKey,
        targetGenomeKey: tgtKey,
        refGeneId: refFocusGeneId,
        targetGeneId: tgtFocusGeneId,
        useHomology: neighbourhoodUseHomology,
      })
    }

    for (const pairKey of Object.keys(neighbourhoodPairAbortRef.current || {})) {
      if (validPairKeys.has(pairKey)) continue
      try { neighbourhoodPairAbortRef.current[pairKey]?.abort() } catch { }
      delete neighbourhoodPairAbortRef.current[pairKey]
      delete neighbourhoodPairRequestSeqRef.current[pairKey]
    }
    setNeighbourhoodLinksByPair((prev) => {
      const next = {}
      for (const [key, value] of Object.entries(prev || {})) {
        if (validPairKeys.has(key)) next[key] = value
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodPairRequestByKey((prev) => {
      const next = {}
      for (const [key, value] of Object.entries(prev || {})) {
        if (validPairKeys.has(key)) next[key] = value
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
  }, [
    currentView,
    config?.active_species,
    neighbourhoodGenomeOrderKeys,
    browserFocusByGenome,
    browserRefGene,
    browserTgtGene,
    refGenomeKey,
    tgtGenomeKey,
    neighbourhoodDisabledByGenome,
    neighbourhoodTracksByGenome,
    neighbourhoodPairRequestByKey,
    neighbourhoodUseHomology,
    loadNeighbourhoodTrack,
    loadNeighbourhoodPairLinks,
  ])

  useEffect(() => {
    return () => {
      for (const controller of Object.values(neighbourhoodTrackAbortRef.current || {})) {
        try { controller?.abort() } catch { }
      }
      for (const controller of Object.values(neighbourhoodPairAbortRef.current || {})) {
        try { controller?.abort() } catch { }
      }
      neighbourhoodTrackAbortRef.current = {}
      neighbourhoodPairAbortRef.current = {}
      neighbourhoodTrackRequestSeqRef.current = {}
      neighbourhoodPairRequestSeqRef.current = {}

      neighbourhoodRequestSeqRef.current += 1
      if (neighbourhoodAbortRef.current) {
        neighbourhoodAbortRef.current.abort()
        neighbourhoodAbortRef.current = null
      }
    }
  }, [])

  const buildAlignmentInputRow = useCallback((species, index, previousRow = null) => {
    const genomeKey = speciesItemKey(species)
    const tag = `G${index + 1}`
    const fallbackLabel = buildGenomePillLabel(species) || `${tag} ${species?.species_key || 'Genome'}`
    const prevSettings = previousRow?.settings || {}
    const selectedTranscriptId = prevSettings.selectedTranscriptId || previousRow?.resolved?.selectedTranscriptId || ''
    return {
      genome_key: genomeKey,
      genome_param: genomeKey,
      tag,
      pillLabel: fallbackLabel,
      query: previousRow?.query || '',
      status: previousRow?.status || 'idle',
      error: previousRow?.error || '',
      include: true,
      resolved: previousRow?.resolved || null,
      settings: {
        useGlobalFlanks: prevSettings.useGlobalFlanks ?? true,
        useGeneBoundaries: prevSettings.useGeneBoundaries ?? true,
        flank5: Number.isFinite(Number(prevSettings.flank5)) ? Number(prevSettings.flank5) : 100,
        flank3: Number.isFinite(Number(prevSettings.flank3)) ? Number(prevSettings.flank3) : 100,
        flankMax: Number.isFinite(Number(prevSettings.flankMax)) ? Math.max(100, Number(prevSettings.flankMax)) : 1000,
        flanksLocked: prevSettings.flanksLocked ?? true,
        overlayAnnotation: prevSettings.overlayAnnotation ?? true,
        selectedTranscriptId,
      },
      lastAutoQuery: previousRow?.lastAutoQuery || '',
    }
  }, [])

  useEffect(() => {
    const activeSpecies = dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3))
    const restoring = pendingAlignmentRowsRef.current
    setAlignmentInputs((prev) => {
      const byKey = new Map((prev || []).map((row) => [row.genome_key, row]))
      return activeSpecies.map((species, idx) => {
        const key = speciesItemKey(species)
        // A row from before a reload starts from what the reader had in it; it is
        // resolved again below, keeping the transcript they had chosen.
        const restored = !byKey.has(key) ? restoring?.get(key) : null
        return buildAlignmentInputRow(species, idx, byKey.get(key) || (restored ? {
          query: String(restored.query || ''),
          lastAutoQuery: String(restored.lastAutoQuery || ''),
          settings: restored.settings && typeof restored.settings === 'object' ? restored.settings : {},
        } : null))
      })
    })
  }, [config?.active_species, buildAlignmentInputRow])

  useEffect(() => {
    const keys = (alignmentInputs || []).map((row) => String(row.genome_key || '').trim()).filter(Boolean)
    if (keys.length === 0) return
    if (!keys.includes(String(collapseSource || '').trim())) {
      setCollapseSource(keys[0])
    }
  }, [alignmentInputs, collapseSource])

  const resolveAlignmentInput = useCallback((...args) => resolveAlignmentInputs({ alignmentInputsRef, alignmentResolveControllersRef, alignmentResolveRequestTokenRef, setAlignmentInputs }, ...args), [])

  const cancelAlignmentInputResolve = useCallback((genomeKey) => {
    const controller = alignmentResolveControllersRef.current[genomeKey]
    if (controller) {
      try { controller.abort() } catch { }
      delete alignmentResolveControllersRef.current[genomeKey]
    }
    alignmentResolveRequestTokenRef.current[genomeKey] = `cancelled-${Date.now()}`
    setAlignmentInputs((prev) => prev.map((item) => (
      item.genome_key === genomeKey && item.status === 'resolving'
        ? { ...item, status: 'idle', error: '' }
        : item
    )))
  }, [])

  const handleAlignmentResolveRow = useCallback((genomeKey) => {
    const row = (alignmentInputsRef.current || []).find((item) => item.genome_key === genomeKey)
    if (!row) return
    if (row.status === 'resolving') {
      cancelAlignmentInputResolve(genomeKey)
      return
    }
    resolveAlignmentInput(genomeKey)
  }, [cancelAlignmentInputResolve, resolveAlignmentInput])

  // The gene a genome's row follows: its gene of focus in the browser.
  const alignmentFocusTokenFor = useCallback((genomeKey, idx) => {
    const focus = (idx === 0 ? browserRefGene : (idx === 1 ? browserTgtGene : null))
      || browserFocusByGenome?.[genomeKey]
    return String(focus?.name || focus?.id || '').trim()
  }, [browserFocusByGenome, browserRefGene, browserTgtGene])

  // One gene for every genome, from the search across the top of the controls. Each
  // row is then the reader's own: marked as already holding its focus, so the focus
  // filling below leaves it alone until that genome's focus actually changes.
  const handleAlignmentSearchAll = useCallback((query) => {
    const token = String(query || '').trim()
    if (!token) return
    const rows = alignmentInputsRef.current || []
    const focusTokens = new Map(rows.map((row, idx) => [row.genome_key, alignmentFocusTokenFor(row.genome_key, idx).toLowerCase()]))
    setAlignmentInputs((prev) => prev.map((row) => ({
      ...row,
      query: token,
      status: 'idle',
      error: '',
      resolved: null,
      lastAutoQuery: focusTokens.get(row.genome_key) || row.lastAutoQuery || '',
      settings: { ...(row.settings || {}), selectedTranscriptId: '' },
    })))
    for (const row of rows) resolveAlignmentInput(row.genome_key, token)
  }, [alignmentFocusTokenFor, resolveAlignmentInput])

  // Fill each genome's row from its gene of focus. Runs when a focus changes and also
  // when rows appear — after a reload, or a genome being activated — since the focus may
  // already be there by then. Each row is filled from its own genome's focus once: a row
  // the reader has since typed into is theirs, and another genome's focus changing does
  // not overwrite it.
  const alignmentRowKeysSignature = (alignmentInputs || []).map((row) => row.genome_key).join('|')
  useEffect(() => {
    const rows = alignmentInputsRef.current || []
    if (!rows.length) return
    rows.forEach((row, idx) => {
      const genomeKey = row.genome_key
      // A row being put back from before a reload is resolved by the restore below.
      if (pendingAlignmentRowsRef.current?.has(genomeKey)) return
      const token = alignmentFocusTokenFor(genomeKey, idx)
      if (!token) return
      const tokenNorm = token.toLowerCase()
      const currentNorm = String(row.query || '').trim().toLowerCase()
      const alreadyAuto = String(row.lastAutoQuery || '') === tokenNorm
      if (alreadyAuto && currentNorm !== tokenNorm) return
      if (alreadyAuto && currentNorm === tokenNorm && row.status === 'resolved') return
      if (alreadyAuto && currentNorm === tokenNorm && row.status === 'resolving') return

      setAlignmentInputs((prev) => prev.map((item) => (
        item.genome_key === genomeKey
          ? { ...item, query: token, lastAutoQuery: tokenNorm }
          : item
      )))
      resolveAlignmentInput(genomeKey, token, { auto: true })
    })
  }, [alignmentFocusTokenFor, resolveAlignmentInput, alignmentRowKeysSignature])

  const handleAlignmentRowQueryChange = useCallback((genomeKey, value) => {
    setAlignmentInputs((prev) => prev.map((row) => (
      row.genome_key === genomeKey
        ? {
          ...row,
          query: value,
          status: value ? 'idle' : row.status,
          error: value ? '' : row.error,
          resolved: value ? null : row.resolved,
          settings: value
            ? { ...(row.settings || {}), selectedTranscriptId: '' }
            : row.settings,
        }
        : row
    )))
  }, [])

  const handleAlignmentGlobalFlanksChange = useCallback((patch) => {
    setAlignmentGlobalFlanks((prev) => {
      const incoming = { ...(patch || {}) }
      const max = Math.max(100, Number(alignmentGlobalFlankMax) || 1000)
      const hasF5 = Object.prototype.hasOwnProperty.call(incoming, 'flank5')
      const hasF3 = Object.prototype.hasOwnProperty.call(incoming, 'flank3')
      let flank5 = hasF5 ? Math.max(0, Number(incoming.flank5) || 0) : Number(prev.flank5 || 0)
      let flank3 = hasF3 ? Math.max(0, Number(incoming.flank3) || 0) : Number(prev.flank3 || 0)

      if (alignmentGlobalFlanksLocked) {
        if (hasF5 && !hasF3) {
          flank3 = flank5
        } else if (hasF3 && !hasF5) {
          flank5 = flank3
        } else if (hasF5 && hasF3) {
          flank3 = flank5
        }
      }

      return {
        flank5: Math.min(max, flank5),
        flank3: Math.min(max, flank3),
      }
    })
  }, [alignmentGlobalFlankMax, alignmentGlobalFlanksLocked])

  const handleAlignmentGlobalFlankMaxChange = useCallback((nextMaxRaw) => {
    const nextMax = Math.max(100, Number(nextMaxRaw) || 1000)
    setAlignmentGlobalFlankMax(nextMax)
    setAlignmentGlobalFlanks((prev) => ({
      flank5: Math.min(nextMax, Math.max(0, Number(prev.flank5) || 0)),
      flank3: Math.min(nextMax, Math.max(0, Number(prev.flank3) || 0)),
    }))
  }, [])

  const handleAlignmentGlobalFlanksLockToggle = useCallback(() => {
    setAlignmentGlobalFlanksLocked((prevLocked) => {
      const nextLocked = !prevLocked
      if (nextLocked) {
        setAlignmentGlobalFlanks((prev) => ({ flank5: prev.flank5, flank3: prev.flank5 }))
      }
      return nextLocked
    })
  }, [])

  const handleAlignmentRowSettingChange = useCallback((...args) => changeAlignmentRowSetting({ setAlignmentInputs }, ...args), [])

  const handleAlignmentRunSettingsChange = useCallback((patch) => {
    setAlignmentRunSettings((prev) => ({ ...prev, ...(patch || {}), profile: 'balanced' }))
  }, [])

  const buildPairwiseOverlayFromMulti = useCallback((...args) => buildPairwiseOverlay({}, ...args), [])

  const buildResolvedAlignmentSignature = useCallback((rows, globalFlanksSource) => {
    const flankSource = globalFlanksSource || { flank5: 100, flank3: 100 }
    const normalized = (rows || []).map((row, idx) => {
      const useGlobal = row.settings?.useGlobalFlanks !== false
      const flank5 = useGlobal ? flankSource.flank5 : row.settings?.flank5
      const flank3 = useGlobal ? flankSource.flank3 : row.settings?.flank3
      const bestQuery = String(
        row.query
        || row.resolved?.query
        || row.resolved?.gene?.id
        || row.resolved?.gene?.name
        || ''
      ).trim()
      const transcriptId = String(
        row.settings?.selectedTranscriptId
        || row.resolved?.selectedTranscriptId
        || row.resolved?.transcripts?.find((tx) => tx?.is_canonical)?.id
        || row.resolved?.transcripts?.[0]?.id
        || ''
      ).trim()
      const include = row.status === 'resolved' && Boolean(transcriptId || bestQuery)
      if (!include) return null
      return {
        genome_key: String(row.genome_key || ''),
        tag: String(row.tag || `G${idx + 1}`),
        query: bestQuery,
        transcript_id: transcriptId,
        use_gene_boundaries: row.settings?.useGeneBoundaries !== false,
        flank_5_bp: Math.max(0, parseInt(flank5 || 0, 10) || 0),
        flank_3_bp: Math.max(0, parseInt(flank3 || 0, 10) || 0),
        overlay_annotation: Boolean(row.settings?.overlayAnnotation),
      }
    }).filter(Boolean)
    return JSON.stringify(normalized)
  }, [])

  const runMultiAlignment = useCallback((...args) => runMultipleAlignment({
      alignmentGlobalFlanks,
      alignmentInputs,
      alignmentResultSourceRef,
      alignmentRunSettings,
      buildResolvedAlignmentSignature,
      setAlignmentOverlay,
      setAlignmentViewError,
      setAlignmentViewLoading,
      setLastSuccessfulMultiAlignmentSignature,
      setLoadedAlignmentBaselineByGenome,
      setMultiAlignmentResult,
  }, ...args), [alignmentInputs, alignmentRunSettings, alignmentGlobalFlanks, buildResolvedAlignmentSignature])

  // Putting the Feature Alignment back after a reload. Each restored row is resolved
  // again, keeping the transcript the reader had chosen; once they all have, the result
  // is asked for again — but only when the view is open, never in the background. A run
  // comes back from the backend's alignment cache, and only if the rows still describe
  // exactly what was run; a loaded alignment is read from its saved file again.
  useEffect(() => {
    const pending = pendingAlignmentRowsRef.current
    if (!pending || !alignmentInputs.length) return
    const rowKeys = new Set(alignmentInputs.map((row) => row.genome_key))
    for (const key of [...pending.keys()]) {
      if (!rowKeys.has(key)) pending.delete(key)
    }
    for (const row of alignmentInputs) {
      const saved = pending.get(row.genome_key)
      if (!saved) continue
      const query = String(row.query || '').trim()
      if (!query) {
        pending.delete(row.genome_key)
      } else if (!saved.started) {
        saved.started = true
        resolveAlignmentInput(row.genome_key, query, {
          selectedTranscriptId: saved.settings?.selectedTranscriptId || '',
          preferSelectedTranscriptId: true,
        })
      } else if (row.status === 'resolved' || row.status === 'error') {
        pending.delete(row.genome_key)
      }
    }
    if (!pending.size) pendingAlignmentRowsRef.current = null
  }, [alignmentInputs, resolveAlignmentInput])

  // Build a map of genome_key → full species object from active_species for use in save modal
  const activeSpeciesByKey = useMemo(() => {
    const map = new Map()
    for (const s of dedupeSpeciesList(config?.active_species || [])) {
      map.set(speciesItemKey(s), s)
    }
    return map
  }, [config?.active_species])

  const alignmentGenomeColorsByKey = useMemo(() => {
    const resolveColor = genomeColorResolver(config)
    return Object.fromEntries(
      [...activeSpeciesByKey].map(([key, species]) => [key, resolveColor(species)])
    )
  }, [activeSpeciesByKey, config])

  useEffect(() => {
    if (multiAlignmentResult) return
    setLoadedAlignmentBaselineByGenome({})
  }, [multiAlignmentResult])

  const handleSaveAlignment = useCallback(() => {
    if (!multiAlignmentResult) return
    setSaveAlignmentModalOpen(true)
  }, [multiAlignmentResult])

  const handleDoSaveAlignment = useCallback((...args) => saveAlignmentWorkspace({ activeSpeciesByKey, config, loadedAlignmentBaselineByGenome, multiAlignmentResult }, ...args), [multiAlignmentResult, config?.output_dir, activeSpeciesByKey, loadedAlignmentBaselineByGenome])

  const handleLoadAlignment = useCallback((...args) => loadAlignmentWorkspace({
      alignmentInputsRef,
      alignmentResultSourceRef,
      buildAlignmentInputRow,
      config,
      configRef,
      handleGenomeFocusGeneSelect,
      inactiveSelectedSpeciesRef,
      refGenomeKey,
      resolveAlignmentInput,
      setAlignmentInputs,
      setAlignmentViewError,
      setConfig,
      setInactiveSelectedSpecies,
      setLoadedAlignmentBaselineByGenome,
      setMultiAlignmentResult,
      setRefError,
      setRefInput,
      setRefResolved,
      setTgtError,
      setTgtInput,
      setTgtResolved,
      tgtGenomeKey,
  }, ...args), [config, buildAlignmentInputRow, refGenomeKey, tgtGenomeKey, resolveAlignmentInput, handleGenomeFocusGeneSelect])

  const collapseSourceOptions = useMemo(
    () => (alignmentInputs || []).map((row) => ({
      genome_key: row.genome_key,
      tag: row.tag,
      label: row.pillLabel,
    })),
    [alignmentInputs]
  )

  // Theme-specific styles
  const isLight = theme === 'light'
  const explicitScreenshotViews = useMemo(() => new Set(['genome_browser', 'feature_explorer', 'download', 'genome_selector']), [])
  const fallbackScreenshotViews = useMemo(() => new Set([
    'home',
    'feature_explorer',
    'alignment',
    'sequence',
    'alignment_explorer',
    'gene_trees',
    'neighbourhood',
    'structural_variation',
    'homology',
    'stats',
    'configuration',
    'help',
    'track_manager',
    'achievements',
  ]), [])
  const explicitScreenshotAvailable = explicitScreenshotViews.has(currentView) && Boolean(screenshotAvailabilityByView[currentView])
  const fallbackScreenshotAvailable = (
    !shouldShowWindowsBackendSetup &&
    fallbackScreenshotViews.has(currentView) &&
    Boolean(activeViewContentNode)
  )
  const usingFallbackScreenshot = screenshotMode && !explicitScreenshotAvailable && fallbackScreenshotAvailable
  const screenshotSupported = explicitScreenshotViews.has(currentView) || fallbackScreenshotViews.has(currentView)
  const screenshotAvailable = explicitScreenshotAvailable || fallbackScreenshotAvailable
  const shouldRenderFallbackContentWrapper = shouldShowWindowsBackendSetup || !configLoaded || currentView !== 'genome_browser'
  const themeStyles = {
    bg: isLight ? 'bg-gray-100' : 'bg-gray-900',
    header: isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700',
    headerBgColor: isLight ? '#ffffff' : '#1f2937',
    headerBgFade: isLight ? 'rgba(255, 255, 255, 0)' : 'rgba(31, 41, 55, 0)',
    panel: isLight ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-800',
    text: isLight ? 'text-gray-900' : 'text-gray-100',
    subtext: isLight ? 'text-gray-500' : 'text-gray-400',
    accent: isLight ? 'text-[#0099ff]' : 'text-blue-400',
    button: isLight ? 'bg-[#0099ff] hover:bg-[#0088ee]' : 'bg-blue-600 hover:bg-blue-700',
  }

  const handleScreenshotAvailabilityChange = useCallback((viewId, available) => {
    const key = String(viewId || '').trim()
    if (!key) return
    setScreenshotAvailabilityByView((prev) => {
      const nextValue = Boolean(available)
      if (prev[key] === nextValue) return prev
      return { ...prev, [key]: nextValue }
    })
  }, [])

  const viewTitles = {
    home: 'Home',
    genome_selector: 'Genome Selector',
    genome_browser: 'Genome Browser',
    feature_explorer: 'Feature Explorer',
    alignment: 'Feature Alignment',
    sequence: 'Sequence',
    alignment_explorer: 'Alignment Explorer',
    gene_trees: 'Gene Trees',
    neighbourhood: 'Neighbourhood',
    structural_variation: 'Structural Variation',
    homology: 'Homology',
    stats: 'Statistics',
    notes: 'Notes',
    download: 'Download',
    configuration: 'Configuration',
    tutorials: 'Tutorials',
    help: 'Help',
    track_manager: 'Track Manager',
    achievements: 'Achievements',
  }

  const viewDescriptions = {
    home: 'Download, browse and analyse Ensembl data locally',
    genome_selector: 'Select downloaded genomes for visualisation in the Genome Browser',
    genome_browser: 'Navigate gene annotations across chromosomes',
    feature_explorer: 'Explore genes and related features in detail',
    alignment: 'Align annotated gene regions across two or more genomes',
    sequence: 'Read sequence base by base, from a whole region down to a single exon',
    alignment_explorer: 'Explore alignment blocks and connected sequence paths in named layers',
    gene_trees: 'Load gene trees, explore them, and see which genes are in your local genomes',
    neighbourhood: 'Explore gene neighbourhood context',
    structural_variation: 'Inspect structural variation and chain-based syntenic mappings between two genomes',
    homology: 'Query homology TSV files for cross-species gene matches',
    stats: 'Compare genome and annotation statistics across selected genomes',
    notes: 'Browse and manage every note you have written, across all your genomes',
    download: 'Download genomes, annotations and homologies locally',
    configuration: 'Set up genome paths and index files',
    tutorials: 'Follow guided walkthroughs of the main Ensembl Go workflows',
    help: 'Read guidance and workflow notes for each view',
    track_manager: 'Register and manage custom data tracks for the Genome Browser',
    achievements: 'Everything you have unlocked, and what is still left to find',
  }

  const currentViewTitle = shouldShowWindowsBackendSetup
    ? 'Windows setup'
    : (viewTitles[currentView] ?? 'Home')
  const currentViewDescription = shouldShowWindowsBackendSetup
    ? 'Connect the packaged Windows app to a Python backend running inside WSL.'
    : (viewDescriptions[currentView] ?? '')
  const currentViewButtonId = shouldShowWindowsBackendSetup
    ? ''
    : (Object.values(APP_BUTTON_META).find(
      (entry) => entry.kind === 'data_view' && entry.viewId === currentView
    )?.id || '')
  const defaultFallbackScreenshotDir = useMemo(() => {
    const base = String(config?.output_dir || '').trim().replace(/\/+$/, '')
    return base ? `${base}/screenshots` : ''
  }, [config?.output_dir])
  const fallbackScreenshotNode = useMemo(() => {
    if (!activeViewContentNode) return null
    return activeViewContentNode.matches?.('[data-screenshot-capture="view"]')
      ? activeViewContentNode
      : (activeViewContentNode.querySelector?.('[data-screenshot-capture="view"]') || activeViewContentNode)
  }, [activeViewContentNode, currentView])
  const fallbackViewContainsCanvas = useMemo(
    () => subtreeContainsCanvas(fallbackScreenshotNode),
    [fallbackScreenshotNode, currentView]
  )
  const fallbackScreenshotTarget = useMemo(() => {
    if (!(fallbackScreenshotAvailable && fallbackScreenshotNode)) return null
    const captureNode = fallbackScreenshotNode
    const visibleNode = activeViewContentNode || captureNode
    const { width: measuredCaptureWidth, height: captureHeight } = measureScreenshotNode(captureNode)
    const { width: visibleWidth } = measureScreenshotNode(visibleNode, { preferScrollSize: false })
    const captureWidth = Math.max(measuredCaptureWidth, visibleWidth)
    const allowedFormats = fallbackViewContainsCanvas ? ['png', 'jpeg'] : ['svg', 'png', 'jpeg']
    const defaultFormat = fallbackViewContainsCanvas ? 'png' : 'svg'
    return {
      id: `fallback:${currentView}`,
      label: `${currentViewTitle} view`,
      allowedFormats,
      defaultFormat,
      getVisibleRect: () => visibleNode.getBoundingClientRect(),
      getScrollElement: () => captureNode,
      buildDefaultFilename: () => buildDefaultScreenshotName(`ens_${currentView}_page`),
      buildExportSnapshot: async () => buildDomNodeScreenshotSnapshot(captureNode, {
        width: captureWidth,
        height: captureHeight,
        backgroundColor: isLight ? '#f3f4f6' : '#111827',
      }),
    }
  }, [activeViewContentNode, currentView, currentViewTitle, fallbackScreenshotAvailable, fallbackScreenshotNode, fallbackViewContainsCanvas, isLight])
  const fallbackScreenshotTargets = useMemo(
    () => (fallbackScreenshotTarget ? [fallbackScreenshotTarget] : []),
    [fallbackScreenshotTarget]
  )

  const handleFallbackScreenshotModalClose = useCallback(() => {
    setSelectedFallbackScreenshotTarget(null)
  }, [])

  const handleFallbackScreenshotSave = useCallback((...args) => saveFallbackScreenshot({ isLight }, ...args), [isLight])

  // Detect changes between current config and savedConfigRef, apply cascading clears,
  // trigger selective browser reloads, and reset alignment state as needed.
  // Returns the (possibly cascaded) config to save.
  const applyConfigCascade = (...args) => applyAppConfigCascade({
      config,
      savedConfigRef,
      setAlignment,
      setAlignmentViewError,
      setBrowserRefGene,
      setBrowserRefViewport,
      setBrowserTgtGene,
      setConfig,
      setLastSuccessfulMultiAlignmentSignature,
      setLoadedParams,
      setMultiAlignmentResult,
      setNeighbourhoodData,
      setRecentItems,
      setRefBrowserReloadKey,
      setRefInput,
      setRefResolved,
      setTgtBrowserReloadKey,
      setTgtInput,
      setTgtResolved,
  }, ...args)

  const handleRetryBackendCheck = useCallback(async () => {
    try {
      const nextRuntime = await retryBackendCheck()
      setBackendRuntime(nextRuntime)
    } catch (e) {
      console.error('Retry backend check failed:', e)
    }
  }, [])

  const handleRetryBackendLaunch = useCallback(async () => {
    try {
      const nextRuntime = await retryBackendLaunch()
      setBackendRuntime(nextRuntime)
    } catch (e) {
      console.error('Retry backend launch failed:', e)
    }
  }, [])

  const persistConfigToBackend = useCallback(async (nextConfig, label = 'config') => {
    // Tutorial state is deliberately transient. The fetch shim also refuses config
    // writes, but the Electron store is reached directly here, so this guard must come
    // before either persistence path.
    if (!nextConfig || isTutorialSandboxActive()) return false
    window.electronAPI?.saveElectronConfig?.(nextConfig)
    try {
      const res = await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig)
      })
      // Adopt settings merged by the backend from the chosen output directory.
      // Apply only fields changed by the server that are still unchanged locally
      // since this request began, so a delayed save cannot overwrite newer edits.
      let saved = nextConfig
      if (res.ok) {
        try {
          const payload = await res.json()
          const adopted = withoutTutorialSandboxFields(payload?.config)
          if (adopted && Object.keys(adopted).length) saved = adopted
        } catch (parseError) {
          console.error(`Could not read the saved ${label} back:`, parseError)
        }
      }
      savedConfigRef.current = { ...saved }
      if (saved !== nextConfig) {
        const current = configRef.current || {}
        const patch = {}
        for (const [key, value] of Object.entries(saved)) {
          const sent = JSON.stringify(nextConfig[key])
          if (JSON.stringify(value) === sent) continue
          if (JSON.stringify(current[key]) !== sent) continue
          patch[key] = value
        }
        if (Object.keys(patch).length) {
          configRef.current = { ...current, ...patch }
          setConfig((prev) => ({ ...prev, ...patch }))
        }
      }
      return true
    } catch (e) {
      console.error(`Failed to save ${label}:`, e)
      return false
    }
  }, [])

  const persistNextPreviousSessionGenomes = useCallback((speciesList, baseConfig = null) => {
    const nextPreviousGenomes = buildPreviousSessionGenomes(speciesList)
    const base = baseConfig || configRef.current || {}
    const signature = JSON.stringify(nextPreviousGenomes)
    if (signature === nextPreviousSessionSignatureRef.current) return
    nextPreviousSessionSignatureRef.current = signature

    const nextConfig = withNextPreviousSessionGenomes(base, nextPreviousGenomes)
    configRef.current = nextConfig
    setConfig((prev) => {
      const prevSignature = JSON.stringify(buildPreviousSessionGenomes(prev?.next_previous_session_genomes || []))
      if (prevSignature === signature) return prev
      return withNextPreviousSessionGenomes(prev, nextPreviousGenomes)
    })
    void persistConfigToBackend(nextConfig, 'next previous session')
  }, [persistConfigToBackend])

  useEffect(() => {
    if (!configLoaded) return

    const playlistSignature = JSON.stringify({
      genome_playlists: config.genome_playlists || [],
      selected_genome_playlist_id: config.selected_genome_playlist_id || '__all__',
    })
    const savedPlaylistSignature = JSON.stringify({
      genome_playlists: savedConfigRef.current?.genome_playlists || [],
      selected_genome_playlist_id: savedConfigRef.current?.selected_genome_playlist_id || '__all__',
    })
    if (playlistSignature === savedPlaylistSignature) return

    persistConfigToBackend(configRef.current || config, 'playlist configuration')
  }, [configLoaded, config.genome_playlists, config.selected_genome_playlist_id, persistConfigToBackend])

  const scheduleConfigurationAutosave = useCallback((nextConfig, { immediate = false } = {}) => {
    if (!configLoaded || !nextConfig) return

    if (persistConfigurationTimerRef.current) {
      clearTimeout(persistConfigurationTimerRef.current)
      persistConfigurationTimerRef.current = null
    }

    if (immediate) {
      persistConfigToBackend(nextConfig, 'configuration')
      return
    }

    persistConfigurationTimerRef.current = setTimeout(() => {
      persistConfigurationTimerRef.current = null
      persistConfigToBackend(configRef.current || nextConfig, 'configuration')
    }, 250)
  }, [configLoaded, persistConfigToBackend])

  const handleConfigurationChange = useCallback((configUpdate) => {
    // Playback and the builder preview both edit a scratch configuration. Let normal UI
    // controls (notably Genome Selector playlists) behave truthfully, but route their
    // result into that override instead of dropping the interaction or touching the
    // user's real settings.
    if (tutorialConfig) {
      const previous = configRef.current || config
      const nextConfig = typeof configUpdate === 'function'
        ? configUpdate(previous)
        : configUpdate
      if (nextConfig) {
        configRef.current = nextConfig
        updateSandboxConfig(nextConfig)
      }
      return
    }
    setConfig((prev) => {
      const nextConfig = typeof configUpdate === 'function'
        ? configUpdate(prev)
        : configUpdate
      if (!nextConfig) return prev

      const directoryChanged =
        (nextConfig.output_dir || '') !== (prev.output_dir || '') ||
        (nextConfig.working_dir || '') !== (prev.working_dir || '')

      configRef.current = nextConfig
      scheduleConfigurationAutosave(nextConfig, { immediate: directoryChanged })
      return nextConfig
    })
  }, [config, scheduleConfigurationAutosave, tutorialConfig, updateSandboxConfig])

  useEffect(() => {
    // This is a launch prompt, not a permanent warning. If this session opened with a
    // configured directory, clearing it deliberately later must not restart onboarding.
    if (configLoaded && String(userConfig?.output_dir || '').trim()) {
      setGettingStartedOutputDirDismissed(true)
    }
  }, [configLoaded, userConfig?.output_dir])

  const handleGettingStartedOutputDir = useCallback(async (path) => {
    const outputDir = String(path || '').trim()
    if (!outputDir) return false
    handleConfigurationChange((previous) => ({ ...previous, output_dir: outputDir }))
    setGettingStartedOutputDirDismissed(true)
    setOutputDirNotification(outputDir)
    return true
  }, [handleConfigurationChange])

  useEffect(() => {
    if (!outputDirNotification) return undefined
    const notificationTimer = setTimeout(() => setOutputDirNotification(''), 4000)
    return () => clearTimeout(notificationTimer)
  }, [outputDirNotification])

  useEffect(() => {
    return () => {
      if (persistConfigurationTimerRef.current) {
        clearTimeout(persistConfigurationTimerRef.current)
        persistConfigurationTimerRef.current = null
      }
    }
  }, [])

  // Leaving the configuration view saves it — but navigation must not be hostage to
  // that save. The backend answers on a single event loop, so one slow request
  // elsewhere leaves this POST queued behind it, and while it was awaited outright
  // every view button did nothing at all: the click registered, the button showed its
  // pressed state, and the view never changed until the backend came back, possibly
  // minutes later. So wait only long enough for the ordinary save to land. The request
  // is never cancelled, so a slow one still completes and still writes — it just
  // finishes after the view has moved on, exactly as every other autosave here does.
  const saveConfigurationBeforeLeaving = async () => {
    let pending = configSaveOnLeaveRef.current
    if (!pending) {
      let cascaded
      try {
        // Synchronous state work: the dependent clears and browser reloads have to
        // happen whether or not the backend ever answers, so they stay inline.
        cascaded = applyConfigCascade()
      } catch (error) {
        console.error('Could not apply the configuration cascade:', error)
        return
      }
      pending = persistConfigToBackend(cascaded, 'config')
        .catch((error) => {
          console.error('Failed to save the configuration on leaving it:', error)
          return false
        })
        .finally(() => {
          if (configSaveOnLeaveRef.current === pending) configSaveOnLeaveRef.current = null
        })
      configSaveOnLeaveRef.current = pending
    }

    let waitTimer = null
    const waited = new Promise((resolve) => {
      waitTimer = setTimeout(() => resolve('timeout'), CONFIG_SAVE_NAV_WAIT_MS)
    })
    try {
      const outcome = await Promise.race([pending.then(() => 'saved'), waited])
      if (outcome === 'timeout') {
        console.warn('Configuration save is still in flight; continuing to the next view.')
      }
    } finally {
      if (waitTimer) clearTimeout(waitTimer)
    }
  }

  // Called after ConfigurationView's own Save/Generate actions POST to the backend.
  // Fetches the latest config from backend first (to pick up backend-side changes
  // like newly generated index paths), then detects what changed and triggers
  // selective browser reloads and cascading clears.
  const handleConfigSaved = async () => {
    const prev = savedConfigRef.current
    tutorialRuntime.emitSignal('config.saved')
    // What was saved is what the reader wants now, not what they had before a reload.
    consumeRestoredSessionState('app.genomes')
    // Fetch latest config from backend (may have new index paths, etc.)
    const newConfig = await fetchConfig()
    if (!newConfig || !prev) return

    const refChanged = newConfig.ref_fasta !== prev.ref_fasta || newConfig.ref_gff !== prev.ref_gff
    const tgtChanged = newConfig.target_fasta !== prev.target_fasta || newConfig.target_gff !== prev.target_gff
    const refIndexChanged = newConfig.ref_index !== prev.ref_index
    const tgtIndexChanged = newConfig.target_index !== prev.target_index

    // Browser track reloads — needed when genome files OR indexes change
    if (refChanged || refIndexChanged) setRefBrowserReloadKey(k => k + 1)
    if (tgtChanged || tgtIndexChanged) setTgtBrowserReloadKey(k => k + 1)

    // Selective alignment/neighbourhood reset when genome files change
    if (refChanged || tgtChanged) {
      setAlignment(null)
      setMultiAlignmentResult(null)
      setLastSuccessfulMultiAlignmentSignature('')
      setAlignmentViewError(null)
      setNeighbourhoodData(null)
      setLoadedParams(null)
      setRecentItems([])
      Promise.all([
        fetch(`${API_BASE}/api/recent/clear`, { method: 'POST' }),
        fetch(`${API_BASE}/api/cache/clear`, { method: 'POST' })
      ]).catch(console.error)

      if (refChanged) {
        setRefResolved(null)
        setRefInput('')
        setBrowserRefGene(null)
        setBrowserRefViewport(null)
      }
      if (tgtChanged) {
        setTgtResolved(null)
        setTgtInput('')
        setBrowserTgtGene(null)
      }
    }
  }

  const buildFocusFromActive = useCallback((activeSpecies, focusOverride = null) => {
    const active = dedupeSpeciesList(activeSpecies)
    const focusInput = focusOverride || dualViewFocusRef.current || { primaryKey: '', secondaryKey: '' }
    const byKey = new Map(active.map((species) => [speciesItemKey(species), species]))

    let primaryKey = byKey.has(focusInput.primaryKey || '') ? (focusInput.primaryKey || '') : ''
    let secondaryKey = byKey.has(focusInput.secondaryKey || '') ? (focusInput.secondaryKey || '') : ''

    if (!primaryKey && active.length > 0) {
      primaryKey = speciesItemKey(active[0])
    }
    if (secondaryKey && secondaryKey === primaryKey) {
      secondaryKey = ''
    }
    if (!secondaryKey && active.length > 1) {
      const fallbackSecondary = active.find((species) => speciesItemKey(species) !== primaryKey)
      secondaryKey = fallbackSecondary ? speciesItemKey(fallbackSecondary) : ''
    }

    return { primaryKey, secondaryKey }
  }, [])

  const getContextFullyActiveSpecies = useCallback((activeSpecies, viewId, focusOverride = null) => {
    const active = dedupeSpeciesList(activeSpecies)
    const capacity = getViewActiveCapacity(viewId)
    if (active.length === 0 || capacity === 0) return []
    if (!Number.isFinite(capacity)) return active

    if (viewId === 'structural_variation') {
      return active.slice(0, capacity)
    }

    const byKey = new Map(active.map((species) => [speciesItemKey(species), species]))
    const focus = buildFocusFromActive(active, focusOverride)
    const out = []

    const primary = byKey.get(focus.primaryKey || '') || active[0] || null
    if (primary) out.push(primary)
    if (capacity >= 2) {
      const secondary = byKey.get(focus.secondaryKey || '') || null
      if (secondary && (!primary || speciesItemKey(secondary) !== speciesItemKey(primary))) {
        out.push(secondary)
      }
    }

    return out.slice(0, capacity)
  }, [buildFocusFromActive])

  const getAlignedGenomeConfigForView = useCallback((configObj, viewId, focusOverride = null) => {
    const activeSpecies = dedupeSpeciesList(configObj?.active_species)
    const byKey = new Map(activeSpecies.map((species) => [speciesItemKey(species), species]))
    const byGff = new Map(activeSpecies.map((species) => [species?.files?.gff3 || '', species]))
    const focus = buildFocusFromActive(activeSpecies, focusOverride)

    const currentPrimary = byGff.get(configObj?.ref_gff || '') || null
    const currentSecondary = byGff.get(configObj?.target_gff || '') || null
    const focusPrimary = byKey.get(focus.primaryKey || '') || null
    const focusSecondary = byKey.get(focus.secondaryKey || '') || null

    let primary = focusPrimary || currentPrimary || activeSpecies[0] || null
    let secondary = null

    if (viewId === 'structural_variation') {
      primary = activeSpecies[0] || primary
      secondary = activeSpecies[1] || null
    } else {
      secondary = secondary || focusSecondary || currentSecondary || null
    }

    if (primary && secondary && speciesItemKey(primary) === speciesItemKey(secondary)) {
      secondary = null
    }

    return {
      ...configObj,
      active_species: activeSpecies,
      ref_fasta: primary?.files?.fasta || '',
      ref_gff: primary?.files?.gff3 || '',
      ref_index: primary?.files?.index || '',
      homologies_file: primary?.files?.homology || '',
      target_fasta: secondary?.files?.fasta || '',
      target_gff: secondary?.files?.gff3 || '',
      target_index: secondary?.files?.index || '',
    }
  }, [buildFocusFromActive])

  // Called when GenomeBrowserView or GenomeSelectorView changes active genome selection.
  // Immediately saves new config to backend so browser fetch calls get the right index/gff paths.
  // Counted while in flight, so a Feature Alignment being put back after a reload can
  // wait for the view's genome assignment to settle: finishing one clears whatever
  // alignment is on screen. The epoch only moves while such a restore is waiting.
  const configChangesInFlightRef = useRef(0)
  const [configChangeSettledEpoch, setConfigChangeSettledEpoch] = useState(0)
  const handleBrowserConfigChange = async (configUpdate) => {
    configChangesInFlightRef.current += 1
    try {
      return await applyBrowserConfigChange(configUpdate)
    } finally {
      configChangesInFlightRef.current -= 1
      if (pendingAlignmentResultRef.current) setConfigChangeSettledEpoch((epoch) => epoch + 1)
    }
  }

  const applyBrowserConfigChange = async (configUpdate) => {
    const prev = configRef.current
    const rawNewConfig = typeof configUpdate === 'function'
      ? configUpdate(prev)
      : configUpdate
    if (!rawNewConfig) return
    const hasExplicitNextPreviousSessionUpdate = Array.isArray(rawNewConfig.next_previous_session_genomes)
    const sessionSpeciesSource = hasExplicitNextPreviousSessionUpdate
      ? rawNewConfig.next_previous_session_genomes
      : [
          ...dedupeSpeciesList(rawNewConfig.active_species || []),
          ...dedupeSpeciesList(inactiveSelectedSpeciesRef.current || []),
        ]
    const newConfig = withNextPreviousSessionGenomes(rawNewConfig, sessionSpeciesSource)
    if (!newConfig) return

    // View-alignment effects can run as the tutorial swaps in its temporary genome set.
    // That must never turn into an Electron config write: the tutorial provider owns the
    // overlay, and dropping it is what restores the user's browser configuration.
    if (isTutorialSandboxActive()) {
      configRef.current = newConfig
      updateSandboxConfig(newConfig)
      return
    }
    nextPreviousSessionSignatureRef.current = JSON.stringify(buildPreviousSessionGenomes(newConfig.next_previous_session_genomes || []))

    // Special case: deactivating primary while secondary is active promotes
    // the previous target genome into primary. Preserve target-side state.
    const targetPromotedToRef =
      !!prev?.target_gff &&
      newConfig.ref_gff === prev.target_gff &&
      !newConfig.target_gff

    const refGenomeChanged = newConfig.ref_gff !== prev.ref_gff || newConfig.ref_fasta !== prev.ref_fasta
    const tgtGenomeChanged = newConfig.target_gff !== prev.target_gff || newConfig.target_fasta !== prev.target_fasta

    // Persist to backend right away — GenomeBrowser fetches data from the backend
    // using the on-disk config, so we must save before reload triggers fetch.
    // The UI updates without waiting, which means views keyed on the active
    // genomes remount before the save lands; the save is published first so they
    // can wait for it (the Feature Explorer's first gene lookup does).
    window.electronAPI?.saveElectronConfig?.(newConfig)
    const save = fetch(`${API_BASE}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig)
    }).then(() => {}, (e) => {
      console.error('Failed to save genome config:', e)
    })
    genomeConfigSaveRef.current = save
    setConfig(newConfig)
    configRef.current = newConfig
    await save
    savedConfigRef.current = { ...newConfig }

    // Trigger browser reloads when ref/target genome selection changes
    const refChanged = newConfig.ref_gff !== prev.ref_gff || newConfig.ref_index !== prev.ref_index
    const tgtChanged = newConfig.target_gff !== prev.target_gff || newConfig.target_index !== prev.target_index
    if (refChanged) setRefBrowserReloadKey(k => k + 1)
    if (tgtChanged) setTgtBrowserReloadKey(k => k + 1)

    // Keep pairwise/neighbourhood state consistent with active genomes.
    // If either genome assignment changed, clear stale pairwise/alignment state.
    if (refGenomeChanged || tgtGenomeChanged) {
      setAlignment(null)
      setMultiAlignmentResult(null)
      setLastSuccessfulMultiAlignmentSignature('')
      setAlignmentViewError(null)
      setAlignmentOverlay(null)
      setLoadedParams(null)
      setError(null)
    }

    // Neighbourhood handling:
    // - ref change => reset neighbourhood entirely (different anchor genome)
    // - tgt change => preserve ref neighbourhood but clear target-side/links
    if (targetPromotedToRef) {
      setNeighbourhoodError(null)
      setNeighbourhoodLoading(false)
      setNeighbourhoodData((prevData) => {
        if (!prevData) return prevData
        const promotedGenes = (prevData.target_genes && prevData.target_genes.length > 0)
          ? prevData.target_genes
          : prevData.reference_genes
        return {
          ...prevData,
          reference_genes: promotedGenes || [],
          center_ref_id: prevData.center_target_id || prevData.center_ref_id,
          target_genes: [],
          center_target_id: null,
          homologies: [],
          request_transcript_id: prevData.request_target_transcript_id || prevData.request_transcript_id,
          request_target_transcript_id: null,
          request_ref_gene_id: prevData.request_target_gene_id || prevData.request_ref_gene_id || null,
          request_target_gene_id: null,
        }
      })
    } else if (refGenomeChanged) {
      setNeighbourhoodData(null)
      setNeighbourhoodError(null)
      setNeighbourhoodLoading(false)
    } else if (tgtGenomeChanged) {
      setNeighbourhoodError(null)
      setNeighbourhoodLoading(false)
      setNeighbourhoodData((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          target_genes: [],
          center_target_id: null,
          homologies: [],
          request_target_transcript_id: null,
          request_target_gene_id: null,
        }
      })
    }

    // Clear changed sides. When a genome is deactivated, drop any focused gene tied to that browser slot.
    if (targetPromotedToRef) {
      setRefResolved(null)
      setRefInput('')
      setRefError(null)
      setBrowserRefGene(null)
      setBrowserRefViewport(null)
      setTgtResolved(null)
      setTgtInput('')
      setTgtError(null)
      setBrowserTgtGene(null)
    } else if (refGenomeChanged) {
      setRefResolved(null)
      setRefInput('')
      setRefError(null)
      setBrowserRefGene(null)
      setBrowserRefViewport(null)
    }
    if (!targetPromotedToRef && tgtGenomeChanged) {
      setTgtResolved(null)
      setTgtInput('')
      setTgtError(null)
      setBrowserTgtGene(null)
    }

    if (!newConfig.ref_gff && !newConfig.target_gff) {
      setRefResolved(null)
      setTgtResolved(null)
      setRefInput('')
      setTgtInput('')
      setRefError(null)
      setTgtError(null)
      setBrowserRefGene(null)
      setBrowserRefViewport(null)
      setBrowserTgtGene(null)
      setNeighbourhoodData(null)
      setNeighbourhoodError(null)
      setNeighbourhoodLoading(false)
    }

  }

  const hasGenomeAssignmentChanges = useCallback((a, b) => {
    if (!a || !b) return true
    return (
      (a.ref_gff || '') !== (b.ref_gff || '') ||
      (a.ref_fasta || '') !== (b.ref_fasta || '') ||
      (a.ref_index || '') !== (b.ref_index || '') ||
      (a.target_gff || '') !== (b.target_gff || '') ||
      (a.target_fasta || '') !== (b.target_fasta || '') ||
      (a.target_index || '') !== (b.target_index || '') ||
      (a.homologies_file || '') !== (b.homologies_file || '')
    )
  }, [])

  const persistBuiltIndexForGenome = useCallback(async (species, indexPath) => {
    const gffPath = String(species?.files?.gff3 || '').trim()
    if (!gffPath || !indexPath) return

    const genomeKey = speciesItemKey(species)
    let nextConfig = null

    setConfig((prev) => {
      let changed = false
      const applyIndex = (items) => (items || []).map((item) => {
        if (speciesItemKey(item) !== genomeKey) return item
        if ((item.files?.index || '') === indexPath) return item
        changed = true
        return {
          ...item,
          files: {
            ...(item.files || {}),
            index: indexPath,
          },
        }
      })

      const updated = {
        ...prev,
        active_species: applyIndex(prev.active_species),
        manual_species: applyIndex(prev.manual_species),
      }

      if (updated.ref_gff === gffPath && updated.ref_index !== indexPath) {
        updated.ref_index = indexPath
        changed = true
      }
      if (updated.target_gff === gffPath && updated.target_index !== indexPath) {
        updated.target_index = indexPath
        changed = true
      }

      nextConfig = changed ? updated : prev
      return nextConfig
    })

    setInactiveSelectedSpecies((prev) => {
      let changed = false
      const next = (prev || []).map((item) => {
        if (speciesItemKey(item) !== genomeKey) return item
        if ((item.files?.index || '') === indexPath) return item
        changed = true
        return {
          ...item,
          files: {
            ...(item.files || {}),
            index: indexPath,
          },
        }
      })
      return changed ? next : prev
    })

    if (!nextConfig || nextConfig === configRef.current) return

    configRef.current = nextConfig
    savedConfigRef.current = { ...nextConfig }

    try {
      await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig),
      })
    } catch (e) {
      console.error('Failed to persist built genome index:', e)
    }
  }, [])

  const fileExistsAtPath = useCallback(async (path) => {
    const targetPath = String(path || '').trim()
    if (!targetPath) return false
    try {
      const dir = dirnameFromPath(targetPath)
      const name = basenameFromPath(targetPath)
      if (!dir || !name) return false
      const res = await fetch(`${API_BASE}/api/files/list?path=${encodeURIComponent(dir)}`)
      if (!res.ok) return false
      const data = await res.json()
      return (data.items || []).some((item) => !item.is_dir && item.name === name)
    } catch {
      return false
    }
  }, [])

  // Whether the backend considers a genome's index built and current. Falls back
  // to "is the file there" for a genome it does not know about yet, which is the
  // only case it cannot answer for.
  const backendWillUseIndex = useCallback(async (genomeKey, indexPath) => {
    const key = String(genomeKey || '').trim()
    if (key) {
      try {
        const res = await fetch(`${API_BASE}/api/browse/index-status?genome=${encodeURIComponent(key)}`)
        if (res.ok) return (await res.json())?.state === 'ready'
      } catch {
        // Fall through to the filesystem check below.
      }
    }
    return fileExistsAtPath(indexPath)
  }, [fileExistsAtPath])

  const ensureSelectedGenomeIndex = useCallback((species) => {
    const gffPath = String(species?.files?.gff3 || '').trim()
    if (!gffPath) return Promise.resolve(null)

    const genomeKey = speciesItemKey(species)
    const currentIndex = String(species?.files?.index || '').trim()
    const ensureKey = `${genomeKey}|${gffPath}|${currentIndex}`
    const indexlessEnsureKey = `${genomeKey}|${gffPath}|`
    if (ensuredGenomeIndexKeysRef.current.has(ensureKey) || ensuredGenomeIndexKeysRef.current.has(indexlessEnsureKey)) {
      return Promise.resolve(currentIndex || null)
    }

    const existingPromise = activeIndexBuildsRef.current.get(genomeKey)
    if (existingPromise) return existingPromise

    const promise = (async () => {
      const currentConfig = configRef.current || {}

      if (currentIndex) {
        // Ask the backend whether it would actually browse with this index, not
        // merely whether the file is there. An index built from an older copy of
        // the annotation is on disk and unusable: accepting it here marked the
        // genome as sorted, so nothing queued a rebuild or followed its
        // progress, and the browser was left polling a build it had started for
        // itself with nothing watching it.
        const usable = await backendWillUseIndex(genomeKey, currentIndex)
        if (usable) {
          await persistBuiltIndexForGenome(species, currentIndex)
          ensuredGenomeIndexKeysRef.current.add(ensureKey)
          return currentIndex
        }
      }

      const outputDir = String(currentConfig.output_dir || '').trim()
      const outputDirHint = currentIndex ? (dirnameFromPath(currentIndex) || outputDir) : outputDir
      if (!outputDirHint) return null

      try {
        const res = await fetch(`${API_BASE}/api/index/generate-for-genome`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gff_path: gffPath,
            output_dir: outputDirHint,
            index_path: currentIndex || undefined,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          console.error('Failed to start genome index build:', err?.detail || res.statusText)
          return null
        }

        const { task_id } = await res.json()
        if (!task_id) return null

        const builtIndexPath = await new Promise((resolve) => {
          let consecutivePollFailures = 0
          const maxPollFailures = 5
          const poll = async () => {
            try {
              const statusRes = await fetch(`${API_BASE}/api/index/task-status/${task_id}`)
              if (statusRes.ok) {
                consecutivePollFailures = 0
                const statusData = await statusRes.json()
                if (statusData.status === 'success') {
                  resolve(statusData.index_path || null)
                  return
                }
                if (statusData.status === 'failed') {
                  console.error('Genome index build failed:', statusData.error || 'Unknown error')
                  resolve(null)
                  return
                }
              } else {
                consecutivePollFailures += 1
              }
            } catch (error) {
              consecutivePollFailures += 1
              console.error('Genome index build poll failed:', error)
            }
            if (consecutivePollFailures >= maxPollFailures) {
              console.error('Genome index build poll stopped after repeated status fetch failures.')
              resolve(null)
              return
            }
            window.setTimeout(poll, 3000)
          }
          poll()
        })

        if (builtIndexPath) {
          await persistBuiltIndexForGenome(species, builtIndexPath)
          ensuredGenomeIndexKeysRef.current.add(ensureKey)
          ensuredGenomeIndexKeysRef.current.add(`${genomeKey}|${gffPath}|${builtIndexPath}`)
        }
        return builtIndexPath
      } catch (error) {
        console.error('Failed to ensure genome index:', error)
        return null
      }
    })()

    activeIndexBuildsRef.current.set(genomeKey, promise)
    promise.finally(() => {
      activeIndexBuildsRef.current.delete(genomeKey)
    })

    return promise
  }, [backendWillUseIndex, persistBuiltIndexForGenome])

  useEffect(() => {
    if (!shouldAutoEnsurePrimaryIndex(currentView)) return
    const primary = primaryGenomeForIndex(
      dedupeSpeciesList(config?.active_species || []),
      config?.ref_gff,
    )
    if (primary) ensureSelectedGenomeIndex(primary)
  }, [currentView, config?.active_species, config?.ref_gff, ensureSelectedGenomeIndex])

  useEffect(() => {
    if (suppressViewSyncRef.current) return
    const currentConfig = configRef.current || config
    const normalizedFocus = buildFocusFromActive(currentConfig?.active_species, dualViewFocusRef.current)
    if (
      normalizedFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
      normalizedFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
    ) {
      setDualViewFocus(normalizedFocus)
    }
    const aligned = getAlignedGenomeConfigForView(currentConfig, currentView, normalizedFocus)
    const activeUnchanged = speciesListsEqualByKey(currentConfig?.active_species || [], aligned?.active_species || [])
    if (activeUnchanged && !hasGenomeAssignmentChanges(currentConfig, aligned)) return
    handleBrowserConfigChange(aligned)
  }, [currentView, config?.active_species, dualViewFocus.primaryKey, dualViewFocus.secondaryKey, buildFocusFromActive, getAlignedGenomeConfigForView, hasGenomeAssignmentChanges])

  // The alignment's result, asked for again once its rows are back (see above).
  useEffect(() => {
    const wanted = pendingAlignmentResultRef.current
    // Not while the view is still settling which genomes it shows: that clears whatever
    // alignment is on screen when it finishes, and would take the restored one with it.
    if (!wanted || currentView !== 'alignment' || pendingAlignmentRowsRef.current) return
    if (configChangesInFlightRef.current > 0) return
    pendingAlignmentResultRef.current = null
    if (wanted.kind === 'run') {
      if (buildResolvedAlignmentSignature(alignmentInputs, alignmentGlobalFlanks) === wanted.signature) {
        runMultiAlignment()
      }
      return
    }
    if (wanted.kind !== 'loaded' || !wanted.name || !config?.output_dir) return
    let cancelled = false
    fetch(`${API_BASE}/api/alignments/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: wanted.name, output_dir: config.output_dir, genome_keys: wanted.genomeKeys || [] }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        setMultiAlignmentResult(data)
        if (resumedAlignment?.baseline && typeof resumedAlignment.baseline === 'object') {
          setLoadedAlignmentBaselineByGenome(resumedAlignment.baseline)
        }
        alignmentResultSourceRef.current = wanted
      })
      .catch((error) => console.error('Could not reopen the loaded alignment:', error))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView, alignmentInputs, alignmentGlobalFlanks, runMultiAlignment, buildResolvedAlignmentSignature, config?.output_dir, configChangeSettledEpoch])

	  // `options.desired` states the outcome the caller wants — 'selected' or 'deselected'
	  // — for a change applied on a delay, which may find the world already in that state
	  // by the time it runs. Without it the delayed change flips whatever it finds and
	  // takes back a selection something else has since made.
	  const handleSpeciesPillToggle = useCallback((...args) => toggleSpeciesPill({
	      buildFocusFromActive,
	      config,
	      configRef,
	      currentView,
	      dualViewFocusRef,
	      getAlignedGenomeConfigForView,
	      getContextFullyActiveSpecies,
	      handleBrowserConfigChange,
	      hasGenomeAssignmentChanges,
	      inactiveSelectedSpeciesRef,
	      persistNextPreviousSessionGenomes,
	      setDualViewFocus,
	      setInactiveSelectedSpecies,
	      suppressViewSyncRef,
	      toggleTutorialGenome,
	      tutorialConfig,
	  }, ...args), [
    buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView,
    getContextFullyActiveSpecies, hasGenomeAssignmentChanges, persistNextPreviousSessionGenomes,
    toggleTutorialGenome, tutorialConfig,
  ])

  const handleApplyPlaylistFromSelector = useCallback(async ({ playlistId, activeSpecies, selectedSpecies }) => {
    const currentConfig = configRef.current || config
    const nextSelected = dedupeSpeciesList(selectedSpecies || activeSpecies || [])
    const nextActive = dedupeSpeciesList(activeSpecies || nextSelected.slice(0, 1))
    const activeKeys = new Set(nextActive.map((species) => speciesItemKey(species)))
    const nextInactive = nextSelected.filter((species) => !activeKeys.has(speciesItemKey(species)))
    const nextFocus = buildFocusFromActive(nextActive, {
      primaryKey: nextActive[0] ? speciesItemKey(nextActive[0]) : '',
      secondaryKey: nextActive[1] ? speciesItemKey(nextActive[1]) : '',
    })

    suppressViewSyncRef.current = true
    try {
      setInactiveSelectedSpecies(nextInactive)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

	      const nextConfig = getAlignedGenomeConfigForView(
	        withNextPreviousSessionGenomes(
	          {
	            ...currentConfig,
	            selected_genome_playlist_id: playlistId || '__all__',
	            active_species: nextActive,
	          },
	          nextSelected
	        ),
        currentView,
        nextFocus
      )

      await handleBrowserConfigChange(nextConfig)
      return { ok: true }
    } catch (error) {
      console.error('Failed to apply genome playlist:', error)
      return { ok: false, message: error?.message || 'Unable to apply genome playlist.' }
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView, persistNextPreviousSessionGenomes])

  const resolveLocalSpeciesForPlaylist = useCallback(async (playlist) => {
    const currentConfig = configRef.current || config
    const outputDir = String(currentConfig?.output_dir || '').trim()
    let localAssemblies = []
    if (outputDir) {
      const res = await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(outputDir)}`)
      if (res.ok) {
        const data = await res.json()
        localAssemblies = Array.isArray(data) ? data : []
      }
    }

    const byKey = new Map()
    const addCandidate = (item) => {
      const normalized = normalizeGenomeRecord(item)
      const key = speciesItemKey(normalized)
      if (key && !byKey.has(key)) byKey.set(key, normalized)
    }
    for (const item of localAssemblies) {
      addCandidate(item)
      for (const instance of Array.isArray(item?.dataset_instances) ? item.dataset_instances : []) {
        addCandidate(instance)
      }
    }
    for (const item of currentConfig?.manual_species || []) addCandidate({ ...item, is_manual: true })

    const playlistGenomes = Array.isArray(playlist?.genomes) ? playlist.genomes : []
    const hasExplicitActiveDefaults = playlistGenomes.some((genome) => Object.prototype.hasOwnProperty.call(genome || {}, 'active_by_default'))
    const availablePairs = []
    for (const genome of playlistGenomes) {
      const liveItem = Array.from(byKey.values()).find((item) => genomeKeysMatch(item, genome))
      if (!liveItem?.files?.gff3) continue
      if (availablePairs.some((entry) => genomeKeysMatch(entry.liveItem, liveItem))) continue
      availablePairs.push({ genome, liveItem })
    }
    const availableSpecies = availablePairs.map((entry) => entry.liveItem)
    const activeSpecies = availablePairs
      .filter((entry) => Boolean(entry.genome?.active_by_default))
      .map((entry) => entry.liveItem)
    return {
      activeSpecies: activeSpecies.length > 0 || hasExplicitActiveDefaults ? activeSpecies : availableSpecies.slice(0, 1),
      availableSpecies,
    }
  }, [config])

  const handleTopBarPlaylistSelect = useCallback(async (playlist) => {
    if (!playlist?.id || applyingGenomePlaylistId) return
    setApplyingGenomePlaylistId(playlist.id)
    try {
      const { activeSpecies, availableSpecies } = await resolveLocalSpeciesForPlaylist(playlist)
      const result = await handleApplyPlaylistFromSelector({
        playlistId: playlist.id,
        playlist,
        activeSpecies,
        selectedSpecies: availableSpecies,
      })
      if (result?.ok !== false) {
        trackAchievement('playlist.switched')
        setGenomePlaylistPopoverOpen(false)
      }
    } catch (error) {
      console.error('Failed to apply genome playlist from top bar:', error)
    } finally {
      setApplyingGenomePlaylistId('')
    }
  }, [applyingGenomePlaylistId, handleApplyPlaylistFromSelector, resolveLocalSpeciesForPlaylist])

  const handleSpeciesPillReorder = useCallback((...args) => reorderSpeciesPills({
      buildFocusFromActive,
      config,
      configRef,
      currentView,
      dualViewFocusRef,
      getAlignedGenomeConfigForView,
      handleBrowserConfigChange,
      hasGenomeAssignmentChanges,
      inactiveSelectedSpeciesRef,
      setDualViewFocus,
      setInactiveSelectedSpecies,
      suppressViewSyncRef,
  }, ...args), [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView, hasGenomeAssignmentChanges, handleBrowserConfigChange])

  const handleGenomeWheelPromote = useCallback(async (sourceKey, action, source) => {
    const currentConfig = tutorialConfig || configRef.current || config
    const active = dedupeSpeciesList(currentConfig.active_species)
    const listed = dedupeSpeciesList([
      ...active,
      ...(tutorialConfig ? (tutorialConfig.tutorial_selected_genomes || []) : inactiveSelectedSpeciesRef.current || []),
      ...(source ? [source] : []),
    ])
    const selection = cycleSelection(active, listed, sourceKey, action)
    if (!selection) throw new Error('This genome cannot be opened')
    if (speciesListsEqualByKey(active, selection.active)) return
    const nextFocus = buildFocusFromActive(selection.active, {
      primaryKey: speciesItemKey(selection.active[0]),
      secondaryKey: selection.active[1] ? speciesItemKey(selection.active[1]) : '',
    })
    suppressViewSyncRef.current = true
    try {
      if (!tutorialConfig) setInactiveSelectedSpecies(selection.inactive)
      dualViewFocusRef.current = nextFocus
      setDualViewFocus(nextFocus)
      const nextConfig = getAlignedGenomeConfigForView(
        withNextPreviousSessionGenomes({ ...currentConfig, active_species: selection.active }, listed),
        'genome_browser', nextFocus,
      )
      await handleBrowserConfigChange(nextConfig)
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, tutorialConfig, getAlignedGenomeConfigForView, handleBrowserConfigChange])

  const handleStructuralVariationGenomeOrderChange = useCallback((...args) => changeStructuralVariationGenomeOrder({
      buildFocusFromActive,
      config,
      configRef,
      dualViewFocusRef,
      getAlignedGenomeConfigForView,
      handleBrowserConfigChange,
      hasGenomeAssignmentChanges,
      inactiveSelectedSpeciesRef,
      setDualViewFocus,
      setInactiveSelectedSpecies,
      setSvAnchorRegionId,
      setSvAnchorSpeciesKey,
      setSvFullyActiveSpeciesKeys,
      setSvRegionExplicitlySelected,
      setSvSecondSpeciesKey,
      setSvThirdSpeciesKey,
      suppressViewSyncRef,
      svAnchorRegionId,
      svAnchorSpeciesKey,
      svRegionExplicitlySelected,
      svSecondSpeciesKey,
      svThirdSpeciesKey,
  }, ...args), [
    buildFocusFromActive,
    config,
    getAlignedGenomeConfigForView,
    hasGenomeAssignmentChanges,
    handleBrowserConfigChange,
    svAnchorRegionId,
    svAnchorSpeciesKey,
    svSecondSpeciesKey,
    svThirdSpeciesKey,
    svRegionExplicitlySelected,
  ])

  const handleStructuralVariationPillToggle = useCallback((...args) => toggleStructuralVariationPill({
      handleSpeciesPillToggle,
      handleStructuralVariationGenomeOrderChange,
      svAnchorSpecies,
      svSecondSpecies,
      svThirdSpecies,
  }, ...args), [
    handleSpeciesPillToggle,
    handleStructuralVariationGenomeOrderChange,
    svAnchorSpecies,
    svSecondSpecies,
    svThirdSpecies,
  ])

  const handleRemoveSpeciesFromList = useCallback(async (species) => {
    if (!species) return { ok: false, reason: 'missing_species' }

    const key = speciesItemKey(species)
    const currentConfig = configRef.current || config
    const active = dedupeSpeciesList(currentConfig?.active_species)
    const inactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)

    const nextActive = active.filter((item) => speciesItemKey(item) !== key)
    const nextInactive = inactive.filter((item) => speciesItemKey(item) !== key)
    const activeChanged = !speciesListsEqualByKey(active, nextActive)

    suppressViewSyncRef.current = true
    try {
      setInactiveSelectedSpecies(nextInactive)

      let nextFocus = buildFocusFromActive(active, dualViewFocusRef.current)
      if (nextFocus.primaryKey === key) {
        nextFocus.primaryKey = nextFocus.secondaryKey || ''
        nextFocus.secondaryKey = ''
      } else if (nextFocus.secondaryKey === key) {
        nextFocus.secondaryKey = ''
      }
      nextFocus = buildFocusFromActive(nextActive, nextFocus)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

	      persistNextPreviousSessionGenomes([...nextActive, ...nextInactive], { ...currentConfig, active_species: nextActive })
	      if (!activeChanged) return { ok: true }

	      const nextConfig = getAlignedGenomeConfigForView(
	        withNextPreviousSessionGenomes(
	          { ...currentConfig, active_species: nextActive },
	          [...nextActive, ...nextInactive]
	        ),
	        currentView,
	        nextFocus
	      )
      await handleBrowserConfigChange(nextConfig)
      return { ok: true }
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView, persistNextPreviousSessionGenomes])

  const handlePromoteSecondaryToPrimary = useCallback(async () => {
    const currentConfig = configRef.current || config
    const active = dedupeSpeciesList(currentConfig?.active_species)
    if (active.length === 0) return { ok: false, reason: 'no_active_genomes' }

    const primarySpecies = active.find((species) => species?.files?.gff3 === currentConfig?.ref_gff) || null
    const secondarySpecies = active.find((species) => species?.files?.gff3 === currentConfig?.target_gff) || null
    if (!secondarySpecies) return { ok: false, reason: 'no_secondary' }

    const nextFocus = buildFocusFromActive(active, {
      primaryKey: speciesItemKey(secondarySpecies),
      secondaryKey: primarySpecies ? speciesItemKey(primarySpecies) : '',
    })

    suppressViewSyncRef.current = true
    try {
      dualViewFocusRef.current = nextFocus
      setDualViewFocus(nextFocus)

      const nextConfig = getAlignedGenomeConfigForView(currentConfig, currentView, nextFocus)
      if (hasGenomeAssignmentChanges(currentConfig, nextConfig)) {
        await handleBrowserConfigChange(nextConfig)
      }
      return { ok: true }
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView, hasGenomeAssignmentChanges])

  const alignmentLoaded = loadedParams !== null &&
    loadedParams.refId === refResolved?.selectedTranscriptId &&
    loadedParams.targetId === tgtResolved?.selectedTranscriptId &&
    loadedParams.refFlank === refFlankBp &&
    loadedParams.tgtFlank === tgtFlankBp
  const bothResolved = !!refResolved?.selectedTranscriptId && !!tgtResolved?.selectedTranscriptId

  const G1_TAG = 'G1'
  const G2_TAG = 'G2'
  const g1Label = buildGenomeLabel(G1_TAG, refSpecies, 'Reference')
  const g2Label = buildGenomeLabel(G2_TAG, tgtSpecies, 'Secondary')
  const g1PillLabel = buildGenomePillLabel(refSpecies)
  const g2PillLabel = buildGenomePillLabel(tgtSpecies)
  const svAnchorPillLabel = buildGenomePillLabel(svAnchorSpecies)
  const svSecondPillLabel = buildGenomePillLabel(svSecondSpecies)
  const svThirdPillLabel = buildGenomePillLabel(svThirdSpecies)
  const structuralVariationViewKey = [
    'structural_variation',
    speciesItemKey(svAnchorSpecies),
  ].join('|')
  const featureExplorerAvailableGenomes = useMemo(
    () => dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3)),
    [config?.active_species]
  )
  const featureExplorerDefaultGenomeKey = refGenomeKey || (featureExplorerAvailableGenomes[0] ? speciesItemKey(featureExplorerAvailableGenomes[0]) : '')
  const focusGeneByGenome = useMemo(() => {
    const next = { ...(browserFocusByGenome || {}) }
    if (refGenomeKey) {
      if (browserRefGene) next[refGenomeKey] = browserRefGene
      else delete next[refGenomeKey]
    }
    if (tgtGenomeKey && tgtGenomeKey !== refGenomeKey) {
      if (browserTgtGene) next[tgtGenomeKey] = browserTgtGene
      else delete next[tgtGenomeKey]
    }
    return next
  }, [browserFocusByGenome, browserRefGene, browserTgtGene, refGenomeKey, tgtGenomeKey])
  // Where each genome is being read, gathered from wherever the reader left it:
  // the gene in focus in the browser's panels, and any region pinned there. The
  // sequence view opens on this when the reader switches genomes, rather than
  // dropping them at that genome's default starting locus.
  const genomeStartingPoints = useMemo(() => {
    const out = {}
    for (const [key, gene] of Object.entries(focusGeneByGenome || {})) {
      if (gene) out[key] = { gene }
    }
    for (const [key, location] of Object.entries(browserLocationFocusByGenome || {})) {
      if (location) out[key] = { ...(out[key] || {}), location }
    }
    return out
  }, [focusGeneByGenome, browserLocationFocusByGenome])

  const neighbourhoodGenomes = useMemo(
    () => {
      const activeGenomes = dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3))
      if (!activeGenomes.length) return []
      const byKey = new Map(activeGenomes.map((species) => [speciesItemKey(species), species]))
      const ordered = []
      const seen = new Set()
      for (const key of neighbourhoodGenomeOrderKeys) {
        const species = byKey.get(key)
        if (!species || seen.has(key)) continue
        seen.add(key)
        ordered.push(species)
      }
      for (const species of activeGenomes) {
        const key = speciesItemKey(species)
        if (!key || seen.has(key)) continue
        seen.add(key)
        ordered.push(species)
      }
      return ordered
    },
    [config?.active_species, neighbourhoodGenomeOrderKeys]
  )

  // One gene for every genome shown in Neighbourhood, from the search across the top
  // of its controls. Each genome resolves the same symbol or ID on its own, as its Go
  // button would, so a genome without it reports that in its own row.
  const handleNeighbourhoodSearchAll = useCallback((query) => {
    const token = String(query || '').trim()
    if (!token) return
    const keys = neighbourhoodGenomes
      .map((species) => speciesItemKey(species))
      .filter((key) => key && !neighbourhoodDisabledByGenome?.[key])
    if (!keys.length) return
    setNeighbourhoodQueryByGenome((prev) => {
      const next = { ...(prev || {}) }
      for (const key of keys) next[key] = token
      return next
    })
    for (const key of keys) handleNeighbourhoodResolveGenome(key, token)
  }, [neighbourhoodGenomes, neighbourhoodDisabledByGenome, handleNeighbourhoodResolveGenome])

  // Pre-check homology-TSV availability for every genome currently in the Neighbourhood
  // view, so the "Use Homology" button's enabled/disabled state and tooltip are correct
  // before the user ever clicks it. Genomes with a local file are 'local' immediately
  // (no network call); others are checked once each against the remote files catalog.
  useEffect(() => {
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      if (!key) continue
      if (species?.files?.homology) {
        setNeighbourhoodHomologyAvailabilityByGenome((prev) => (
          prev?.[key] === 'local' ? prev : { ...prev, [key]: 'local' }
        ))
        continue
      }
      if (neighbourhoodHomologyCheckedGenomeKeysRef.current.has(key)) continue
      neighbourhoodHomologyCheckedGenomeKeysRef.current.add(key)

      const provider = normalizeGenomeProvider(species)
      if (provider === MANUAL_PROVIDER) {
        setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'unavailable' }))
        continue
      }

      const speciesKey = String(species?.species_key || '').trim()
      const assembly = getAssemblyAccession(species)
      if (!speciesKey || !assembly) {
        setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'unavailable' }))
        continue
      }

      setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'checking' }))
      const url = `${API_BASE}/api/remote/files/${encodeURIComponent(speciesKey)}/${encodeURIComponent(assembly)}?provider=${encodeURIComponent(provider)}&file_types=homology`
      fetch(url)
        .then((res) => (res.ok ? res.json() : []))
        .then((files) => {
          const available = Array.isArray(files) && files.some((f) => f?.type === 'homology')
          setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: available ? 'downloadable' : 'unavailable' }))
        })
        .catch(() => {
          setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'unavailable' }))
        })
    }
  }, [neighbourhoodGenomes])

  // "Use Homology" — toggle real Compara-homology links in the Neighbourhood view,
  // auto-downloading any missing-but-available homology TSV files first.
  const handleNeighbourhoodUseHomologyClick = useCallback((...args) => seedNeighbourhoodFromHomologyHit({
      config,
      neighbourhoodDisabledByGenome,
      neighbourhoodGenomes,
      neighbourhoodHomologyAvailabilityByGenome,
      neighbourhoodHomologyAvailabilityByGenomeRef,
      neighbourhoodUseHomology,
      setNeighbourhoodHomologyAvailabilityByGenome,
      setNeighbourhoodHomologyDownloadTaskByGenome,
      setNeighbourhoodHomologyError,
      setNeighbourhoodHomologyPairLoading,
      setNeighbourhoodUseHomology,
  }, ...args), [neighbourhoodUseHomology, neighbourhoodGenomes, neighbourhoodHomologyAvailabilityByGenome, config?.output_dir])

  // Auto-populate focus genes for genomes that don't have one yet, using the first
  // (primary) enabled genome's focus gene as the sole source — never the reverse, and
  // never from any other non-primary genome. Symbol/ID mode looks for the same gene
  // symbol/ID in each missing genome; Homology mode looks up the best Compara hit.
  useEffect(() => {
    // Focus is shared between views, but cross-genome completion belongs to the
    // Neighbourhood view. Without this guard, selecting a gene in Genome Browser
    // searched every other active genome even though the user had not linked them.
    if (currentView !== 'neighbourhood') return

    const enabledGenomes = neighbourhoodGenomes.filter((species) => {
      const key = speciesItemKey(species)
      return key && !neighbourhoodDisabledByGenome?.[key]
    })
    if (enabledGenomes.length < 2) return

    const primarySpecies = enabledGenomes[0]
    const primaryKey = speciesItemKey(primarySpecies)
    const primaryGene = focusGeneByGenome?.[primaryKey]
    const primaryGeneId = String(primaryGene?.id || '').trim()
    if (!primaryGeneId) return

    const missingGenomes = enabledGenomes.slice(1).filter((species) => {
      const key = speciesItemKey(species)
      return key && !focusGeneByGenome?.[key]
    })
    if (!missingGenomes.length) return

    const mode = neighbourhoodUseHomology ? 'homology' : 'symbol'
    const attemptSignature = `${mode}:${primaryKey}:${primaryGeneId}`
    const pendingGenomes = missingGenomes.filter((species) => (
      neighbourhoodAnchorResolutionAttemptRef.current[speciesItemKey(species)] !== attemptSignature
    ))
    if (!pendingGenomes.length) return
    for (const species of pendingGenomes) {
      neighbourhoodAnchorResolutionAttemptRef.current[speciesItemKey(species)] = attemptSignature
    }

    let cancelled = false

    const run = async () => {
      const noHitKeys = []

      if (mode === 'symbol') {
        // Same endpoint the Genome Browser's own cross-genome "link genes" feature
        // uses (case-insensitive name/ID match) — kept consistent so a gene that
        // resolves there also resolves here, regardless of symbol-casing differences
        // between genomes' own annotations.
        const query = String(primaryGene?.name || primaryGene?.id || '').trim()
        await Promise.all(pendingGenomes.map(async (species) => {
          const key = speciesItemKey(species)
          if (!query) { noHitKeys.push(key); return }
          try {
            const res = await fetch(`${API_BASE}/api/browse/search_gene?genome=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`)
            if (!res.ok) { noHitKeys.push(key); return }
            const gene = await res.json()
            if (!gene?.id) { noHitKeys.push(key); return }
            if (!cancelled) {
              handleGenomeFocusGeneSelect(key, gene)
              const label = String(gene?.name || gene?.id || query).trim()
              if (label) setNeighbourhoodQueryByGenome((prev) => ({ ...prev, [key]: label }))
              handleNeighbourhoodResolveGenome(key, label || gene.id)
            }
          } catch {
            noHitKeys.push(key)
          }
        }))
      } else {
        const targetKeys = pendingGenomes.map((species) => speciesItemKey(species)).filter(Boolean)
        try {
          const url = `${API_BASE}/api/neighbourhood/homology_anchor?genome=${encodeURIComponent(primaryKey)}&gene_id=${encodeURIComponent(primaryGeneId)}&target_genomes=${encodeURIComponent(targetKeys.join(','))}`
          const res = await fetch(url)
          const data = res.ok ? await res.json() : null
          const hits = data?.hits || {}
          for (const key of targetKeys) {
            const hit = hits?.[key]
            if (hit?.gene_id && !cancelled) {
              const gene = { id: hit.gene_id, name: hit.gene_name || hit.gene_id }
              handleGenomeFocusGeneSelect(key, gene)
              const label = String(gene.name || gene.id || '').trim()
              if (label) setNeighbourhoodQueryByGenome((prev) => ({ ...prev, [key]: label }))
              handleNeighbourhoodResolveGenome(key, label || gene.id)
            } else {
              noHitKeys.push(key)
            }
          }
        } catch {
          noHitKeys.push(...targetKeys)
        }
      }

      if (cancelled) return
      const pendingKeySet = new Set(pendingGenomes.map((species) => speciesItemKey(species)))
      setNeighbourhoodNoHitGenomeKeys((prev) => [...prev.filter((key) => !pendingKeySet.has(key)), ...noHitKeys])
    }

    run()
    return () => { cancelled = true }
  }, [currentView, neighbourhoodGenomes, neighbourhoodDisabledByGenome, focusGeneByGenome, neighbourhoodUseHomology, handleGenomeFocusGeneSelect, handleNeighbourhoodResolveGenome])

  // Independent cleanup: drop any genome from the "no hit" list as soon as it has a
  // focus gene from any source (auto-resolved or chosen directly by the user), or once
  // it's no longer an active genome at all.
  useEffect(() => {
    setNeighbourhoodNoHitGenomeKeys((prev) => {
      if (!prev.length) return prev
      const activeKeys = new Set(neighbourhoodGenomes.map((species) => speciesItemKey(species)))
      const next = prev.filter((key) => activeKeys.has(key) && !focusGeneByGenome?.[key])
      return next.length === prev.length ? prev : next
    })
  }, [neighbourhoodGenomes, focusGeneByGenome])

  // Backstop for auto-populated Neighbourhood search boxes: if a row has a
  // query label but no loaded track yet, resolve that label just as the Go
  // button would. This keeps symbol-case matches such as PHGDH -> Phgdh from
  // stopping at "text in the box" without loading the mouse region.
  useEffect(() => {
    if (currentView !== 'neighbourhood') return

    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      if (!key || neighbourhoodDisabledByGenome?.[key]) continue
      if (neighbourhoodLoadingByGenome?.[key] || neighbourhoodResolvingByGenome?.[key]) continue

      const query = String(neighbourhoodQueryByGenome?.[key] || '').trim()
      if (!query) continue

      const track = neighbourhoodTracksByGenome?.[key]
      const hasLoadedTrack = Array.isArray(track?.genes) && track.genes.length > 0
      if (hasLoadedTrack) continue

      const queryNorm = query.toLowerCase()
      const signature = `${key}:${queryNorm}`
      if (neighbourhoodQueryResolutionAttemptRef.current[key] === signature) continue
      neighbourhoodQueryResolutionAttemptRef.current[key] = signature
      handleNeighbourhoodResolveGenome(key, query)
    }
  }, [
    currentView,
    neighbourhoodGenomes,
    neighbourhoodDisabledByGenome,
    neighbourhoodLoadingByGenome,
    neighbourhoodResolvingByGenome,
    neighbourhoodQueryByGenome,
    neighbourhoodTracksByGenome,
    handleNeighbourhoodResolveGenome,
  ])

  const neighbourhoodLoadingStateByGenome = useMemo(() => {
    const next = {}
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      next[key] = Boolean(neighbourhoodLoadingByGenome?.[key] || neighbourhoodResolvingByGenome?.[key])
    }
    return next
  }, [neighbourhoodGenomes, neighbourhoodLoadingByGenome, neighbourhoodResolvingByGenome])
  const neighbourhoodQueryStateByGenome = useMemo(() => {
    const next = {}
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      next[key] = String(neighbourhoodQueryByGenome?.[key] || '')
    }
    return next
  }, [neighbourhoodGenomes, neighbourhoodQueryByGenome])
  const neighbourhoodTrackStateByGenome = useMemo(() => {
    const next = {}
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      const row = neighbourhoodTracksByGenome?.[key]
      next[key] = row || { genes: [], centerGeneId: '', requestGeneId: '', windowSize: 0 }
    }
    return next
  }, [neighbourhoodGenomes, neighbourhoodTracksByGenome])
  const neighbourhoodErrorStateByGenome = useMemo(() => {
    const next = {}
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      next[key] = String(neighbourhoodErrorByGenome?.[key] || '')
    }
    return next
  }, [neighbourhoodGenomes, neighbourhoodErrorByGenome])
  const featureExplorerSelectedGenome = useMemo(() => {
    const key = String(featureExplorerGenomeKey || '').trim()
    return featureExplorerAvailableGenomes.find((species) => speciesItemKey(species) === key) || null
  }, [featureExplorerAvailableGenomes, featureExplorerGenomeKey])
  const featureExplorerActiveGenome = featureExplorerSelectedGenome || refSpecies || featureExplorerAvailableGenomes[0] || null
  const featureExplorerActiveGenomeKey = featureExplorerActiveGenome ? speciesItemKey(featureExplorerActiveGenome) : ''
  const featureExplorerSeedQuery = useMemo(() => {
    const genomeKey = String(featureExplorerActiveGenomeKey || '').trim()
    if (!genomeKey) return ''
    const focusedGene = focusGeneByGenome?.[genomeKey]
    if (focusedGene?.name || focusedGene?.id) return focusedGene.name || focusedGene.id
    return ''
  }, [featureExplorerActiveGenomeKey, focusGeneByGenome])
  const activeAppButtons = useMemo(
    () => normalizeActiveAppButtons(config.active_app_buttons),
    [config.active_app_buttons]
  )

  // ── Achievements ────────────────────────────────────────────────────────────
  //
  // Tracked whether or not achievements are switched on (with the button in the view);
  // the tracker only shows unlock notifications once they are. Everything here reads the
  // user's own configuration (`userConfig`), never a tutorial's sandbox, and the tracker
  // ignores anything done during a tutorial in any case.
  const [achievementFocusId, setAchievementFocusId] = useState('')
  useEffect(() => { startAchievements() }, [])
  useEffect(() => {
    setAchievementsContext({ currentView, screenshotMode })
  }, [currentView, screenshotMode])

  // The store lives in the output directory, so a new one means a different file.
  const achievementsOutputDirRef = useRef(userConfig?.output_dir || '')
  useEffect(() => {
    const outputDir = userConfig?.output_dir || ''
    if (outputDir === achievementsOutputDirRef.current) return
    achievementsOutputDirRef.current = outputDir
    void loadAchievements()
  }, [userConfig?.output_dir])

  useEffect(() => {
    if (currentView) trackAchievement('view.visit', currentView)
  }, [currentView])

  const activeGenomeCount = Array.isArray(config?.active_species) ? config.active_species.length : 0
  useEffect(() => {
    if (currentView === 'genome_browser' && activeGenomeCount >= 2) trackAchievement('browser.multiverse')
  }, [currentView, activeGenomeCount])

  // Genome Browser → Feature Explorer with a gene in focus.
  const previousViewForAchievementsRef = useRef(currentView)
  const focusedGeneForAchievementsRef = useRef(false)
  focusedGeneForAchievementsRef.current = Object.values(focusGeneByGenome || {}).some(Boolean)
  useEffect(() => {
    const previous = previousViewForAchievementsRef.current
    previousViewForAchievementsRef.current = currentView
    if (previous === 'genome_browser' && currentView === 'feature_explorer' && focusedGeneForAchievementsRef.current) {
      trackAchievement('browser.toFeatureExplorer')
    }
  }, [currentView])

  // What is already true of the saved configuration. Re-run after the store loads and
  // after a reset, as well as whenever these settings change.
  const achievementConfigRef = useRef(userConfig)
  achievementConfigRef.current = userConfig
  const reconcileConfigAchievements = useCallback(() => {
    const saved = achievementConfigRef.current || {}
    const buttons = normalizeActiveAppButtons(saved.active_app_buttons)
    if (isRearrangedFromDefault(buttons)) trackAchievement('appButtons.rearranged')
    if (Array.isArray(saved.genome_playlists) && saved.genome_playlists.length) trackAchievement('playlist.created')
    if (Array.isArray(saved.manual_species) && saved.manual_species.length) trackAchievement('genome.manualAdded')
    // Only colours the user picked are stored per genome (the default is not), so each
    // key is a genome someone chose a colour for.
    for (const genomeKey of Object.keys(saved.genome_colors || {})) trackAchievement('genome.colour', genomeKey)
  }, [])
  useEffect(() => registerAchievementReconciler(reconcileConfigAchievements), [reconcileConfigAchievements])
  useEffect(() => {
    reconcileConfigAchievements()
  }, [reconcileConfigAchievements, userConfig?.active_app_buttons, userConfig?.genome_playlists, userConfig?.manual_species, userConfig?.genome_colors])
  const topBarButtonLayout = useMemo(() => buildAppButtonLayout(activeAppButtons), [activeAppButtons])
  const topBarButtonRows = topBarButtonLayout.rows
  const topBarOverflows = topBarButtonLayout.overflows
  const sortedGenomePlaylists = useMemo(() => {
    return [...(Array.isArray(config?.genome_playlists) ? config.genome_playlists : [])]
      .filter((playlist) => (
        playlist?.id &&
        String(playlist?.name || '').trim() &&
        !playlist?.hidden &&
        !isNextPreviousSessionPlaylist(playlist) &&
        (!isPreviousSessionPlaylist(playlist) || (playlist.genomes || []).length > 0)
      ))
      .sort((a, b) => {
        if (a?.id === PREVIOUS_SESSION_PLAYLIST_ID) return -1
        if (b?.id === PREVIOUS_SESSION_PLAYLIST_ID) return 1
        return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
      })
  }, [config?.genome_playlists])
  const selectorPlaylistConfig = useMemo(() => ({
    ...config,
    genome_playlists: (Array.isArray(config?.genome_playlists) ? config.genome_playlists : [])
      .filter((playlist) => !playlist?.hidden && !isNextPreviousSessionPlaylist(playlist) && (!isPreviousSessionPlaylist(playlist) || (playlist.genomes || []).length > 0)),
  }), [config])
  const topListMode = 'all'
  const contextFullyActiveSpecies = useMemo(() => {
    const active = Array.isArray(config?.active_species) ? config.active_species : []
    // The sequence view keeps its own choice of genome rather than following
    // the shared two-genome focus, so it says which one, and only for the
    // strip: nothing here is written back to the configuration.
    const focus = currentView === 'sequence' && sequenceGenomeKey
      ? { primaryKey: sequenceGenomeKey, secondaryKey: '' }
      : dualViewFocus
    return getContextFullyActiveSpecies(active, currentView, focus)
  }, [config?.active_species, currentView, dualViewFocus, sequenceGenomeKey, getContextFullyActiveSpecies])
  const selectedSpeciesKeysForView = useMemo(() => {
    if (currentView === 'structural_variation') {
      if (svFullyActiveSpeciesKeys.length) return new Set(svFullyActiveSpeciesKeys)
      return new Set(svAnchorSpecies ? [speciesItemKey(svAnchorSpecies)] : [])
    }
    return new Set(contextFullyActiveSpecies.map((species) => speciesItemKey(species)))
  }, [contextFullyActiveSpecies, currentView, svAnchorSpecies, svFullyActiveSpeciesKeys])
  const semiSelectedSpeciesKeysForView = useMemo(() => {
    const active = Array.isArray(config?.active_species) ? config.active_species : []
    const selected = selectedSpeciesKeysForView
    const semi = new Set()
    for (const species of active) {
      const key = speciesItemKey(species)
      if (selected.has(key)) continue
      semi.add(key)
    }
    return semi
  }, [config?.active_species, selectedSpeciesKeysForView])
  // The active genomes as an ordered list: the overview colours its pills by
  // position in it, the same way the browser colours its panels.
  const statsActiveGenomeKeys = useMemo(
    () => [...selectedSpeciesKeysForView],
    [selectedSpeciesKeysForView],
  )
  const topBarSpecies = useMemo(() => {
    const active = Array.isArray(config?.active_species) ? config.active_species : []
    const fullyActiveKeys = new Set(contextFullyActiveSpecies.map((species) => speciesItemKey(species)))
    const semiActive = active.filter((species) => !fullyActiveKeys.has(speciesItemKey(species)))
    const orderedActive = [...contextFullyActiveSpecies, ...semiActive]
    const orderedActiveKeys = new Set(orderedActive.map((species) => speciesItemKey(species)))
    const activeKeys = new Set(active.map((species) => speciesItemKey(species)))
    // Inactive selections are component state rather than configuration, so the
    // tutorial override cannot replace them. Never append that user-owned state while
    // the sandbox is up: a tutorial starts with no pills unless it explicitly activates
    // one of its own datasets, and dropping the override reveals the user's list again.
    const extras = tutorialConfig
      ? (tutorialConfig.tutorial_selected_genomes || []).filter((species) => !activeKeys.has(speciesItemKey(species)))
      : inactiveSelectedSpecies.filter((species) => !activeKeys.has(speciesItemKey(species)) && !orderedActiveKeys.has(speciesItemKey(species)))
    if (tutorialConfig?.tutorial_selected_genomes) return tutorialConfig.tutorial_selected_genomes
    return [...orderedActive, ...extras]
  }, [config?.active_species, contextFullyActiveSpecies, inactiveSelectedSpecies, tutorialConfig])
  const handleOpenAlignmentExplorerLoci = async ({ loci = [] } = {}) => {
    const wanted=[]
    for(const locus of loci){
      const assembly=String(locus?.assembly||'').trim().toUpperCase()
      const species=topBarSpecies.find(item=>getAssemblyAccession(item).toUpperCase()===assembly&&item?.files?.gff3)
      if(species&&!wanted.some(item=>speciesItemKey(item)===speciesItemKey(species)))wanted.push(species)
    }
    if(!wanted.length)return
    const wantedKeys=new Set(wanted.map(speciesItemKey))
    const inactive=topBarSpecies.filter(species=>!wantedKeys.has(speciesItemKey(species)))
    const nextFocus=buildFocusFromActive(wanted,{
      primaryKey:speciesItemKey(wanted[0]),
      secondaryKey:wanted[1]?speciesItemKey(wanted[1]):'',
    })
    const currentConfig=tutorialConfig||configRef.current||config
    suppressViewSyncRef.current=true
    try{
      if(!tutorialConfig)setInactiveSelectedSpecies(inactive)
      dualViewFocusRef.current=nextFocus;setDualViewFocus(nextFocus)
      setCurrentView('genome_browser')
      const nextConfig=getAlignedGenomeConfigForView(
        withNextPreviousSessionGenomes({...currentConfig,active_species:wanted},topBarSpecies),
        'genome_browser',nextFocus,
      )
      await handleBrowserConfigChange(nextConfig)
      const positioned=loci.map(locus=>{
        const species=wanted.find(item=>getAssemblyAccession(item).toUpperCase()===String(locus?.assembly||'').trim().toUpperCase())
        return species?{...locus,genomeKey:speciesItemKey(species)}:null
      }).filter(Boolean)
      // These are regions, not synthetic genes. Using the browser's location
      // navigation gives every panel its location focus and frames it without
      // reserving the gene drawer width (which can magnify narrow multi-genome
      // panels by an order of magnitude).
      setBrowserLocationFocusByGenome(Object.fromEntries(positioned.map(locus=>[
        locus.genomeKey,
        {chrom:locus.chrom||locus.region,start:locus.start,end:locus.end,strand:locus.strand},
      ])))
    }finally{suppressViewSyncRef.current=false}
  }
  const selectorSelectedSpecies = useMemo(() => (
    tutorialConfig
      ? dedupeSpeciesList([...(config?.active_species || []), ...inactiveSelectedSpecies])
      : topBarSpecies
  ), [config?.active_species, inactiveSelectedSpecies, topBarSpecies, tutorialConfig])
  // A fixed selector scene used to hide this strip outright, so that ticking a genome
  // could not change the header height and push the rows being selected down the page.
  // That also took away the very thing selecting a genome is supposed to show. Instead
  // the strip keeps its place in the layout from the moment the scene arrives — present
  // but invisible while nothing is selected — so the first tick fills a space that was
  // already there and nothing below it moves.
  //
  // Reserved for any tutorial standing in the Genome Selector, not only one that asked for
  // the fixed list scene. A tutorial that walks the reader through registering a genome and
  // then ticking it has the same two problems — a header that grows under the row being
  // ticked, and a step that points at a strip which does not exist yet — without ever
  // framing the list.
  const reserveTutorialSelectorPills = Boolean(tutorialConfig && currentView === 'genome_selector')
  // With nothing in it the strip used to vanish, which left the emptiest possible app
  // saying nothing about how to fill it, and made the header jump the moment a first
  // genome arrived. Not during a tutorial: its sandbox has its own way in, and telling a
  // reader to go and download something is the opposite of what the tutorial is doing.
  const showNoGenomesMessage = configLoaded && topBarSpecies.length === 0 && !tutorialConfig
  const showsPillsStrip = Boolean(
    !headerCollapsed
    && !shouldShowWindowsBackendSetup
    && (topBarSpecies.length > 0 || reserveTutorialSelectorPills || showNoGenomesMessage)
  )

  useEffect(() => {
    // The top bar intentionally changes when a tutorial takes over. It is a view of the
    // sandbox, not a new "previous session" selection to persist for the user.
    if (!configLoaded || tutorialConfig) return
    persistNextPreviousSessionGenomes(topBarSpecies, configRef.current || config)
  }, [configLoaded, topBarSpecies, persistNextPreviousSessionGenomes, tutorialConfig])

  useEffect(() => {
    const previousView = previousViewRef.current
    if (currentView === 'feature_explorer' && previousView !== 'feature_explorer') {
      setFeatureExplorerGenomeKey(featureExplorerDefaultGenomeKey)
    }
    previousViewRef.current = currentView
  }, [currentView, featureExplorerDefaultGenomeKey])

  useEffect(() => {
    const validKeys = new Set(featureExplorerAvailableGenomes.map((species) => speciesItemKey(species)))
    const fallbackKey = String(featureExplorerDefaultGenomeKey || '').trim()
    setFeatureExplorerGenomeKey((prev) => {
      const currentKey = String(prev || '').trim()
      if (currentKey && validKeys.has(currentKey)) return prev
      return fallbackKey
    })
  }, [featureExplorerAvailableGenomes, featureExplorerDefaultGenomeKey])

  const handleFeatureExplorerGenomeSelect = useCallback((species) => {
    const nextKey = speciesItemKey(species)
    if (!nextKey || nextKey === featureExplorerActiveGenomeKey) return
    setFeatureExplorerGenomeKey(nextKey)
  }, [featureExplorerActiveGenomeKey])

  const alignmentInputByGenomeKey = useMemo(() => {
    const next = new Map()
    for (const row of alignmentInputs || []) {
      const key = String(row?.genome_key || '').trim()
      if (!key) continue
      next.set(key, row)
    }
    return next
  }, [alignmentInputs])

  const alignmentDisplayRows = useMemo((...args) => computeAlignmentDisplayRows({ alignmentInputByGenomeKey, loadedAlignmentBaselineByGenome, multiAlignmentResult }, ...args), [multiAlignmentResult?.rows, alignmentInputByGenomeKey, loadedAlignmentBaselineByGenome, alignmentGlobalFlanks])

  const alignmentDisplayMetaByGenomeKey = useMemo(() => {
    const next = {}
    try {
      for (const row of alignmentDisplayRows) {
        const key = String(row?.genome_key || row?.genome || '').trim()
        if (!key) continue
        next[key] = {
          geneLabel: String(row?.gene_label || '').trim(),
          selectedTranscriptId: String(row?.transcript_id || '').trim(),
          coverageStatus: String(row?.coverage_status || 'full').trim(),
          notAlignedBpLeft: Math.max(0, Number(row?.not_aligned_bp_left) || 0),
          notAlignedBpRight: Math.max(0, Number(row?.not_aligned_bp_right) || 0),
        }
      }
    } catch (error) {
      console.error('Failed to derive alignment display metadata:', error)
    }
    return next
  }, [alignmentDisplayRows])

  const alignmentViewerDisplayKey = useMemo(() => {
    return alignmentDisplayRows.map((row) => {
      const genomeKey = String(row?.genome_key || row?.genome || '').trim()
      const transcriptId = String(row?.transcript_id || '').trim()
      const coverageStatus = String(row?.coverage_status || 'full').trim()
      const coveredStart = Number.isFinite(Number(row?.covered_column_start)) ? Number(row.covered_column_start) : ''
      const coveredEnd = Number.isFinite(Number(row?.covered_column_end)) ? Number(row.covered_column_end) : ''
      const noCoverage = row?.no_coverage ? '1' : '0'
      return [genomeKey, transcriptId, coverageStatus, coveredStart, coveredEnd, noCoverage].join(':')
    }).join('|')
  }, [alignmentDisplayRows])

  const alignmentIncludedResolvedCount = useMemo(
    () => (alignmentInputs || []).filter((row) => row.status === 'resolved').length,
    [alignmentInputs]
  )
  const alignmentNeedsRerun = useMemo(() => {
    try {
      if (!multiAlignmentResult) return false
      const loadedGenomeKeys = new Set(
        alignmentDisplayRows.map((row) => String(row?.genome_key || row?.genome || '').trim()).filter(Boolean)
      )
      const hasCoverageIssue = alignmentDisplayRows.some((row) => {
        const status = String(row?.coverage_status || 'full')
        return status === 'outside' || status.startsWith('truncated') || status === 'partial'
      })
      const hasResolvedGenomeOutsideLoadedAlignment = (alignmentInputs || []).some((row) => {
        const genomeKey = String(row?.genome_key || '').trim()
        const selectedTranscriptId = String(row?.settings?.selectedTranscriptId || row?.resolved?.selectedTranscriptId || '').trim()
        if (!genomeKey || row?.status !== 'resolved' || !selectedTranscriptId) return false
        return !loadedGenomeKeys.has(genomeKey)
      })
      return hasCoverageIssue || hasResolvedGenomeOutsideLoadedAlignment
    } catch (error) {
      console.error('Failed to derive alignment rerun state:', error)
      return false
    }
  }, [multiAlignmentResult, alignmentDisplayRows, alignmentInputs])
  const alignedGenomeCount = useMemo(
    () => (Array.isArray(multiAlignmentResult?.rows) ? multiAlignmentResult.rows.length : 0),
    [multiAlignmentResult]
  )
  const unalignedGenomeCount = Math.max(0, (alignmentInputs || []).length - alignedGenomeCount)
  const alignmentPreparedCount = useMemo(
    () => (alignmentInputs || []).filter((row) => {
      const transcriptId = row.settings?.selectedTranscriptId || row.resolved?.selectedTranscriptId || ''
      return Boolean(String(transcriptId).trim())
    }).length,
    [alignmentInputs]
  )
  const alignmentRunDisabled = alignmentIncludedResolvedCount < 2 || alignmentViewLoading

  useEffect(() => {
    const active = Array.isArray(config?.active_species) ? config.active_species : []
    const activeKeys = new Set(active.map((species) => speciesItemKey(species)))
    setInactiveSelectedSpecies((prev) => {
      const next = prev.filter((species) => !activeKeys.has(speciesItemKey(species)))
      return speciesListsEqualByKey(prev, next) ? prev : next
    })
  }, [config?.active_species])

  // A view does not need a button in the top bar to be shown: Home's cards, links between
  // views and tutorials all open views the user may have left out of the bar. What this
  // handles is the button of the view on screen being taken away — removed in the
  // organiser while looking at it, or missing from the saved bar that loads at startup —
  // which moves the user to the first view the bar does have.
  //
  // It used to run whenever the view changed and send any view without a button straight
  // back, so a Home card for such a view appeared to do nothing.
  const currentViewForButtonsRef = useRef(currentView)
  currentViewForButtonsRef.current = currentView
  const previousActiveAppButtonsRef = useRef(activeAppButtons)
  useEffect(() => {
    const previous = previousActiveAppButtonsRef.current
    previousActiveAppButtonsRef.current = activeAppButtons
    if (previous === activeAppButtons) return
    const view = currentViewForButtonsRef.current
    const hasButton = (buttonIds) => buttonIds.some((buttonId) => APP_BUTTON_META[buttonId]?.viewId === view)
    if (!hasButton(previous) || hasButton(activeAppButtons)) return
    const fallbackView = activeAppButtons
      .map((buttonId) => APP_BUTTON_META[buttonId])
      .find((meta) => meta?.kind === 'data_view')?.viewId || 'configuration'
    if (fallbackView !== view) {
      setCurrentView(fallbackView)
    }
  }, [activeAppButtons])

  useEffect(() => {
    if (!screenshotSupported || !screenshotAvailable) {
      setScreenshotMode(false)
    }
  }, [screenshotAvailable, screenshotSupported])

  useEffect(() => {
    if (!fallbackScreenshotAvailable) {
      setSelectedFallbackScreenshotTarget(null)
    }
  }, [fallbackScreenshotAvailable])

  useEffect(() => {
    setSelectedFallbackScreenshotTarget(null)
  }, [currentView])

  useEffect(() => {
    if (!usingFallbackScreenshot) return undefined
    const previousBodyCursor = document.body.style.cursor
    const previousRootCursor = document.documentElement.style.cursor
    document.body.style.cursor = 'crosshair'
    document.documentElement.style.cursor = 'crosshair'
    return () => {
      document.body.style.cursor = previousBodyCursor
      document.documentElement.style.cursor = previousRootCursor
    }
  }, [usingFallbackScreenshot])

  /** Open or close the top-bar playlist popover because a tutorial step says so.
   *
   * The same reconciliation the Genome Selector does for its playlist dialog, for the one
   * piece of this flow that lives in the app shell. A step that names any other dialog is
   * saying this one is closed — the field holds which one is open, not a set. */
  useEffect(() => {
    const dialog = tutorialRuntime.dialogRequest?.dialog
    if (!dialog) return
    setGenomePlaylistPopoverOpen(dialog === 'playlistPopover')
  }, [tutorialRuntime.dialogRequest])

  useEffect(() => {
    if (!genomePlaylistPopoverOpen) return undefined
    const handlePointerDown = (event) => {
      const button = genomePlaylistActionButtonRef.current
      const popover = genomePlaylistPopoverRef.current
      if (button && button.contains(event.target)) return
      if (popover && popover.contains(event.target)) return
      setGenomePlaylistPopoverOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setGenomePlaylistPopoverOpen(false)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [genomePlaylistPopoverOpen])

  // The popover lives outside the scrolling button strip (which would clip it), so it
  // is pinned under its button by measurement: 8px below the button, right edges
  // aligned. Re-measured whenever the strip scrolls or the window resizes, because
  // either moves the button relative to the wrapper.
  useLayoutEffect(() => {
    if (!genomePlaylistPopoverOpen) return undefined
    const strip = topBarScrollRef.current
    const place = () => {
      const button = genomePlaylistActionButtonRef.current
      const anchor = strip?.parentElement
      if (!button || !anchor) return
      const buttonRect = button.getBoundingClientRect()
      const anchorRect = anchor.getBoundingClientRect()
      const next = {
        top: Math.round(buttonRect.bottom - anchorRect.top + 8),
        right: Math.round(anchorRect.right - buttonRect.right),
      }
      setGenomePlaylistPopoverPosition((prev) => (
        prev.top === next.top && prev.right === next.right ? prev : next
      ))
    }
    place()
    strip?.addEventListener('scroll', place, { passive: true })
    window.addEventListener('resize', place)
    return () => {
      strip?.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    }
  }, [genomePlaylistPopoverOpen, topBarButtonRows])

  useEffect(() => {
    if (draggedTopButtonId && !activeAppButtons.includes(draggedTopButtonId)) {
      setDraggedTopButtonId('')
      setDragOverTopButtonId('')
      setDragTopInsertPosition('before')
      topBarDragMovedRef.current = false
    }
  }, [activeAppButtons, draggedTopButtonId])

  // Collapsing the top bar takes the chevron away with it, so an open drawer would be
  // left with nothing to close it and would reappear on expanding again.
  useEffect(() => {
    if (headerCollapsed) setAppOrganiserOpen(false)
  }, [headerCollapsed])

  // Close the organiser drawer the same way the playlist popover closes: a click
  // anywhere outside it, or Escape.
  useEffect(() => {
    if (!appOrganiserOpen) return undefined
    const handlePointerDown = (event) => {
      const button = appOrganiserButtonRef.current
      const panel = appOrganiserPanelRef.current
      if (button && button.contains(event.target)) return
      if (panel && panel.contains(event.target)) return
      setAppOrganiserOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setAppOrganiserOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [appOrganiserOpen])

  // Whether either scroll arrow has anywhere to go. Recomputed on scroll, on resize and
  // whenever the button list changes, because all three move the ends.
  const syncTopBarScroll = useCallback(() => {
    const el = topBarScrollRef.current
    if (!el) {
      setTopBarScroll({ canLeft: false, canRight: false })
      return
    }
    const maxScroll = el.scrollWidth - el.clientWidth
    const next = {
      canLeft: el.scrollLeft > 1,
      canRight: maxScroll > 1 && el.scrollLeft < maxScroll - 1,
    }
    setTopBarScroll((prev) => (
      prev.canLeft === next.canLeft && prev.canRight === next.canRight ? prev : next
    ))
  }, [])

  useEffect(() => {
    syncTopBarScroll()
    const el = topBarScrollRef.current
    if (!el) return undefined
    el.addEventListener('scroll', syncTopBarScroll, { passive: true })
    window.addEventListener('resize', syncTopBarScroll)
    return () => {
      el.removeEventListener('scroll', syncTopBarScroll)
      window.removeEventListener('resize', syncTopBarScroll)
    }
  }, [syncTopBarScroll, topBarButtonRows, headerCollapsed])

  // The drawer's preview and the real bar are two windows onto the same strip of
  // buttons, so they scroll as one: whichever the user moves, the other follows. Without
  // this the preview can be showing a different slice than the bar above it, which is
  // exactly the confusion the preview exists to prevent.
  useEffect(() => {
    if (!appOrganiserOpen) return undefined
    const bar = topBarScrollRef.current
    const preview = organiserScrollRef.current
    if (!bar || !preview) return undefined

    const mirror = (from, to) => () => {
      if (scrollLinkGuardRef.current) return
      if (to.scrollLeft === from.scrollLeft) return
      scrollLinkGuardRef.current = true
      to.scrollLeft = from.scrollLeft
      // Released on the next frame, once the write above has produced its own scroll
      // event, so that the mirror cannot bounce back and forth.
      requestAnimationFrame(() => { scrollLinkGuardRef.current = false })
    }
    const onBarScroll = mirror(bar, preview)
    const onPreviewScroll = mirror(preview, bar)

    // Open the drawer showing whatever the bar is showing.
    preview.scrollLeft = bar.scrollLeft

    bar.addEventListener('scroll', onBarScroll, { passive: true })
    preview.addEventListener('scroll', onPreviewScroll, { passive: true })
    return () => {
      bar.removeEventListener('scroll', onBarScroll)
      preview.removeEventListener('scroll', onPreviewScroll)
      scrollLinkGuardRef.current = false
    }
  }, [appOrganiserOpen, activeAppButtons])

  const scrollTopBarButtons = useCallback((direction) => {
    const el = topBarScrollRef.current
    if (!el) return
    el.scrollBy({ left: direction * TOP_BAR_COLUMN_STRIDE_PX, behavior: 'smooth' })
  }, [])

  // The drawer edits the same setting the Configuration view's organiser edits, so it
  // goes through the same normalisation on the way in.
  const handleAppOrganiserChange = useCallback((nextButtonsOrUpdater) => {
    setConfig((prev) => {
      const base = prev || configRef.current || config
      const prevButtons = normalizeActiveAppButtons(base.active_app_buttons)
      const rawNext = typeof nextButtonsOrUpdater === 'function'
        ? nextButtonsOrUpdater(prevButtons)
        : nextButtonsOrUpdater
      return { ...base, active_app_buttons: normalizeActiveAppButtons(rawNext) }
    })
  }, [config])

  const reorderTopBarButtons = useCallback((sourceButtonId, targetButtonId, insertPosition = 'before') => {
    if (!sourceButtonId || !targetButtonId || sourceButtonId === targetButtonId) return
    trackAchievement('appButtons.rearranged')
    setConfig((prev) => {
      const base = prev || configRef.current || config
      const ordered = normalizeActiveAppButtons(base.active_app_buttons)
      const nextOrder = reorderWithInsertPosition(ordered, sourceButtonId, targetButtonId, insertPosition)
      if (nextOrder === ordered) return base
      return { ...base, active_app_buttons: nextOrder }
    })
  }, [config])

  const handleTopBarButtonClick = async (buttonId) => {
    const buttonMeta = APP_BUTTON_META[buttonId]
    if (!buttonMeta) return

    if (buttonMeta.kind === 'action') {
      if (buttonId === 'genome_playlist') {
        setGenomePlaylistPopoverOpen((prev) => !prev)
      } else if (buttonId === 'theme_toggle') {
        if (theme === 'dark') trackAchievement('theme.toLight')
        setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
      } else if (buttonId === 'screenshot_toggle') {
        if (!(screenshotSupported && screenshotAvailable)) return
        setScreenshotMode((prev) => !prev)
      }
      return
    }

    const nextView = buttonMeta.viewId
    if (!nextView || nextView === currentView) return

    if (currentView === 'configuration' && nextView !== 'configuration') {
      // Never let this throw the navigation away with it. Whatever happened to the
      // save, the view the user asked for still has to open.
      try {
        await saveConfigurationBeforeLeaving()
      } catch (error) {
        console.error('Could not save the configuration on leaving it:', error)
      }
    }

    if (screenshotMode) {
      setScreenshotMode(false)
    }
    setCurrentView(nextView)
  }

  const handleSpeciesToggleFromSelector = useCallback((species, source = 'selector', options = {}) => {
    return handleSpeciesPillToggle(species, source, options)
  }, [handleSpeciesPillToggle])

  const handleSelectorConfigChange = useCallback((...args) => applySelectorConfigChange({
      buildFocusFromActive,
      config,
      configRef,
      currentView,
      dualViewFocusRef,
      getAlignedGenomeConfigForView,
      handleBrowserConfigChange,
      inactiveSelectedSpeciesRef,
      setDualViewFocus,
      setInactiveSelectedSpecies,
      suppressViewSyncRef,
  }, ...args), [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView])

  const homologyGenomes = useMemo(() => dedupeSpeciesList(config?.active_species || []), [config?.active_species])
  const homologyWorkspace = useHomologyWorkspace({ genomes: homologyGenomes, localGenomes: topBarSpecies, outputDir: config?.output_dir, enabled: currentView === 'homology' })

  return (
    renderAppLayout({
        AlignmentExplorerView,
        ErrorBoundary,
        FpsCounter,
        GeneTreesView,
        PILLS_STRIP_HEIGHT,
        PILLS_STRIP_PADDING_BOTTOM,
        PILLS_STRIP_PADDING_TOP,
        PILLS_STRIP_PADDING_X,
        SequenceView,
        achievementFocusId,
        activeAppButtons,
        activeSpeciesByKey,
        alignedGenomeCount,
        alignmentDisplayMetaByGenomeKey,
        alignmentDisplayRows,
        alignmentGenomeColorsByKey,
        alignmentGlobalFlankMax,
        alignmentGlobalFlanks,
        alignmentGlobalFlanksLocked,
        alignmentInputs,
        alignmentNeedsRerun,
        alignmentPreparedCount,
        alignmentRunDisabled,
        alignmentRunSettings,
        alignmentSidebarCollapsed,
        alignmentViewError,
        alignmentViewLoading,
        alignmentViewerDisplayKey,
        appOrganiserButtonRef,
        appOrganiserOpen,
        appOrganiserPanelRef,
        applyingGenomePlaylistId,
        backendRuntime,
        browserGeneEntry,
        browserLocationFocusByGenome,
        browserRefGene,
        browserRefViewport,
        browserTgtGene,
        collapseIntrons,
        collapseSource,
        collapseSourceOptions,
        config,
        configLoaded,
        currentView,
        currentViewButtonId,
        currentViewDescription,
        currentViewTitle,
        defaultFallbackScreenshotDir,
        dragOverTopButtonId,
        dragTopInsertPosition,
        draggedTopButtonId,
        explorerIncoming,
        fallbackScreenshotOverlayRef,
        fallbackScreenshotTarget,
        fallbackScreenshotTargets,
        featureExplorerActiveGenome,
        featureExplorerActiveGenomeKey,
        featureExplorerAvailableGenomes,
        featureExplorerSeedQuery,
        focusGeneByGenome,
        geneTreesIncoming,
        genomePlaylistActionButtonRef,
        genomePlaylistPopoverOpen,
        genomePlaylistPopoverPosition,
        genomePlaylistPopoverRef,
        genomeStartingPoints,
        gettingStartedOutputDirDismissed,
        handleAlignmentGlobalFlankMaxChange,
        handleAlignmentGlobalFlanksChange,
        handleAlignmentGlobalFlanksLockToggle,
        handleAlignmentResolveRow,
        handleAlignmentRowQueryChange,
        handleAlignmentRowSettingChange,
        handleAlignmentRunSettingsChange,
        handleAlignmentSearchAll,
        handleAppOrganiserChange,
        handleApplyPlaylistFromSelector,
        handleBrowserGeneEntryConsumed,
        handleClearAllFocusedGenes,
        handleConfigSaved,
        handleConfigurationChange,
        handleDoSaveAlignment,
        handleFallbackScreenshotModalClose,
        handleFallbackScreenshotSave,
        handleFeatureExplorerGenomeSelect,
        handleGenomeFocusGeneSelect,
        handleGenomeFocusLocationSelect,
        handleGenomeWheelPromote,
        handleGettingStartedOutputDir,
        handleLoadAlignment,
        handleNeighbourhoodFlipGenome,
        handleNeighbourhoodLinkSelect,
        handleNeighbourhoodResolveGenome,
        handleNeighbourhoodSearchAll,
        handleNeighbourhoodSwapAdjacent,
        handleNeighbourhoodToggleGenome,
        handleNeighbourhoodUseHomologyClick,
        handleOpenAlignmentExplorerLoci,
        handleRefGeneSelect,
        handleRemoveSpeciesFromList,
        handleRetryBackendCheck,
        handleRetryBackendLaunch,
        handleSaveAlignment,
        handleScreenshotAvailabilityChange,
        handleSelectorConfigChange,
        handleSpeciesPillReorder,
        handleSpeciesPillToggle,
        handleSpeciesToggleFromSelector,
        handleStructuralVariationGenomeOrderChange,
        handleStructuralVariationPillToggle,
        handleSvAlignmentAvailabilityChange,
        handleTgtGeneSelect,
        handleTopBarButtonClick,
        handleTopBarPlaylistSelect,
        headerCollapsed,
        homologyGenomes,
        homologyWorkspace,
        inactiveSelectedSpecies,
        isLight,
        loadAlignmentModalOpen,
        mainContentNode,
        multiAlignmentResult,
        neighbourhoodDisabledByGenome,
        neighbourhoodErrorStateByGenome,
        neighbourhoodGenomes,
        neighbourhoodHomologyAvailabilityByGenome,
        neighbourhoodHomologyError,
        neighbourhoodHomologyFilters,
        neighbourhoodHomologyLinksByPair,
        neighbourhoodHomologyPairLoading,
        neighbourhoodLinksByPair,
        neighbourhoodLoadingStateByGenome,
        neighbourhoodNoHitGenomeKeys,
        neighbourhoodQueryStateByGenome,
        neighbourhoodTrackStateByGenome,
        neighbourhoodUseHomology,
        organiserScrollRef,
        outputDirNotification,
        refBrowserReloadKey,
        refSpecies,
        reorderTopBarButtons,
        reportBrowserRefViewport,
        reserveTutorialSelectorPills,
        runMultiAlignment,
        saveAlignmentModalOpen,
        screenshotActionButtonRef,
        screenshotAvailable,
        screenshotMode,
        scrollTopBarButtons,
        selectedFallbackScreenshotTarget,
        selectedSpeciesKeysForView,
        selectorPlaylistConfig,
        selectorSelectedSpecies,
        semiSelectedSpeciesKeysForView,
        sequenceViewEntry,
        setAchievementFocusId,
        setActiveViewContentNode,
        setAlignmentSidebarCollapsed,
        setAppOrganiserOpen,
        setBackendSetupOpen,
        setBrowserFocusByGenome,
        setBrowserGeneEntry,
        setCollapseIntrons,
        setCollapseSource,
        setCurrentView,
        setDragOverTopButtonId,
        setDragTopInsertPosition,
        setDraggedTopButtonId,
        setExplorerIncoming,
        setGeneTreesIncoming,
        setGettingStartedOutputDirDismissed,
        setHeaderCollapsed,
        setLoadAlignmentModalOpen,
        setMainContentNode,
        setNeighbourhoodErrorByGenome,
        setNeighbourhoodHomologyFilters,
        setNeighbourhoodQueryByGenome,
        setSaveAlignmentModalOpen,
        setScreenshotMode,
        setSelectedFallbackScreenshotTarget,
        setSequenceGenomeKey,
        setSequenceViewEntry,
        setSvAnchorRegionId,
        setSvRegionExplicitlySelected,
        shouldRenderFallbackContentWrapper,
        shouldShowWindowsBackendSetup,
        showNoGenomesMessage,
        showsPillsStrip,
        sortedGenomePlaylists,
        statsActiveGenomeKeys,
        structuralVariationViewKey,
        svAnchorPillLabel,
        svAnchorRegionId,
        svAnchorSpecies,
        svRegionExplicitlySelected,
        svSavedViewportRef,
        svSecondPillLabel,
        svSecondSpecies,
        svThirdPillLabel,
        svThirdSpecies,
        tgtBrowserReloadKey,
        theme,
        themeStyles,
        topBarButtonLayout,
        topBarButtonRows,
        topBarDragMovedRef,
        topBarScroll,
        topBarScrollRef,
        topBarSpecies,
        topListMode,
        tutorialRuntime,
        unalignedGenomeCount,
        userConfig,
        usingFallbackScreenshot,
        waitForGenomeConfigSave,
    })
  )
}

export default App
