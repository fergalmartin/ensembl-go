import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { getRuntimeTutorialDocument, getTutorial, registerRuntimeTutorial } from '../tutorials/index.js'
import { DEMO_SPECIES_KEY } from '../tutorials/demoGenome.js'
import { REG4, SLICE_GENOME_ID, SLICE_SPECIES_KEY } from '../tutorials/sliceGenome.js'
import { setTutorialSandboxActive } from '../tutorials/sandbox.js'
import { fetchAuthoringEnabled, fetchBuilderEnabled, saveStepPosition, saveStepSize, saveStepText } from '../tutorials/authoring.js'
import { notifyTutorialDraftsChanged, saveTutorialDraft } from '../tutorials/drafts.js'
import {
  clearTutorialGenome,
  createTutorialWorkspace,
  fetchDemoGenomeRecord,
  fetchDemoGenomeStatus,
  fetchTutorialGenomeRecords,
  installDemoGenome,
  installTutorialDataset,
  registerTutorialGenome,
  resetTutorialWorkspace,
} from '../tutorials/demoGenomeApi'
import TutorialOverlay from '../components/TutorialOverlay'
import {
  browserIsFeatureFramed,
  browserIsShowing,
  browserIsShowingSequence,
  deleteBrowserNote,
  resetBrowserScroll,
  setBrowserInteraction,
  describeBrowserViewport,
  moveBrowserViewport,
  sameBrowserViewport,
} from '../utils/browserTutorialControls'
import {
  DEFAULT_SPEED_INDEX,
  TUTORIAL_STATUS,
  actionAnchors,
  anchorSelector,
  arrivalGenomeRecipeIds,
  arrivalDialog,
  arrivalDialogFields,
  arrivalPlaylists,
  arrivalScrollOffset,
  arrivalSelectedPlaylist,
  arrivalsFor,
  currentStep as stepOf,
  initTutorialState,
  isInputAdvanceSatisfied,
  BIOTYPE_CLASSES,
  stepAt,
  isAdvanceEventMatch,
  isLastStep as lastStepOf,
  reduceTutorial,
  stepAction,
  stepAdvance,
  stepCopyTarget,
  stepCopyValue,
  stepPreconditions,
  stepDwellMs,
  stepHoldMs,
  stepInteraction,
  stepSection,
  stepUndo,
  speedFactor,
  tutorialProgressLabel,
} from '../utils/tutorialModel'
import { visibleElementRect, viewportRect } from '../utils/overlayGeometry'
import { targetRefSelector } from '../tutorialTargets/index.js'
import { materializeTutorialDocument, tutorialDatasetStartsActive } from '../utils/tutorialDocument.js'
import { getGenomeKey } from '../utils/genomeIdentity'
import { snapshotGenomeForPlaylist } from '../utils/playlistGenomes'


// Runs a tutorial over the top of the live app.
//
// Two things shape this beyond the obvious. First, a tutorial is a **sandbox**: it never
// writes to the user's configuration. Instead it publishes a `configOverride` that App
// layers over the real one — a scratch output directory inside the user's own, and its
// own set of active genomes. Nothing to restore on the way out, and nothing left behind
// if the app is killed mid-tutorial, because the real configuration was never touched.
//
// Second, the tutorial can **do the steps itself**. Every step declares an action, and
// Next performs it — switching app, typing, clicking — after pulsing the target so the
// click is visible rather than magical. Autoplay is the same thing on a timer. Doing it
// by hand satisfies the step just the same.
//
// The rules live in utils/tutorialModel.js. See docs/TUTORIALS.md.

const PROGRESS_STORAGE_KEY = 'ensembl.tutorial.progress.v1'

// What the sandbox blanks, beyond pointing the output directory at scratch space. These
// are the fields that decide which genomes the app knows about: without them a tutorial
// still shows the user's own genomes and playlists alongside the demo one, which is
// exactly the clutter the sandbox exists to remove.
const SANDBOX_BLANK_FIELDS = Object.freeze({
  active_species: [],
  manual_species: [],
  genome_playlists: [],
  selected_genome_playlist_id: '',
  next_previous_session_genomes: [],
  ref_fasta: '',
  ref_gff: '',
  ref_index: '',
  homologies_file: '',
  target_fasta: '',
  target_gff: '',
  target_index: '',
})

// The tutorial moves at the speed of someone watching it, not someone who already knows
// what happens next. The cursor's travel is long enough to follow with your eyes, the
// press long enough to register as a press, text is typed a character at a time rather
// than appearing, and something that has just happened is left alone for a moment before
// the tutorial moves on — a checkbox that ticks and instantly transitions is jarring even
// when it is exactly what you asked for.
//
// All of these are scaled by the chosen autoplay speed; see AUTOPLAY_SPEEDS.
const CURSOR_TRAVEL_MS = 700
const PULSE_MS = 520
const SETTLE_MS = 320
const TYPE_CHAR_MS = 65
const ACTION_PAUSE_MS = 1200
// How long a pan or a zoom the tutorial performs takes. Matched to the browser's own
// animated moves, so a tutorial's pan and a user's Home key travel at the same rate.
const BROWSER_MOVE_MS = 700
// How many times a step's arrival re-checks that its target is on screen. More than one
// because the app may still be scrolling when the step lands; few enough that a target
// which simply cannot be shown does not hold the step up.
const SCROLL_ATTEMPTS = 5
// How many passes an authored view position gets to establish itself and stay put. More
// than the rescue scroll's, because it is waiting out a page that is still loading.
const PAGE_SCROLL_ATTEMPTS = 12
// How long a field has to hold the value a step is waiting for before it counts. Long
// enough not to fire mid-word, short enough that typing the right thing and stopping does
// not leave the user wondering what else is wanted.
const INPUT_SETTLE_MS = 500
// How long Next waits for a signal it set in motion before giving up and advancing anyway.
// Not scaled: it is a tolerance for how long the app takes, not a piece of pacing.
const SIGNAL_GRACE_MS = 2500

const TutorialContext = createContext(null)

function readStoredProgress() {
  if (typeof window === 'undefined' || !window.localStorage) return { completedIds: [] }
  try {
    const raw = JSON.parse(window.localStorage.getItem(PROGRESS_STORAGE_KEY) || '{}')
    return { completedIds: Array.isArray(raw.completedIds) ? raw.completedIds.map(String) : [] }
  } catch {
    return { completedIds: [] }
  }
}

function writeStoredProgress(progress) {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress))
  } catch {
    // A full or disabled store is not worth interrupting a tutorial over.
  }
}

/** Type into a React-controlled input the way a user would.
 *
 *  Assigning `node.value` directly is invisible to React, which tracks the previous value
 *  on the DOM node itself. Going through the prototype setter updates the node without
 *  disturbing that tracking, so the dispatched `input` event is seen as a real change and
 *  the component's onChange runs. */
export function setNativeInputValue(node, value) {
  if (!node) return false
  const prototype = node.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(node, value)
  else node.value = value
  node.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

function findAnchor(anchor) {
  const selector = anchorSelector(anchor)
  if (!selector) return null
  try {
    return document.querySelector(selector)
  } catch {
    return null   // A malformed selector in a definition should not take the app down.
  }
}

/** Whether a step's collapsible section still has to be opened.
 *
 * The question is "is the thing this step wants actually on the page", and the step's own
 * spotlight usually answers it. A panel that stays mounted while it is shut answers it
 * wrongly, though: the Genome Playlists box is in the DOM either way, so a step ringing
 * the whole box would decide the section was already open and ring a collapsed header.
 * Such a step names its `sectionContent` — something that only exists once the section is
 * open — and that is what gets looked for instead. Absent that, the rule is unchanged. */
function sectionNeedsOpening(step) {
  if (!step?.openSection) return false
  return !findAnchor(step.sectionContent || step.anchor)
}

/** The region whose scrollbar actually moves a target up and down the page.
 *
 * The app marks its own content region, because that is the one an authored view position
 * means: the Genome Selector deliberately scrolls at full width rather than inside the
 * list. Walking the ancestors is the fallback for anywhere that has not been marked, and
 * the document is the last resort. A pane that merely *can* overflow is not the answer —
 * it has to have somewhere to scroll to. */
function pageScrollerFor(node) {
  const marked = document.querySelector('[data-tutorial-page-scroll="true"]')
  if (marked?.contains?.(node)) return marked
  let element = node?.parentElement || null
  while (element && element !== document.body) {
    const overflowY = window.getComputedStyle(element).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll')
      && element.scrollHeight > element.clientHeight + 1) return element
    element = element.parentElement
  }
  return document.scrollingElement || null
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Hold a step back until the app's own transient banner has gone.
 *
 * The confirmation the app shows after an action is fixed to the top right, over the
 * top-bar buttons, and it renders above the app but below the tutorial overlay: it
 * half-covers whatever is highlighted there and the reader cannot click it away. It
 * clears itself after a few seconds, so a step that lands under one waits rather than
 * being drawn around it. Capped, because a banner that never leaves must not strand the
 * tutorial on a step that will then never appear. */
const NOTIFICATION_WAIT_MS = 5000
async function waitForNotificationsToClear() {
  const deadline = Date.now() + NOTIFICATION_WAIT_MS
  while (document.querySelector('[data-tutorial-notification="true"]') && Date.now() < deadline) {
    await sleep(120)
  }
}

/** The next animation frame, or a moment later if there is not going to be one.
 *
 * A hidden page stops painting, and its animation frames stop with it — so an arrival
 * that waits for a frame before measuring never finishes, and the step it belongs to sits
 * on "getting ready" until the window is looked at again. Waiting for whichever comes
 * first keeps the sequence moving in a window nobody is watching, which is exactly when
 * being stuck is hardest to explain. */
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 16); return }
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve() } }
    requestAnimationFrame(done)
    setTimeout(done, 100)
  })
}

/** Wait until a smooth scroll has genuinely stopped moving the target.
 *
 * A fixed timeout can expire halfway through the browser's native smooth-scroll
 * animation. Measuring the target itself also covers nested scrolling containers and
 * late layout shifts without needing to know which ancestor owns the scroll position. */
async function waitForAnchorScrollToSettle(node, { minimumMs = 160, maximumMs = 1600 } = {}) {
  if (!node?.getBoundingClientRect || typeof requestAnimationFrame !== 'function') return
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  let previous = node.getBoundingClientRect()
  let stableFrames = 0
  while (true) {
    await nextFrame()
    if (!node.isConnected) return
    const current = node.getBoundingClientRect()
    const delta = Math.max(
      Math.abs(current.top - previous.top),
      Math.abs(current.left - previous.left),
      Math.abs(current.width - previous.width),
      Math.abs(current.height - previous.height),
    )
    stableFrames = delta <= 0.5 ? stableFrames + 1 : 0
    previous = current
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const elapsed = now - startedAt
    if (elapsed >= minimumMs && stableFrames >= 4) return
    if (elapsed >= maximumMs) return
  }
}

