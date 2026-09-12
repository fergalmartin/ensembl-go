import TutorialBrowserSceneEditor from './TutorialBrowserSceneEditor.jsx'
import TutorialBrowserDemoEditor from './TutorialBrowserDemoEditor.jsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useTutorial from '../hooks/useTutorial.jsx'
import FileBrowserModal from './FileBrowserModal.jsx'
import { APP_BUTTON_META } from '../appButtonConfig.js'
import {
  TUTORIAL_TARGETS,
  TUTORIAL_TARGET_VIEWS,
  findTargetElement,
  targetRef,
  targetRefFromElement,
  tutorialTarget,
} from '../tutorialTargets/index.js'
import {
  analyseTutorialCompatibility,
  createTutorialDocument,
  legacyTutorialToDocument,
  nextDraftStep,
  setTutorialDatasetActivation,
  tutorialDatasetStartsActive,
  validateTutorialDocument,
} from '../utils/tutorialDocument.js'
import { arrivalGenomeRecipeIds, arrivalPlaylists } from '../utils/tutorialModel.js'
import { describeBrowserViewport, sameBrowserViewport } from '../utils/browserTutorialControls.js'
import {
  areRectsEqual,
  cutoutPathD,
  expandRect,
  nonOverlappingRects,
  TUTORIAL_CARD_MARGIN,
  TUTORIAL_CARD_WIDTH,
  tutorialDimColor,
  visibleElementRect,
  viewportRect,
} from '../utils/overlayGeometry.js'
import { registerRuntimeTutorial } from '../tutorials/index.js'
import { resolveGenomeColor } from '../genomeColorSchemes.js'
import {
  exportTutorialPackage,
  generateTutorialDataset,
  generateTutorialFixture,
  listTutorialCheckpoints,
  notifyTutorialDraftsChanged,
  promoteTutorialDraft,
  saveTutorialCheckpoint,
  saveTutorialDraft,
} from '../tutorials/drafts.js'

export const OPEN_TUTORIAL_BUILDER_EVENT = 'ensembl:open-tutorial-builder'
const BUILDER_TRANSPARENCY_KEY = 'ensembl-go:tutorial-builder-transparency'
const BUILDER_WIDTH_KEY = 'ensembl-go:tutorial-builder-width'
const BUILDER_DEFAULT_WIDTH = 470
const BUILDER_MIN_WIDTH = 320
const BUILDER_COLLAPSE_DRAG_THRESHOLD = 48
const BUILDER_VIEWPORT_GUTTER = 160
const MULTI_HIGHLIGHT_INSET = -2
const TURTLES_AND_FRIENDS_FIXTURE_ID = 'turtles-and-friends'

/** Completions that wait for the app to report that something happened, rather than for a
 *  particular pixel to be pressed.
 *
 *  The search box is the case that needs them. It empties itself on a successful search,
 *  so a step waiting for its contents can never be satisfied; and a reader who presses
 *  Return has done the step, watched the browser move, and is then left looking at a card
 *  that still wants Next. Waiting on the signal ends the step when the thing it asked for
 *  actually happened — whoever did it — and the step's pause after completion is what
 *  holds the new view on screen before moving on.
 *
 *  Adding another is one entry, plus the emit at the state transition it names. */
const SIGNAL_COMPLETIONS = Object.freeze([
  {
    name: 'browser.regionSearched',
    label: 'When the browser moves to a searched region',
    views: ['genome_browser'],
    holdMs: 2000,
  },
  {
    name: 'browser.geneFocused',
    label: 'When a gene has been found and focused',
    views: ['genome_browser'],
    holdMs: 2000,
  },
  {
    // Analysis is a real backend call. A step advancing on the press would have its card
    // read over an empty panel, and the report is the whole point of pressing it.
    name: 'custom.analysed',
    label: 'When a genome or annotation has been analysed',
    views: ['genome_selector'],
    holdMs: 2500,
  },
])

const emptyBuilder = {
  open: false,
  outputDir: '',
  document: null,
  selectedStepId: '',
  recording: false,
  picking: false,
  pickPurpose: 'spotlight',
  status: '',
  config: null,
}

function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

function initialBuilderTransparency() {
  if (typeof window === 'undefined') return 0
  try {
    const saved = Number(window.localStorage.getItem(BUILDER_TRANSPARENCY_KEY))
    return Number.isFinite(saved) ? Math.max(0, Math.min(90, saved)) : 0
  } catch {
    return 0
  }
}

function clampBuilderWidth(width) {
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
  const maximum = Math.max(BUILDER_MIN_WIDTH, viewportWidth - BUILDER_VIEWPORT_GUTTER)
  const numeric = Number(width)
  return Math.max(BUILDER_MIN_WIDTH, Math.min(maximum, Number.isFinite(numeric) ? numeric : BUILDER_DEFAULT_WIDTH))
}

function initialBuilderWidth() {
  if (typeof window === 'undefined') return BUILDER_DEFAULT_WIDTH
  try {
    return clampBuilderWidth(window.localStorage.getItem(BUILDER_WIDTH_KEY) || BUILDER_DEFAULT_WIDTH)
  } catch {
    return clampBuilderWidth(BUILDER_DEFAULT_WIDTH)
  }
}

function documentVersion(document) {
  return document ? `${document.id}:${document.revision}:${document.updatedAt}` : ''
}

function cloneTutorial(seed, preserveId = false) {
  if (seed?.format === 'ensembl-go-tutorial') {
    return createTutorialDocument(preserveId
      ? copy(seed)
      : { ...copy(seed), id: `${seed.id}-draft`, title: `${seed.title} draft` })
  }
  const id = seed?.id
    ? String(seed.id).replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
    : `tutorial-${Date.now().toString(36)}`
  return legacyTutorialToDocument(seed || {}, {
    id: seed?.id ? `${id}-draft` : id,
    title: seed?.title ? `${seed.title} draft` : 'Untitled tutorial',
    blurb: seed?.blurb || 'A custom Ensembl Go tutorial.',
    estimatedMinutes: seed?.estimatedMinutes || 5,
    usesDemoGenome: Boolean(seed?.usesDemoGenome),
    completionBody: seed?.completionBody || 'Tutorial complete.',
  })
}

function locus(view) {
  if (!view?.chrom || !Number.isFinite(Number(view.start)) || !Number.isFinite(Number(view.end))) return ''
  return `${view.chrom}:${Math.round(view.start).toLocaleString('en-US')}-${Math.round(view.end).toLocaleString('en-US')}`
}

function builderSpeciesKey(species, index) {
  return `${species?.species_key || 'species'}:${species?.assembly || 'assembly'}:${index}`
}

function contractView(ref) {
  const contract = tutorialTarget(ref?.id)
  if (!contract) return ''
  if (contract.viewId === 'app') {
    const button = APP_BUTTON_META[ref?.params?.buttonId]
    return button?.viewId || ''
  }
  return contract.viewId
}

function authoredTargetsForView(viewId) {
  return TUTORIAL_TARGETS.filter((target) => (
    target.authoringVisible
    && !target.parameters
    && (!viewId || target.viewId === viewId || target.viewId === 'app')
  ))
}

function firstUserCapability(contract) {
  return (contract?.capabilities || []).find((capability) => (
    !['spotlight', 'read-state', 'set-state', 'set-locus'].includes(capability)
  )) || ''
}

function targetReferenceKey(ref) {
  const params = Object.entries(ref?.params || {})
    .sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify([String(ref?.id || ''), Number(ref?.version || 1), params])
}

function presentationRectsEqual(left, right) {
  return left.length === right.length && left.every((rect, index) => areRectsEqual(rect, right[index]))
}

/** Track the authored spotlight while the app mounts, scrolls and relays out. */
function useBuilderPresentationGeometry(entries, active) {
  const [geometry, setGeometry] = useState({ size: { width: 1, height: 1 }, rects: [] })
  useEffect(() => {
    let frame = 0
    const measure = () => {
      const viewport = viewportRect()
      const rects = active
        ? entries.map((entry) => {
          if (entry.whenTypedTarget) {
            const trigger = findTargetElement(entry.whenTypedTarget)
            if (!String(trigger?.value || '').trim()) return null
          }
          const node = findTargetElement(entry.target)
          return node ? visibleElementRect(node, viewport) : null
        })
        : []
      setGeometry((current) => {
        const size = { width: viewport.width, height: viewport.height }
        return current.size.width === size.width
          && current.size.height === size.height
          && presentationRectsEqual(current.rects, rects)
          ? current
          : { size, rects }
      })
    }
    const poll = () => {
      measure()
      frame = requestAnimationFrame(poll)
    }
    // Keep authoring rings locked to rows during an internal panel scroll. The regular
    // animation-frame poll catches arbitrary layout changes; this listener closes the
    // small gap between a scroll event and the next scheduled frame.
    const repair = () => measure()
    measure()
    frame = requestAnimationFrame(poll)
    document.addEventListener('scroll', repair, true)
    window.addEventListener('resize', repair)
    window.visualViewport?.addEventListener?.('resize', repair)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('scroll', repair, true)
      window.removeEventListener('resize', repair)
      window.visualViewport?.removeEventListener?.('resize', repair)
    }
  }, [active, entries])
  return geometry
}

function sameTargetReference(left, right) {
  return Boolean(left && right && targetReferenceKey(left) === targetReferenceKey(right))
}

function targetInstanceLabel(ref, datasets = []) {
  const contract = tutorialTarget(ref?.id)
  if (ref?.id === 'app.viewButton') {
    const appButton = APP_BUTTON_META[ref?.params?.buttonId]
    return `${appButton?.label || ref?.params?.buttonId || contract?.label || 'App'} button`
  }
  const values = Object.values(ref?.params || {}).filter((value) => String(value || '').trim()).map((value) => datasets.find((dataset) => dataset.recipeId === value)?.label || value)
  return values.length
    ? `${contract?.label || ref?.id} — ${values.join(', ')}`
    : (contract?.label || ref?.id || 'Highlighted target')
}

function targetForCapability(selectedTarget, interactionTargets, capability) {
  if (selectedTarget && tutorialTarget(selectedTarget.id)?.capabilities?.includes(capability)) {
    return selectedTarget
  }
  return interactionTargets.find((entry) => entry.capabilities?.includes(capability))?.target || null
}

function ensureStepInteraction(step, target, capability) {
  if (!step || !target || !capability) return
  const targets = [...(step.interactionPolicy?.targets || [])]
  const index = targets.findIndex((entry) => sameTargetReference(entry.target, target))
  if (index >= 0) {
    const capabilities = Array.from(new Set([...(targets[index].capabilities || []), capability]))
    targets[index] = { ...targets[index], target, capabilities }
  } else {
    targets.push({ target, capabilities: [capability] })
  }
  step.interactionPolicy = { targets }
}

function removeStepTargetReferences(step, target) {
  if (!step || !target) return
  step.interactionPolicy = {
    targets: (step.interactionPolicy?.targets || []).filter(
      (entry) => !sameTargetReference(entry.target, target)
    ),
  }

  const advance = step.advanceOn
  if (advance?.target && sameTargetReference(advance.target, target)) {
    step.advanceOn = { type: 'manual' }
  } else if (advance?.targets?.length) {
    const targets = advance.targets.filter((entry) => !sameTargetReference(entry, target))
    if (targets.length !== advance.targets.length) {
      step.advanceOn = targets.length >= 2
        ? { ...advance, targets }
        : targets.length === 1
          ? { type: 'click', target: targets[0] }
          : { type: 'manual' }
    }
  }

  if (step.autoplay?.action?.target && sameTargetReference(step.autoplay.action.target, target)) {
    delete step.autoplay
  } else if (step.autoplay?.actions?.length) {
    const actions = step.autoplay.actions.filter((action) => !sameTargetReference(action.target, target))
    if (actions.length !== step.autoplay.actions.length) {
      if (actions.length) step.autoplay = { ...step.autoplay, actions }
      else delete step.autoplay
    }
  }
}

function setStepSpotlight(step, target) {
  if (!step) return
  const previous = step.spotlight?.target || step.spotlight
  if (previous && !sameTargetReference(previous, target)) removeStepTargetReferences(step, previous)
  if (!target) {
    delete step.spotlight
    return
  }
  step.spotlight = { target }
  // Promoting an additional highlight to primary should not draw it twice.
  step.reveals = (step.reveals || []).filter(
    (entry) => !sameTargetReference(entry.target || entry, target)
  )
}

function arrivalOf(step, type) {
  const arrivals = Array.isArray(step?.arrive) ? step.arrive : (step?.arrive ? [step.arrive] : [])
  return arrivals.find((arrival) => arrival?.type === type) || null
}

function defaultRecordedStep(document, ref, capability, value = '') {
  const contract = tutorialTarget(ref?.id)
  const inherited = nextDraftStep(document, {
    title: capability === 'input' ? `Enter ${contract?.label || 'a value'}` : `Use ${contract?.label || 'this control'}`,
    view: contractView(ref),
  })
  return {
    ...inherited,
    spotlight: { target: ref },
    interactionPolicy: { targets: [{ target: ref, capabilities: [capability] }] },
    autoplay: {
      action: {
        target: ref,
        capability,
        ...(capability === 'input' ? { value, submit: true } : {}),
      },
    },
    recordingReview: contract?.sensitiveReview ? { sensitive: true } : undefined,
  }
}