export function TutorialProvider({ children }) {
  const [stored, setStored] = useState(readStoredProgress)
  const [tutorialId, setTutorialId] = useState('')
  const [state, setState] = useState(null)
  const [configOverride, setConfigOverride] = useState(null)
  const [currentView, setCurrentView] = useState('')
  const [theme, setTheme] = useState('dark')
  const [pulseAnchor, setPulseAnchor] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [autoplay, setAutoplay] = useState(false)
  const [autoplayRun, setAutoplayRun] = useState(null)
  const [speedIndex, setSpeedIndex] = useState(DEFAULT_SPEED_INDEX)
  const [busy, setBusy] = useState('')
  const [runtimeProblem, setRuntimeProblem] = useState('')
  const [preparationRetry, setPreparationRetry] = useState(0)
  const [selectorListPresentation, setSelectorListPresentation] = useState(null)
  // Which Genome Selector dialog the current step wants open. Null means "whatever is
  // open is the user's business"; the selector only acts when a step has an opinion.
  const [dialogRequest, setDialogRequest] = useState(null)
  // The step whose arrival work, including scrolling its anchor into view, has settled.
  // Kept separately from `busy`: most steps deliberately show their card while busy,
  // while a small number defer their whole presentation until this id matches.
  const [readyStepId, setReadyStepId] = useState('')

  const navigatorRef = useRef(null)
  const cursorRef = useRef(null)
  // Read rather than closed over, so changing speed mid-step takes effect at once and
  // does not have to re-create every callback below.
  const speedRef = useRef(1)
  speedRef.current = speedFactor(speedIndex)
  const paced = useCallback((ms) => Math.max(0, Math.round(ms * speedRef.current)), [])
  // How long the tutorial's own doing should be left visible before anything transitions.
  const holdUntilRef = useRef(0)
  // The step whose task is done and which is only waiting out its pause. Its spotlight
  // comes off at once: nothing more is being asked for there, and a ring left on the
  // control still says "this is the thing to use". The search box is the case that makes
  // it obvious — it empties itself on a successful search, so the ring spends the pause
  // around an empty box while the answer is on the track behind it.
  const [settledStepId, setSettledStepId] = useState('')
  const userOutputDirRef = useRef('')
  // The note the browser tutorial took, so Back can delete it again rather than leaving
  // a second one behind every time the step is re-watched.
  const tutorialNoteRef = useRef('')
  // Where the browser was when the current step arrived, so a step can tell whether the
  // user has moved it since.
  const arrivalViewportRef = useRef(null)
  // Raised while a step's `arrive` is running, so its own clicks are not mistaken for the
  // user performing the step.
  const arrivingRef = useRef(false)
  // How much of an `all-clicks` step has been done. Emptied on every arrival rather than
  // only when the step id changes: coming back to a step re-establishes its starting
  // state, so a record of it having already been completed would leave the step unable to
  // complete a second time — the clicks land on selectors it has seen before and the
  // finished flag is still up.
  const allClickProgressRef = useRef({ stepId: '', selectors: new Set(), completed: false })
  // The builder previews a tutorial against the same isolated workspace as playback,
  // but without starting the tutorial state machine. Keeping its installed records here
  // lets moving between steps preserve the scene the author is inspecting.
  const builderPreviewRef = useRef({
    token: 0,
    signature: '',
    activationSignature: '',
    workspace: '',
    root: '',
    genomes: [],
  })
  // The genome record each embedded dataset installed as, by recipe id, in document
  // order. A `genomeSelection` arrival names recipe ids because that is what the portable
  // document knows; only the runtime knows what they became once installed.
  const datasetGenomesRef = useRef(new Map())
  const rememberDatasetGenomes = useCallback((datasets, genomes) => {
    const remembered = new Map()
    for (const [index, dataset] of (datasets || []).entries()) {
      const genome = genomes?.[index]
      if (dataset?.recipeId && genome) remembered.set(String(dataset.recipeId), genome)
    }
    datasetGenomesRef.current = remembered
  }, [])

  /** The record to select for each installed dataset, in dataset order.
   *
   *  Installing a dataset returns the genome as the *installer* describes it; the Genome
   *  Selector lists the same genome as the *catalogue* describes it, and the two disagree
   *  about its dataset release and therefore about its identity. Selecting the installed
   *  record leaves the row in the list below still reading as unselected, so what the
   *  tutorial selects is what the catalogue lists — the same record the user's own click
   *  on that row would have handed over. The installed record stays as the fallback: a
   *  genome the catalogue has not listed is better selected imperfectly than not at all. */
  const resolveDatasetGenomes = useCallback(async (datasets, installed, workspace) => {
    const listed = workspace ? await fetchTutorialGenomeRecords(workspace).catch(() => []) : []
    const bySpecies = new Map()
    for (const entry of listed) {
      const key = String(entry?.species_key || '')
      if (key && !bySpecies.has(key)) bySpecies.set(key, entry)
    }
    return (datasets || []).map((_dataset, index) => {
      const record = installed?.[index]
      if (!record) return null
      return bySpecies.get(String(record.species_key || '')) || record
    })
  }, [])

  // Wording edited from the card, by step id. Held here as well as written to the
  // definition file because the file write is what lasts, and this is what the reader
  // sees straight away — the module reload that picks the file up would otherwise take
  // a moment, and the point of editing in place is seeing the sentence you just wrote.
  const [copyEdits, setCopyEdits] = useState({})
  const [authoringEnabled, setAuthoringEnabled] = useState(false)
  const [builderAuthoringEnabled, setBuilderAuthoringEnabled] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchAuthoringEnabled().then((enabled) => { if (!cancelled) setAuthoringEnabled(enabled) })
    fetchBuilderEnabled().then((enabled) => { if (!cancelled) setBuilderAuthoringEnabled(enabled) })
    return () => { cancelled = true }
  }, [])

  /** Persist an edit made while running a portable builder draft.
   *  Built-ins still use the source-file authoring endpoints below; drafts live under
   *  the user's output directory and must be written back as whole portable documents.
   *
   *  `changes` is a map of step id to the fields to set on that step, because renaming a
   *  section changes every step that shares the heading and one document write has to
   *  carry all of them. Returns null when this is not a draft, which is the caller's
   *  signal to fall back to the source-file path. */
  const savePortableStepFields = useCallback(async (changes) => {
    const document = getRuntimeTutorialDocument(tutorialId)
    const root = userOutputDirRef.current
    if (!document || !root) return null
    const entries = Object.entries(changes || {})
    const touched = []
    for (const [stepId, fields] of entries) {
      const draftStep = (document.steps || []).find((candidate) => String(candidate?.id || '') === String(stepId))
      if (!draftStep) continue
      Object.assign(draftStep, fields)
      touched.push(String(stepId))
    }
    if (!touched.length) return null
    document.updatedAt = new Date().toISOString()
    document.revision = Number(document.revision || 1) + 1
    const { tutorial: saved } = await saveTutorialDraft(root, document)
    registerRuntimeTutorial(saved)
    notifyTutorialDraftsChanged(root)
    const savedStep = (id) => (saved.steps || []).find((candidate) => String(candidate?.id || '') === String(id))
    return { steps: touched, step: savedStep(touched[0]) || null }
  }, [tutorialId])

  const savePortableStepLayout = useCallback(async (stepId, layout) => {
    const result = await savePortableStepFields({ [String(stepId)]: layout })
    return result?.step || null
  }, [savePortableStepFields])

  /** Save one field of the current step, and show it immediately. */
  const editStepText = useCallback(async (stepId, field, value) => {
    const id = String(stepId || '').trim()
    if (!id || !tutorialId) return { saved: false }

    // A section is one heading shared by a run of cards. Save every step in the current
    // tutorial that carries the same *effective* heading (including edits made earlier
    // in this session), then apply the rename to all of them in one React update. The
    // source rewriter follows `SECTION.name` references, so shared constants stay shared
    // rather than being expanded into repeated literals.
    if (field === 'section') {
      const currentTutorial = getTutorial(tutorialId)
      const effectiveStep = (candidate) => ({
        ...candidate,
        ...(copyEdits[String(candidate?.id)] || {}),
      })
      const sourceStep = currentTutorial?.steps?.find((candidate) => String(candidate?.id) === id)
      const oldHeading = stepSection(sourceStep ? effectiveStep(sourceStep) : null)
      const affected = (currentTutorial?.steps || []).filter(
        (candidate) => stepSection(effectiveStep(candidate)) === oldHeading
      )
      if (!oldHeading || affected.length === 0) return { saved: false }

      // A draft's words live in its own document, not in a definition file. Every step
      // sharing the heading is written in one save, which is also what stops a rename
      // leaving the document half renamed if the write fails partway through.
      let result = await savePortableStepFields(
        Object.fromEntries(affected.map((candidate) => [String(candidate.id), { section: value }]))
      )
      if (result) result = { saved: true, file: 'tutorial.json' }
      else {
        result = { saved: false }
        for (const candidate of affected) {
          result = await saveStepText({
            tutorialId,
            stepId: String(candidate.id),
            field,
            value,
          })
        }
      }
      setCopyEdits((previous) => {
        const next = { ...previous }
        for (const candidate of affected) {
          const candidateId = String(candidate.id)
          next[candidateId] = { ...(next[candidateId] || {}), section: value }
        }
        return next
      })
      return { ...result, affectedSteps: affected.length }
    }

    const portable = await savePortableStepFields({ [id]: { [field]: value } })
    const result = portable
      ? { saved: true, file: 'tutorial.json' }
      : await saveStepText({ tutorialId, stepId: id, field, value })
    setCopyEdits((previous) => ({ ...previous, [id]: { ...(previous[id] || {}), [field]: value } }))
    return result
  }, [copyEdits, savePortableStepFields, tutorialId])

  /** Save a drag-authored card position and apply it without waiting for hot reload. */
  const editStepPosition = useCallback(async (stepId, position) => {
    const id = String(stepId || '').trim()
    if (!id || !tutorialId) return { saved: false }
    const normalized = { x: Number(position?.x), y: Number(position?.y) }
    const portableStep = await savePortableStepLayout(id, { cardPosition: normalized })
    const result = portableStep
      ? { saved: true, position: portableStep.cardPosition, file: 'tutorial.json' }
      : await saveStepPosition({ tutorialId, stepId: id, position: normalized })
    setCopyEdits((previous) => ({
      ...previous,
      [id]: { ...(previous[id] || {}), cardPosition: result.position },
    }))
    return result
  }, [savePortableStepLayout, tutorialId])

  /** Save independently authored width/height edges and show them immediately. */
  const editStepSize = useCallback(async (stepId, size) => {
    const id = String(stepId || '').trim()
    if (!id || !tutorialId) return { saved: false }
    const document = getRuntimeTutorialDocument(tutorialId)
    const existingStep = document?.steps?.find((candidate) => String(candidate?.id || '') === id)
    const nextSize = { ...(existingStep?.cardSize || {}), ...size }
    const portableStep = await savePortableStepLayout(id, { cardSize: nextSize })
    const result = portableStep
      ? { saved: true, size: portableStep.cardSize, file: 'tutorial.json' }
      : await saveStepSize({ tutorialId, stepId: id, size })
    setCopyEdits((previous) => ({
      ...previous,
      [id]: { ...(previous[id] || {}), cardSize: result.size },
    }))
    return result
  }, [savePortableStepLayout, tutorialId])
  const overrideRef = useRef(null)
  overrideRef.current = configOverride

  const tutorial = useMemo(() => getTutorial(tutorialId), [tutorialId])
  const isRunning = Boolean(tutorial && state?.status === TUTORIAL_STATUS.running)

  // Closes the door on configuration writes for as long as the tutorial is up.
  //
  // The flag is raised synchronously in `start` rather than only here, because React runs
  // a child's effects before its parent's: App's autosave would otherwise see the sandbox
  // configuration and persist it in the same commit, before this effect had run. This
  // stays as the backstop that lowers it again however the tutorial ends.
  useEffect(() => {
    if (isRunning) setTutorialSandboxActive(true)
    return () => setTutorialSandboxActive(false)
  }, [isRunning])
  const rawStep = useMemo(() => (tutorial && state ? stepOf(tutorial, state) : null), [tutorial, state])
  // The step as the card should show it: the definition, with any wording edited during
  // this session laid over it.
  const step = useMemo(() => {
    const edits = rawStep ? copyEdits[String(rawStep.id)] : null
    return edits ? { ...rawStep, ...edits } : rawStep
  }, [copyEdits, rawStep])

  const stepRef = useRef(null)
  stepRef.current = isRunning ? step : null

  // Raised while the tutorial is clicking something itself. A step's interaction policy
  // says what the *reader* may do; the tutorial performing the step is not the reader, and
  // a look-only step must still be able to open the section its own target lives in.
  const selfActingRef = useRef(false)
  const clickAsTutorial = useCallback((node) => {
    if (typeof node?.click !== 'function') return false
    selfActingRef.current = true
    try {
      node.click()
    } finally {
      selfActingRef.current = false
    }
    return true
  }, [])

  // A broad spotlight, or several separate spotlights, may reveal more than the author
  // wants to make live. Constrain the whole app to the declared target capabilities;
  // tutorial-card controls remain outside this gate.
  useEffect(() => {
    if (!isRunning || !step?.interactionPolicy) return undefined
    const allowed = (step.interactionPolicy.targets || []).map((entry) => {
      const selector = targetRefSelector(entry.target || entry)
      return { selector, capabilities: entry.capabilities || [] }
    }).filter((entry) => entry.selector)
    const permits = (entry, event) => {
      let matched = false
      try {
        matched = typeof event.target?.closest === 'function' && Boolean(event.target.closest(entry.selector))
      } catch {
        matched = false
      }
      if (!matched) return false
      const caps = entry.capabilities
      // `change` is not typing. A checkbox or a select emits it *as* its activation, so a
      // control the step allows the reader to activate has to be allowed to report it —
      // otherwise the click lands, the tutorial's own listener advances the step, and
      // React never hears that the box was ticked. That is what left the gene-class step
      // advancing without unticking anything. The selector's checkboxes escaped it only
      // because they are readOnly and driven from onClick.
      if (event.type === 'change') return caps.includes('input') || caps.includes('activate')
      if (['input', 'beforeinput'].includes(event.type)) return caps.includes('input')
      if (event.type === 'wheel') return caps.includes('zoom') || caps.includes('scroll')
      if (event.type === 'keydown') {
        if (caps.includes('input')) return true
        if (caps.includes('zoom') && ['+', '-', '='].includes(event.key)) return true
        if (caps.includes('pan') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return true
        if (caps.includes('scroll') && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return true
      }
      if (['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup'].includes(event.type)) {
        return caps.includes('activate') || caps.includes('pan') || caps.includes('scroll') || caps.includes('input')
      }
      if (event.type === 'click') return caps.includes('activate') || caps.includes('input')
      return false
    }
    const guard = (event) => {
      if (selfActingRef.current) return
      if (typeof event.target?.closest === 'function' && event.target.closest('[data-tutorial-card]')) return
      // The Genome Selector deliberately scrolls at the full-width app level. Tutorial
      // blocker bands cover the otherwise-empty side margins, so wheel input there would
      // never reach that scroller naturally. Forward it explicitly while leaving wheel
      // input over the highlighted rows locked to their authored interaction policy.
      if (event.type === 'wheel' && typeof event.target?.closest === 'function' && event.target.closest('[data-tutorial-blocker]')) {
        const pageScroller = document.querySelector('[data-tutorial-page-scroll="true"]')
        if (typeof pageScroller?.scrollBy === 'function') {
          event.preventDefault()
          event.stopPropagation()
          event.stopImmediatePropagation?.()
          pageScroller.scrollBy({ left: event.deltaX, top: event.deltaY, behavior: 'auto' })
          return
        }
      }
      if (allowed.some((entry) => permits(entry, event))) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
    }
    const events = ['click', 'pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'input', 'beforeinput', 'change', 'keydown', 'wheel']
    events.forEach((name) => document.addEventListener(name, guard, { capture: true, passive: false }))
    return () => events.forEach((name) => document.removeEventListener(name, guard, { capture: true }))
  }, [isRunning, step])

  const dispatch = useCallback((event) => {
    setState((previous) => {
      if (!previous || !tutorial) return previous
      return reduceTutorial(tutorial, previous, event)
    })
  }, [tutorial])

  // ── Progress ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!tutorial || !state || state.status !== TUTORIAL_STATUS.completed) return
    if (stored.completedIds.includes(tutorial.id)) return
    const next = { completedIds: [...stored.completedIds, tutorial.id] }
    setStored(next)
    writeStoredProgress(next)
  }, [state, stored, tutorial])

  // ── The sandbox ─────────────────────────────────────────────────────────────

  const start = useCallback(async (nextTutorialId, { outputDir, stepIndex = 0 } = {}) => {
    const next = getTutorial(nextTutorialId)
    const root = String(outputDir || '').trim()
    // Gated in the Tutorials view too, but a tutorial with nowhere to put its scratch
    // data cannot run at all.
    if (!next || !root) return false

    userOutputDirRef.current = root
    setReadyStepId('')
    setBusy('Preparing the tutorial…')
    try {
      // Anything left by an interrupted run goes before this one starts.
      await resetTutorialWorkspace(root)
      const workspace = await createTutorialWorkspace(root)
      const datasets = (next.datasets || []).filter((dataset) => dataset?.embedded && dataset?.recipeId)
      const installedGenomes = []
      for (const dataset of datasets) {
        const installed = await installTutorialDataset({
          output_dir: root,
          tutorial_id: next.id,
          recipe_id: dataset.recipeId,
          workspace,
        })
        if (installed?.genome) await registerTutorialGenome(installed.genome)
        installedGenomes.push(installed?.genome || null)
      }
      const datasetGenomes = await resolveDatasetGenomes(datasets, installedGenomes, workspace)
      rememberDatasetGenomes(datasets, datasetGenomes)
      const generatedGenomes = datasetGenomes.filter(
        (genome, index) => genome && tutorialDatasetStartsActive(datasets[index]),
      )
      // Before the override exists, so nothing can persist it.
      setTutorialSandboxActive(true)
      setConfigOverride({ output_dir: workspace, ...SANDBOX_BLANK_FIELDS, active_species: generatedGenomes })
      setState(initTutorialState(next, { startedAt: Date.now(), stepIndex }))
      setTutorialId(next.id)
      setAutoplay(false)
      return true
    } catch {
      setConfigOverride(null)
      return false
    } finally {
      setBusy('')
    }
  }, [rememberDatasetGenomes, resolveDatasetGenomes])

  const teardown = useCallback(() => {
    const root = userOutputDirRef.current
    // Lowered only once the override is gone, so the writes that follow are the user's own.
    setTutorialSandboxActive(false)
    setConfigOverride(null)
    setAutoplay(false)
    setPulseAnchor(null)
    setCursor(null)
    setReadyStepId('')
    setRuntimeProblem('')
    setSelectorListPresentation(null)
    setDialogRequest({ dialog: 'none', requestedAt: Date.now() })
    datasetGenomesRef.current = new Map()
    cursorRef.current = null
    holdUntilRef.current = 0
    setSettledStepId('')
    // The browser is handed back with everything working, whatever the last step wanted.
    setBrowserInteraction('all')
    clearTutorialGenome()
    // Fire and forget: the user is already back in their own session, and a failed
    // cleanup is swept on next launch anyway.
    if (root) resetTutorialWorkspace(root)
  }, [])

  /** Update the scratch configuration used by playback or builder preview.
   *
   * Genome Selector playlist edits use the app's ordinary configuration callback. In a
   * sandbox those edits belong in the override, so the builder can show their result
   * without allowing them to leak into the user's session. */
  const updateSandboxConfig = useCallback((update) => {
    setConfigOverride((previous) => {
      if (!previous) return previous
      const next = typeof update === 'function' ? update(previous) : update
      return next || previous
    })
  }, [])

  /** Build (or reuse) the authoring scene for a portable tutorial document. */
  const prepareBuilderPreview = useCallback(async (document, { outputDir, reset = false } = {}) => {
    const root = String(outputDir || '').trim()
    const tutorialDocumentId = String(document?.id || '').trim()
    if (!root || !tutorialDocumentId) throw new Error('An output directory is required to prepare the tutorial scene.')

    const datasets = (document?.datasets || []).filter((dataset) => dataset?.embedded && dataset?.recipeId)
    const signature = JSON.stringify([root, tutorialDocumentId, datasets.map((dataset) => String(dataset.recipeId))])
    const activationSignature = JSON.stringify(datasets.map((dataset) => tutorialDatasetStartsActive(dataset)))
    const previous = builderPreviewRef.current
    const canReuse = !reset && previous.signature === signature && previous.workspace

    // Raised before the first await so App cannot persist the temporary blank state in
    // the child-effect window between this call and React publishing the override.
    setTutorialSandboxActive(true)
    userOutputDirRef.current = root

    if (canReuse) {
      // Rebuilt rather than assumed to have survived: the records are what a step's
      // `genomeSelection` arrival resolves against, and a scene that is reused without
      // them silently selects nothing.
      rememberDatasetGenomes(datasets, previous.genomes)
      const active = previous.activationSignature === activationSignature
        ? (overrideRef.current?.active_species || [])
        : previous.genomes.filter((_genome, index) => tutorialDatasetStartsActive(datasets[index]))
      if (!overrideRef.current || previous.activationSignature !== activationSignature) {
        setConfigOverride((current) => ({
          output_dir: previous.workspace,
          ...SANDBOX_BLANK_FIELDS,
          ...(current && previous.activationSignature === activationSignature ? current : {}),
          active_species: active,
        }))
      }
      builderPreviewRef.current = { ...previous, activationSignature }
      return { workspace: previous.workspace, genomeCount: previous.genomes.length, activeCount: active.length }
    }

    const token = previous.token + 1
    builderPreviewRef.current = {
      token,
      signature: '',
      activationSignature: '',
      workspace: '',
      root,
      genomes: [],
    }
    setConfigOverride({ output_dir: root, ...SANDBOX_BLANK_FIELDS })

    try {
      await clearTutorialGenome()
      if (previous.root && previous.root !== root) await resetTutorialWorkspace(previous.root)
      await resetTutorialWorkspace(root)
      const workspace = await createTutorialWorkspace(root)
      const genomes = []
      for (const dataset of datasets) {
        const installed = await installTutorialDataset({
          output_dir: root,
          tutorial_id: tutorialDocumentId,
          recipe_id: dataset.recipeId,
          workspace,
        })
        if (installed?.genome) {
          genomes.push(installed.genome)
          await registerTutorialGenome(installed.genome)
        } else {
          genomes.push(null)
        }
      }
      if (builderPreviewRef.current.token !== token) return { cancelled: true }
      // Held as the catalogue's records, so a scene reused for the next step selects the
      // same genomes a fresh one would.
      const resolved = await resolveDatasetGenomes(datasets, genomes, workspace)
      rememberDatasetGenomes(datasets, resolved)
      const active = resolved.filter((genome, index) => genome && tutorialDatasetStartsActive(datasets[index]))
      builderPreviewRef.current = {
        token,
        signature,
        activationSignature,
        workspace,
        root,
        genomes: resolved,
      }
      setConfigOverride({ output_dir: workspace, ...SANDBOX_BLANK_FIELDS, active_species: active })
      return { workspace, genomeCount: genomes.filter(Boolean).length, activeCount: active.length }
    } catch (error) {
      if (builderPreviewRef.current.token === token) {
        builderPreviewRef.current = { token, signature: '', activationSignature: '', workspace: '', root: '', genomes: [] }
        setConfigOverride(null)
        setTutorialSandboxActive(false)
      }
      throw error
    }
  }, [rememberDatasetGenomes, resolveDatasetGenomes])

  /** Tear down authoring state and reveal the user's untouched session again. */
  const stopBuilderPreview = useCallback(async () => {
    const preview = builderPreviewRef.current
    builderPreviewRef.current = {
      token: preview.token + 1,
      signature: '',
      activationSignature: '',
      workspace: '',
      root: '',
      genomes: [],
    }
    setConfigOverride(null)
    setSelectorListPresentation(null)
    setDialogRequest({ dialog: 'none', requestedAt: Date.now() })
    setTutorialSandboxActive(false)
    setBrowserInteraction('all')
    datasetGenomesRef.current = new Map()
    await clearTutorialGenome()
    if (preview.root) await resetTutorialWorkspace(preview.root)
  }, [])

  /** Leave. There is deliberately no choice here — the tutorial never changed anything
   *  of the user's, so returning them to their session is simply what happens. */
  const exit = useCallback(() => {
    teardown()
    dispatch({ type: 'exit' })
    navigatorRef.current?.('tutorials')
  }, [dispatch, teardown])

  const dismiss = useCallback(() => {
    teardown()
    setState(null)
    setTutorialId('')
    // Back where they started, so the next tutorial is one click away rather than
    // wherever the last step happened to leave them.
    navigatorRef.current?.('tutorials')
  }, [teardown])

  // ── Preconditions ───────────────────────────────────────────────────────────

  const ensureDemoGenomeInstalled = useCallback(async () => {
    const workspace = overrideRef.current?.output_dir
    if (!workspace) return null
    // Cheap to check, and steps declare this requirement several times over.
    const status = await fetchDemoGenomeStatus(workspace).catch(() => null)
    if (status?.installed) return status
    return installDemoGenome(workspace)
  }, [])

  const ensureDemoGenomeActive = useCallback(async () => {
    const workspace = overrideRef.current?.output_dir
    if (!workspace) return null
    const already = overrideRef.current?.active_species || []
    if (already.some((entry) => String(entry?.species_key || '') === DEMO_SPECIES_KEY)) return already
    let record = await fetchDemoGenomeRecord(workspace)
    if (!record) {
      await installDemoGenome(workspace)
      record = await fetchDemoGenomeRecord(workspace)
    }
    if (!record) return null
    // The browser resolves genomes server-side, so the override alone is not enough.
    await registerTutorialGenome(record)
    setConfigOverride((previous) => ({ ...(previous || {}), active_species: [record] }))
    return record
  }, [])

  /** The same two, for the chromosome-1 slice the browser tutorial runs on.
   *
   *  Kept as their own callbacks rather than one parameterised pair because the
   *  preconditions are named strings in a validated list — a step says which genome it
   *  needs, and a typo is a failing test rather than a tutorial that quietly opens the
   *  wrong one. */
  const ensureSliceGenomeInstalled = useCallback(async () => {
    const workspace = overrideRef.current?.output_dir
    if (!workspace) return null
    const status = await fetchDemoGenomeStatus(workspace, SLICE_GENOME_ID).catch(() => null)
    if (status?.installed) return status
    return installDemoGenome(workspace, SLICE_GENOME_ID)
  }, [])

  const ensureSliceGenomeActive = useCallback(async () => {
    const workspace = overrideRef.current?.output_dir
    if (!workspace) return null
    const already = overrideRef.current?.active_species || []
    if (already.some((entry) => String(entry?.species_key || '') === SLICE_SPECIES_KEY)) return already
    let record = await fetchDemoGenomeRecord(workspace, SLICE_SPECIES_KEY)
    if (!record) {
      await installDemoGenome(workspace, SLICE_GENOME_ID)
      record = await fetchDemoGenomeRecord(workspace, SLICE_SPECIES_KEY)
    }
    if (!record) return null
    await registerTutorialGenome(record)
    setConfigOverride((previous) => ({ ...(previous || {}), active_species: [record] }))
    return record
  }, [])

  /** Focus REG4, so the drawer half of the browser tutorial is never reached empty.
   *
   *  Done through the search box rather than by setting state, because the focused gene
   *  lives in App and the tutorial has no handle on it — the same reason `unfocusGene`
   *  clicks the Unfocus button instead. */
  const ensureReg4Focused = useCallback(async () => {
    const isFocused = () => {
      const bar = document.querySelector('[data-focus-bar]')
      return Boolean(bar?.textContent?.includes(REG4.symbol))
    }
    if (isFocused()) return true

    // A direct jump can mount the browser and its search field before the first gene
    // tiles/index have finished loading. The first lookup is then harmlessly ignored.
    // Retry the real search interaction until its visible result exists, rather than
    // treating "we pressed Return" as equivalent to "the gene is focused".
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const search = findAnchor('browser-location-search')
      if (search) {
        if (typeof search.focus === 'function') search.focus()
        setNativeInputValue(search, REG4.symbol)
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }
      const until = Date.now() + 1400
      while (Date.now() < until) {
        if (isFocused()) return true
        await sleep(140)
      }
    }
    return isFocused()
  }, [])

  /** Put the demo genome back to not-chosen, so the step that chooses it can be watched
   *  again rather than replayed against an already-ticked checkbox. */
  const deactivateDemoGenome = useCallback(async () => {
    await clearTutorialGenome()
    setConfigOverride((previous) => ({ ...(previous || {}), active_species: [] }))
  }, [])

  /** Clear the browser's focused gene, so the step that focuses one can be watched again
   *  rather than replayed against a gene that is already in focus. */
  const unfocusGene = useCallback(() => {
    findAnchor('browser-unfocus')?.click()
    const search = findAnchor('browser-location-search')
    if (search) setNativeInputValue(search, '')
  }, [])

  /** Delete the note the tutorial took, so the step that takes it adds one note however
   *  many times it is watched. */
  const deleteTutorialNote = useCallback(() => {
    const noteId = tutorialNoteRef.current
    if (!noteId) return
    tutorialNoteRef.current = ''
    // Through the browser's own handler rather than straight to the API, so the note
    // store and the drawer both know it has gone.
    deleteBrowserNote(noteId)
  }, [])

  /** Put the browser's switches into a named state, leaving alone anything not named.
   *
   *  Set rather than toggle, because this runs on every arrival at a step — including
   *  arriving backwards — and a toggle would flip on each visit. The buttons publish
   *  whether they are engaged so this can tell "already right" from "needs a press".
   */
  const setBrowserControls = useCallback(async (wanted) => {
    const engaged = (anchor) => findAnchor(anchor)?.getAttribute('data-tutorial-engaged') === 'true'
    const waitForAnchor = async (anchor, attempts = 8) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const target = findAnchor(anchor)
        if (target) return target
        await sleep(paced(SETTLE_MS))
      }
      return null
    }
    const press = async (anchor) => {
      // A direct jump can arrive in Genome Browser before its toolbar has mounted. Waiting
      // here makes the jump menu establish the same state as walking through the preceding
      // steps instead of silently dropping the requested control change.
      const target = await waitForAnchor(anchor)
      if (!target) return false
      clickAsTutorial(target)
      await sleep(paced(SETTLE_MS))
      return true
    }

    // Expand-all comes first, and Detail has to be off while it happens: Detail disables
    // the expand control, so setting expand after Detail presses a dead button and the
    // step arrives in a state it did not ask for. Detail is put back below.
    if (wanted.expanded !== undefined && engaged('browser-expand-transcripts') !== wanted.expanded) {
      const detailWasOn = engaged('browser-detail')
      if (detailWasOn) await press('browser-detail')
      await press('browser-expand-transcripts')
      if (detailWasOn) await press('browser-detail')
    }
    if (wanted.detail !== undefined && engaged('browser-detail') !== wanted.detail) {
      await press('browser-detail')
    }
    if (wanted.flatten !== undefined && engaged('browser-flatten') !== wanted.flatten) {
      await press('browser-flatten')
    }
    // One named gene's own transcripts, which is a different thing from the window-wide
    // expand control above: the `+N` pill under a gene sets that gene alone. Applied last,
    // because expand-all and Flatten both change what the pill is showing. Set rather than
    // toggled, from the pill's own engaged state, so re-entering the step does not undo it.
    // One transcript's hidden state, read from the drawer's own eye button: `aria-pressed`
    // is false exactly when the transcript is hidden, so the arrival can set it rather than
    // toggle whatever it finds. Before the per-gene pill below, since restoring a hidden
    // transcript changes how many rows the gene is showing.
    if (wanted.hiddenTranscript?.transcript) {
      const wantHidden = wanted.hiddenTranscript.hidden !== false
      const eye = await waitForAnchor(`focus-transcript-hide-${wanted.hiddenTranscript.transcript}`)
      if (eye && (eye.getAttribute('aria-pressed') === 'false') !== wantHidden) {
        clickAsTutorial(eye)
        await sleep(paced(SETTLE_MS))
      }
    }
    if (wanted.geneTranscripts?.gene) {
      const wantExpanded = wanted.geneTranscripts.expanded !== false
      const anchor = `browser-gene-transcripts-${wanted.geneTranscripts.gene}`
      const pill = await waitForAnchor(anchor)
      if (pill && engaged(anchor) !== wantExpanded) {
        clickAsTutorial(pill)
        await sleep(paced(SETTLE_MS))
      }
    }
    // Panels an earlier step opened. Without these, walking back to a step whose target
    // lives inside one finds nothing to point at: the spotlight simply vanishes, which is
    // how it looked when the note editor and the sequence panel were reached in reverse.
    if (wanted.transcriptDetail !== undefined) {
      let info = document.querySelector(`[data-tour-id^="focus-transcript-info-"]`)
      if (!info && wanted.transcriptDetail === 'open') {
        for (let attempt = 0; attempt < 8 && !info; attempt += 1) {
          await sleep(paced(SETTLE_MS))
          info = document.querySelector(`[data-tour-id^="focus-transcript-info-"]`)
        }
      }
      const open = info?.getAttribute('aria-expanded') === 'true'
      if (info && open !== (wanted.transcriptDetail === 'open')) {
        info.click()
        await sleep(paced(SETTLE_MS))
      }
    }
    if (wanted.transcriptSequence) {
      const sequenceButton = await waitForAnchor(`focus-sequence-${String(wanted.transcriptSequence)}`)
      if (sequenceButton && sequenceButton.getAttribute('aria-pressed') !== 'true') {
        sequenceButton.click()
        await sleep(paced(SETTLE_MS))
      }
    }
    if (wanted.tutorialNote === 'none') {
      // Deleted rather than left, so the step that writes it writes exactly one however
      // many times it is walked through.
      deleteTutorialNote()
      await sleep(paced(SETTLE_MS))
    }
    if (wanted.noteEditor !== undefined) {
      const open = Boolean(findAnchor('focus-note-body'))
      if (!open && wanted.noteEditor === 'open') {
        // Reopen the note that is already there. A direct jump used for tutorial testing
        // may not have walked through its creation step, so create one only when there is
        // no existing row to reopen. Creation can race the note store's initial load on a
        // direct jump, so retry only while there is still neither a row nor an editor.
        for (let attempt = 0; attempt < 3 && !findAnchor('focus-note-body'); attempt += 1) {
          const row = document.querySelector('[data-tour-id^="focus-note-row-"]')
          if (row) row.click()
          else findAnchor('focus-notes-add')?.click()
          await waitForAnchor('focus-note-body', 4)
        }
      }
    }
    if (wanted.drawerTranscripts !== undefined) {
      // The drawer's own fold, which is not the same control as the window-wide expand
      // above: this one is the focused gene's list. It reports its state through
      // aria-expanded, so this can set rather than toggle.
      const chevron = findAnchor('focus-transcripts-expand')
      const expanded = chevron?.getAttribute('aria-expanded') === 'true'
      if (chevron && expanded !== (wanted.drawerTranscripts === 'expanded')) {
        chevron.click()
        await sleep(paced(SETTLE_MS))
      }
    }
    if (wanted.pinnedTranscript === 'none') {
      const pinned = document.querySelector(
        '[data-drawer-transcript-row][data-tutorial-engaged="true"]'
      )
      if (pinned) {
        pinned.click()
        await sleep(paced(SETTLE_MS))
      }
    }
    if (wanted.biotypes !== undefined) {
      // Two shorthands and an explicit set, because a step may leave the filter part way:
      // a window holding only two of the four classes has nothing to show for unticking
      // the other two, so the step that teaches the filter unticks the one that matters.
      const on = Array.isArray(wanted.biotypes)
        ? wanted.biotypes
        : (wanted.biotypes === 'all' ? BIOTYPE_CLASSES : ['proteinCoding'])
      for (const key of BIOTYPE_CLASSES) {
        const box = findAnchor(`browser-biotype-${key}`)
        // As the tutorial, not as the reader: an arrival puts the filter where the step
        // asked for it, and the step's own interaction policy has no say in that. A plain
        // `.click()` goes through the guard and is refused for any box the step did not
        // happen to allow.
        if (box && box.checked !== on.includes(key)) {
          clickAsTutorial(box)
          await sleep(paced(SETTLE_MS))
        }
      }
    }
  }, [clickAsTutorial, deleteTutorialNote, paced])

  /** Perform a browserView move, or a sequence of them, and hold the result. */
  const runBrowserView = useCallback(async (move) => {
    const moves = Array.isArray(move?.moves) ? move.moves : [move]
    for (const one of moves) {
      const requestedDuration = Number(one?.durationMs ?? move?.durationMs)
      const durationMs = requestedDuration > 0 ? requestedDuration : BROWSER_MOVE_MS
      if (!moveBrowserViewport({ ...one, durationMs: paced(durationMs) })) continue
      // Long enough for the browser's own animation to finish, so the next move in the
      // sequence starts from where the last one ended rather than fighting it.
      await sleep(paced(durationMs) + paced(SETTLE_MS))
    }
    // A move that arrives and immediately transitions is over before it registers as
    // having gone anywhere. Steps that travel some distance ask for a beat at the end.
    if (Number(move?.pauseMs) > 0) await sleep(paced(Number(move.pauseMs)))
  }, [paced])


  /** Scroll a step's target into view, if something has put it out of it.
   *
   *  The genome browser is the reason this exists. Its panel is often far taller than the
   *  window and scrolls inside itself, and focusing a gene centres that gene vertically —
   *  which quietly carries the focus bar, the drawer's rows and the panel's own toolbar
   *  off the top. The anchor is found, the element is real, and the spotlight has nothing
   *  to draw because the rectangle has been clipped away to nothing.
   *
   *  Only when it is actually out of view, so a step whose target is already on screen is
   *  not jolted for no reason. */
  const bringAnchorIntoView = useCallback(async (forStep) => {
    const centreOnArrival = forStep?.anchorScroll === 'center'
    // Checked a few times rather than once, because the thing that scrolled the target
    // away is often still happening: focusing a gene loads its transcripts and only then
    // centres it vertically, so a single scroll on arrival is undone a moment later by
    // the app. Bounded, and it stops as soon as the target has stayed put.
    for (let attempt = 0; attempt < SCROLL_ATTEMPTS; attempt += 1) {
      const node = findAnchor(forStep?.anchor)
      if (!node?.getBoundingClientRect) return
      const rect = node.getBoundingClientRect()
      const height = window.innerHeight || 0
      const width = window.innerWidth || 0
      const visibleRect = visibleElementRect(node, viewportRect())
      // Fully visible, not merely carrying coordinates inside the window. A control
      // scrolled above its own overflow panel can still have an on-screen DOM rectangle;
      // treating that ghost rectangle as visible is how spotlights end up in empty space.
      const visible = Boolean(
        visibleRect
        && visibleRect.width >= Math.min(rect.width, width) - 1
        && visibleRect.height >= Math.min(rect.height, height) - 1
      )
      // A target taller than the window — the canvas surface — is never fully in view and
      // must not be scrolled to, or every step about the track would jump.
      if (rect.height > height) return
      // Large authored regions can be technically visible while sitting awkwardly at the
      // edge of the window. Their target contract can ask for one deliberate centring
      // scroll before presentation; never repeat it and fight the same animation.
      if (centreOnArrival) {
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
        await waitForAnchorScrollToSettle(node)
        // A region can be taller than its own scrolling viewport even though it is
        // shorter than the browser window. It can therefore never pass the full-
        // visibility test below; returning here prevents four redundant scrolls from
        // re-starting the animation and producing the jump this policy is meant to stop.
        return
      }
      if (visible) {
        if (attempt > 0) return
        // Visible on arrival still gets one wait, in case a relayout is on its way.
        await sleep(paced(SETTLE_MS))
        continue
      }
      node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
      await waitForAnchorScrollToSettle(node)
    }
  }, [paced])

  /** Give a Genome Selector step a deliberately static teaching layout.
   *
   * This is separate from interactionPolicy: framing the complete list must not make the
   * list a live or highlighted target. Two animation frames let the selector remove its
   * height cap and re-render in catalogue order before the outer app viewport is centred
   * on the finished list. */
  const applySelectorListArrival = useCallback(async (arrival, { center = true } = {}) => {
    if (!arrival) {
      setSelectorListPresentation(null)
      return
    }
    // `center` is false when the step authored its own view position. The fixed scene
    // centres the list again on its own whenever the rows change — which in playback they
    // do, late, as the tutorial workspace loads — and that silently undid the authored
    // framing. In the builder the rows were already there, so the two disagreed and only
    // playback looked wrong.
    setSelectorListPresentation({
      fitAllRows: arrival.fitAllRows !== false,
      preserveOrder: arrival.preserveOrder !== false,
      lockScroll: arrival.lockScroll !== false,
      center: center && arrival.center !== false,
    })
    await nextFrame()
    await nextFrame()
    if (!center || arrival.center === false) return
    const node = findAnchor(arrival.anchor)
    if (!node?.scrollIntoView) return
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
    await waitForAnchorScrollToSettle(node)
  }, [])

  /** Put the page where the author framed this step, rather than where the last one left it.
   *
   * `bringAnchorIntoView` exists to rescue a target that has been scrolled out of sight,
   * and it centres, because a rescue has no better idea. An authored position is the
   * opposite case: the author scrolled the page until the step looked right — the control
   * in view, room beside it for the card — and that composition is what should be
   * restored. So this runs instead of the rescue, not before it.
   *
   * Measured against the scrolling region rather than the window, so the offset survives
   * anything that changes the height of the chrome above it, and applied by scrolling the
   * region by the difference rather than by writing `scrollTop` — the same arithmetic
   * works whichever ancestor actually owns the scrollbar.
   *
   * Smooth in playback so the step reads as the view travelling to the next thing;
   * instant in the builder, where the author is jumping between steps and an animation
   * each time is only a delay. */
  const applyPageScrollArrival = useCallback(async (arrival, { smooth = true } = {}) => {
    const offset = arrivalScrollOffset(arrival)
    let moved = false
    let held = 0
    // Held rather than set once. Getting there is easy; staying there is the problem. The
    // Genome Selector rescans its assemblies as the tutorial's own output directory takes
    // effect, and while it is loading the page is shorter than its own viewport — so the
    // scroll position clamps to zero and the framing is silently lost a few hundred
    // milliseconds after it was established. So the position is re-asserted until it has
    // survived two checks in a row, which is what tells us the page has stopped arriving.
    for (let attempt = 0; attempt < PAGE_SCROLL_ATTEMPTS && held < 2; attempt += 1) {
      const node = findAnchor(arrival?.anchor)
      // Absent, not wrong: the step's own list may not have rendered yet. Waiting is the
      // whole point of the loop, so this must not give up the way a missing target does.
      if (!node?.getBoundingClientRect) {
        await sleep(SETTLE_MS)
        continue
      }
      const scroller = pageScrollerFor(node)
      if (!scroller) return
      const scrollerTop = scroller === document.scrollingElement
        ? 0
        : scroller.getBoundingClientRect().top
      const delta = node.getBoundingClientRect().top - (scrollerTop + offset)
      if (Math.abs(delta) < 2) {
        held += 1
        if (held < 2) await sleep(SETTLE_MS)
        continue
      }
      held = 0
      // Smooth only for the first move, which is the one the reader watches. A later
      // correction is repairing something that just moved under them, and animating it
      // reads as the page wandering.
      const before = scroller.scrollTop
      scroller.scrollBy({ top: delta, left: 0, behavior: smooth && !moved ? 'smooth' : 'auto' })
      moved = true
      await waitForAnchorScrollToSettle(node)
      // The page cannot go where the author put it — a shorter window, or a target near
      // the end of a short page. Asking again would only spend the step's whole
      // preparation getting the same answer, so take what the page can give.
      if (Math.abs(scroller.scrollTop - before) < 1) return
    }
  }, [])

  /** Open or close the dialog or popover this step is about.
   *
   * The views own this state, so this only publishes what the step wants and lets them
   * reconcile it — the selector for the playlist dialog, the app shell for the top-bar
   * playlist popover. Which genomes the playlist dialog opens for is deliberately not
   * authored: it is always the selected set, which the `genomeSelection` arrival on the
   * same step is what establishes.
   *
   * The timestamp matters. Re-entering the same step is a fresh request, because "closed"
   * has to be re-established on the way back even though nothing about the step changed. */
  const applyDialogArrival = useCallback(async (arrival) => {
    const dialog = arrivalDialog(arrival)
    if (!dialog) return
    setDialogRequest({ dialog, fields: arrivalDialogFields(arrival), requestedAt: Date.now() })
    await nextFrame()
    await nextFrame()
  }, [])

  /** Establish the playlists a step expects to find, in the sandbox configuration.
   *
   * The whole set, replaced rather than merged, because that is what makes it idempotent
   * and reversible: the step before the one that creates a playlist declares an empty list
   * and going Back genuinely returns to before it existed. Without that, redoing the
   * creation step fails outright — the app refuses a second playlist of the same name — and
   * the tutorial cannot be watched twice.
   *
   * Members are named by recipe id and resolved through the same catalogue records the
   * selection arrival uses, so a playlist the tutorial builds and one the user builds by
   * hand hold the same genomes. Ids are minted fresh each time; nothing outside the
   * sandbox refers to them. */
  const applyPlaylistsArrival = useCallback(async (arrival) => {
    const authored = arrivalPlaylists(arrival)
    const selectedName = arrivalSelectedPlaylist(arrival)
    const playlists = authored.map((entry, index) => {
      const genomes = entry.genomes
        .map((recipeId) => datasetGenomesRef.current.get(recipeId))
        .filter(Boolean)
        .map((genome, genomeIndex) => ({
          ...snapshotGenomeForPlaylist(genome),
          active_by_default: genomeIndex === 0,
        }))
      return {
        id: `tutorial_playlist_${index + 1}`,
        name: entry.name,
        description: entry.description,
        genomes,
      }
    })
    const selected = playlists.find((playlist) => playlist.name === selectedName)
    setConfigOverride((previous) => {
      if (!previous) return previous
      const currentSignature = JSON.stringify(previous.genome_playlists || [])
      const nextSignature = JSON.stringify(playlists)
      const nextSelectedId = selected ? selected.id : '__all__'
      // A no-op arrival must stay a no-op: rewriting an identical set would restart every
      // effect watching the playlists, mid-step.
      if (currentSignature === nextSignature
        && String(previous.selected_genome_playlist_id || '__all__') === nextSelectedId) return previous
      return { ...previous, genome_playlists: playlists, selected_genome_playlist_id: nextSelectedId }
    })
    await nextFrame()
  }, [])

  /** Put the tutorial's own genomes into the selected state a step expects to find.
   *
   * A step that talks about the selected-genomes strip has to be able to fill it. Without
   * this the strip is only populated by the user having just done the previous step, so
   * arriving from Back, from a skip, or from the builder's step list shows a card
   * describing four pills beside an empty bar.
   *
   * Selecting is expressed as the resulting set rather than as clicks, so it is
   * idempotent the way `arrive` requires: repeating it selects the same genomes instead
   * of toggling the ones already there. The tutorial's sandbox configuration is the same
   * one the selector's own checkboxes write to, so the pills, the row checkboxes and the
   * bulk playlist controls all read this immediately.
   *
   * Only genomes the document embedded can be named. A recipe id with no installed
   * record is skipped rather than fabricated: the scene is then visibly short a genome,
   * which is the honest result of a dataset that failed to install. */
  const applyGenomeSelectionArrival = useCallback(async (arrival) => {
    const wanted = new Set(arrivalGenomeRecipeIds(arrival))
    const selected = []
    for (const [recipeId, genome] of datasetGenomesRef.current.entries()) {
      if (genome && wanted.has(recipeId)) selected.push(genome)
    }
    setConfigOverride((previous) => {
      if (!previous) return previous
      const current = previous.active_species || []
      const same = current.length === selected.length
        && current.every((entry, index) => getGenomeKey(entry) === getGenomeKey(selected[index]))
      // A no-op arrival must stay a no-op: replacing an identical array would restart
      // every effect that watches the active genomes, mid-step.
      if (same) return previous
      return { ...previous, active_species: selected }
    })
    // Said out loud rather than left as an empty strip: a step that asks for genomes and
    // gets none is a broken scene, and the card above it is about to describe pills that
    // are not there.
    if (wanted.size > 0 && selected.length === 0) {
      setRuntimeProblem('This step arrives with genomes selected, but none of them are installed in the tutorial workspace.')
    }
    if (selected.length > 0) await registerTutorialGenome(selected[0])
  }, [])

  /** The playlists in the scene right now, as a `playlists` arrival would express them.
   *
   * Members come back as recipe ids so the builder can seed a step from a playlist the
   * author just built by hand in the scene, exactly as the selected-genomes section seeds
   * from the genomes they just ticked. A playlist member that is not one of the tutorial's
   * own genomes is dropped rather than named: the document has no way to say it. */
  const scenePlaylists = useCallback(() => {
    const recipeByKey = new Map()
    for (const [recipeId, genome] of datasetGenomesRef.current.entries()) {
      const key = getGenomeKey(genome)
      if (key) recipeByKey.set(key, recipeId)
    }
    const selectedId = String(overrideRef.current?.selected_genome_playlist_id || '')
    const playlists = (overrideRef.current?.genome_playlists || []).filter((playlist) => !playlist?.system)
    return {
      playlists: playlists.map((playlist) => ({
        name: String(playlist?.name || '').trim(),
        description: String(playlist?.description || '').trim(),
        genomes: (playlist?.genomes || [])
          .map((genome) => recipeByKey.get(getGenomeKey(genome)))
          .filter(Boolean),
      })).filter((playlist) => playlist.name),
      selected: playlists.find((playlist) => playlist.id === selectedId)?.name || '',
    }
  }, [])

  /** Which embedded datasets the sandbox currently has selected, as recipe ids.
   *
   * The builder authors a `genomeSelection` from the scene in front of the author, so it
   * needs the document's own vocabulary back out of the runtime. Nothing in the portable
   * document records what species key a dataset installed as, so this mapping only ever
   * exists here. */
  const selectedDatasetRecipeIds = useCallback(() => {
    const active = overrideRef.current?.active_species || []
    const keys = new Set(active.map((entry) => getGenomeKey(entry)).filter(Boolean))
    const ids = []
    for (const [recipeId, genome] of datasetGenomesRef.current.entries()) {
      if (genome && keys.has(getGenomeKey(genome))) ids.push(recipeId)
    }
    return ids
  }, [])

  // Responsive layout can move an anchor after the step has already arrived — notably
  // the focus drawer changes from side-by-side to stacked in a narrow window. Re-run the
  // same bounded visibility repair after a resize, so an open tutorial remains usable
  // when a window is moved between displays or resized mid-step. Debounced because a
  // dragged window emits a stream of resize events and each repair may scroll smoothly.
  useEffect(() => {
    if (!isRunning || !step) return undefined
    let timer = 0
    const repair = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { bringAnchorIntoView(step) }, 120)
    }
    window.addEventListener('resize', repair)
    window.visualViewport?.addEventListener?.('resize', repair)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', repair)
      window.visualViewport?.removeEventListener?.('resize', repair)
    }
  }, [bringAnchorIntoView, isRunning, step])

  /** Bring about whatever a step needs before it runs.
   *
   *  This is what makes skipping safe: a user who skips the download still arrives at the
   *  browser with a genome to look at, because the step that needs one says so. */
  const satisfyPreconditions = useCallback(async (forStep) => {
    const required = stepPreconditions(forStep)
    if (required.length === 0) return
    for (const requirement of required) {
      if (requirement === 'demo-genome-installed') await ensureDemoGenomeInstalled()
      if (requirement === 'demo-genome-active') await ensureDemoGenomeActive()
      if (requirement === 'slice-genome-installed') await ensureSliceGenomeInstalled()
      if (requirement === 'slice-genome-active') await ensureSliceGenomeActive()
      if (requirement === 'reg4-gene-focused') await ensureReg4Focused()
      if (requirement === 'notifications-clear') await waitForNotificationsToClear()
    }
  }, [
    ensureDemoGenomeActive, ensureDemoGenomeInstalled, ensureReg4Focused,
    ensureSliceGenomeActive, ensureSliceGenomeInstalled,
  ])

  // ── Doing the steps ─────────────────────────────────────────────────────────

  const navigateToView = useCallback((viewId) => {
    navigatorRef.current?.(viewId)
  }, [])

  /** Walk the tutorial's cursor onto a target, so the action that follows is something
   *  the user watched happen at a speed they could follow.
   *
   *  The first move has nowhere to come from, so it starts at the foot of the screen and
   *  travels up on the next frame — appearing already on target reads as a glitch rather
   *  than a movement. */
  const moveCursorTo = useCallback(async (node) => {
    const rect = node?.getBoundingClientRect?.()
    if (!rect || !(rect.width > 0 || rect.height > 0)) return false
    const point = { x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) }

    if (!cursorRef.current) {
      const origin = { x: window.innerWidth / 2, y: window.innerHeight - 40, pressing: false }
      cursorRef.current = origin
      setCursor(origin)
      await nextFrame()
      await nextFrame()
    }
    const next = { ...point, pressing: false }
    cursorRef.current = next
    setCursor(next)
    await sleep(paced(CURSOR_TRAVEL_MS))
    return true
  }, [paced])

  const pressCursor = useCallback(async () => {
    setCursor((previous) => (previous ? { ...previous, pressing: true } : previous))
    await sleep(paced(PULSE_MS))
    setCursor((previous) => (previous ? { ...previous, pressing: false } : previous))
  }, [paced])

  /** Take the cursor away again.
   *
   *  It has to go: it sits on top of whatever it just pressed, and what happens next is
   *  usually visible exactly there — a checkbox ticking, a download's progress filling in,
   *  the text appearing in a field. Leaving it parked hides the result of the very action
   *  it was demonstrating. */
  const hideCursor = useCallback(() => {
    cursorRef.current = null
    setCursor(null)
  }, [])

  /** Type a value in a character at a time, the way it would arrive from a keyboard.
   *  Text that simply appears, fully formed, is over before it registers as typing. */
  const typeInto = useCallback(async (node, value) => {
    const text = String(value ?? '')
    setNativeInputValue(node, '')
    for (let i = 1; i <= text.length; i += 1) {
      setNativeInputValue(node, text.slice(0, i))
      await sleep(paced(TYPE_CHAR_MS))
    }
  }, [paced])

  /** Perform a step's action: move the cursor there, press, then do the thing.
   *
   *  A step whose action is a click on something that is not on screen — an app button in
   *  a view that has not rendered yet — falls back to switching app directly, so the step
   *  still completes rather than silently doing nothing. */
  const performAction = useCallback(async (forStep) => {
    const action = stepAction(forStep)
    if (!action || action.type === 'none') return false

    // The user may have done the step themselves — pasted the region, gone to the place.
    // Typing over what they did would be rude, and re-teaching them something they have
    // just demonstrated. Next then does nothing but move on.
    if (action.skipIfShowing && browserIsShowing(action.skipIfShowing)) return false
    if (action.skipIfSequenceVisible && browserIsShowingSequence(action.panelKey)) return false
    if (action.skipIfFeatureFramed && browserIsFeatureFramed(action.skipIfFeatureFramed)) return false
    if (action.skipIfEngaged) {
      const target = findAnchor(action.anchor)
      if (target?.getAttribute('data-tutorial-engaged') === 'true') return false
    }
    if (action.type === 'type') {
      const target = findAnchor(action.anchor)
      const existing = String(target?.value || '').trim()
      // Next should mean "continue" once the field already says what the step asked for —
      // their own answer where anything will do, or the exact value where only one will.
      // Checked before the cursor moves or pulses, so a step the reader has already done
      // does not first look like the tutorial is about to type over them.
      const satisfied = action.overwrite
        ? existing === String(action.value ?? '').trim()
        : Boolean(existing)
      if (satisfied) return false
    }

    if (action.type === 'navigate') {
      navigateToView(action.view)
      return true
    }

    // From here on the tutorial has done something, and whatever it did should be left on
    // screen long enough to be seen before anything transitions away from it.
    const hold = () => { holdUntilRef.current = Date.now() + paced(ACTION_PAUSE_MS) }

    // Moving the browser has no control to press, so there is no cursor to send anywhere
    // — the movement itself is the thing to watch, and a disc parked over the track while
    // it travels would be the only part of the screen not moving. The step stays
    // interactive, so the user can drag and scroll the same track by hand.
    if (action.type === 'browserView') {
      // The user may have panned and zoomed the track themselves — that is the whole
      // point of leaving these steps interactive. Doing the move anyway would snatch the
      // view back from someone who had just gone somewhere they wanted.
      if (action.skipIfMoved && arrivalViewportRef.current
        && !sameBrowserViewport(describeBrowserViewport(), arrivalViewportRef.current)) {
        return false
      }
      hold()
      await runBrowserView(action)
      return true
    }
    if (action.type === 'browserControls') {
      hold()
      await setBrowserControls(action)
      return true
    }

    if (action.type === 'click') {
      // One press is the ordinary case. Several is for a step whose single idea takes
      // more than one — leaving only protein-coding genes means unticking three classes —
      // and they are pressed in turn, with the same pause between them as between steps,
      // so each one's effect on the track is visible rather than the lot at once.
      const anchors = actionAnchors(action)
      // An `all-clicks` step is satisfied by each of its boxes being *ticked*, so a box
      // the user has already ticked is done. Pressing it anyway would untick it: the
      // tutorial would appear to undo the user's work and then move on, which is exactly
      // what Next did to someone who came back to a selection step and redid it by hand.
      const ticksBoxes = stepAdvance(forStep).type === 'all-clicks'
      let acted = false
      for (const anchor of anchors) {
        const target = findAnchor(anchor)
        if (!target) continue
        if (ticksBoxes && 'checked' in target && target.checked) continue
        if (acted) {
          const pauseMs = Number(action.pauseMs) > 0 ? Number(action.pauseMs) : ACTION_PAUSE_MS
          await sleep(paced(pauseMs))
        }
        await moveCursorTo(target)
        setPulseAnchor(anchor)
        await pressCursor()
        setPulseAnchor(null)
        hideCursor()
        hold()
        clickAsTutorial(target)
        acted = true
      }
      if (!acted && action.view) navigateToView(action.view)
      await sleep(paced(SETTLE_MS))
      if (acted && Number(action.endPauseMs) > 0) {
        await sleep(paced(Number(action.endPauseMs)))
      }
      return acted
    }

    const node = findAnchor(action.anchor)
    if (!node) {
      if (action.view) navigateToView(action.view)
      return false
    }

    await moveCursorTo(node)
    setPulseAnchor(action.anchor)
    await pressCursor()
    setPulseAnchor(null)
    hideCursor()
    if (action.type === 'type') {
      if (typeof node.focus === 'function') node.focus()
      // Normally the tutorial fills an empty field and leaves anything the user typed
      // alone. `overwrite` is for the steps where only one value will do — searching the
      // demo genome for a gene that is not in it just fails, and the step would sit there
      // looking broken rather than teaching anything.
      const existing = String(node.value || '')
      if (!existing.trim() || (action.overwrite && existing.trim() !== String(action.value))) {
        await typeInto(node, action.value)
      }
      if (action.submit !== false) {
        // Search fields here act on Enter, so typing alone would leave the step half done.
        // The pause before it is what makes the typing readable rather than a flash.
        await sleep(paced(ACTION_PAUSE_MS))
        hold()
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }
    }
    return true
  }, [
    clickAsTutorial, hideCursor, moveCursorTo, navigateToView, paced, pressCursor, runBrowserView,
    setBrowserControls, typeInto,
  ])

  /** Put the card's offered value into the field the step named, for the reader who
   *  pressed the chip rather than Next.
   *
   *  Deliberately not the typed-out demonstration `performAction` gives: this is the
   *  reader doing the step, and a value they asked for should land the moment they ask,
   *  the way a paste would. It leaves the field focused and does not submit — pressing
   *  Return, or the go button now inside the highlight, is still theirs to do.
   *
   *  It fills over whatever is there, because the same rule that lets a step offer a value
   *  at all is that only that value works. */
  const fillCopyValue = useCallback(() => {
    const value = stepCopyValue(stepRef.current)
    const node = findAnchor(stepCopyTarget(stepRef.current))
    if (!value || !node) return false
    setNativeInputValue(node, value)
    if (typeof node.focus === 'function') node.focus()
    return true
  }, [])

  const advancing = useRef(false)

  const next = useCallback(async () => {
    if (advancing.current) return
    const forStep = stepRef.current
    advancing.current = true
    try {
      const acted = forStep ? await performAction(forStep) : false

      // A step can ask for its result to be left up before the tutorial moves on. Only
      // when the tutorial was the one that brought it about: someone who has just pasted
      // the region themselves has already watched it land, and holding them there would
      // be the tutorial pausing over their own work.
      if (acted && stepHoldMs(forStep) > 0) await sleep(paced(stepHoldMs(forStep)))

      // A step waiting on a signal or on a field's value is waiting for something its
      // action set in motion, and
      // that thing takes time: a download runs for seconds, and the genome selector
      // deliberately holds a selection for a second before applying it. Advancing the
      // instant the click lands runs ahead of all of it — and worse, arriving early at the
      // next step lets that step's preconditions bring about the very thing still in
      // flight, so the two then undo each other. The genome would tick on, then off again.
      const waitsForApp = ['signal', 'input'].includes(stepAdvance(forStep || {}).type)
      if (forStep && waitsForApp) {
        const graceMs = Number(forStep.settleMs) > 0 ? Number(forStep.settleMs) : SIGNAL_GRACE_MS
        const until = Date.now() + graceMs
        while (Date.now() < until) {
          // The signal got there first, which is the good case: it advanced the step and
          // there is nothing left to do.
          if (String(stepRef.current?.id || '') !== String(forStep.id)) return
          await sleep(120)
        }
      }

      // Tagged with the step it came from: if the action already advanced things (a click
      // satisfying a "view" step), this is ignored rather than skipping one.
      dispatch({ type: 'next', fromStepId: forStep?.id })
    } finally {
      advancing.current = false
    }
  }, [dispatch, paced, performAction])

  const back = useCallback(async () => {
    // Undone before the step pointer moves, so the step being returned to finds the world
    // as it was when it last ran. See stepUndo in utils/tutorialModel.js.
    const undo = stepUndo(stepRef.current)
    if (undo.type === 'deactivate-demo-genome') await deactivateDemoGenome()
    if (undo.type === 'deactivate-slice-genome') await deactivateDemoGenome()
    if (undo.type === 'unfocus-gene') unfocusGene()

    // A step whose task is typing something has to find its field empty when it is
    // returned to. Left as it was, its watcher matches the moment the step arrives and
    // bounces the user straight forward again — Back would appear not to work at all.
    // Automatic rather than declared: it follows from the advance, so no author has to
    // remember it.
    const returningTo = stepAt(tutorial, (state?.stepIndex ?? 0) - 1)
    const advance = stepAdvance(returningTo)
    if (advance.type === 'input') {
      const node = findAnchor(advance.anchor || returningTo?.anchor)
      if (node && isInputAdvanceSatisfied(advance, node.value)) setNativeInputValue(node, '')
    }

    dispatch({ type: 'back' })
  }, [
    deactivateDemoGenome, dispatch, state?.stepIndex, tutorial, unfocusGene,
  ])
  const skip = useCallback(() => dispatch({ type: 'skip' }), [dispatch])

  /** Establish the selected builder step exactly as playback would establish it.
   *
   * Authoring deliberately navigates to the declared view even when opening that view is
   * the learner's task: the builder is inspecting the presentation of this step, not
   * performing its completion logic. */
  const prepareBuilderStep = useCallback(async (document, stepIndex = 0) => {
    const runtimeDocument = materializeTutorialDocument(document)
    const forStep = stepAt(runtimeDocument, Math.max(0, Number(stepIndex) || 0))
    if (!forStep) return { prepared: false, targetFound: false }

    const arrivals = arrivalsFor(runtimeDocument, forStep)
    const selectorListArrival = arrivals.find((arrival) => arrival.type === 'selectorList')
    if (!selectorListArrival) setSelectorListPresentation(null)
    const positionsThePage = arrivals.some((arrival) => arrival.type === 'pageScroll')

    if (forStep.view) navigateToView(forStep.view)
    await sleep(250)

    if (sectionNeedsOpening(forStep)) {
      clickAsTutorial(findAnchor(forStep.openSection))
      await sleep(paced(SETTLE_MS))
    }

    const viewportPolicy = (forStep.interactionPolicy?.targets || []).find((entry) => (
      (entry.target || entry)?.id === 'browser.viewport'
    ))
    const viewportCapabilities = viewportPolicy?.capabilities || []
    setBrowserInteraction(
      viewportCapabilities.includes('zoom') && !viewportCapabilities.includes('pan')
        ? 'zoom-only'
        : stepInteraction(forStep)
    )

    await satisfyPreconditions(forStep)
    arrivingRef.current = true
    try {
      for (const arrival of arrivals) {
        if (arrival.type === 'browserView') await runBrowserView(arrival)
        if (arrival.type === 'browserControls') await setBrowserControls(arrival)
        if (arrival.type === 'playlists') await applyPlaylistsArrival(arrival)
        if (arrival.type === 'selectorList') await applySelectorListArrival(arrival, { center: !positionsThePage })
        if (arrival.type === 'genomeSelection') await applyGenomeSelectionArrival(arrival)
      }
      // After the selection, which is the set the dialog opens for.
      for (const arrival of arrivals) {
        if (arrival.type === 'dialog') await applyDialogArrival(arrival)
      }
      // Re-stated once the app's own effects have flushed; see the playback path.
      for (const arrival of arrivals) {
        if (arrival.type === 'playlists') await applyPlaylistsArrival(arrival)
      }
      // Last, and after the dialog and the selection have changed the page's height.
      for (const arrival of arrivals) {
        if (arrival.type === 'pageScroll') await applyPageScrollArrival(arrival, { smooth: false })
      }
    } finally {
      await sleep(paced(SETTLE_MS))
      arrivingRef.current = false
    }

    if (!positionsThePage) {
      resetBrowserScroll()
      await bringAnchorIntoView(forStep)
    }
    const targetFound = !forStep.anchor || Boolean(findAnchor(forStep.anchor))
    return { prepared: true, targetFound, step: forStep }
  }, [
    applyGenomeSelectionArrival, applyPageScrollArrival, applyDialogArrival, applyPlaylistsArrival,
    applySelectorListArrival, bringAnchorIntoView, clickAsTutorial, navigateToView,
    paced, runBrowserView, satisfyPreconditions, setBrowserControls,
  ])

  // On arriving at a step: make sure its app is on screen and its requirements are met.
  // This is why no step ever sits there waiting for something that will never appear.
  useEffect(() => {
    if (!isRunning || !step) return
    setReadyStepId('')
    setRuntimeProblem('')
    allClickProgressRef.current = { stepId: '', selectors: new Set(), completed: false }
    let cancelled = false
    const prepare = async () => {
      // Bring the step's app on screen so its anchor exists — except when arriving there
      // *is* the step. "Open Configuration" is satisfied by the view changing, so
      // navigating on the user's behalf here would complete the step before they saw it.
      const arrivingIsTheTask = stepAdvance(step).type === 'view'
      if (step.view && step.view !== currentView && !arrivingIsTheTask) navigateToView(step.view)

      // A step can point at something inside a collapsed section. Rather than each step
      // saying "open this first", it names the header that opens it, and we only click
      // that when the thing we actually want is nowhere to be found — so a user who
      // already opened it is not fought with.
      if (step.openSection) {
        await sleep(250)
        if (!cancelled && sectionNeedsOpening(step)) {
          clickAsTutorial(findAnchor(step.openSection))
        }
      }

      // Set on every arrival rather than only where a step asks for it, so a limit one
      // step wanted cannot follow the user into the next.
      const viewportPolicy = (step.interactionPolicy?.targets || []).find((entry) => (
        (entry.target || entry)?.id === 'browser.viewport'
      ))
      const viewportCapabilities = viewportPolicy?.capabilities || []
      setBrowserInteraction(
        viewportCapabilities.includes('zoom') && !viewportCapabilities.includes('pan')
          ? 'zoom-only'
          : stepInteraction(step)
      )

      // Everything that has to be true before the card is read, under one "getting
      // ready" — Next is disabled while it is up, which is what stops someone pressing on
      // while the view is still moving.
      const required = stepPreconditions(step)
      const arrivals = arrivalsFor(tutorial, step)
      const positionsThePage = arrivals.some((arrival) => arrival.type === 'pageScroll')
      if (!arrivals.some((arrival) => arrival.type === 'selectorList')) {
        setSelectorListPresentation(null)
      }
      if (!cancelled && (required.length > 0 || arrivals.length > 0)) setBusy('Getting things ready…')
      try {
        if (required.length > 0) await satisfyPreconditions(step)

        // The step's expected starting state, established on every visit — including
        // arriving backwards. This is what makes the tutorial re-watchable: a card that
        // says "PHGDH has thirty-eight transcripts" has to be able to put PHGDH on
        // screen, or Back leaves it describing whatever the user last looked at.
        arrivingRef.current = true
        try {
          for (const arrival of arrivals) {
            if (cancelled) break
            if (arrival.type === 'browserView') await runBrowserView(arrival)
            if (arrival.type === 'browserControls') await setBrowserControls(arrival)
            // Before the selection: applying a playlist is what fills the selected set,
            // and a step declaring both means the selection to win.
            if (arrival.type === 'playlists') await applyPlaylistsArrival(arrival)
            if (arrival.type === 'selectorList') await applySelectorListArrival(arrival, { center: !positionsThePage })
            if (arrival.type === 'genomeSelection') await applyGenomeSelectionArrival(arrival)
          }
          // After the selection: the dialog opens for the selected genomes, so a step
          // that establishes both has to establish them in that order.
          for (const arrival of arrivals) {
            if (cancelled) break
            if (arrival.type === 'dialog') await applyDialogArrival(arrival)
          }
          // Asserted a second time, after the settle below has let the app's own effects
          // flush. Changing the selected genomes makes the app rebuild its configuration
          // for the current view, and that rebuild is computed from a snapshot taken
          // before this step arrived — so it lands in the same batch and quietly replaces
          // the playlists with the ones from before. Re-stating them costs nothing when
          // nothing clobbered them: an identical set is a no-op by signature.
          for (const arrival of arrivals) {
            if (cancelled) break
            if (arrival.type === 'playlists') await applyPlaylistsArrival(arrival)
          }
          // The authored view position is applied after everything else, because opening a
          // dialog or filling the pills strip is exactly the kind of thing that moves the
          // page out from under a position measured before it happened.
          for (const arrival of arrivals) {
            if (cancelled) break
            if (arrival.type === 'pageScroll') await applyPageScrollArrival(arrival)
          }
        } finally {
          // One frame's grace: a click dispatched synchronously here still has its
          // capture-phase listener to run.
          await sleep(paced(SETTLE_MS))
          arrivingRef.current = false
        }

        // Back to the top of the panel before anything is measured. Zooming and
        // expanding transcripts change how tall the tracks are, and a panel left scrolled
        // from two steps ago puts every anchor somewhere the step did not intend — which
        // is how a spotlight ends up around a patch of empty track where a button was.
        // Not when the step framed its own view. This puts the browser's panel back to the
        // top, and the panel registers the *shared* page scroller — so on a Genome Selector
        // step it silently threw away the position the arrival had just established.
        if (!cancelled && !positionsThePage) resetBrowserScroll()
        // A step that authored its own view position has already been framed; the
        // rescue scroll would only re-centre the target and lose the composition.
        if (!cancelled && !positionsThePage) await bringAnchorIntoView(step)
        if (!cancelled && step.anchor && !findAnchor(step.anchor)) {
          setRuntimeProblem(`The registered target for “${step.title}” did not render after preparation.`)
        }
      } finally {
        if (!cancelled) {
          // Set only after `bringAnchorIntoView` has finished its smooth, bounded repair.
          // A deferred presentation therefore appears around the control at rest rather
          // than following it through the panel while it scrolls.
          setReadyStepId(step.id)
          setBusy('')
        }
      }
      // Remembered so an action with `skipIfMoved` can tell the tutorial's own move from
      // one the user made while reading.
      arrivalViewportRef.current = describeBrowserViewport()

      // The backend keeps the tutorial's genome in memory for the life of the process, so
      // a backend restart — routine in development — silently unregisters it and every
      // browse request comes back 400 with blank tracks behind it. Re-asserting it on each
      // step is one cheap POST and makes that recoverable rather than fatal.
      const active = overrideRef.current?.active_species || []
      if (!cancelled && active.length > 0) registerTutorialGenome(active[0])
    }
    prepare()
    return () => { cancelled = true }
    // currentView is deliberately absent: this should run when the step changes, not
    // every time the user wanders between apps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applyGenomeSelectionArrival, applyPageScrollArrival, applyDialogArrival, applyPlaylistsArrival,
    applySelectorListArrival, bringAnchorIntoView, isRunning, step,
    navigateToView, runBrowserView, satisfyPreconditions, setBrowserControls, tutorial,
    preparationRetry,
  ])

  // Autoplay is Next on a timer, but the timer is not silent: it publishes how long this
  // step has, and the card traces its own edge over that time. Without it autoplay is a
  // series of unexplained jumps — you cannot tell whether the tutorial is waiting for you
  // or about to move on.
  //
  // How long a step gets comes from how much there is to read on it (stepDwellMs), so a
  // three-line explanation is not given the same moment as a one-liner.
  //
  // Changing speed mid-step does not start the step again. The progress made is kept as a
  // fraction and handed to the new run as a negative animation delay, so the ring carries
  // on from where it was at the new rate — restarting it would punish you for adjusting
  // the speed while reading.
  const autoplayProgressRef = useRef(0)
  const autoplaySegmentRef = useRef({ startedAt: 0, totalMs: 0 })

  // A new step starts from nothing, however the last one ended.
  useEffect(() => {
    autoplayProgressRef.current = 0
  }, [state?.stepIndex])

  useEffect(() => {
    if (!isRunning || !autoplay || busy) {
      // Hold the progress made rather than discarding it: pausing to read and then
      // resuming should not restart the step.
      const segment = autoplaySegmentRef.current
      if (segment.totalMs > 0 && segment.startedAt) {
        autoplayProgressRef.current = Math.min(
          1,
          autoplayProgressRef.current + ((Date.now() - segment.startedAt) / segment.totalMs)
        )
      }
      autoplaySegmentRef.current = { startedAt: 0, totalMs: 0 }
      setAutoplayRun((previous) => (previous ? null : previous))
      return undefined
    }

    const totalMs = paced(stepDwellMs(step))
    const done = Math.min(0.999, Math.max(0, autoplayProgressRef.current))
    const remaining = Math.max(120, Math.round(totalMs * (1 - done)))
    autoplaySegmentRef.current = { startedAt: Date.now(), totalMs }
    setAutoplayRun({
      token: `${state?.stepIndex ?? 0}:${speedIndex}:${Date.now()}`,
      ms: totalMs,
      // Negative, so the ring starts already this far round rather than from zero.
      delayMs: -Math.round(totalMs * done),
    })
    const timer = setTimeout(() => { next() }, remaining)
    return () => {
      clearTimeout(timer)
      const segment = autoplaySegmentRef.current
      if (segment.totalMs > 0 && segment.startedAt) {
        autoplayProgressRef.current = Math.min(
          1,
          autoplayProgressRef.current + ((Date.now() - segment.startedAt) / segment.totalMs)
        )
      }
    }
  }, [autoplay, busy, isRunning, next, paced, speedIndex, state?.stepIndex, step])

  useEffect(() => {
    if (!state || state.status === TUTORIAL_STATUS.running) return
    setAutoplay(false)
    // A fixed selector scene holds the list still and reserves room for the pills strip.
    // Release that presentation as soon as the selection step finishes, so the following
    // step gets the ordinary layout back.
    setSelectorListPresentation(null)
    setDialogRequest({ dialog: 'none', requestedAt: Date.now() })
  }, [state])

  // ── Events coming in from the app ───────────────────────────────────────────

  /** Advance on an app event, but not before whatever the tutorial just did has been on
   *  screen for a moment. Ticking a checkbox and transitioning in the same instant is
   *  jarring — you see the new step and have to take on trust that the tick happened. */
  // Only ever true of the step you are looking at. Moving on — forwards, back, or out —
  // clears it, so the next step arrives with its own highlight intact.
  useEffect(() => {
    const id = String(step?.id || '')
    setSettledStepId((current) => (current && current !== id ? '' : current))
  }, [step?.id])

  const dispatchAfterHold = useCallback((event) => {
    // Whichever is longer: the pause after something the tutorial did, or the beat the
    // step asks for so its result can be seen before the step moves on.
    const wait = Math.max(
      holdUntilRef.current - Date.now(),
      paced(stepHoldMs(stepRef.current))
    )
    if (wait <= 0) {
      dispatch(event)
      return
    }
    // Only for the event that actually finishes this step. A signal the step is not
    // waiting on, or a click somewhere else, leaves it exactly as it was.
    if (isAdvanceEventMatch(stepRef.current, event)) {
      setSettledStepId(String(stepRef.current?.id || ''))
    }
    setTimeout(() => dispatch(event), wait)
  }, [dispatch, paced])

  const emitSignal = useCallback((name, payload = null) => {
    // Remembered rather than looked up later: by the time Back runs, the drawer may be
    // closed and the note is no longer on screen to identify.
    if (name === 'browser.noteCreated' && payload?.noteId) {
      tutorialNoteRef.current = String(payload.noteId)
    }
    dispatchAfterHold({ type: 'signal', name, payload })
  }, [dispatchAfterHold])

  const notifyView = useCallback((viewId) => {
    const view = String(viewId || '')
    // The view itself changes at once; only the tutorial's reaction to it waits.
    setCurrentView(view)
    dispatchAfterHold({ type: 'view', view })
  }, [dispatchAfterHold])

  const notifyTheme = useCallback((nextTheme) => {
    setTheme(nextTheme === 'light' ? 'light' : 'dark')
  }, [])

  const registerHost = useCallback(({ navigate }) => {
    navigatorRef.current = navigate || null
  }, [])

  /** Genome selection during a tutorial goes here instead of to the backend, so the
   *  user's real set of active genomes is untouched. */
  /** Choose or unchoose one of the tutorial's genomes.
   *
   *  `desired` states an outcome instead of asking for a flip, and is decided against the
   *  set as it is at that moment. The Genome Selector applies a selection a second after
   *  the click, and a step's `arrive` may have selected the same genome in between; a
   *  blind toggle would then take back the genome the user had just chosen. */
  const toggleTutorialGenome = useCallback((species, desired = '') => {
    const key = String(species?.species_key || '')
    // Same record the browser will be asked to resolve; see registerTutorialGenome.
    if (key === DEMO_SPECIES_KEY) registerTutorialGenome(species)
    const alreadyPresent = (overrideRef.current?.active_species || [])
      .some((entry) => String(entry?.species_key || '') === key)
    // Nothing to do, so nothing is announced either: a step waiting on this signal must
    // not be advanced by a selection that was already in place.
    if ((desired === 'selected' && alreadyPresent) || (desired === 'deselected' && !alreadyPresent)) return
    setConfigOverride((previous) => {
      const active = previous?.active_species || []
      const present = active.some((entry) => String(entry?.species_key || '') === key)
      return {
        ...(previous || {}),
        active_species: present
          ? active.filter((entry) => String(entry?.species_key || '') !== key)
          : [...active, species],
      }
    })
    emitSignal('genome.activated', { speciesKey: key })
  }, [emitSignal])

  // A single capture-phase listener stands in for wiring every button a tutorial might
  // ever point at.
  useEffect(() => {
    if (!isRunning) return undefined
    const handleClick = (event) => {
      const activeStep = stepRef.current
      if (!activeStep) return
      // A step's `arrive` puts the browser's switches where the step expects them, and it
      // does that by pressing the very controls the step is often about. Those presses
      // are the tutorial setting the scene, not the user doing the step, and counting
      // them would finish the step the instant it began.
      if (arrivingRef.current) return
      const advance = stepAdvance(activeStep)
      if (!['click', 'all-clicks'].includes(advance.type)) return
      if (advance.type === 'all-clicks') {
        const anchors = advance.anchors || []
        const matched = anchors.find((anchor) => {
          const selector = anchorSelector(anchor)
          return selector && typeof event.target?.closest === 'function' && event.target.closest(selector)
        })
        if (!matched) return
        const allClickProgress = allClickProgressRef.current
        if (allClickProgress.stepId !== activeStep.id) {
          allClickProgress.stepId = activeStep.id
          allClickProgress.selectors = new Set()
          allClickProgress.completed = false
        }
        const matchedSelector = anchorSelector(matched)
        // Let the checkbox's own click handler commit first. For checkbox-like targets,
        // count current checked state rather than merely counting a click, so ticking a
        // turtle on and then off cannot accidentally satisfy "select all four".
        setTimeout(() => {
          if (String(stepRef.current?.id || '') !== String(activeStep.id)) return
          let node = null
          try { node = document.querySelector(matchedSelector) } catch { node = null }
          const progress = allClickProgressRef.current
          if (node && 'checked' in node && !node.checked) progress.selectors.delete(matchedSelector)
          else progress.selectors.add(matchedSelector)
          if (!progress.completed && progress.selectors.size >= anchors.length) {
            progress.completed = true
            dispatchAfterHold({ type: 'all-clicks', stepId: activeStep.id })
          }
        }, 0)
        return
      }
      const expected = advance.anchor || activeStep.anchor
      const selector = anchorSelector(expected)
      if (!selector) return
      if (typeof event.target?.closest !== 'function') return
      if (!event.target.closest(selector)) return
      dispatchAfterHold({ type: 'click', anchor: expected })
    }
    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [dispatchAfterHold, isRunning])

  // Steps whose task is "type this here". Watching the field rather than waiting for a
  // click means someone who types the right thing and stops is not left wondering what
  // else is wanted — and Return, which they will reach for anyway, takes it at once.
  useEffect(() => {
    if (!isRunning || !step) return undefined
    const advance = stepAdvance(step)
    if (advance.type !== 'input') return undefined
    const selector = anchorSelector(advance.anchor || step.anchor)
    if (!selector) return undefined

    const settleMs = Number(advance.ms) > 0 ? Number(advance.ms) : INPUT_SETTLE_MS
    let settleTimer = 0
    const done = (value) => dispatch({ type: 'input', stepId: step.id, value })

    // Polled rather than listened for: the tutorial types through the native value
    // setter, and a step's field may not exist yet when the step arrives.
    const poll = setInterval(() => {
      const node = findAnchor(advance.anchor || step.anchor)
      const matches = node && isInputAdvanceSatisfied(advance, node.value)
      if (matches && !settleTimer) {
        settleTimer = setTimeout(() => { settleTimer = 0; done(node.value) }, settleMs)
      } else if (!matches && settleTimer) {
        // Still typing, or typing something else. Start the clock again when they stop.
        clearTimeout(settleTimer)
        settleTimer = 0
      }
    }, 120)

    const onKeyDown = (event) => {
      if (event.key !== 'Enter') return
      const node = findAnchor(advance.anchor || step.anchor)
      if (!node || event.target !== node) return
      if (!isInputAdvanceSatisfied(advance, node.value)) return
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0 }
      done(node.value)
    }
    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      clearInterval(poll)
      if (settleTimer) clearTimeout(settleTimer)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [dispatch, isRunning, step])

  // Steps that wait out a fixed time. The step id travels with the event so a timer that
  // outlives its step cannot skip the next one.
  useEffect(() => {
    if (!isRunning || !step) return undefined
    const advance = stepAdvance(step)
    if (advance.type !== 'dwell') return undefined
    const timer = setTimeout(() => dispatch({ type: 'dwell', stepId: step.id }), Number(advance.ms) || 0)
    return () => clearTimeout(timer)
  }, [dispatch, isRunning, step])

  const value = useMemo(() => ({
    tutorial,
    state,
    step,
    isRunning,
    currentView,
    theme,
    configOverride,
    selectorListPresentation,
    dialogRequest,
    pulseAnchor,
    cursor,
    cursorTravelMs: paced(CURSOR_TRAVEL_MS),
    autoplay,
    autoplayRun,
    speedIndex,
    setSpeedIndex,
    busy,
    runtimeProblem,
    retryPreparation: () => setPreparationRetry((value) => value + 1),
    presentationReady: Boolean(step?.id && readyStepId === step.id),
    completedIds: stored.completedIds,
    progressLabel: tutorial && state ? tutorialProgressLabel(tutorial, state) : '',
    isLastStep: Boolean(tutorial && state && lastStepOf(tutorial, state)),
    start,
    prepareBuilderPreview,
    prepareBuilderStep,
    stopBuilderPreview,
    selectedDatasetRecipeIds,
    scenePlaylists,
    updateSandboxConfig,
    exit,
    dismiss,
    next,
    back,
    skip,
    setAutoplay,
    emitSignal,
    notifyView,
    notifyTheme,
    navigateToView,
    registerHost,
    toggleTutorialGenome,
    fillCopyValue,
    settled: Boolean(settledStepId) && settledStepId === String(step?.id || ''),
    authoringEnabled,
    builderAuthoringEnabled,
    editStepPosition,
    editStepSize,
    editStepText,
  }), [
    authoringEnabled, builderAuthoringEnabled, autoplay, autoplayRun, back, busy, configOverride, cursor,
    currentView, dismiss, editStepPosition, editStepSize, editStepText, emitSignal, exit, isRunning, navigateToView, next,
    fillCopyValue, notifyTheme, notifyView, paced, prepareBuilderPreview, prepareBuilderStep, pulseAnchor, registerHost, skip, speedIndex, start,
    readyStepId, runtimeProblem, dialogRequest, settledStepId, selectorListPresentation, state, step, stored,
    theme, toggleTutorialGenome, tutorial,
    selectedDatasetRecipeIds, scenePlaylists, stopBuilderPreview, updateSandboxConfig,
  ])

  return (
    <TutorialContext.Provider value={value}>
      {children}
      <TutorialOverlay />
    </TutorialContext.Provider>
  )
}

export default function useTutorial() {
  const tutorial = useContext(TutorialContext)
  if (!tutorial) throw new Error('useTutorial must be used inside a TutorialProvider')
  return tutorial
}

/** What App calls to plug itself into the tutorial runtime: it reports which app is on
 *  screen, and lends the tutorial the ability to switch apps. */
export function useTutorialHost({ currentView, theme, navigate }) {
  const tutorial = useTutorial()
  const { notifyTheme, notifyView, registerHost } = tutorial

  useEffect(() => {
    registerHost({ navigate })
  }, [navigate, registerHost])

  useEffect(() => {
    notifyView(currentView)
  }, [currentView, notifyView])

  useEffect(() => {
    notifyTheme(theme)
  }, [notifyTheme, theme])

  return tutorial
}