function BuilderButton({ children, disabled = false, active = false, danger = false, onClick, title = '' }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
        disabled ? 'cursor-not-allowed border-gray-700 text-gray-600'
          : danger ? 'border-red-500/40 text-red-300 hover:bg-red-500/10'
            : active ? 'border-sky-400 bg-sky-500/20 text-sky-200'
              : 'border-gray-600 text-gray-200 hover:bg-gray-700'
      }`}
    >
      {children}
    </button>
  )
}

// Matches the horizontal drawer chevron used by FocusGeneDrawer: the open
// right-hand panel points towards the edge to collapse, and its rail points back
// into the page to expand.
function BuilderChevronGlyph({ pointsRight, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={pointsRight ? '9 6 15 12 9 18' : '15 6 9 12 15 18'} />
    </svg>
  )
}

export default function TutorialBuilderOverlay() {
  const tutorial = useTutorial()
  const { prepareBuilderPreview, prepareBuilderStep, stopBuilderPreview } = tutorial
  const [builder, setBuilder] = useState(emptyBuilder)
  const [history, setHistory] = useState([])
  const [future, setFuture] = useState([])
  const [checkpoints, setCheckpoints] = useState([])
  const [hoveredRef, setHoveredRef] = useState(null)
  const [hoveredRect, setHoveredRect] = useState(null)
  const [showExportBrowser, setShowExportBrowser] = useState(false)
  const [datasetForm, setDatasetForm] = useState({ speciesKey: '', chrom: '', start: '', end: '', partialMode: 'expand' })
  const [generatingDataset, setGeneratingDataset] = useState(false)
  const [generatingFixture, setGeneratingFixture] = useState(false)
  const [saveState, setSaveState] = useState('idle')
  const [builderTransparency, setBuilderTransparency] = useState(initialBuilderTransparency)
  const [builderWidth, setBuilderWidth] = useState(initialBuilderWidth)
  const [builderPanelCollapsed, setBuilderPanelCollapsed] = useState(false)
  const [builderCollapseDragOffset, setBuilderCollapseDragOffset] = useState(0)
  const [builderResizeActive, setBuilderResizeActive] = useState(false)
  const [cardDragActive, setCardDragActive] = useState(false)
  // The preview card's real height when the step authors no `cardSize`. The reader's card
  // grows to fit its words; assuming a fixed height here made the preview a different box
  // from the one being authored, and clamped it away from the bottom of the window by the
  // difference. Measured from the preview itself, as the overlay measures the real card.
  const infoCardRef = useRef(null)
  const [measuredCardHeight, setMeasuredCardHeight] = useState(null)
  const [sceneState, setSceneState] = useState({ status: 'idle', genomeCount: 0, activeCount: 0, targetFound: true, message: '' })
  const dragRef = useRef(null)
  const builderResizeRef = useRef(null)
  const saveTimerRef = useRef(0)
  const saveQueueRef = useRef(Promise.resolve())
  const saveRequestRef = useRef(0)
  const builderRef = useRef(builder)
  const recordViewportRef = useRef(null)
  const viewportSettleRef = useRef({ view: null, at: 0 })
  const lastInputAtRef = useRef(0)
  const sceneRequestRef = useRef(0)
  const cardDragHandlersRef = useRef({ move: null, finish: null })
  const builderResizeHandlersRef = useRef({ move: null, finish: null })

  builderRef.current = builder

  useEffect(() => {
    try {
      window.localStorage.setItem(BUILDER_TRANSPARENCY_KEY, String(builderTransparency))
    } catch {
      // The slider still works for this session if browser storage is unavailable.
    }
  }, [builderTransparency])

  useEffect(() => {
    try {
      window.localStorage.setItem(BUILDER_WIDTH_KEY, String(Math.round(builderWidth)))
    } catch {
      // Resizing still works for this session if browser storage is unavailable.
    }
  }, [builderWidth])

  useEffect(() => {
    const fitToViewport = () => setBuilderWidth((width) => clampBuilderWidth(width))
    window.addEventListener('resize', fitToViewport)
    return () => window.removeEventListener('resize', fitToViewport)
  }, [])

  useEffect(() => () => {
    const resize = builderResizeRef.current
    if (!resize) return
    document.body.style.cursor = resize.bodyCursor
    document.body.style.userSelect = resize.bodyUserSelect
  }, [])

  // Pointer capture normally keeps the card drag alive outside its header, but a panel
  // disappearing under the pointer can cause some browser/OS combinations to retarget
  // the release. A document-level backstop guarantees the builder always comes back.
  useEffect(() => {
    if (!cardDragActive) return undefined
    const move = (event) => cardDragHandlersRef.current.move?.(event)
    const finish = () => cardDragHandlersRef.current.finish?.()
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerup', finish, true)
    document.addEventListener('pointercancel', finish, true)
    window.addEventListener('blur', finish)
    return () => {
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', finish, true)
      document.removeEventListener('pointercancel', finish, true)
      window.removeEventListener('blur', finish)
    }
  }, [cardDragActive])

  // The resize handle moves with the panel. Keep listening at the document as well as on
  // the handle so a fast drag cannot outrun pointer capture and leave the resize (or its
  // collapse threshold) half-finished.
  useEffect(() => {
    if (!builderResizeActive) return undefined
    const move = (event) => builderResizeHandlersRef.current.move?.(event)
    const finish = (event) => builderResizeHandlersRef.current.finish?.(event, true)
    const cancel = (event) => builderResizeHandlersRef.current.finish?.(event, false)
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerup', finish, true)
    document.addEventListener('pointercancel', cancel, true)
    window.addEventListener('blur', cancel)
    return () => {
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('pointerup', finish, true)
      document.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('blur', cancel)
    }
  }, [builderResizeActive])

  const selectedIndex = useMemo(
    () => builder.document?.steps?.findIndex((step) => step.id === builder.selectedStepId) ?? -1,
    [builder.document?.steps, builder.selectedStepId],
  )
  const selectedStep = selectedIndex >= 0 ? builder.document.steps[selectedIndex] : null

  // Placed after `selectedStep`, which it reads, and before the early return below,
  // which it must not be able to skip. Both halves matter: declared earlier it crashed
  // the view with "Cannot access 'selectedStep' before initialization", declared later
  // with "Rendered more hooks than during the previous render".
  useEffect(() => {
    const node = infoCardRef.current
    if (!node) return undefined
    const measure = () => {
      const height = node.getBoundingClientRect?.().height
      if (height) setMeasuredCardHeight((current) => (Math.abs(height - current) > 1 ? height : current))
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [selectedStep?.id, selectedStep?.title, selectedStep?.body, selectedStep?.section, selectedStep?.cardSize])
  const selectedTarget = selectedStep?.spotlight?.target || selectedStep?.spotlight
  const presentationEntries = useMemo(() => {
    const entries = selectedTarget ? [{ target: selectedTarget, ring: true }] : []
    for (const reveal of selectedStep?.reveals || []) {
      entries.push({
        target: reveal.target || reveal,
        whenTypedTarget: reveal.whenTypedTarget || null,
        ring: Boolean(reveal.ring),
      })
    }
    return entries
  }, [selectedStep?.reveals, selectedTarget])
  const presentationGeometry = useBuilderPresentationGeometry(
    presentationEntries,
    Boolean(builder.open && builder.document && !builder.picking && !builder.recording),
  )
  const report = useMemo(
    () => builder.document ? analyseTutorialCompatibility(builder.document) : null,
    [builder.document],
  )
  const validation = useMemo(
    () => builder.document ? validateTutorialDocument(builder.document) : [],
    [builder.document],
  )

  const sceneSignature = useMemo(() => {
    if (!builder.open || !builder.document || !selectedStep) return ''
    return JSON.stringify({
      tutorial: builder.document.id,
      settings: builder.document.settings,
      outputDir: builder.outputDir,
      datasets: (builder.document.datasets || []).map((dataset) => ({
        recipeId: dataset?.recipeId || '',
        label: dataset?.label || '',
        embedded: Boolean(dataset?.embedded),
        active: tutorialDatasetStartsActive(dataset),
      })),
      step: {
        id: selectedStep.id,
        view: selectedStep.view,
        spotlight: selectedStep.spotlight,
        reveals: selectedStep.reveals,
        arrive: selectedStep.arrive,
        openSection: selectedStep.openSection,
        openSectionTarget: selectedStep.openSectionTarget,
        sectionContentTarget: selectedStep.sectionContentTarget,
        preconditions: selectedStep.preconditions,
        interactionPolicy: selectedStep.interactionPolicy,
      },
    })
  }, [builder.document, builder.open, builder.outputDir, selectedStep])

  const prepareScene = useCallback(async ({ reset = false } = {}) => {
    const current = builderRef.current
    if (!current.open || !current.document) return false
    const index = current.document.steps.findIndex((step) => step.id === current.selectedStepId)
    const requestId = sceneRequestRef.current + 1
    sceneRequestRef.current = requestId
    setSceneState((state) => ({ ...state, status: 'preparing', message: 'Preparing tutorial scene…' }))
    try {
      const datasetResult = await prepareBuilderPreview(current.document, {
        outputDir: current.outputDir,
        reset,
      })
      if (sceneRequestRef.current !== requestId || datasetResult?.cancelled) return false
      const stepResult = await prepareBuilderStep(current.document, Math.max(0, index))
      if (sceneRequestRef.current !== requestId) return false
      setSceneState({
        status: 'ready',
        genomeCount: Number(datasetResult?.genomeCount) || 0,
        activeCount: Number(datasetResult?.activeCount) || 0,
        targetFound: stepResult?.targetFound !== false,
        message: stepResult?.targetFound === false
          ? 'Scene ready, but the selected target is not currently rendered.'
          : 'Scene matches tutorial playback.',
      })
      return true
    } catch (error) {
      if (sceneRequestRef.current === requestId) {
        setSceneState((state) => ({ ...state, status: 'error', message: error.message || 'Could not prepare the tutorial scene.' }))
      }
      return false
    }
  }, [prepareBuilderPreview, prepareBuilderStep])

  useEffect(() => {
    if (!sceneSignature) return undefined
    const timer = window.setTimeout(() => { prepareScene() }, 80)
    return () => window.clearTimeout(timer)
  }, [prepareScene, sceneSignature])

  useEffect(() => {
    const open = (event) => {
      const detail = event.detail || {}
      const document = cloneTutorial(detail.seed || null, Boolean(detail.editExisting))
      if (!document.steps.length) document.steps.push(nextDraftStep(document))
      setHistory([])
      setFuture([])
      setCheckpoints([])
      setSaveState('unsaved')
      setBuilderPanelCollapsed(false)
      setBuilderCollapseDragOffset(0)
      setBuilderResizeActive(false)
      setCardDragActive(false)
      setSceneState({ status: 'idle', genomeCount: 0, activeCount: 0, targetFound: true, message: '' })
      setBuilder({
        ...emptyBuilder,
        open: true,
        outputDir: String(detail.outputDir || ''),
        document,
        selectedStepId: document.steps[0]?.id || '',
        config: detail.config || null,
        status: detail.editExisting
          ? 'Draft opened for editing. Changes are saved automatically.'
          : detail.seed
            ? 'Built-in cloned as an editable draft. Changes are saved automatically.'
            : 'New draft created. Changes are saved automatically.',
      })
      if (detail.outputDir) {
        listTutorialCheckpoints(detail.outputDir, document.id)
          .then((result) => setCheckpoints(result.checkpoints || []))
          .catch(() => {})
      }
      const active = detail.config?.active_species?.[0]
      const view = describeBrowserViewport()
      setDatasetForm({
        speciesKey: active ? builderSpeciesKey(active, 0) : '',
        chrom: String(view?.chrom || ''),
        start: view?.start ? String(Math.round(view.start)) : '',
        end: view?.end ? String(Math.round(view.end)) : '',
        partialMode: 'expand',
      })
    }
    window.addEventListener(OPEN_TUTORIAL_BUILDER_EVENT, open)
    return () => window.removeEventListener(OPEN_TUTORIAL_BUILDER_EVENT, open)
  }, [])

  const commitDocument = useCallback((updater, status = '') => {
    setBuilder((current) => {
      if (!current.document) return current
      const previous = copy(current.document)
      const next = typeof updater === 'function' ? updater(copy(current.document)) : updater
      next.updatedAt = new Date().toISOString()
      next.revision = Number(current.document.revision || 1) + 1
      setHistory((items) => [...items.slice(-99), previous])
      setFuture([])
      return { ...current, document: next, status: status || current.status }
    })
  }, [])

  const appendRecordedStep = useCallback((step, message) => {
    commitDocument((document) => {
      document.steps.push(step)
      return document
    }, message)
    setBuilder((current) => ({ ...current, selectedStepId: step.id }))
  }, [commitDocument])

  const persistDraft = useCallback((outputDir, document, successMessage = 'Draft saved.') => {
    if (!outputDir || !document) {
      const error = new Error('An output directory is required to save this tutorial.')
      setSaveState('error')
      return Promise.reject(error)
    }
    const snapshot = copy(document)
    const version = documentVersion(snapshot)
    const requestId = saveRequestRef.current + 1
    saveRequestRef.current = requestId
    setSaveState('saving')
    const request = saveQueueRef.current
      .catch(() => undefined)
      .then(() => saveTutorialDraft(outputDir, snapshot))
    saveQueueRef.current = request
    return request.then(({ tutorial: saved }) => {
      registerRuntimeTutorial(saved)
      if (saveRequestRef.current === requestId && documentVersion(builderRef.current.document) === version) {
        setSaveState('saved')
        setBuilder((current) => current.open ? { ...current, status: successMessage } : current)
      }
      return saved
    }).catch((error) => {
      if (saveRequestRef.current === requestId && documentVersion(builderRef.current.document) === version) {
        setSaveState('error')
        setBuilder((current) => current.open ? { ...current, status: error.message } : current)
      }
      throw error
    })
  }, [])

  useEffect(() => {
    if (!builder.open || !builder.document || !builder.outputDir) return undefined
    clearTimeout(saveTimerRef.current)
    setSaveState('unsaved')
    saveTimerRef.current = setTimeout(() => {
      persistDraft(builder.outputDir, builder.document).catch(() => {})
    }, 650)
    return () => clearTimeout(saveTimerRef.current)
  }, [builder.document, builder.open, builder.outputDir, persistDraft])

  const pickElement = useCallback((event) => {
    if (!builder.open || (!builder.picking && !builder.recording)) return null
    if (event.target?.closest?.('[data-tutorial-builder-panel]')) return null
    const candidates = []
    let node = event.target
    while (node && node !== document.body) {
      if (targetRefFromElement(node)) candidates.push(node)
      node = node.parentElement
    }
    return candidates[0] || null
  }, [builder.open, builder.picking, builder.recording])

  useEffect(() => {
    if (!builder.open || (!builder.picking && !builder.recording)) return undefined
    const move = (event) => {
      const element = pickElement(event)
      const ref = targetRefFromElement(element)
      setHoveredRef(ref)
      setHoveredRect(element?.getBoundingClientRect?.() || null)
    }
    const click = (event) => {
      const element = pickElement(event)
      const ref = targetRefFromElement(element)
      if (!ref) {
        if (builder.picking) {
          event.preventDefault()
          event.stopPropagation()
          setBuilder((current) => ({ ...current, status: 'That element is not registered as a tutorial target.' }))
        }
        return
      }
      const contract = tutorialTarget(ref.id)
      if (builder.picking) {
        event.preventDefault()
        event.stopPropagation()
        commitDocument((document) => {
          const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
          if (step) {
            if (builder.pickPurpose === 'reveal') {
              const existing = step.reveals || []
              if (!existing.some((entry) => sameTargetReference(entry.target || entry, ref))) {
                step.reveals = [...existing, { target: ref, ring: true }]
              }
            } else if (builder.pickPurpose === 'interaction') {
              const capability = firstUserCapability(contract)
              if (capability) {
                const existing = step.interactionPolicy?.targets || []
                step.interactionPolicy = {
                  targets: [...existing.filter((entry) => !sameTargetReference(entry.target, ref)), { target: ref, capabilities: [capability] }],
                }
              }
            } else {
              setStepSpotlight(step, ref)
              step.view = contractView(ref) || step.view
            }
          }
          return document
        }, `Selected ${contract.label} for ${builder.pickPurpose}.`)
        setBuilder((current) => ({ ...current, picking: false, pickPurpose: 'spotlight' }))
        return
      }
      if (!builder.recording || !contract.capabilities.includes('activate')) return
      const step = defaultRecordedStep(builder.document, ref, 'activate')
      appendRecordedStep(step, `Recorded: ${contract.label}.`)
    }
    document.addEventListener('pointermove', move, true)
    document.addEventListener('click', click, true)
    return () => {
      document.removeEventListener('pointermove', move, true)
      document.removeEventListener('click', click, true)
    }
  }, [appendRecordedStep, builder.document, builder.open, builder.pickPurpose, builder.picking, builder.recording, builder.selectedStepId, commitDocument, pickElement])

  useEffect(() => {
    if (!builder.open || !builder.recording) return undefined
    const pending = new Map()
    const remember = (event) => {
      const element = pickElement(event)
      const ref = targetRefFromElement(element)
      const contract = tutorialTarget(ref?.id)
      if (!ref || !contract?.capabilities?.includes('input')) return
      pending.set(element, { ref, value: String(element.value || '') })
    }
    const flush = (element) => {
      const recorded = pending.get(element)
      if (!recorded) return
      pending.delete(element)
      const contract = tutorialTarget(recorded.ref.id)
      const value = contract.recordValue === false ? '' : recorded.value
      const step = defaultRecordedStep(builder.document, recorded.ref, 'input', value)
      appendRecordedStep(step, contract.recordValue === false
        ? `Recorded ${contract.label}; its path was deliberately not retained.`
        : `Recorded input: ${contract.label}.`)
      lastInputAtRef.current = Date.now()
    }
    const key = (event) => {
      remember(event)
      if (event.key === 'Enter') flush(event.target)
    }
    const change = (event) => { remember(event); flush(event.target) }
    const blur = (event) => flush(event.target)
    document.addEventListener('input', remember, true)
    document.addEventListener('keydown', key, true)
    document.addEventListener('change', change, true)
    document.addEventListener('blur', blur, true)
    return () => {
      document.removeEventListener('input', remember, true)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('change', change, true)
      document.removeEventListener('blur', blur, true)
    }
  }, [appendRecordedStep, builder.document, builder.open, builder.recording, pickElement])

  useEffect(() => {
    if (!builder.open || (!builder.picking && !builder.recording)) return undefined
    const leaveCaptureMode = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (builder.recording) document.activeElement?.blur?.()
      setHoveredRef(null)
      setHoveredRect(null)
      setBuilder((current) => ({
        ...current,
        picking: false,
        recording: false,
        status: current.recording
          ? 'Recording stopped. Review and annotate the captured steps.'
          : 'Target selection cancelled.',
      }))
    }
    document.addEventListener('keydown', leaveCaptureMode, true)
    return () => document.removeEventListener('keydown', leaveCaptureMode, true)
  }, [builder.open, builder.picking, builder.recording])

  // Browser motion has no DOM button. Poll its semantic viewport descriptor and record
  // one settled before/after move instead of a trail of wheel or drag events.
  useEffect(() => {
    if (!builder.open || !builder.recording) {
      recordViewportRef.current = null
      return undefined
    }
    recordViewportRef.current = describeBrowserViewport()
    viewportSettleRef.current = { view: recordViewportRef.current, at: Date.now() }
    const timer = setInterval(() => {
      const current = describeBrowserViewport()
      if (!current) return
      const settled = viewportSettleRef.current
      if (!settled.view || !sameBrowserViewport(current, settled.view)) {
        viewportSettleRef.current = { view: current, at: Date.now() }
        return
      }
      const before = recordViewportRef.current
      if (!before || sameBrowserViewport(before, current) || Date.now() - settled.at < 700) return
      recordViewportRef.current = current
      // A search input already describes this move more usefully; do not add a duplicate
      // viewport step immediately after it.
      if (Date.now() - lastInputAtRef.current < 1500) return
      const ref = targetRef('browser.viewport')
      const step = {
        ...nextDraftStep(builder.document, { title: 'Move through the genome', view: 'genome_browser' }),
        spotlight: { target: ref },
        interactionPolicy: { targets: [{ target: ref, capabilities: ['pan', 'zoom'] }] },
        arrive: { type: 'browserView', locus: locus(before) },
        autoplay: { action: { target: ref, capability: 'set-locus', value: locus(current) } },
      }
      appendRecordedStep(step, `Recorded browser move to ${locus(current)}.`)
    }, 250)
    return () => clearInterval(timer)
  }, [appendRecordedStep, builder.document, builder.open, builder.recording])

  const updateStep = (field, value) => commitDocument((document) => {
    const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
    if (step) {
      if (value === '' || value === null || value === undefined) delete step[field]
      else step[field] = value
    }
    return document
  })

  const updateMetadata = (field, value) => commitDocument((document) => ({ ...document, [field]: value }))

  const updateArrival = (type, changes) => commitDocument((document) => {
    const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
    if (!step) return document
    const arrivals = Array.isArray(step.arrive) ? copy(step.arrive) : (step.arrive ? [copy(step.arrive)] : [])
    const index = arrivals.findIndex((arrival) => arrival?.type === type)
    const current = index >= 0 ? arrivals[index] : { type }
    const next = { ...current, ...changes }
    for (const [key, value] of Object.entries(next)) {
      if (value === '' || value === null || value === undefined) delete next[key]
    }
    if (Object.keys(next).length === 1) {
      if (index >= 0) arrivals.splice(index, 1)
    } else if (index >= 0) arrivals[index] = next
    else arrivals.push(next)
    if (arrivals.length) step.arrive = arrivals
    else delete step.arrive
    return document
  })

  const addStep = () => {
    const step = nextDraftStep(builder.document, {
      previousStep: selectedStep,
      view: selectedStep?.view || tutorial.currentView,
    })
    commitDocument((document) => {
      document.steps.splice(Math.max(0, selectedIndex + 1), 0, step)
      return document
    }, 'Step added from the previous step.')
    setBuilder((current) => ({ ...current, selectedStepId: step.id }))
  }

  const duplicateStep = () => {
    if (!selectedStep) return
    const duplicate = copy(selectedStep)
    duplicate.id = `${selectedStep.id}-copy-${Date.now().toString(36)}`
    duplicate.title = `${selectedStep.title} copy`
    commitDocument((document) => {
      document.steps.splice(selectedIndex + 1, 0, duplicate)
      return document
    }, 'Step duplicated.')
    setBuilder((current) => ({ ...current, selectedStepId: duplicate.id }))
  }

  const moveStep = (offset) => {
    const destination = selectedIndex + offset
    if (selectedIndex < 0 || destination < 0 || destination >= builder.document.steps.length) return
    commitDocument((document) => {
      const [moved] = document.steps.splice(selectedIndex, 1)
      document.steps.splice(destination, 0, moved)
      return document
    }, `Step moved ${offset < 0 ? 'up' : 'down'}.`)
  }

  const removeStep = () => {
    if (!selectedStep || builder.document.steps.length < 2) return
    const nextId = builder.document.steps[selectedIndex - 1]?.id || builder.document.steps[selectedIndex + 1]?.id
    commitDocument((document) => {
      document.steps = document.steps.filter((step) => step.id !== selectedStep.id)
      return document
    }, 'Step removed.')
    setBuilder((current) => ({ ...current, selectedStepId: nextId }))
  }

  const undo = () => {
    const previous = history.at(-1)
    if (!previous) return
    setFuture((items) => [copy(builder.document), ...items].slice(0, 100))
    setHistory((items) => items.slice(0, -1))
    setBuilder((current) => ({ ...current, document: previous, selectedStepId: previous.steps[0]?.id || '', status: 'Undid the last authoring change.' }))
  }

  const redo = () => {
    const next = future[0]
    if (!next) return
    setHistory((items) => [...items, copy(builder.document)].slice(-100))
    setFuture((items) => items.slice(1))
    setBuilder((current) => ({ ...current, document: next, selectedStepId: next.steps[0]?.id || '', status: 'Redid the authoring change.' }))
  }

  const checkpoint = async () => {
    const name = window.prompt('Checkpoint name', `Checkpoint ${checkpoints.length + 1}`)
    if (name === null) return
    try {
      const result = await saveTutorialCheckpoint({
        outputDir: builder.outputDir,
        tutorialId: builder.document.id,
        name,
        tutorial: builder.document,
      })
      setCheckpoints((items) => [...items, result.checkpoint])
      setBuilder((current) => ({ ...current, status: `Checkpoint “${result.checkpoint.name}” saved.` }))
    } catch (error) {
      setBuilder((current) => ({ ...current, status: error.message }))
    }
  }

  const restoreCheckpoint = (index) => {
    const saved = checkpoints[index]?.tutorial || checkpoints[index]?.document
    if (saved) commitDocument(saved, `Restored checkpoint ${index + 1}.`)
  }

  const saveNow = async (message = 'Draft saved.') => {
    const current = builderRef.current
    clearTimeout(saveTimerRef.current)
    try {
      await persistDraft(current.outputDir, current.document, message)
      notifyTutorialDraftsChanged(current.outputDir)
      return true
    } catch {
      return false
    }
  }

  const closeBuilder = async () => {
    const current = builderRef.current
    clearTimeout(saveTimerRef.current)
    setBuilder((value) => ({ ...value, status: 'Saving before closing…' }))
    try {
      await persistDraft(current.outputDir, current.document, 'Draft saved.')
      notifyTutorialDraftsChanged(current.outputDir)
      await stopBuilderPreview()
      setBuilder(emptyBuilder)
      setSaveState('idle')
      tutorial.navigateToView('tutorials')
    } catch {
      // Keep the builder open and show the persistence error set by persistDraft.
    }
  }

  const preview = async () => {
    if (!report?.runnable || validation.length) {
      setBuilder((current) => ({ ...current, status: 'Resolve the validation problems before previewing.' }))
      return
    }
    if (!await saveNow('Draft saved before preview.')) return
    registerRuntimeTutorial(builder.document)
    await stopBuilderPreview()
    setBuilder(emptyBuilder)
    setSaveState('idle')
    await tutorial.start(builder.document.id, { outputDir: builder.outputDir, stepIndex: Math.max(0, selectedIndex) })
  }

  const promote = async () => {
    try {
      if (!await saveNow('Draft saved before promotion.')) return
      const result = await promoteTutorialDraft(builder.outputDir, builder.document.id)
      setBuilder((current) => ({ ...current, status: `Promoted to ${result.tutorial.split('/').pop()}.` }))
    } catch (error) {
      setBuilder((current) => ({ ...current, status: error.message }))
    }
  }

  const generateDataset = async () => {
    const species = (builder.config?.active_species || []).find((entry, index) => builderSpeciesKey(entry, index) === datasetForm.speciesKey)
    if (!species?.files?.fasta || !species?.files?.gff3) {
      setBuilder((current) => ({ ...current, status: 'Choose an active genome with FASTA and annotation files.' }))
      return
    }
    setGeneratingDataset(true)
    try {
      if (!await saveNow('Draft saved before generating the dataset.')) return
      const result = await generateTutorialDataset({
        output_dir: builder.outputDir,
        tutorial_id: builder.document.id,
        fasta_path: species.files.fasta,
        annotation_path: species.files.gff3,
        chrom: datasetForm.chrom,
        start: Number(datasetForm.start),
        end: Number(datasetForm.end),
        partial_mode: datasetForm.partialMode,
        source: {
          species_key: species.species_key,
          assembly: species.assembly,
          display_name: species.display_name,
          scientific_name: species.scientific_name,
          common_name: species.common_name,
          provider: species.provider,
          assembly_name: species.assembly_name,
          metadata_path: species.files.metadata,
        },
      })
      commitDocument((document) => {
        const ref = {
          id: result.recipe.datasetRef,
          recipeId: result.recipe.id,
          embedded: true,
          autoActivate: true,
          label: result.recipe.displayName,
          source: result.recipe.source,
        }
        document.datasets = [...(document.datasets || []).filter((entry) => entry.recipeId !== ref.recipeId), ref]
        return document
      }, `Generated ${result.recipe.assemblyName}.`)
    } catch (error) {
      setBuilder((current) => ({ ...current, status: error.message }))
    } finally {
      setGeneratingDataset(false)
    }
  }

  const addTurtlesAndFriendsFixture = async () => {
    setGeneratingFixture(true)
    try {
      if (!await saveNow('Draft saved before generating the example genomes.')) return
      const result = await generateTutorialFixture({
        output_dir: builder.outputDir,
        tutorial_id: builder.document.id,
        fixture_id: TURTLES_AND_FRIENDS_FIXTURE_ID,
      })
      commitDocument((document) => {
        const generatedIds = new Set((result.datasets || []).map((dataset) => dataset.recipeId))
        document.datasets = [
          ...(document.datasets || []).filter((dataset) => !generatedIds.has(dataset.recipeId)),
          ...(result.datasets || []),
        ]
        return document
      }, `Added ${result.genomeCount || 8} synthetic genomes from ${result.label || 'the example set'}.`)
    } catch (error) {
      setBuilder((current) => ({ ...current, status: error.message }))
    } finally {
      setGeneratingFixture(false)
    }
  }

  const setInitialDatasetActivation = (active, recipeId = null) => commitDocument((document) => {
    document.datasets = setTutorialDatasetActivation(document.datasets, active, recipeId)
    return document
  }, recipeId === null
    ? `${active ? 'All' : 'No'} tutorial genomes will be active initially.`
    : `Tutorial genome will start ${active ? 'active' : 'inactive'}.`)

  const detachTutorialDatasets = (recipeIds, message = 'Tutorial dataset detached.') => {
    const detached = new Set((recipeIds || []).map(String))
    if (!detached.size) return
    commitDocument((document) => {
      document.datasets = (document.datasets || []).filter((dataset) => !detached.has(String(dataset?.recipeId || '')))
      return document
    }, message)
  }

  const startBuilderResize = (event) => {
    event.preventDefault()
    builderResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: builderWidth,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
      collapseArmed: false,
    }
    setBuilderCollapseDragOffset(0)
    setBuilderResizeActive(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
  }

  const moveBuilderResize = (event) => {
    const resize = builderResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const rawWidth = resize.startWidth + resize.startX - event.clientX
    const overshoot = Math.max(0, BUILDER_MIN_WIDTH - rawWidth)
    resize.collapseArmed = overshoot >= BUILDER_COLLAPSE_DRAG_THRESHOLD
    setBuilderCollapseDragOffset(Math.min(BUILDER_COLLAPSE_DRAG_THRESHOLD + 24, overshoot))
    setBuilderWidth(clampBuilderWidth(rawWidth))
  }

  const finishBuilderResize = (event, allowCollapse = true) => {
    const resize = builderResizeRef.current
    if (!resize || (event?.pointerId !== undefined && resize.pointerId !== event.pointerId)) return
    builderResizeRef.current = null
    setBuilderCollapseDragOffset(0)
    setBuilderResizeActive(false)
    if (allowCollapse && resize.collapseArmed) setBuilderPanelCollapsed(true)
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    document.body.style.cursor = resize.bodyCursor
    document.body.style.userSelect = resize.bodyUserSelect
  }
  builderResizeHandlersRef.current = { move: moveBuilderResize, finish: finishBuilderResize }

  const resizeBuilderFromKeyboard = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') setBuilderWidth(clampBuilderWidth(BUILDER_DEFAULT_WIDTH))
    else setBuilderWidth((width) => clampBuilderWidth(width + (event.key === 'ArrowLeft' ? 32 : -32)))
  }

  const startDrag = (event, mode) => {
    const position = selectedStep?.cardPosition || { x: 0.55, y: 0.12 }
    const size = selectedStep?.cardSize || { width: TUTORIAL_CARD_WIDTH, height: measuredCardHeight }
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      position,
      size,
      document: copy(builder.document),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    // The panel is authoring chrome, not part of the scene. Remove it while the card is
    // being positioned so the whole viewport is available and nothing moves underneath
    // an opaque sidebar the author cannot see through.
    setCardDragActive(true)
  }

  const moveDrag = (event) => {
    const drag = dragRef.current
    if (!drag || (drag.pointerId !== undefined && event.pointerId !== drag.pointerId)) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    const width = drag.size.width || TUTORIAL_CARD_WIDTH
    const height = drag.size.height || measuredCardHeight || 0
    const maxX = window.innerWidth ? (window.innerWidth - width - TUTORIAL_CARD_MARGIN) / window.innerWidth : 1
    const maxY = window.innerHeight ? (window.innerHeight - height - TUTORIAL_CARD_MARGIN) / window.innerHeight : 1
    const minX = window.innerWidth ? TUTORIAL_CARD_MARGIN / window.innerWidth : 0
    const minY = window.innerHeight ? TUTORIAL_CARD_MARGIN / window.innerHeight : 0
    const value = drag.mode === 'move'
      ? {
          x: Math.max(minX, Math.min(Math.max(minX, maxX), drag.position.x + (dx / window.innerWidth))),
          y: Math.max(minY, Math.min(Math.max(minY, maxY), drag.position.y + (dy / window.innerHeight))),
        }
      : {
          width: Math.max(320, Math.min(620, Math.round((drag.size.width || 420) + dx))),
          height: Math.max(180, Math.min(600, Math.round((drag.size.height || 260) + dy))),
        }
    const field = drag.mode === 'move' ? 'cardPosition' : 'cardSize'
    setBuilder((current) => {
      if (!current.document) return current
      const document = copy(current.document)
      const step = document.steps.find((entry) => entry.id === current.selectedStepId)
      if (step) step[field] = value
      return { ...current, document }
    })
  }

  const finishDrag = () => {
    const drag = dragRef.current
    dragRef.current = null
    setCardDragActive(false)
    if (!drag?.document) return
    setHistory((items) => [...items.slice(-99), drag.document])
    setFuture([])
    setBuilder((current) => current.document ? {
      ...current,
      document: {
        ...current.document,
        revision: Number(drag.document.revision || 1) + 1,
        updatedAt: new Date().toISOString(),
      },
      status: drag.mode === 'move' ? 'Card position updated.' : 'Card size updated.',
    } : current)
  }
  cardDragHandlersRef.current = { move: moveDrag, finish: finishDrag }

  if (!builder.open || !builder.document) return null

  const selectedContract = tutorialTarget(selectedTarget?.id)
  const viewTargets = authoredTargetsForView(selectedStep?.view)
  const interactionTargets = selectedStep?.interactionPolicy?.targets || []
  const scrollableViewTargets = viewTargets.filter((target) => firstUserCapability(target) === 'scroll')
  const ordinaryInteractionTargets = interactionTargets.filter(
    (entry) => !entry.capabilities?.includes('scroll')
  )
  const targetIsHighlighted = (target) => Boolean(
    (selectedTarget && sameTargetReference(selectedTarget, target))
    || (selectedStep?.reveals || []).some((entry) => sameTargetReference(entry.target || entry, target))
  )
  const activationTargets = interactionTargets
    .filter((entry) => entry.capabilities?.includes('activate'))
    .map((entry) => entry.target)
    .filter(Boolean)
  const highlightedCapability = firstUserCapability(selectedContract)
  const highlightedTargetAllowed = Boolean(
    selectedTarget && interactionTargets.some((entry) => sameTargetReference(entry.target, selectedTarget))
  )
  // Only a field can be filled, and only one that this step's view actually offers.
  const copyFillTargets = viewTargets.filter(
    (target) => (target.capabilities || []).includes('input')
  )
  const authoredAction = selectedStep?.autoplay?.action || selectedStep?.autoplay?.actions?.[0] || null
  const authoredActionCapability = selectedStep?.autoplay?.actions?.length > 1
    && selectedStep.autoplay.actions.every((action) => action.capability === 'activate')
    ? 'activate-all'
    : (authoredAction?.capability || '')
  const turtlesAndFriendsDatasets = (builder.document.datasets || []).filter(
    (dataset) => dataset.fixtureId === TURTLES_AND_FRIENDS_FIXTURE_ID
  )
  const turtlesAndFriendsAttached = turtlesAndFriendsDatasets.length === 8
  const embeddedTutorialDatasets = (builder.document.datasets || []).filter((dataset) => dataset?.embedded && dataset?.recipeId)
  const initiallyActiveDatasetCount = embeddedTutorialDatasets.filter(tutorialDatasetStartsActive).length
  const browserViewArrival = arrivalOf(selectedStep, 'browserView')
  const browserControlsArrival = arrivalOf(selectedStep, 'browserControls')
  const selectorListArrival = arrivalOf(selectedStep, 'selectorList')
  const genomeSelectionArrival = arrivalOf(selectedStep, 'genomeSelection')
  // Ordered by the document's datasets rather than by the runtime's active list, so the
  // authored set reads the same way as the checkboxes below it.
  const sceneSelectedRecipeIds = () => {
    const selected = new Set(tutorial.selectedDatasetRecipeIds?.() || [])
    return embeddedTutorialDatasets
      .map((dataset) => String(dataset.recipeId))
      .filter((recipeId) => selected.has(recipeId))
  }
  const arrivalSelectedRecipeIds = new Set(arrivalGenomeRecipeIds(genomeSelectionArrival))
  const pageScrollArrival = arrivalOf(selectedStep, 'pageScroll')
  const dialogArrival = arrivalOf(selectedStep, 'dialog')
  const playlistsArrival = arrivalOf(selectedStep, 'playlists')
  const customGenomeArrival = arrivalOf(selectedStep, 'customGenome')
  const arrivalPlaylistNames = arrivalPlaylists(playlistsArrival).map((playlist) => playlist.name)
  // The step's own highlighted target is what an authored view position is measured
  // against: the author scrolls until this step looks right, and what "right" means is
  // where the thing the step is about sits on the screen.
  const viewPositionTarget = pageScrollArrival?.target || selectedTarget || selectorListArrival?.target || null
  /** How far the target's top currently sits below the top of the scrolling region.
   *
   * Read from the live scene rather than from the document, so "use what I am looking at"
   * means exactly that. Null when the target is not on screen to measure. */
  const sceneViewOffset = () => {
    const node = viewPositionTarget ? findTargetElement(viewPositionTarget) : null
    if (!node?.getBoundingClientRect) return null
    const scroller = document.querySelector('[data-tutorial-page-scroll="true"]')
    const scrollerTop = scroller?.getBoundingClientRect?.().top ?? 0
    return Math.round(node.getBoundingClientRect().top - scrollerTop)
  }
  const cardPosition = selectedStep?.cardPosition || { x: 0.55, y: 0.12 }
  // An authored size is the true size. Without one the card is the reader's default width
  // and whatever height its words need, which is what `measuredCardHeight` reports.
  const cardSize = selectedStep?.cardSize || {
    width: TUTORIAL_CARD_WIDTH,
    height: measuredCardHeight,
  }
  const captureMode = Boolean(builder.picking || builder.recording)
  const narrowBuilder = builderWidth < BUILDER_DEFAULT_WIDTH
  const wideBuilder = builderWidth >= 720
  const extraWideBuilder = builderWidth >= 980
  const builderOpacity = Math.max(0.1, 1 - (builderTransparency / 100))
  const saveStateLabel = saveState === 'saving'
    ? 'Saving…'
    : saveState === 'saved'
      ? 'Saved'
      : saveState === 'error'
        ? 'Save failed'
        : 'Unsaved changes'
  const textInput = 'w-full rounded-md border border-gray-600 bg-gray-900 px-2.5 py-2 text-sm text-gray-100 outline-none focus:border-sky-400'
  const label = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-400'
  const wideField = wideBuilder ? 'col-span-2' : ''
  const presentationRingCount = presentationGeometry.rects.filter((rect, index) => (
    rect && presentationEntries[index]?.ring
  )).length
  const presentationRects = presentationGeometry.rects.map((rect, index) => (
    rect ? expandRect(
      rect,
      presentationEntries[index]?.target?.id === 'browser.viewport' ? 6 : (presentationEntries[index]?.ring && presentationRingCount > 1 ? MULTI_HIGHLIGHT_INSET : 6),
      presentationGeometry.size,
    ) : null
  ))
  const presentationCutouts = nonOverlappingRects(presentationRects.filter(Boolean))
  const presentationRingRects = presentationRects.filter((rect, index) => (
    rect && presentationEntries[index]?.ring
  ))
  const presentationDim = tutorialDimColor(tutorial.theme)
  const sceneActiveGenomeCount = tutorial.configOverride?.active_species?.length ?? sceneState.activeCount
  const renderBuilderPanel = !captureMode && !cardDragActive
  const showBuilderRestoreTab = !captureMode && builderPanelCollapsed && !cardDragActive
  const builderPanelTransform = builderPanelCollapsed
    ? 'translateX(100%)'
    : builderCollapseDragOffset > 0
      ? `translateX(${builderCollapseDragOffset}px)`
      : 'translateX(0)'

  const setHighlightedTargetAllowed = (allowed) => commitDocument((document) => {
    const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
    if (!step || !selectedTarget || !highlightedCapability) return document
    if (allowed) {
      ensureStepInteraction(step, selectedTarget, highlightedCapability)
    } else {
      step.interactionPolicy = {
        targets: (step.interactionPolicy?.targets || []).filter(
          (entry) => !sameTargetReference(entry.target, selectedTarget)
        ),
      }
    }
    return document
  }, allowed ? `Allowed ${targetInstanceLabel(selectedTarget, builder.document?.datasets)}.` : `Made ${targetInstanceLabel(selectedTarget, builder.document?.datasets)} look-only.`)

  const setManualCompletion = (type) => commitDocument((document) => {
    const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
    if (!step) return document
    if (type === 'manual') {
      step.advanceOn = { type: 'manual' }
      return document
    }
    const signal = SIGNAL_COMPLETIONS.find((entry) => `signal:${entry.name}` === type)
    if (signal) {
      step.advanceOn = { type: 'signal', name: signal.name }
      // The result of a search appears away from the box that asked for it, so the step
      // needs a beat to be watched arriving. Suggested rather than imposed: an author who
      // has already set a pause meant it.
      if (step.holdMs === undefined || step.holdMs === null) step.holdMs = signal.holdMs
      return document
    }
    if (type === 'dwell') {
      step.advanceOn = { type: 'dwell', ms: 3000 }
      return document
    }
    if (type === 'all-clicks') {
      const targets = (step.interactionPolicy?.targets || [])
        .filter((entry) => entry.capabilities?.includes('activate'))
        .map((entry) => entry.target)
        .filter(Boolean)
      if (targets.length < 2) return document
      step.advanceOn = { type: 'all-clicks', targets }
      if (step.holdMs === undefined || step.holdMs === null) step.holdMs = 650
      step.autoplay = { actions: targets.map((target) => ({ target, capability: 'activate' })) }
      return document
    }
    const capability = type === 'input' ? 'input' : 'activate'
    const target = targetForCapability(selectedTarget, step.interactionPolicy?.targets || [], capability)
    if (!target) return document
    ensureStepInteraction(step, target, capability)
    const currentAction = step.autoplay?.action || step.autoplay?.actions?.[0]
    step.advanceOn = {
      type,
      target,
      ...(type === 'input' && currentAction?.value ? { value: currentAction.value } : {}),
    }
    return document
  }, type === 'click'
    ? 'The step will complete when the control is clicked.'
    : type === 'all-clicks'
      ? 'The step will complete after every required control has been clicked.'
      : type.startsWith('signal:')
        ? 'The step will complete when the app reports it happened, however it was done.'
        : '')

  const setAutoplayCapability = (capability) => commitDocument((document) => {
    const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
    if (!step) return document
    if (!capability) {
      delete step.autoplay
      return document
    }
    if (capability === 'activate-all') {
      const targets = (step.interactionPolicy?.targets || [])
        .filter((entry) => entry.capabilities?.includes('activate'))
        .map((entry) => entry.target)
        .filter(Boolean)
      if (targets.length) step.autoplay = { actions: targets.map((target) => ({ target, capability: 'activate' })) }
      return document
    }
    const target = targetForCapability(selectedTarget, step.interactionPolicy?.targets || [], capability)
    if (!target) return document
    ensureStepInteraction(step, target, capability)
    const previousAction = step.autoplay?.action || step.autoplay?.actions?.[0]
    step.autoplay = {
      action: {
        target,
        capability,
        ...(capability === 'input' ? { value: previousAction?.value || '', submit: true } : {}),
      },
    }
    return document
  }, capability ? `Next and autoplay will use ${targetInstanceLabel(selectedTarget, builder.document?.datasets)}.` : 'Removed the Next/autoplay action.')

  return (
    <>
      {!captureMode && (
        <svg
          data-tutorial-builder-presentation-preview="true"
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[303]"
          width={Math.max(1, presentationGeometry.size.width)}
          height={Math.max(1, presentationGeometry.size.height)}
          viewBox={`0 0 ${Math.max(1, presentationGeometry.size.width)} ${Math.max(1, presentationGeometry.size.height)}`}
          preserveAspectRatio="none"
        >
          <path fill={presentationDim} fillRule="evenodd" d={cutoutPathD(presentationGeometry.size, presentationCutouts)} />
        </svg>
      )}
      {captureMode && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed left-1/2 top-3 z-[312] flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-sky-400/45 bg-gray-950/60 px-4 py-2 text-xs text-gray-100 shadow-lg backdrop-blur-[2px]"
        >
          <span className={`h-2 w-2 rounded-full ${builder.recording ? 'animate-pulse bg-red-400' : 'bg-sky-300'}`} />
          <span className="font-semibold">{builder.recording ? 'Recording tutorial actions' : 'Select a tutorial target'}</span>
          <span className="text-gray-300">·</span>
          <span className="text-gray-300">Press <kbd className="rounded border border-gray-500/70 bg-gray-900/70 px-1.5 py-0.5 font-mono text-[10px] text-white">Esc</kbd> to {builder.recording ? 'stop' : 'cancel'}</span>
        </div>
      )}
      {hoveredRect && (builder.picking || builder.recording) && (
        <div
          className="pointer-events-none fixed z-[309] rounded-lg border-2 border-sky-300 bg-sky-400/10 shadow-[0_0_0_3px_rgba(14,165,233,0.22)]"
          style={{ left: hoveredRect.left - 4, top: hoveredRect.top - 4, width: hoveredRect.width + 8, height: hoveredRect.height + 8 }}
        >
          <span className="absolute -top-6 left-0 rounded bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {tutorialTarget(hoveredRef?.id)?.label || 'Registered target'}
          </span>
        </div>
      )}

      {!captureMode && presentationRingRects.map((rect, index) => (
        <div
          key={`builder-ring-${index}`}
          data-tutorial-builder-spotlight-ring="true"
          className="pointer-events-none fixed z-[304] rounded-lg border-2 border-white/90 shadow-[0_0_0_3px_rgba(14,165,233,0.3)]"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}

      {showBuilderRestoreTab && (
        <button
          type="button"
          data-tutorial-builder-restore="true"
          aria-label="Expand tutorial builder"
          title="Expand tutorial builder"
          onClick={() => setBuilderPanelCollapsed(false)}
          aria-expanded="false"
          className="fixed right-0 top-3 z-[311] flex h-9 w-9 items-center justify-center rounded-l border border-r-0 border-gray-700 bg-gray-950 text-sky-300 shadow-xl transition-colors hover:bg-gray-800 hover:text-sky-100 focus:outline-none focus:ring-2 focus:ring-sky-400"
        >
          <BuilderChevronGlyph pointsRight={false} />
        </button>
      )}

      {renderBuilderPanel && <aside
        data-tutorial-builder-panel="true"
        aria-hidden={builderPanelCollapsed}
        className={`fixed inset-y-0 right-0 z-[310] isolate flex flex-col overflow-hidden border-l border-gray-700 text-gray-100 transition-transform duration-200 ease-out ${builderPanelCollapsed ? 'pointer-events-none' : ''}`}
        style={{ width: builderWidth, transform: builderPanelTransform }}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gray-950 shadow-2xl transition-opacity" style={{ opacity: builderOpacity }} />
        <div
          role="separator"
          aria-label="Resize tutorial builder"
          aria-orientation="vertical"
          aria-valuemin={BUILDER_MIN_WIDTH}
          aria-valuemax={Math.max(BUILDER_MIN_WIDTH, window.innerWidth - BUILDER_VIEWPORT_GUTTER)}
          aria-valuenow={Math.round(builderWidth)}
          tabIndex={0}
          title="Drag to resize · double-click or press Home to reset"
          className="group absolute inset-y-0 left-0 z-[4] w-2 cursor-ew-resize touch-none outline-none focus:bg-sky-400/15"
          onPointerDown={startBuilderResize}
          onPointerMove={moveBuilderResize}
          onPointerUp={finishBuilderResize}
          onPointerCancel={(event) => finishBuilderResize(event, false)}
          onDoubleClick={() => setBuilderWidth(clampBuilderWidth(BUILDER_DEFAULT_WIDTH))}
          onKeyDown={resizeBuilderFromKeyboard}
        >
          <span className="absolute inset-y-0 left-0 w-px bg-gray-700 transition-colors group-hover:bg-sky-400 group-focus:bg-sky-300" />
          <span className="absolute left-0 top-1/2 h-12 w-1 -translate-y-1/2 rounded-r bg-gray-600 transition-colors group-hover:bg-sky-400 group-focus:bg-sky-300" />
        </div>
        {builderCollapseDragOffset >= BUILDER_COLLAPSE_DRAG_THRESHOLD && (
          <div className="pointer-events-none absolute left-3 top-1/2 z-[5] -translate-y-1/2 rounded-md border border-sky-400/40 bg-gray-950/95 px-2.5 py-1.5 text-[11px] font-semibold text-sky-200 shadow-lg">
            Release to collapse
          </div>
        )}
        <header className="relative z-[1] min-w-[470px] border-b border-gray-700 px-4 py-3">
          <div className="transition-opacity" style={{ opacity: builderOpacity }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">Tutorial builder</div>
                  <button
                    type="button"
                    aria-label="Collapse tutorial builder"
                    aria-expanded="true"
                    title="Collapse tutorial builder"
                    onClick={() => setBuilderPanelCollapsed(true)}
                    className="flex h-[22px] w-[26px] flex-none items-center justify-center rounded text-sky-300 transition-colors hover:bg-gray-700/80 hover:text-sky-100 focus:outline-none focus:ring-2 focus:ring-sky-400"
                  >
                    <BuilderChevronGlyph pointsRight />
                  </button>
                </div>
                <div className="mt-0.5 text-base font-semibold">{builder.document.title}</div>
                <div
                  data-tutorial-builder-save-state={saveState}
                  className={`mt-1 text-[11px] ${saveState === 'error' ? 'text-red-300' : saveState === 'saved' ? 'text-emerald-300' : 'text-amber-200'}`}
                >
                  {saveStateLabel} · drafts are stored in your output directory
                </div>
                <div
                  data-tutorial-builder-scene-state={sceneState.status}
                  className={`mt-1 text-[11px] ${sceneState.status === 'error' || !sceneState.targetFound ? 'text-amber-300' : 'text-emerald-300'}`}
                >
                  {sceneState.status === 'preparing'
                    ? 'Preparing selected step scene…'
                    : sceneState.status === 'error' || !sceneState.targetFound
                      ? sceneState.message
                      : `Scene preview · Step ${selectedIndex + 1} · ${selectedStep?.view || 'current view'} · ${sceneActiveGenomeCount}/${sceneState.genomeCount} genomes active`}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <BuilderButton disabled={saveState === 'saving'} onClick={() => saveNow()}>Save</BuilderButton>
                <BuilderButton disabled={saveState === 'saving'} onClick={closeBuilder}>Save &amp; close</BuilderButton>
              </div>
            </div>
          </div>
          <div className={wideBuilder ? 'mt-3 grid grid-cols-[minmax(260px,0.8fr)_minmax(300px,1.2fr)] items-start gap-3' : ''}>
            <div data-tutorial-builder-transparency-control="true" className={`${wideBuilder ? '' : 'mt-3'} rounded-lg border border-gray-600/80 px-3 py-2`}>
              <div className="mb-1 flex items-center justify-between gap-3">
                <label htmlFor="tutorial-builder-transparency" className="text-[11px] font-semibold text-gray-200">Transparency</label>
                <output htmlFor="tutorial-builder-transparency" className="text-[11px] tabular-nums text-sky-300">{builderTransparency}%</output>
              </div>
              <input
                id="tutorial-builder-transparency"
                aria-label="Builder transparency"
                type="range"
                min="0"
                max="90"
                step="5"
                value={builderTransparency}
                onInput={(event) => setBuilderTransparency(Number(event.target.value))}
                onChange={(event) => setBuilderTransparency(Number(event.target.value))}
                className="block h-1.5 w-full cursor-pointer accent-sky-500"
              />
            </div>
            <div className="transition-opacity" style={{ opacity: builderOpacity }}>
              <div className={`${wideBuilder ? '' : 'mt-3'} flex flex-wrap gap-1.5`}>
                <BuilderButton active={builder.recording} onClick={() => setBuilder((current) => ({ ...current, recording: !current.recording, picking: false, status: !current.recording ? 'Recording registered actions…' : 'Recording stopped.' }))}>
                  {builder.recording ? 'Stop recording' : 'Record actions'}
                </BuilderButton>
                <BuilderButton active={builder.picking && builder.pickPurpose === 'spotlight'} onClick={() => setBuilder((current) => ({ ...current, picking: !(current.picking && current.pickPurpose === 'spotlight'), pickPurpose: 'spotlight', recording: false, status: 'Click a registered target in the app.' }))}>Pick target</BuilderButton>
                <BuilderButton disabled={!history.length} onClick={undo}>Undo</BuilderButton>
                <BuilderButton disabled={!future.length} onClick={redo}>Redo</BuilderButton>
                <BuilderButton onClick={checkpoint}>Checkpoint</BuilderButton>
                <BuilderButton disabled={sceneState.status === 'preparing'} onClick={() => prepareScene({ reset: true })}>Reset scene</BuilderButton>
              </div>
              {builder.status && <p className="mt-2 text-xs text-gray-400">{builder.status}</p>}
            </div>
          </div>
        </header>

        <div
          className={`relative z-[1] grid min-h-0 min-w-[470px] flex-1 ${wideBuilder ? 'grid-cols-[190px_1fr]' : narrowBuilder ? 'grid-cols-[154px_316px]' : 'grid-cols-[154px_1fr]'} transition-opacity`}
          style={{ opacity: builderOpacity }}
        >
          <nav className="overflow-y-auto border-r border-gray-800 p-2">
            <div className="mb-2 flex gap-1">
              <BuilderButton onClick={addStep}>+ Step</BuilderButton>
              <BuilderButton onClick={duplicateStep}>Copy</BuilderButton>
            </div>
            <div className="mb-2 flex gap-1">
              <BuilderButton disabled={selectedIndex <= 0} onClick={() => moveStep(-1)}>↑ Up</BuilderButton>
              <BuilderButton disabled={selectedIndex < 0 || selectedIndex >= builder.document.steps.length - 1} onClick={() => moveStep(1)}>↓ Down</BuilderButton>
            </div>
            <ol className="space-y-1">
              {builder.document.steps.map((step, index) => {
                const broken = report?.unavailableSteps?.[step.id]
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setBuilder((current) => ({ ...current, selectedStepId: step.id }))
                        if (step.view) tutorial.navigateToView(step.view)
                      }}
                      className={`w-full rounded-md px-2 py-2 text-left text-xs ${step.id === builder.selectedStepId ? 'bg-sky-500/20 text-sky-100' : 'text-gray-300 hover:bg-gray-800'}`}
                    >
                      <span className="mr-1 text-gray-500">{index + 1}.</span>{step.title}
                      {broken && <span className="ml-1 text-red-300" title={broken.join(' ')}>!</span>}
                    </button>
                  </li>
                )
              })}
            </ol>
            {checkpoints.length > 0 && (
              <div className="mt-4 border-t border-gray-800 pt-2">
                <div className="text-[10px] font-semibold uppercase text-gray-500">Checkpoints</div>
                {checkpoints.map((entry, index) => (
                  <button key={entry.at} type="button" onClick={() => restoreCheckpoint(index)} className="mt-1 block text-left text-xs text-sky-300 hover:underline">Restore {entry.name || index + 1}</button>
                ))}
              </div>
            )}
          </nav>

          <main className={`${wideBuilder ? 'p-4' : 'p-3'} overflow-y-auto`}>
            <div className={wideBuilder ? 'grid grid-cols-2 items-start gap-3' : 'space-y-3'}>
              <div>
                <label className={label}>Tutorial title</label>
                <input className={textInput} value={builder.document.title} onChange={(event) => updateMetadata('title', event.target.value)} />
              </div>
              <div>
                <label className={label}>Summary</label>
                <textarea className={`${textInput} min-h-16`} value={builder.document.blurb} onChange={(event) => updateMetadata('blurb', event.target.value)} />
              </div>
              <div className="border-t border-gray-800 pt-3">
                <label className={label}>Section</label>
                <input className={textInput} value={selectedStep?.section || ''} onChange={(event) => updateStep('section', event.target.value)} />
              </div>
              <div>
                <label className={label}>Step title</label>
                <input className={textInput} value={selectedStep?.title || ''} onChange={(event) => updateStep('title', event.target.value)} />
              </div>
              <div className={wideField}>
                <label className={label}>Information box</label>
                <textarea className={`${textInput} min-h-24`} value={selectedStep?.body || ''} onChange={(event) => updateStep('body', event.target.value)} />
              </div>
              <div className={wideField}>
                <label className={label}>Value offered on the card</label>
                <input
                  className={textInput}
                  placeholder="Nothing offered"
                  value={selectedStep?.copy || ''}
                  onChange={(event) => {
                    const value = event.target.value
                    updateStep('copy', value.trim() ? value : null)
                    if (!value.trim() && selectedStep?.copyTarget) updateStep('copyTarget', null)
                  }}
                />
                <p className="mt-0.5 text-[11px] leading-snug text-gray-500">
                  For a value too long to retype, where only that value works. Where the
                  reader is meant to supply their own, handing them the tutorial's says
                  otherwise.
                </p>
                {selectedStep?.copy?.trim() && (
                  <select
                    className={`${textInput} mt-1.5`}
                    value={selectedStep?.copyTarget?.id || ''}
                    onChange={(event) => updateStep('copyTarget', event.target.value ? targetRef(event.target.value) : null)}
                  >
                    <option value="">Pressing it copies to the clipboard</option>
                    {copyFillTargets.map((target) => (
                      <option key={target.id} value={target.id}>Pressing it fills {target.label}</option>
                    ))}
                  </select>
                )}
                {selectedStep?.copyTarget?.id && (
                  <p className="mt-0.5 text-[11px] leading-snug text-gray-500">
                    The value still reaches the clipboard as well. Filling leaves the field
                    focused without submitting, so pressing Return stays the reader's move.
                  </p>
                )}
              </div>
              <div>
                <label className={label}>View</label>
                <select className={textInput} value={selectedStep?.view || ''} onChange={(event) => { updateStep('view', event.target.value); tutorial.navigateToView(event.target.value) }}>
                  <option value="">No required view</option>
                  {TUTORIAL_TARGET_VIEWS.filter((view) => view.viewId !== 'app').map((view) => <option key={view.viewId} value={view.viewId}>{view.label}</option>)}
                </select>
              </div>
              <div>
                <label className={label}>Primary highlighted target</label>
                <select
                  className={textInput}
                  value={selectedTarget?.id || ''}
                  onChange={(event) => {
                    const contract = tutorialTarget(event.target.value)
                    if (!contract) {
                      commitDocument((document) => {
                        const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
                        setStepSpotlight(step, null)
                        return document
                      }, 'Removed the primary highlight; additional highlighted targets were kept.')
                      return
                    }
                    if (contract.parameters) {
                      document.activeElement?.blur?.()
                      setBuilder((current) => ({
                        ...current,
                        picking: true,
                        pickPurpose: 'spotlight',
                        recording: false,
                        status: `Click the exact ${contract.label.toLowerCase()} to use as the primary highlight.`,
                      }))
                      return
                    }
                    const ref = targetRef(contract.id)
                    commitDocument((document) => {
                      const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
                      setStepSpotlight(step, ref)
                      return document
                    }, `Changed the primary highlight to ${contract.label}.`)
                  }}
                >
                  <option value="">No primary highlighted target</option>
                  {TUTORIAL_TARGETS.filter((target) => target.authoringVisible && (!selectedStep?.view || target.viewId === selectedStep.view || target.viewId === 'app')).map((target) => (
                    <option key={target.id} value={target.id}>{target.label}{target.parameters ? ' (pick live)' : ''}</option>
                  ))}
                </select>
                {selectedContract && <p className="mt-1 text-[11px] text-gray-500">{selectedContract.kind} · {selectedContract.capabilities.join(', ')}</p>}
                {selectedTarget && (
                  <button
                    type="button"
                    className="mt-1 text-[11px] font-semibold text-red-300 hover:underline"
                    onClick={() => commitDocument((document) => {
                      const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
                      setStepSpotlight(step, null)
                      return document
                    }, 'Removed the primary highlight; additional highlighted targets were kept.')}
                  >
                    Remove primary highlight
                  </button>
                )}
              </div>
              <div>
                <label className={label}>Additional highlighted targets</label>
                <select
                  className={textInput}
                  value=""
                  onChange={(event) => {
                    if (!event.target.value) return
                    const ref = targetRef(event.target.value)
                    const reveals = selectedStep?.reveals || []
                    if (!reveals.some((entry) => sameTargetReference(entry.target || entry, ref))) {
                      updateStep('reveals', [...reveals, { target: ref, ring: true }])
                    }
                  }}
                >
                  <option value="">Add another target…</option>
                  {viewTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
                </select>
                <button type="button" className="mt-1 text-[11px] font-semibold text-sky-300 hover:underline" onClick={() => setBuilder((current) => ({ ...current, picking: true, pickPurpose: 'reveal', recording: false, status: 'Click another registered target to highlight.' }))}>Pick another highlighted target</button>
                <div className="mt-2 space-y-1">
                  {(selectedStep?.reveals || []).map((reveal, index) => (
                    <div key={`${targetReferenceKey(reveal.target || reveal)}-${index}`} className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[11px] text-gray-300">{targetInstanceLabel(reveal.target || reveal)}</span>
                      <button type="button" className="text-red-300" aria-label={`Remove ${targetInstanceLabel(reveal.target || reveal)}`} onClick={() => updateStep('reveals', selectedStep.reveals.filter((_entry, entryIndex) => entryIndex !== index))}>×</button>
                    </div>
                  ))}
                </div>
              </div>
              <div className={`${wideField} rounded-md border border-gray-700 p-2.5`}>
                <label className={label}>Allowed interactions (separate from highlights)</label>
                <select
                  className={textInput}
                  value=""
                  onChange={(event) => {
                    const contract = tutorialTarget(event.target.value)
                    const capability = firstUserCapability(contract)
                    if (!contract || !capability) return
                    const ref = targetRef(contract.id)
                    const existing = interactionTargets.filter((entry) => !sameTargetReference(entry.target, ref))
                    updateStep('interactionPolicy', { targets: [...existing, { target: ref, capabilities: [capability] }] })
                  }}
                >
                  <option value="">Add an allowed control…</option>
                  {viewTargets.filter((target) => {
                    const capability = firstUserCapability(target)
                    return capability && capability !== 'scroll'
                  }).map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
                </select>
                <button type="button" className="mt-1.5 text-[11px] font-semibold text-sky-300 hover:underline" onClick={() => setBuilder((current) => ({ ...current, picking: true, pickPurpose: 'interaction', recording: false, status: 'Click the exact registered control to allow.' }))}>Pick live allowed control</button>
                {scrollableViewTargets.length > 0 && (
                  <div className="mt-2 rounded-md border border-gray-700 bg-gray-950/35 px-2.5 py-2">
                    <div className="text-[11px] font-semibold text-gray-200">Scrollable regions</div>
                    <p className="mt-0.5 text-[11px] leading-snug text-gray-500">Scrolling is passed through without highlighting or undimming the region.</p>
                    <div className="mt-1.5 space-y-1.5">
                      {scrollableViewTargets.map((target) => {
                        const ref = targetRef(target.id)
                        const allowed = interactionTargets.some((entry) => (
                          sameTargetReference(entry.target, ref) && entry.capabilities?.includes('scroll')
                        ))
                        const alsoHighlighted = targetIsHighlighted(ref)
                        return (
                          <div key={target.id} className="rounded border border-gray-800 px-2 py-1.5">
                            <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-200">
                              <input
                                type="checkbox"
                                checked={allowed}
                                onChange={(event) => {
                                  const existing = interactionTargets.filter((entry) => !sameTargetReference(entry.target, ref))
                                  updateStep('interactionPolicy', {
                                    targets: event.target.checked
                                      ? [...existing, { target: ref, capabilities: ['scroll'] }]
                                      : existing,
                                  })
                                }}
                                className="h-4 w-4 accent-sky-500"
                              />
                              <span>Allow scrolling in {target.label}</span>
                            </label>
                            {allowed && alsoHighlighted && (
                              <div className="mt-1.5 rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-200">
                                <span>{target.label} is also highlighted, so the whole region is lit.</span>{' '}
                                <button
                                  type="button"
                                  className="font-semibold text-amber-100 underline hover:text-white"
                                  onClick={() => commitDocument((document) => {
                                    const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
                                    if (!step) return document
                                    const spotlight = step.spotlight?.target || step.spotlight
                                    if (spotlight && sameTargetReference(spotlight, ref)) delete step.spotlight
                                    step.reveals = (step.reveals || []).filter(
                                      (entry) => !sameTargetReference(entry.target || entry, ref)
                                    )
                                    return document
                                  }, `Kept ${target.label} scrollable and removed its highlight.`)}
                                >
                                  Keep scrolling, dim this region
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {selectedTarget && highlightedCapability && (
                  <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-2 text-xs text-sky-100">
                    <input
                      type="checkbox"
                      checked={highlightedTargetAllowed}
                      onChange={(event) => setHighlightedTargetAllowed(event.target.checked)}
                      className="h-4 w-4 accent-sky-500"
                    />
                    <span className="min-w-0">
                      <span className="block font-semibold">Allow interaction with highlighted target</span>
                      <span className="block truncate text-[11px] text-sky-300">{targetInstanceLabel(selectedTarget, builder.document?.datasets)} · {highlightedCapability}</span>
                    </span>
                  </label>
                )}
                <div className="mt-2 space-y-1.5">
                  {ordinaryInteractionTargets.map((entry) => {
                    const index = interactionTargets.indexOf(entry)
                    const contract = tutorialTarget(entry.target?.id)
                    const capabilities = (contract?.capabilities || []).filter((capability) => !['spotlight', 'read-state', 'set-state', 'set-locus'].includes(capability))
                    return (
                      <div key={`${entry.target?.id}-${index}`} className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-300">{contract?.label || entry.target?.id}</span>
                        <select className="rounded border border-gray-700 bg-gray-900 px-1.5 py-1 text-[11px]" value={entry.capabilities?.[0] || ''} onChange={(event) => updateStep('interactionPolicy', { targets: interactionTargets.map((item, itemIndex) => itemIndex === index ? { ...item, capabilities: [event.target.value] } : item) })}>
                          {capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}
                        </select>
                        <button type="button" className="text-red-300" aria-label={`Remove ${contract?.label || 'interaction'}`} onClick={() => updateStep('interactionPolicy', { targets: interactionTargets.filter((_item, itemIndex) => itemIndex !== index) })}>×</button>
                      </div>
                    )
                  })}
                  {!interactionTargets.length && (selectedStep?.interactionPolicy ? (
                    <p className="text-[11px] text-gray-500">Look only. A broad panel can be highlighted while only chosen child controls are allowed.</p>
                  ) : (
                    <div className="space-y-1.5">
                      <p className="text-[11px] leading-relaxed text-amber-300">
                        This step names no controls at all, which leaves everything inside its
                        highlight live. A step that describes a panel the reader is asked to use
                        one step later should say so explicitly.
                      </p>
                      <BuilderButton onClick={() => updateStep('interactionPolicy', { targets: [] })}>
                        Make this step look-only
                      </BuilderButton>
                    </div>
                  ))}
                </div>
              </div>
              <details className="rounded-md border border-gray-700 p-2.5">
                <summary className="cursor-pointer text-xs font-semibold text-gray-200">Progression and autoplay</summary>
                <div className="mt-2 space-y-2">
                  <div>
                    <label className={label}>Manual completion</label>
                    <select className={textInput} value={selectedStep?.advanceOn?.type === 'signal' ? `signal:${selectedStep.advanceOn.name}` : (selectedStep?.advanceOn?.type || 'manual')} onChange={(event) => setManualCompletion(event.target.value)}>
                      <option value="manual">Next button</option>
                      <option value="click" disabled={!targetForCapability(selectedTarget, interactionTargets, 'activate')}>When the highlighted/allowed control is clicked</option>
                      <option value="all-clicks" disabled={activationTargets.length < 2}>When every allowed control has been clicked</option>
                      <option value="input" disabled={!targetForCapability(selectedTarget, interactionTargets, 'input')}>When the expected value is entered</option>
                      {SIGNAL_COMPLETIONS.filter((entry) => entry.views.includes(selectedStep?.view)).map((entry) => (
                        <option key={entry.name} value={`signal:${entry.name}`}>{entry.label}</option>
                      ))}
                      <option value="dwell">After a fixed pause</option>
                    </select>
                  </div>
                  {selectedStep?.advanceOn?.type === 'dwell' && <div><label className={label}>Pause (ms)</label><input className={textInput} type="number" min="250" value={selectedStep.advanceOn.ms || 3000} onChange={(event) => updateStep('advanceOn', { ...selectedStep.advanceOn, ms: Number(event.target.value) })} /></div>}
                  <div>
                    <label className={label}>Next/autoplay action</label>
                    <select className={textInput} value={authoredActionCapability} onChange={(event) => setAutoplayCapability(event.target.value)}>
                      <option value="">No action; just continue</option>
                      {targetForCapability(selectedTarget, interactionTargets, 'activate') && <option value="activate">Activate the highlighted/allowed control</option>}
                      {activationTargets.length > 1 && <option value="activate-all">Activate every allowed control</option>}
                      {targetForCapability(selectedTarget, interactionTargets, 'input') && <option value="input">Enter a value</option>}
                    </select>
                  </div>
                  {authoredAction?.capability === 'activate' && <label className={label}>Button state after Next
                    <select className={textInput} value={selectedStep.autoplay?.options?.desiredEngaged === undefined ? '' : String(selectedStep.autoplay.options.desiredEngaged)} onChange={(e) => updateStep('autoplay', { ...selectedStep.autoplay, options: { ...selectedStep.autoplay?.options, desiredEngaged: e.target.value === '' ? undefined : e.target.value === 'true' } })}>
                      <option value="">Press once</option><option value="true">On (skip buttons already on)</option><option value="false">Off (skip buttons already off)</option>
                    </select>
                  </label>}
                  {authoredAction?.capability === 'input' && (
                    <div className="space-y-1.5">
                      <div><label className={label}>Value to enter</label><input className={textInput} value={authoredAction.value || ''} onChange={(event) => updateStep('autoplay', { action: { ...authoredAction, value: event.target.value } })} /></div>
                      <label className="flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-gray-300">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-sky-500"
                          checked={Boolean(authoredAction.overwrite)}
                          onChange={(event) => updateStep('autoplay', { action: { ...authoredAction, overwrite: event.target.checked || undefined } })}
                        />
                        <span>
                          Only this value will do
                          <span className="mt-0.5 block text-gray-500">
                            On: Next types this over anything else, and does nothing when the field
                            already says it. Off: whatever the reader wrote stands, and Next only
                            fills an empty field.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className={label}>Autoplay dwell (ms)</label><input className={textInput} type="number" min="0" placeholder="Automatic" value={selectedStep?.autoplayMs ?? ''} onChange={(event) => updateStep('autoplayMs', event.target.value === '' ? null : Number(event.target.value))} /></div>
                    <div><label className={label}>Pause after completion (ms)</label><input className={textInput} type="number" min="0" value={selectedStep?.holdMs ?? ''} onChange={(event) => updateStep('holdMs', event.target.value === '' ? null : Number(event.target.value))} /></div>
                  </div>
                </div>
              </details>
              {selectedStep?.view === 'genome_browser' && <>
                <TutorialBrowserDemoEditor value={selectedStep.autoplayDemo} datasets={embeddedTutorialDatasets} onChange={(value) => updateStep('autoplayDemo', value)} />
                <TutorialBrowserSceneEditor title="Multi-genome arrival state" datasets={embeddedTutorialDatasets}
                  value={arrivalOf(selectedStep, 'browserScene')}
                  onChange={(scene) => commitDocument((document) => {
                    const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
                    const arrivals = [step.arrive].flat().filter((a) => a && a.type !== 'browserScene')
                    step.arrive = scene ? [...arrivals, { ...scene, type: 'browserScene' }] : arrivals
                    return document
                  })} />
                <TutorialBrowserSceneEditor title="Browser state applied by Next" datasets={embeddedTutorialDatasets}
                  value={selectedStep.action?.type === 'browserScene' ? selectedStep.action : null}
                  onChange={(scene) => commitDocument((document) => {
                    const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
                    delete step.autoplay
                    step.action = scene ? { ...scene, type: 'browserScene' } : { type: 'none' }
                    return document
                  })} />
                <TutorialBrowserSceneEditor title="Complete when the browser matches" datasets={embeddedTutorialDatasets} checkOnly
                  value={selectedStep.completeWhen}
                  onChange={(scene) => commitDocument((document) => {
                    const step = document.steps.find((entry) => entry.id === builder.selectedStepId)
                    if (scene) { step.completeWhen = scene; step.advanceOn = { type: 'signal', name: 'browser.state' } }
                    else { delete step.completeWhen; step.advanceOn = { type: 'manual' } }
                    return document
                  })} />
                <label className="text-xs text-gray-300">Message for a locked genome control bar
                  <input className={textInput} value={selectedStep.blockedControlMessage || ''} placeholder="This control bar isn't active for this step."
                    onChange={(e) => updateStep('blockedControlMessage', e.target.value)} />
                </label>
              </>}
              {selectedStep?.view === 'genome_browser' && (
                <details className="rounded-md border border-gray-700 p-2.5">
                  <summary className="cursor-pointer text-xs font-semibold text-gray-200">Browser arrival state</summary>
                  <div className="mt-2 space-y-2">
                    <div><label className={label}>Locus shown before the card</label><input className={textInput} placeholder="1:100,000-120,000" value={browserViewArrival?.locus || ''} onChange={(event) => updateArrival('browserView', { locus: event.target.value })} /></div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {['detail', 'flatten', 'expanded'].map((field) => (
                        <div key={field}><label className={label}>{field}</label><select className={textInput} value={browserControlsArrival?.[field] === undefined ? '' : String(browserControlsArrival[field])} onChange={(event) => updateArrival('browserControls', { [field]: event.target.value === '' ? undefined : event.target.value === 'true' })}><option value="">Keep</option><option value="true">On</option><option value="false">Off</option></select></div>
                      ))}
                    </div>
                  </div>
                </details>
              )}
              {selectedStep?.view === 'genome_selector' && (
                <details className="rounded-md border border-gray-700 p-2.5" open>
                  <summary className="cursor-pointer text-xs font-semibold text-gray-200">Genome list arrival state</summary>
                  <div className="mt-2 space-y-2">
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-xs text-sky-100">
                      <input
                        type="checkbox"
                        checked={Boolean(selectorListArrival)}
                        onChange={(event) => updateArrival('selectorList', event.target.checked ? {
                          target: targetRef('selector.genomeList'),
                          fitAllRows: true,
                          preserveOrder: true,
                          lockScroll: true,
                          center: true,
                        } : {
                          target: undefined,
                          fitAllRows: undefined,
                          preserveOrder: undefined,
                          lockScroll: undefined,
                          center: undefined,
                        })}
                        className="mt-0.5 h-4 w-4 accent-sky-500"
                      />
                      <span>
                        <span className="block font-semibold">Frame a fixed, complete genome list</span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-sky-300">
                          Fit every row, centre the list before showing the card, prevent internal scrolling, and keep rows in place while genomes are selected.
                        </span>
                      </span>
                    </label>
                    <p className="text-[11px] leading-relaxed text-gray-400">
                      This changes only the scene layout. It does not highlight the list or allow interaction with it.
                    </p>
                  </div>
                </details>
              )}
              <details className="rounded-md border border-gray-700 p-2.5" open={Boolean(pageScrollArrival)}>
                <summary className="cursor-pointer text-xs font-semibold text-gray-200">View position on arrival</summary>
                <div className="mt-2 space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-xs text-sky-100">
                    <input
                      type="checkbox"
                      disabled={!viewPositionTarget}
                      checked={Boolean(pageScrollArrival)}
                      onChange={(event) => updateArrival('pageScroll', event.target.checked
                        ? { target: viewPositionTarget, offset: sceneViewOffset() ?? 0 }
                        : { target: undefined, offset: undefined })}
                      className="mt-0.5 h-4 w-4 accent-sky-500"
                    />
                    <span>
                      <span className="block font-semibold">Open this step with the page scrolled as it is now</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-sky-300">
                        Scroll the app until the step looks right, then tick this. Arriving from the
                        previous step scrolls smoothly to the same place, so the card and its target
                        are never half off the screen.
                      </span>
                    </span>
                  </label>
                  {!viewPositionTarget && (
                    <p className="text-[11px] leading-relaxed text-gray-400">
                      Pick the step&rsquo;s highlighted target first. The position is remembered as where
                      that target sits on screen, so it frames the same picture at another window size.
                    </p>
                  )}
                  {pageScrollArrival && (
                    <>
                      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-gray-700 px-2.5 py-2 text-xs text-gray-200">
                        <input
                          type="checkbox"
                          checked={pageScrollArrival.center === true}
                          onChange={(event) => updateArrival('pageScroll', event.target.checked
                            ? { target: viewPositionTarget, center: true, offset: undefined }
                            : { target: viewPositionTarget, center: undefined, offset: sceneViewOffset() ?? 0 })}
                          className="mt-0.5 h-4 w-4 accent-sky-500"
                        />
                        <span>
                          <span className="block font-semibold">Centre it instead of framing it</span>
                          <span className="mt-0.5 block text-[11px] leading-relaxed text-gray-400">
                            For a control the reader has to press. The page centres it as far as it
                            will scroll, so it cannot end up against the bottom edge of a window
                            shorter than this one.
                          </span>
                        </span>
                      </label>
                      {pageScrollArrival.center !== true && (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[11px] leading-relaxed text-gray-400">
                            {targetInstanceLabel(viewPositionTarget)} sits {Math.round(Number(pageScrollArrival.offset) || 0)} px
                            below the top of the page area.
                          </p>
                          <BuilderButton onClick={() => {
                            const offset = sceneViewOffset()
                            if (offset === null) {
                              setBuilder((current) => ({ ...current, status: 'That target is not on screen to measure.' }))
                              return
                            }
                            updateArrival('pageScroll', { target: viewPositionTarget, offset })
                          }}>
                            Use current position
                          </BuilderButton>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </details>
              <details className="rounded-md border border-gray-700 p-2.5" open={Boolean(dialogArrival)}>
                <summary className="cursor-pointer text-xs font-semibold text-gray-200">Dialog on arrival</summary>
                <div className="mt-2 space-y-2">
                  <select
                    className={textInput}
                    value={dialogArrival?.dialog || ''}
                    onChange={(event) => updateArrival('dialog', { dialog: event.target.value || undefined })}
                  >
                    <option value="">Leave whatever is open alone</option>
                    <option value="playlistMembership">The playlist dialog, for the selected genomes</option>
                    <option value="playlistPopover">The top-bar playlist popover</option>
                    <option value="none">Nothing: make sure they are closed</option>
                  </select>
                  <p className="text-[11px] leading-relaxed text-gray-400">
                    A step about a dialog has to be able to open it, or it is only reachable by doing
                    the step before it &mdash; including here in the builder. Give the step that opens one
                    &ldquo;make sure they are closed&rdquo;, so coming Back to it does not leave the dialog
                    covering the control the reader is being asked to press.
                  </p>
                </div>
              </details>
              <details className={`${wideField} rounded-md border border-gray-700 p-2.5`} open={Boolean(customGenomeArrival)}>
                <summary className="cursor-pointer text-xs font-semibold text-gray-200">Add-a-genome form on arrival</summary>
                <div className="mt-2 space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-xs text-sky-100">
                    <input
                      type="checkbox"
                      checked={Boolean(customGenomeArrival)}
                      onChange={(event) => updateArrival('customGenome', event.target.checked ? {
                        panel: 'open',
                        fields: { genomeLabel: '', assemblyLabel: '', accession: '', fasta: '', annotation: '', homology: '' },
                        reports: { genome: 'none', annotation: 'none' },
                        browser: { state: 'closed', directory: 'demo' },
                        registered: false,
                        active: false,
                      } : null)}
                      className="mt-0.5"
                    />
                    <span>State the add-a-genome form on arrival</span>
                  </label>
                  {customGenomeArrival && (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={label}>Genome label</label>
                          <input
                            className={textInput}
                            placeholder="Ensemblus welcomus"
                            value={customGenomeArrival.fields?.genomeLabel || ''}
                            onChange={(event) => updateArrival('customGenome', {
                              fields: { ...customGenomeArrival.fields, genomeLabel: event.target.value },
                            })}
                          />
                        </div>
                        <div>
                          <label className={label}>Assembly label</label>
                          <input
                            className={textInput}
                            placeholder="EnsWel1.0"
                            value={customGenomeArrival.fields?.assemblyLabel || ''}
                            onChange={(event) => updateArrival('customGenome', {
                              fields: { ...customGenomeArrival.fields, assemblyLabel: event.target.value },
                            })}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {[['fasta', 'Sequence file'], ['annotation', 'Annotation file']].map(([field, name]) => (
                          <div key={field}>
                            <label className={label}>{name}</label>
                            <select
                              className={textInput}
                              value={customGenomeArrival.fields?.[field] || ''}
                              onChange={(event) => updateArrival('customGenome', {
                                fields: { ...customGenomeArrival.fields, [field]: event.target.value },
                              })}
                            >
                              <option value="">Empty</option>
                              <option value={`demo:${field === 'fasta' ? 'fasta' : 'annotation'}`}>The demo {field === 'fasta' ? 'FASTA' : 'GTF'}</option>
                            </select>
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {[['genome', 'Sequence report'], ['annotation', 'Annotation report']].map(([kind, name]) => (
                          <div key={kind}>
                            <label className={label}>{name}</label>
                            <select
                              className={textInput}
                              value={customGenomeArrival.reports?.[kind] || 'none'}
                              onChange={(event) => updateArrival('customGenome', {
                                reports: { ...customGenomeArrival.reports, [kind]: event.target.value },
                              })}
                            >
                              <option value="none">Not analysed</option>
                              <option value="ready">Analysed, report showing</option>
                            </select>
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={label}>File browser</label>
                          <select
                            className={textInput}
                            value={customGenomeArrival.browser?.state === 'open' ? (customGenomeArrival.browser.target || 'manual_fasta') : ''}
                            onChange={(event) => updateArrival('customGenome', {
                              browser: event.target.value
                                ? { state: 'open', target: event.target.value, directory: 'demo' }
                                : { state: 'closed', directory: 'demo' },
                            })}
                          >
                            <option value="">Closed</option>
                            <option value="manual_fasta">Open, choosing a sequence file</option>
                            <option value="manual_gff3">Open, choosing an annotation</option>
                          </select>
                        </div>
                        <div>
                          <label className={label}>The genome itself</label>
                          <select
                            className={textInput}
                            value={customGenomeArrival.registered ? (customGenomeArrival.active ? 'active' : 'registered') : ''}
                            onChange={(event) => updateArrival('customGenome', {
                              registered: event.target.value !== '',
                              active: event.target.value === 'active',
                            })}
                          >
                            <option value="">Not added yet</option>
                            <option value="registered">Added, not activated</option>
                            <option value="active">Added and activated</option>
                          </select>
                        </div>
                      </div>
                      <p className="text-[11px] leading-relaxed text-gray-400">
                        The files are named symbolically, never as paths: the tutorial lays its own copy
                        of the demo genome inside the sandbox and the runtime fills in where it landed.
                        &ldquo;Not added yet&rdquo; is a real instruction &mdash; give it to the step that presses
                        <strong> Add genome</strong>, or coming Back to that step finds the job already done.
                        Adding the genome converts and indexes its annotation, so a step declaring it added
                        waits for that rather than assuming.
                      </p>
                    </>
                  )}
                </div>
              </details>
              <details className={`${wideField} rounded-md border border-gray-700 p-2.5`} open={Boolean(playlistsArrival)}>
                <summary className="cursor-pointer text-xs font-semibold text-gray-200">Playlists on arrival</summary>
                <div className="mt-2 space-y-2">
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-xs text-sky-100">
                    <input
                      type="checkbox"
                      checked={Boolean(playlistsArrival)}
                      onChange={(event) => updateArrival('playlists', event.target.checked
                        ? { ...tutorial.scenePlaylists?.(), playlists: tutorial.scenePlaylists?.().playlists || [] }
                        : { playlists: undefined, selected: undefined })}
                      className="mt-0.5 h-4 w-4 accent-sky-500"
                    />
                    <span>
                      <span className="block font-semibold">Set which playlists exist when this step opens</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-sky-300">
                        Taken from the playlists in the scene right now. Every step after the one that
                        creates a playlist needs this, or the playlist is missing whenever the step is
                        reached any other way &mdash; and redoing the creation step fails, because the app
                        refuses a second playlist with the same name.
                      </span>
                    </span>
                  </label>
                  {playlistsArrival && (
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[11px] leading-relaxed text-gray-400">
                        {arrivalPlaylistNames.length === 0
                          ? 'No playlists: the step opens before any have been created.'
                          : `${arrivalPlaylistNames.join(', ')}${playlistsArrival.selected ? ` — showing ${playlistsArrival.selected}` : ''}.`}
                      </p>
                      <div className="flex shrink-0 gap-1.5">
                        <BuilderButton onClick={() => updateArrival('playlists', {
                          ...tutorial.scenePlaylists?.(),
                          playlists: tutorial.scenePlaylists?.().playlists || [],
                        })}>
                          Use the scene
                        </BuilderButton>
                        <BuilderButton
                          disabled={arrivalPlaylistNames.length === 0}
                          onClick={() => updateArrival('playlists', { playlists: [], selected: undefined })}
                        >
                          None
                        </BuilderButton>
                      </div>
                    </div>
                  )}
                </div>
              </details>
              {embeddedTutorialDatasets.length > 0 && (
                <details className={`${wideField} rounded-md border border-gray-700 p-2.5`} open={Boolean(genomeSelectionArrival)}>
                  <summary className="cursor-pointer text-xs font-semibold text-gray-200">Selected genomes on arrival</summary>
                  <div className="mt-2 space-y-2">
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-xs text-sky-100">
                      <input
                        type="checkbox"
                        checked={Boolean(genomeSelectionArrival)}
                        onChange={(event) => updateArrival('genomeSelection', {
                          genomes: event.target.checked ? sceneSelectedRecipeIds() : undefined,
                        })}
                        className="mt-0.5 h-4 w-4 accent-sky-500"
                      />
                      <span>
                        <span className="block font-semibold">Set which genomes are selected when this step opens</span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-sky-300">
                          Starts from whatever is selected in the scene right now. The step then establishes exactly this set every time it is entered — from Next, from Back, from a skipped step, and here in the builder.
                        </span>
                      </span>
                    </label>
                    {genomeSelectionArrival && (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-[11px] leading-relaxed text-gray-400">
                            {arrivalSelectedRecipeIds.size === 0
                              ? 'Nothing selected: the genome pills strip is empty when this step opens.'
                              : `${arrivalSelectedRecipeIds.size} of ${embeddedTutorialDatasets.length} selected, so they appear as pills in the top bar.`}
                          </p>
                          <div className="flex shrink-0 gap-1.5">
                            <BuilderButton
                              disabled={arrivalSelectedRecipeIds.size === embeddedTutorialDatasets.length}
                              onClick={() => updateArrival('genomeSelection', {
                                genomes: embeddedTutorialDatasets.map((dataset) => dataset.recipeId),
                              })}
                            >
                              All
                            </BuilderButton>
                            <BuilderButton
                              disabled={arrivalSelectedRecipeIds.size === 0}
                              onClick={() => updateArrival('genomeSelection', { genomes: [] })}
                            >
                              None
                            </BuilderButton>
                          </div>
                        </div>
                        <div className={`grid max-h-40 ${extraWideBuilder ? 'grid-cols-4' : wideBuilder ? 'grid-cols-3' : 'grid-cols-2'} gap-1.5 overflow-y-auto pr-1`}>
                          {embeddedTutorialDatasets.map((dataset) => (
                            <label key={dataset.recipeId} className="flex cursor-pointer items-start gap-2 rounded border border-sky-400/20 bg-gray-950/30 px-2 py-1.5 text-[11px] text-gray-200 hover:border-sky-400/40">
                              <input
                                type="checkbox"
                                className="mt-0.5 accent-sky-500"
                                checked={arrivalSelectedRecipeIds.has(String(dataset.recipeId))}
                                onChange={(event) => {
                                  const next = new Set(arrivalSelectedRecipeIds)
                                  if (event.target.checked) next.add(String(dataset.recipeId))
                                  else next.delete(String(dataset.recipeId))
                                  updateArrival('genomeSelection', {
                                    genomes: embeddedTutorialDatasets
                                      .map((entry) => String(entry.recipeId))
                                      .filter((recipeId) => next.has(recipeId)),
                                  })
                                }}
                              />
                              <span className="min-w-0 truncate" title={dataset.label || dataset.recipeId}>{dataset.label || dataset.recipeId}</span>
                            </label>
                          ))}
                        </div>
                        <p className="text-[11px] leading-relaxed text-gray-400">
                          Give the step before a selection step its own empty set, so returning to it shows the selection being made rather than one already made.
                        </p>
                      </>
                    )}
                  </div>
                </details>
              )}
              <div className={`${wideField} grid ${wideBuilder ? 'grid-cols-4' : 'grid-cols-2'} gap-2`}>
                <div><label className={label}>Card X (0–1)</label><input className={textInput} type="number" min="0" max="1" step="0.01" value={selectedStep?.cardPosition?.x ?? 0.55} onChange={(event) => updateStep('cardPosition', { x: Number(event.target.value), y: selectedStep?.cardPosition?.y ?? 0.12 })} /></div>
                <div><label className={label}>Card Y (0–1)</label><input className={textInput} type="number" min="0" max="1" step="0.01" value={selectedStep?.cardPosition?.y ?? 0.12} onChange={(event) => updateStep('cardPosition', { x: selectedStep?.cardPosition?.x ?? 0.55, y: Number(event.target.value) })} /></div>
                <div><label className={label}>Width</label><input className={textInput} type="number" min="320" max="620" value={selectedStep?.cardSize?.width ?? 420} onChange={(event) => updateStep('cardSize', { width: Math.max(320, Math.min(620, Number(event.target.value))), height: selectedStep?.cardSize?.height ?? 260 })} /></div>
                <div><label className={label}>Height</label><input className={textInput} type="number" min="180" max="600" value={selectedStep?.cardSize?.height ?? 260} onChange={(event) => updateStep('cardSize', { width: selectedStep?.cardSize?.width ?? 420, height: Math.max(180, Math.min(600, Number(event.target.value))) })} /></div>
              </div>
              <details className={`${wideField} rounded-md border border-gray-700 p-2.5`}>
                <summary className="cursor-pointer text-xs font-semibold text-gray-200">Tutorial datasets</summary>
                {embeddedTutorialDatasets.length > 0 && <div className="mt-2 space-y-2">
                  {embeddedTutorialDatasets.map((dataset) => <label key={dataset.recipeId} className="block text-xs text-gray-300">
                    Pill label · {dataset.recipeId}
                    <input className={textInput} aria-label={`Pill label for ${dataset.recipeId}`} value={dataset.label || ''} onChange={(event) => {
                      const value = event.target.value
                      commitDocument((document) => {
                        document.datasets.find((entry) => entry.recipeId === dataset.recipeId).label = value
                        return document
                      })
                    }} />
                  </label>)}
                </div>}
                <div className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2.5">
                  <div className="text-xs font-semibold text-emerald-100">Turtles &amp; friends · 8 fake genomes</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-emerald-200/80">Four turtle species plus Splinter, April, Rocksteady and Bebop. Their short FASTA and annotation files are entirely synthetic and travel with the tutorial package.</p>
                  <div className="mt-2 flex items-center gap-2">
                    <BuilderButton disabled={generatingFixture || turtlesAndFriendsAttached} onClick={addTurtlesAndFriendsFixture}>
                      {generatingFixture ? 'Generating 8 genomes…' : turtlesAndFriendsAttached ? 'Attached to tutorial' : 'Add example set'}
                    </BuilderButton>
                    {turtlesAndFriendsDatasets.length > 0 && (
                      <BuilderButton
                        danger
                        onClick={() => detachTutorialDatasets(
                          turtlesAndFriendsDatasets.map((dataset) => dataset.recipeId),
                          'Detached the Turtles & friends genomes. Use Undo to restore them.',
                        )}
                      >
                        Detach set
                      </BuilderButton>
                    )}
                    {turtlesAndFriendsDatasets.length > 0 && <span className="text-[11px] text-emerald-300">✓ {turtlesAndFriendsDatasets.length}/8 genomes</span>}
                  </div>
                </div>
                {embeddedTutorialDatasets.length > 0 && (
                  <div className="mt-3 rounded-md border border-sky-500/30 bg-sky-500/10 p-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold text-sky-100">Initially active genomes</div>
                        <p className="mt-1 text-[11px] leading-relaxed text-sky-200/80">
                          {initiallyActiveDatasetCount} of {embeddedTutorialDatasets.length} active when the tutorial starts. Inactive genomes still appear in the selector and can be added to playlists.
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <BuilderButton disabled={initiallyActiveDatasetCount === embeddedTutorialDatasets.length} onClick={() => setInitialDatasetActivation(true)}>All</BuilderButton>
                        <BuilderButton disabled={initiallyActiveDatasetCount === 0} onClick={() => setInitialDatasetActivation(false)}>None</BuilderButton>
                      </div>
                    </div>
                    <div className={`mt-2 grid max-h-40 ${extraWideBuilder ? 'grid-cols-4' : wideBuilder ? 'grid-cols-3' : 'grid-cols-2'} gap-1.5 overflow-y-auto pr-1`}>
                      {embeddedTutorialDatasets.map((dataset) => (
                        <label key={dataset.recipeId} className="flex cursor-pointer items-start gap-2 rounded border border-sky-400/20 bg-gray-950/30 px-2 py-1.5 text-[11px] text-gray-200 hover:border-sky-400/40">
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-sky-500"
                            checked={tutorialDatasetStartsActive(dataset)}
                            onChange={(event) => setInitialDatasetActivation(event.target.checked, dataset.recipeId)}
                          />
                          <span className="min-w-0 truncate" title={dataset.label || dataset.id}>{dataset.label || dataset.id}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-3 border-t border-gray-700 pt-3">
                  <div className="text-xs font-semibold text-gray-200">Create a portable region from an active genome</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-amber-200">This option contains real sequence and annotation from the selected genome. Check that it is appropriate to share.</p>
                </div>
                <div className="mt-2 space-y-2">
                  <select className={textInput} value={datasetForm.speciesKey} onChange={(event) => setDatasetForm((current) => ({ ...current, speciesKey: event.target.value }))}>
                    <option value="">Choose an active genome</option>
                    {(builder.config?.active_species || []).map((species, index) => ({ species, index })).filter(({ species }) => species?.files?.fasta && species?.files?.gff3).map(({ species, index }) => {
                      const key = builderSpeciesKey(species, index)
                      return <option key={key} value={key}>{species.display_name || species.scientific_name || species.species_key}{species.assembly ? ` · ${species.assembly}` : ''}</option>
                    })}
                  </select>
                  <div className="grid grid-cols-3 gap-1.5">
                    <input className={textInput} placeholder="Chromosome" value={datasetForm.chrom} onChange={(event) => setDatasetForm((current) => ({ ...current, chrom: event.target.value }))} />
                    <input className={textInput} type="number" placeholder="Start" value={datasetForm.start} onChange={(event) => setDatasetForm((current) => ({ ...current, start: event.target.value }))} />
                    <input className={textInput} type="number" placeholder="End" value={datasetForm.end} onChange={(event) => setDatasetForm((current) => ({ ...current, end: event.target.value }))} />
                  </div>
                  <select className={textInput} value={datasetForm.partialMode} onChange={(event) => setDatasetForm((current) => ({ ...current, partialMode: event.target.value }))}>
                    <option value="expand">Expand to complete genes</option>
                    <option value="omit">Omit partial genes</option>
                    <option value="cancel">Stop if a gene is partial</option>
                  </select>
                  <BuilderButton disabled={generatingDataset} onClick={generateDataset}>{generatingDataset ? 'Generating…' : 'Generate from region'}</BuilderButton>
                  <label className="flex gap-2 text-xs text-gray-200"><input type="checkbox" checked={Boolean(builder.document.settings?.showInactivePills)}
                    onChange={(e) => updateMetadata('settings', { ...builder.document.settings, showInactivePills: e.target.checked })} /> Show inactive dataset pills in the browser</label>
                  <div className="space-y-2 text-xs text-gray-200">
                    <button type="button" className={textInput} onClick={() => updateMetadata('settings', { ...builder.document.settings, genomeColors: (builder.config?.active_species || []).map((species) => resolveGenomeColor(builder.config, species)) })}>Copy current genome colours into tutorial</button>
                    {(builder.document.settings?.genomeColors || []).map((colour, index) => <label key={index} className="flex items-center gap-2">Genome {index + 1}<input type="color" value={colour} onChange={(e) => {
                      const genomeColors = [...builder.document.settings.genomeColors]; genomeColors[index] = e.target.value
                      updateMetadata('settings', { ...builder.document.settings, genomeColors })
                    }} /></label>)}
                  </div>
                  {(builder.document.datasets || []).filter((dataset) => dataset.fixtureId !== TURTLES_AND_FRIENDS_FIXTURE_ID).map((dataset) => (
                    <div key={dataset.id} className="flex items-center justify-between gap-2 rounded border border-emerald-500/20 px-2 py-1.5 text-[11px] text-emerald-300">
                      <span className="min-w-0 truncate">✓ {dataset.label || dataset.id}</span>
                      <button
                        type="button"
                        className="shrink-0 font-semibold text-red-300 hover:underline"
                        onClick={() => detachTutorialDatasets([dataset.recipeId])}
                      >
                        Detach
                      </button>
                    </div>
                  ))}
                </div>
              </details>
              {selectedStep?.recordingReview?.sensitive && <div className={`${wideField} rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200`}>Review this recorded value before export; it may contain private text.</div>}
              {report?.unavailableSteps?.[selectedStep?.id] && <div className={`${wideField} rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200`}>{report.unavailableSteps[selectedStep.id].join(' ')}</div>}
              <div className={`${wideField} flex flex-wrap gap-1.5 border-t border-gray-800 pt-3`}>
                <BuilderButton danger disabled={builder.document.steps.length < 2} onClick={removeStep}>Delete step</BuilderButton>
                <BuilderButton disabled={Boolean(validation.length)} onClick={preview}>Preview here</BuilderButton>
                <BuilderButton onClick={() => setShowExportBrowser(true)}>Export package</BuilderButton>
                <BuilderButton disabled={Boolean(validation.length)} onClick={promote}>Promote</BuilderButton>
              </div>
              {validation.length > 0 && <ul className={`${wideField} list-disc space-y-1 pl-4 text-xs text-red-300`}>{validation.slice(0, 8).map((problem) => <li key={problem}>{problem}</li>)}</ul>}
            </div>
          </main>
        </div>
      </aside>}

      {!builder.picking && !builder.recording && selectedStep && (
        <div
          data-tutorial-builder-panel="true"
          data-tutorial-builder-info-card="true"
          ref={infoCardRef}
          className="fixed z-[305] overflow-hidden rounded-xl border border-sky-400/70 bg-gray-900/95 text-gray-100 shadow-2xl"
          style={{
            left: Math.max(
              TUTORIAL_CARD_MARGIN,
              Math.min(window.innerWidth - cardSize.width - TUTORIAL_CARD_MARGIN,
                Math.max(TUTORIAL_CARD_MARGIN, cardPosition.x * window.innerWidth)),
            ),
            // Bounded by the card's own height, so the bottom of the window is a real edge
            // for it rather than an edge for an assumed 260px box. Until the first
            // measurement lands there is nothing to bound it with, so it is left alone.
            top: Math.max(
              TUTORIAL_CARD_MARGIN,
              cardSize.height
                ? Math.min(window.innerHeight - cardSize.height - TUTORIAL_CARD_MARGIN,
                  cardPosition.y * window.innerHeight)
                : cardPosition.y * window.innerHeight,
            ),
            width: cardSize.width,
            height: selectedStep?.cardSize?.height || undefined,
          }}
        >
          <div className="cursor-grab border-b border-gray-700 px-4 py-3" onPointerDown={(event) => startDrag(event, 'move')} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{selectedStep.section || 'Tutorial section'}</div>
            <div className="mt-1 font-semibold">{selectedStep.title}</div>
          </div>
          <p className="px-4 py-3 text-sm leading-relaxed text-gray-300">{selectedStep.body}</p>
          <div className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize border-b-2 border-r-2 border-sky-300" onPointerDown={(event) => startDrag(event, 'resize')} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag} />
        </div>
      )}

      <FileBrowserModal
        isOpen={showExportBrowser}
        onClose={() => setShowExportBrowser(false)}
        onSelect={async (path) => {
          setShowExportBrowser(false)
          try {
            if (!await saveNow('Draft saved before export.')) return
            const result = await exportTutorialPackage({ outputDir: builder.outputDir, tutorialId: builder.document.id, path })
            setBuilder((current) => ({ ...current, status: `Exported ${result.path.split('/').pop()}.` }))
          } catch (error) {
            setBuilder((current) => ({ ...current, status: error.message }))
          }
        }}
        initialPath={builder.outputDir}
        mode="save"
        theme={tutorial.theme}
        extensions={['.egtutorial']}
        defaultFileName={`${builder.document.id}.egtutorial`}
      />
    </>
  )
}
