import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import useTutorial from '../hooks/useTutorial'
import {
  AUTOPLAY_SPEEDS,
  TUTORIAL_STATUS,
  anchorSelector,
  stepAdvance,
  stepAlign,
  stepCardPosition,
  stepCardSize,
  stepCopyTarget,
  stepCopyValue,
  stepDefersPresentation,
  stepIsInteractive,
  stepSection,
  stepShowsSpotlightRing,
  stepShowsSpotlightRingShadow,
} from '../utils/tutorialModel'
import {
  areRectsEqual,
  blockerRects,
  unionRect,
  cutoutPathD,
  expandRect,
  nonOverlappingRects,
  placeCard,
  TUTORIAL_CARD_MARGIN,
  TUTORIAL_CARD_WIDTH,
  tutorialDimColor,
  visibleElementRect,
  viewportRect,
} from '../utils/overlayGeometry'
import { targetRefSelector } from '../tutorialTargets/index.js'

// The dimming, the hole, and the card that explains the step.
//
// The thing that makes this different from ScreenshotSelectionOverlay, which dims the app
// so the user can pick a region to capture, is that here the user has to be able to *use*
// what is spotlit. So the dimming is not one element covering the screen with a hole drawn
// into it — it is four bands around the hole, leaving the real control with nothing on top
// of it. Clicks that land on a band are swallowed and nudge instead.
//
// A step can opt out of that with `interactive: false`, which covers the hole too: the
// control is pointed at but not usable, so a step that is explaining the file-type chips
// cannot be derailed by someone toggling one.

const CARD_WIDTH = TUTORIAL_CARD_WIDTH
const MIN_CARD_WIDTH = 300
const MAX_CARD_WIDTH = 620
const MIN_CARD_HEIGHT = 180
const CARD_MARGIN = TUTORIAL_CARD_MARGIN
const HOLE_PADDING = 6
const MULTI_HIGHLIGHT_INSET = -2
// An SVG `pathLength`, so the countdown's dash maths does not depend on the card's
// measured perimeter.
const TRACE_LENGTH = 100
// How long a manual step waits before Next starts asking to be pressed. Long enough that
// it never interrupts someone reading, short enough to catch someone who has stopped.
const NEXT_NUDGE_AFTER_MS = 7000

/** Whether the field named by an anchor currently has anything in it.
 *
 *  Polled alongside the rectangles rather than listened for, because the tutorial types
 *  through the native value setter and the field may not exist when the step arrives. */
function useAnchorRect(selector, active) {
  const [rect, setRect] = useState(null)

  // Measured every frame rather than on scroll and resize alone: the anchor can move for
  // reasons no event announces — a panel expanding, a list loading, the genome browser
  // relaying out — and a spotlight that lags behind the thing it points at is worse than
  // none. The equality guard means a still target costs no renders.
  useEffect(() => {
    let frame = 0
    const measure = () => {
      let node = null
      if (active && selector) {
        try {
          node = document.querySelector(selector)
        } catch {
          node = null
        }
      }
      const measured = node ? visibleElementRect(node, viewportRect()) : null
      setRect((current) => (areRectsEqual(current, measured) ? current : measured))
    }
    const poll = () => {
      measure()
      frame = requestAnimationFrame(poll)
    }
    // A scroll can happen after the current animation-frame measurement but before the
    // browser paints the newly positioned rows. Measure from the scroll event as well so
    // the cutout and ring commit with that paint instead of following one frame behind.
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
  }, [active, selector])

  return rect
}

function useRevealRects(reveals, active) {
  const [rects, setRects] = useState([])
  useEffect(() => {
    let frame = 0
    const measure = () => {
      const viewport = viewportRect()
      const measured = active ? reveals.map((reveal) => {
        const selector = anchorSelector(reveal?.anchor)
        const triggerSelector = anchorSelector(reveal?.whenTyped)
        let node = null
        let trigger = null
        try {
          node = selector ? document.querySelector(selector) : null
          trigger = triggerSelector ? document.querySelector(triggerSelector) : null
        } catch {
          node = null
          trigger = null
        }
        if (triggerSelector && !String(trigger?.value || '').trim()) return null
        return node ? visibleElementRect(node, viewport) : null
      }) : []
      setRects((current) => (
        current.length === measured.length
        && current.every((rect, index) => areRectsEqual(rect, measured[index]))
          ? current
          : measured
      ))
    }
    const poll = () => {
      measure()
      frame = requestAnimationFrame(poll)
    }
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
  }, [active, reveals])
  return rects
}

function useSelectorRects(selectors, active) {
  const [rects, setRects] = useState([])
  useEffect(() => {
    let frame = 0
    const measure = () => {
      const viewport = viewportRect()
      const measured = active ? selectors.map((selector) => {
        let node = null
        try { node = selector ? document.querySelector(selector) : null } catch { node = null }
        return node ? visibleElementRect(node, viewport) : null
      }) : []
      setRects((current) => (
        current.length === measured.length
        && current.every((rect, index) => areRectsEqual(rect, measured[index]))
          ? current
          : measured
      ))
    }
    const poll = () => {
      measure()
      frame = requestAnimationFrame(poll)
    }
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
  }, [active, selectors])
  return rects
}

export default function TutorialOverlay() {
  const {
    tutorial, state, step, isRunning, theme, pulseAnchor, cursor, cursorTravelMs,
    autoplay, autoplayRun, speedIndex, setSpeedIndex, busy, presentationReady,
    progressLabel, isLastStep, runtimeProblem, retryPreparation,
    next, back, skip, exit, dismiss, setAutoplay, authoringEnabled, fillCopyValue, settled,
    editStepPosition, editStepSize, editStepText,
  } = useTutorial()

  const isLight = theme === 'light'
  const sectionTitle = stepSection(step)
  const [size, setSize] = useState(() => ({ width: 0, height: 0 }))
  const [cardHeight, setCardHeight] = useState(200)
  // The height the card has in its saved, read-only state. Edit mode adds inputs, a
  // Save/Reset row and a note line, so the shell an author drags is taller than the thing
  // they are authoring — and clamping the drag to the taller shell put the bottom of the
  // window out of reach for the real card. Measured whenever the card is rendered in its
  // saved form, which includes the whole of a drag.
  const trueCardHeightRef = useRef(200)
  const [nudging, setNudging] = useState(false)
  // Whether Next has started asking to be pressed; see the timer below.
  const [nudgeNext, setNudgeNext] = useState(false)
  const [copied, setCopied] = useState(false)
  const [blockedMessage, setBlockedMessage] = useState('')
  useEffect(() => {
    let timer
    const show = (event) => {
      setBlockedMessage(String(event.detail || ''))
      clearTimeout(timer)
      timer = setTimeout(() => setBlockedMessage(''), 2200)
    }
    window.addEventListener('tutorial-control-blocked', show)
    return () => { clearTimeout(timer); window.removeEventListener('tutorial-control-blocked', show) }
  }, [])
  const cardRef = useRef(null)

  // ── Editing the wording in place (developer tool; see tutorials/authoring.js) ──
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  const [editNote, setEditNote] = useState('')
  // A move away from the step, held while the reader decides what to do about the edits
  // they have not saved. Leaving is theirs to choose; losing the words is not.
  const [pendingNavigation, setPendingNavigation] = useState(null)
  const [dragPosition, setDragPosition] = useState(null)
  const [dragging, setDragging] = useState(false)
  const dragPositionRef = useRef(null)
  const dragStartRef = useRef(null)
  const [resizeSize, setResizeSize] = useState(null)
  const [resizing, setResizing] = useState('')
  const resizeSizeRef = useRef(null)
  const resizeStartRef = useRef(null)
  const editBaselineRef = useRef(null)

  // A new step closes the editor rather than carrying a half-finished draft into it.
  useEffect(() => {
    setEditing(false)
    setDraft(null)
    setEditNote('')
    setPendingNavigation(null)
    setDragPosition(null)
    setDragging(false)
    dragPositionRef.current = null
    dragStartRef.current = null
    setResizeSize(null)
    setResizing('')
    resizeSizeRef.current = null
    resizeStartRef.current = null
    editBaselineRef.current = null
  }, [step?.id])

  const startEditing = useCallback(() => {
    const baseline = {
      section: stepSection(step),
      title: step?.title || '',
      body: step?.body || '',
      copy: stepCopyValue(step),
    }
    editBaselineRef.current = baseline
    setDraft({ ...baseline })
    setEditNote('')
    setEditing(true)
    // Nothing should move the step on while someone is writing on it, least of all a
    // timer they are not watching.
    setAutoplay(false)
  }, [setAutoplay, step])

  const clearStagedLayout = useCallback(() => {
    setDragPosition(null)
    setResizeSize(null)
    dragPositionRef.current = null
    resizeSizeRef.current = null
  }, [])

  const cancelEditing = useCallback(() => {
    setEditing(false)
    setDraft(null)
    setEditNote('')
    setPendingNavigation(null)
    clearStagedLayout()
  }, [clearStagedLayout])

  const resetEditing = useCallback(() => {
    if (editBaselineRef.current) setDraft({ ...editBaselineRef.current })
    clearStagedLayout()
    setEditNote('Unsaved changes reset.')
  }, [clearStagedLayout])

  const saveEditing = useCallback(async () => {
    if (!draft || !step?.id) return
    const fields = [
      ['section', draft.section, stepSection(step)],
      ['title', draft.title, step.title || ''],
      ['body', draft.body, step.body || ''],
      ['copy', draft.copy, stepCopyValue(step)],
    ]
    const written = []
    const followed = []
    const refused = []
    let renamedSectionSteps = 0
    try {
      for (const [field, value, was] of fields) {
        if (value === was || (!value && !was)) continue
        const result = await editStepText(step.id, field, value)
        // Saying "Saved." for a write that did not happen is worse than the failure: the
        // words are still on screen, so nothing looks wrong until the tutorial is next
        // opened and they are gone.
        if (result?.saved !== true) { refused.push(field); continue }
        if (result?.interpolationDropped) written.push(field)
        if (field === 'section') renamedSectionSteps = Number(result?.affectedSteps) || 0
        else if (result?.followed) followed.push(`${result.followed} in ${result.file}`)
      }
      if (refused.length) {
        setEditNote(`The ${refused.join(' and ')} could not be saved. Your text is still here; nothing has been written.`)
        return false
      }
      if (dragPosition) await editStepPosition(step.id, dragPosition)
      if (resizeSize && Object.keys(resizeSize).length) await editStepSize(step.id, resizeSize)
      setEditing(false)
      setDraft(null)
      clearStagedLayout()
      const notes = ['Saved.']
      if (renamedSectionSteps) {
        notes.push(`Renamed this section across all ${renamedSectionSteps} of its steps.`)
      }
      if (followed.length) {
        notes.push(`Changed ${followed.join(' and ')}, so every step using it has changed too.`)
      }
      if (written.length) {
        notes.push(`The ${written.join(' and ')} used a computed value, now written out in full.`)
      }
      setEditNote(notes.join(' '))
      return true
    } catch (error) {
      setEditNote(String(error?.message || 'Could not save'))
      return false
    }
  }, [clearStagedLayout, draft, dragPosition, editStepPosition, editStepSize, editStepText, resizeSize, step])

  /** Whether anything would be lost by leaving the step now. */
  const hasUnsavedEdits = Boolean(
    editing && (
      (draft && editBaselineRef.current && ['section', 'title', 'body', 'copy'].some(
        (field) => String(draft[field] ?? '') !== String(editBaselineRef.current[field] ?? '')
      ))
      || dragPosition
      || (resizeSize && Object.keys(resizeSize).length)
    )
  )
  // Read through a ref so the wrapped handlers stay stable across keystrokes.
  const hasUnsavedEditsRef = useRef(false)
  hasUnsavedEditsRef.current = hasUnsavedEdits

  /** Wrap a control that leaves the step, so it asks rather than discards.
   *
   * Pressing Next with the editor open and a sentence half rewritten used to throw the
   * sentence away without a word: the step changes, and the card's draft goes with it.
   * The move itself is never refused — it is held until the reader says what to do with
   * the words. */
  const guardLeaving = useCallback((run, label) => () => {
    if (!hasUnsavedEditsRef.current) {
      run()
      return
    }
    setPendingNavigation({ run, label })
  }, [])

  const keepEditing = useCallback(() => setPendingNavigation(null), [])

  const discardAndLeave = useCallback(() => {
    const held = pendingNavigation
    if (editBaselineRef.current) setDraft({ ...editBaselineRef.current })
    clearStagedLayout()
    setEditing(false)
    setDraft(null)
    setPendingNavigation(null)
    setEditNote('')
    held?.run?.()
  }, [clearStagedLayout, pendingNavigation])

  const saveAndLeave = useCallback(async () => {
    const held = pendingNavigation
    const saved = await saveEditing()
    setPendingNavigation(null)
    if (saved) held?.run?.()
  }, [pendingNavigation, saveEditing])

  useEffect(() => {
    if (!editNote || editing) return undefined
    const timer = setTimeout(() => setEditNote(''), 4000)
    return () => clearTimeout(timer)
  }, [editNote, editing])

  const copyValue = stepCopyValue(step)
  // A step may name the field the value belongs in, in which case pressing the chip puts
  // it there rather than on the clipboard and leaving the reader to find the paste
  // gesture — the app's own right-click menu is not the browser's, so only the keyboard
  // shortcut works and nothing on screen says so.
  const copyFills = Boolean(stepCopyTarget(step))
  const copyStepValue = useCallback(async () => {
    if (!copyValue) return
    // Filled first: it is the thing the reader pressed for, and a clipboard the browser
    // refuses must not stop it happening. The clipboard write still follows, for anyone
    // who wanted the value somewhere else.
    const filled = copyFills ? fillCopyValue() : false
    try {
      await navigator?.clipboard?.writeText?.(copyValue)
      setCopied(true)
    } catch {
      // A refused clipboard is not worth interrupting a tutorial over; the value is on
      // screen either way and can be selected by hand.
      setCopied(filled)
    }
  }, [copyFills, copyValue, fillCopyValue])

  // Back to the icon after a moment, so the same value can be copied again.
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  // A new step brings a new value; the old confirmation must not carry over.
  useEffect(() => { setCopied(false) }, [step?.id])

  const selector = useMemo(() => anchorSelector(step?.anchor), [step])
  const hole = useAnchorRect(selector, isRunning)

  // A step can un-dim several things besides its primary target. Portable tutorials use
  // `reveals`; the singular form keeps older authored tutorials working unchanged.
  const reveals = useMemo(() => (
    step?.reveals?.length ? step.reveals : (step?.reveal ? [step.reveal] : [])
  ), [step])
  const revealRects = useRevealRects(reveals, isRunning)
  const scrollInteractionSelectors = useMemo(() => (
    (step?.interactionPolicy?.targets || [])
      .filter((entry) => (entry.capabilities || []).some((capability) => ['scroll', 'pan'].includes(capability)))
      .map((entry) => targetRefSelector(entry.target || entry))
      .filter(Boolean)
  ), [step])
  const scrollInteractionRects = useSelectorRects(scrollInteractionSelectors, isRunning)
  const pulseRect = useAnchorRect(useMemo(() => anchorSelector(pulseAnchor), [pulseAnchor]), Boolean(pulseAnchor))
  // Something to place the card against that is not the thing being spotlit. A step that
  // lights up the whole track has nowhere for its card to go that is not over the genes
  // it is describing; this gives it an edge to sit above instead.
  const placeAgainstSelector = useMemo(() => anchorSelector(step?.placeAgainst), [step])
  const placeAgainstRect = useAnchorRect(placeAgainstSelector, Boolean(isRunning && placeAgainstSelector))

  useEffect(() => {
    const update = () => {
      const view = viewportRect()
      setSize((current) => (
        current.width === view.width && current.height === view.height
          ? current
          : { width: view.width, height: view.height }
      ))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // The card is placed from its real height, so a long step cannot run off the bottom
  // and hide its own buttons. Observe it rather than measuring only after React renders:
  // text wrapping, font loading and a live window resize can all change its height
  // without changing the step.
  useLayoutEffect(() => {
    const node = cardRef.current
    if (!node) return undefined
    const measure = () => {
      const measured = node.getBoundingClientRect?.().height
      if (!measured) return
      if (!node.hasAttribute('data-tutorial-card-editing')) trueCardHeightRef.current = measured
      setCardHeight((current) => (Math.abs(measured - current) > 1 ? measured : current))
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [step?.id])

  useEffect(() => {
    if (!nudging) return undefined
    const timer = setTimeout(() => setNudging(false), 900)
    return () => clearTimeout(timer)
  }, [nudging])

  // A step that ends only when the reader presses Next gives them no other sign that it
  // is waiting: everything is dimmed, nothing is highlighted to act on, and a reader who
  // has finished the sentence has no way to tell "still loading" from "your move". After
  // a while with nothing happening the button says so quietly.
  //
  // Only for a reader who is actually reading. Autoplay is already pressing it; someone
  // rewriting the card's words, or being asked about unsaved ones, has not stalled; and a
  // step still preparing is not waiting on anyone. Any of those starts the wait over,
  // which is what makes the cue mean "nothing is going to happen until you press this".
  const nudgeStepId = isRunning && step && stepAdvance(step).type === 'manual' ? step.id : ''
  const nudgeBlocked = Boolean(
    autoplay || editing || pendingNavigation || busy
    || (stepDefersPresentation(step) && !presentationReady)
  )
  useEffect(() => {
    setNudgeNext(false)
    if (!nudgeStepId || nudgeBlocked) return undefined
    const timer = setTimeout(() => setNudgeNext(true), NEXT_NUDGE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [nudgeStepId, nudgeBlocked])

  const buttonBase = 'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors'
  const primaryButton = `${buttonBase} ${isLight ? 'bg-[#0099ff] text-white hover:bg-[#0088e6]' : 'bg-blue-600 text-white hover:bg-blue-500'}`
  const quietButton = `${buttonBase} ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-700'}`

  if (tutorial && state?.status === TUTORIAL_STATUS.completed) {
    return (
      <div
        className="fixed inset-0 z-[300] flex items-center justify-center"
        style={{ backgroundColor: 'rgba(2, 6, 23, 0.55)' }}
        data-tutorial-overlay="complete"
      >
        <div
          className="rounded-xl border p-5 shadow-2xl"
          style={{
            width: 'min(440px, calc(100vw - 24px))',
            maxHeight: 'calc(100vh - 24px)',
            overflowY: 'auto',
            backgroundColor: isLight ? '#ffffff' : 'rgb(17, 24, 39)',
            borderColor: isLight ? 'rgba(203, 213, 225, 0.9)' : 'rgba(55, 65, 81, 0.9)',
          }}
        >
          <div className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
            {tutorial.title} complete
          </div>
          <p className={`mt-2 text-sm leading-relaxed ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
            {tutorial.completionBody || 'That is the whole tour.'}
          </p>
          <div className="mt-4 flex items-center justify-end">
            <button type="button" className={primaryButton} onClick={dismiss}>
              Back to my session
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!isRunning || !step) return null

  // A control low in a newly opened scrolling panel must reach its resting place before
  // it is pointed out. Until the provider has completed the arrival and scroll repair,
  // keep the app blocked and quietly dimmed; then reveal the correctly placed card and
  // spotlight together instead of letting them chase the moving control.
  if (stepDefersPresentation(step) && !presentationReady) {
    return (
      <div
        className="fixed inset-0 z-[300]"
        style={{ pointerEvents: 'auto', backgroundColor: tutorialDimColor(theme) }}
        data-tutorial-overlay="true"
        data-tutorial-preparing={step.id}
      />
    )
  }

  const highlightedRectCount = (hole ? 1 : 0) + revealRects.filter((rect, index) => (
    rect && reveals[index]?.ring
  )).length
  // Adjacent rows commonly share an edge. Expanding every ring makes those edges cross
  // over one another, so a group of authored highlights is inset just enough to leave a
  // clean strip between rows. Ordinary target + context reveals retain their breathing
  // room because context reveals are not rings.
  const highlightPadding = highlightedRectCount > 1 ? MULTI_HIGHLIGHT_INSET : HOLE_PADDING
  // A canvas starts at its ruler. Insetting its ring would paint over that ruler;
  // unlike adjacent list rows, browser panels have space for an outside outline.
  const padded = expandRect(hole, selector.includes('[data-browser-canvas-surface]') ? HOLE_PADDING : highlightPadding, size)
  const interactive = stepIsInteractive(step)
  // A settled step has been done and is only waiting out its pause, so its ring comes off
  // at once — it would otherwise spend that pause insisting on a control there is nothing
  // left to do with, while the result it produced is somewhere else on screen. The cutout
  // and the card's position are left exactly as they were: the step is ending, and a card
  // that moves as it goes is a card that moves while it is being read.
  const showSpotlightRing = stepShowsSpotlightRing(step) && !settled
  const showSpotlightRingShadow = stepShowsSpotlightRingShadow(step)
  // When the step is only pointing something out, the hole is covered as well, so the
  // spotlight reads as "look at this" rather than "use this".
  const revealed = revealRects.map((rect, index) => (
    rect ? expandRect(rect, anchorSelector(reveals[index]?.anchor).includes('[data-browser-canvas-surface]') ? HOLE_PADDING : (reveals[index]?.ring ? highlightPadding : HOLE_PADDING), size) : null
  ))
  // Scrollable regions are pointer pass-throughs, but not visual cutouts: the four rows
  // stay highlighted while wheel, trackpad, touch and scrollbar input reaches the list.
  const liveArea = unionRect([padded, ...revealed, ...scrollInteractionRects].filter(Boolean))
  const bands = interactive
    ? blockerRects(size, liveArea, 0)
    : blockerRects(size, null)
  // A revealed panel can sit underneath the control being spotlit (the focus drawer is
  // over the browser canvas). Even/odd SVG holes toggle twice where rectangles overlap,
  // painting the dimming back over the target. Express their union as non-overlapping
  // pieces before drawing it.
  const cutouts = nonOverlappingRects([padded, ...revealed])
  const keepClearOf = unionRect([padded, ...revealed].filter(Boolean)) || padded
  const preferred = step.placement || (hole ? 'bottom' : 'center')
  // Placed clear of everything the step has lit up, not just its target, so the card
  // cannot end up sitting over the list it just asked the user to watch.
  // A 380px card is comfortable on a desktop, but an author may adjust it where the copy
  // wraps awkwardly. Authored CSS pixels preserve readable line length across displays;
  // these clamps still keep the whole card usable in a smaller window.
  // Its max height makes even a long translated/edited step scroll inside the card
  // instead of putting its controls beyond the bottom edge.
  const authoredSize = { ...(stepCardSize(step) || {}), ...(resizeSize || {}) }
  const requestedCardWidth = authoredSize.width || CARD_WIDTH
  const availableCardWidth = Math.max(0, size.width - (CARD_MARGIN * 2))
  const cardWidth = size.width > 0
    ? Math.min(Math.max(MIN_CARD_WIDTH, requestedCardWidth), MAX_CARD_WIDTH, availableCardWidth)
    : requestedCardWidth
  const cardMaxHeight = size.height > 0 ? Math.max(0, size.height - (CARD_MARGIN * 2)) : undefined
  const authoredCardHeight = authoredSize.height && cardMaxHeight
    ? Math.min(Math.max(MIN_CARD_HEIGHT, authoredSize.height), cardMaxHeight)
    : null
  const layoutCardHeight = authoredCardHeight || cardHeight
  const cardBox = { width: cardWidth, height: layoutCardHeight, margin: CARD_MARGIN }
  const align = stepAlign(step)
  const against = placeAgainstRect ? expandRect(placeAgainstRect, HOLE_PADDING, size) : null
  let card
  if (against) {
    // Placed against the named element and nothing else. Like an explicit alignment, this
    // is the author deciding where the card goes, so the revealed area does not get a
    // vote — and neither does the spotlight, which is the whole point of asking.
    card = placeCard(size, against, cardBox, preferred, {
      pinned: true,
      ...(align ? { align, alignTo: placeAgainstRect } : {}),
    })
  } else if (align) {
    // An explicit alignment is the author placing the card. Measured against the step's
    // own target only — taking the revealed area into account would move the card every
    // time that area changed, and a card that shifts while it is being read is exactly
    // what the alignment was asked for to stop.
    card = placeCard(size, padded, cardBox, preferred, { align, alignTo: hole })
  } else {
    card = placeCard(size, keepClearOf, cardBox, preferred)
    // A step that lights up something as large as a scrolling list may leave nowhere that
    // clears all of it. Clearing the step's own target is then better than the centred last
    // resort, which would sit over the target and the revealed area both.
    if (card.overlaps && padded && keepClearOf !== padded) {
      const fallback = placeCard(size, padded, cardBox, preferred)
      if (!fallback.overlaps) card = fallback
    }
  }
  // A position authored by dragging takes precedence over semantic placement. It is a
  // fraction of the viewport, so it remains stable across display sizes and does not jump
  // when edit mode makes the card taller than its normal reading state.
  const authoredPosition = dragPosition || stepCardPosition(step)
  const maxCardLeft = Math.max(CARD_MARGIN, size.width - cardWidth - CARD_MARGIN)

  // Two boxes, and the distinction is the whole of this. The *true* box is the card as it
  // will be once saved: it is what the author is placing, what the stored position means,
  // and what the bottom of the window has to be a boundary for. The *shell* is what is on
  // screen right now, which in edit mode is taller by the height of the inputs and the
  // Save row. Clamping the drag to the shell is what stopped a card being pushed as far
  // down as it will actually sit, and left a gap at the bottom of the window that nothing
  // could be placed in.
  const trueCardHeight = authoredCardHeight
    || (editing && !dragging ? trueCardHeightRef.current : cardHeight)
  const maxTrueTop = Math.max(CARD_MARGIN, size.height - trueCardHeight - CARD_MARGIN)
  const maxShellTop = Math.max(CARD_MARGIN, size.height - layoutCardHeight - CARD_MARGIN)
  const maxCardTop = maxTrueTop
  let trueCard = null
  if (authoredPosition) {
    const trueLeft = Math.max(CARD_MARGIN, Math.min(maxCardLeft, authoredPosition.x * size.width))
    const trueTop = Math.max(CARD_MARGIN, Math.min(maxTrueTop, authoredPosition.y * size.height))
    trueCard = { left: trueLeft, top: trueTop, width: cardWidth, height: trueCardHeight }
    card = {
      left: trueLeft,
      // The nearest fully visible place for the taller shell. Outside edit mode the two
      // heights are the same and this is a no-op.
      top: Math.min(trueTop, maxShellTop),
      placement: 'authored',
      overlaps: false,
    }
  }
  // Only worth drawing when the shell has had to move off the true box to stay on screen.
  const showTrueCardOutline = Boolean(editing && !dragging && trueCard && trueCard.top !== card.top)
  // While the card is being dragged it drops its editing chrome and shows the step as it
  // will read once saved — the author places the box they are authoring, at its real size,
  // rather than a taller shell they then have to imagine away. The draft's own words, not
  // the saved ones, since the point is to see the result of the edits in hand.
  const editingChrome = editing && !dragging
  const previewSection = editing ? (draft?.section ?? sectionTitle) : sectionTitle
  const previewTitle = editing ? (draft?.title ?? step.title) : step.title
  const previewBody = editing ? (draft?.body ?? step.body) : step.body

  const beginCardDrag = (event) => {
    if (!editing || event.button !== 0 || event.target.closest('button,input,textarea,select')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragStartRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      left: card.left,
      // The drag moves the true box. Starting from the shell's top instead would make the
      // card jump by the height of the editing chrome the moment the pointer moved.
      top: trueCard ? trueCard.top : card.top,
      moved: false,
    }
    setDragging(true)
  }

  const moveCardDrag = (event) => {
    const start = dragStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    const dx = event.clientX - start.clientX
    const dy = event.clientY - start.clientY
    if (Math.abs(dx) + Math.abs(dy) > 2) start.moved = true
    const left = Math.max(CARD_MARGIN, Math.min(maxCardLeft, start.left + dx))
    const top = Math.max(CARD_MARGIN, Math.min(maxCardTop, start.top + dy))
    const nextPosition = {
      x: size.width ? Number((left / size.width).toFixed(4)) : 0,
      y: size.height ? Number((top / size.height).toFixed(4)) : 0,
    }
    dragPositionRef.current = nextPosition
    setDragPosition(nextPosition)
  }

  const finishCardDrag = (event) => {
    const start = dragStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    dragStartRef.current = null
    setDragging(false)
    const position = dragPositionRef.current
    if (!start.moved || !position) return
    setEditNote('Position changed — use Save to keep it.')
  }

  const cancelCardDrag = (event) => {
    if (dragStartRef.current?.pointerId !== event.pointerId) return
    dragStartRef.current = null
    dragPositionRef.current = null
    setDragPosition(null)
    setDragging(false)
  }

  const beginCardResize = (edge) => (event) => {
    if (!editing || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    resizeStartRef.current = {
      edge,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      width: cardWidth,
      height: layoutCardHeight,
      staged: resizeSize || {},
      moved: false,
    }
    setResizing(edge)
  }

  const moveCardResize = (event) => {
    const start = resizeStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    const dx = event.clientX - start.clientX
    const dy = event.clientY - start.clientY
    if (Math.abs(dx) + Math.abs(dy) > 2) start.moved = true
    const changed = { ...start.staged }
    if (start.edge === 'right' || start.edge === 'corner') {
      changed.width = Math.round(Math.max(
        Math.min(MIN_CARD_WIDTH, availableCardWidth),
        Math.min(MAX_CARD_WIDTH, availableCardWidth, start.width + dx),
      ))
    }
    if (start.edge === 'bottom' || start.edge === 'corner') {
      changed.height = Math.round(Math.max(
        Math.min(MIN_CARD_HEIGHT, cardMaxHeight || MIN_CARD_HEIGHT),
        Math.min(cardMaxHeight || start.height, start.height + dy),
      ))
    }
    resizeSizeRef.current = changed
    setResizeSize(changed)
  }

  const finishCardResize = (event) => {
    const start = resizeStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    resizeStartRef.current = null
    setResizing('')
    const changed = resizeSizeRef.current
    if (!start.moved || !changed || !Object.keys(changed).length) return
    setEditNote('Size changed — use Save to keep it.')
  }

  const cancelCardResize = (event) => {
    if (resizeStartRef.current?.pointerId !== event.pointerId) return
    resizeStartRef.current = null
    resizeSizeRef.current = null
    setResizeSize(null)
    setResizing('')
  }
  const advance = stepAdvance(step)
  const waitingOnUser = advance.type !== 'manual'
  const dim = tutorialDimColor(theme)

  return (
    <div className="fixed inset-0 z-[300]" style={{ pointerEvents: 'none' }} data-tutorial-overlay="true">
      {blockedMessage && <div role="status" className="fixed bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-gray-900 px-4 py-3 text-sm text-white shadow-lg" style={{ zIndex: 400 }}>{blockedMessage}</div>}
      <svg
        className="absolute inset-0"
        width={Math.max(1, size.width)}
        height={Math.max(1, size.height)}
        viewBox={`0 0 ${Math.max(1, size.width)} ${Math.max(1, size.height)}`}
        preserveAspectRatio="none"
        style={{ pointerEvents: 'none' }}
      >
        <path fill={dim} fillRule="evenodd" d={cutoutPathD(size, cutouts)} />
      </svg>

      {bands.map((band, index) => (
        <div
          key={`band-${index}`}
          data-tutorial-blocker="true"
          className="absolute"
          style={{ left: band.left, top: band.top, width: band.width, height: band.height, pointerEvents: 'auto' }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (waitingOnUser) setNudging(true)
          }}
          onContextMenu={(event) => event.preventDefault()}
        />
      ))}

      {padded && showSpotlightRing && (
        <div
          data-tutorial-ring={interactive ? 'interactive' : 'look'}
          className="absolute"
          style={{
            left: padded.left,
            top: padded.top,
            width: padded.width,
            height: padded.height,
            border: `3px solid ${nudging ? 'rgba(250, 204, 21, 0.98)' : 'rgba(255,255,255,0.96)'}`,
            boxShadow: showSpotlightRingShadow
              ? '0 0 0 2px rgba(15, 23, 42, 0.65), 0 18px 36px rgba(15, 23, 42, 0.28)'
              : 'none',
            borderRadius: '10px',
            pointerEvents: 'none',
            // A ring around something you may use looks much like a ring around something
            // you may only look at. The difference is worth animating.
            animation: interactive
              ? 'tutorial-attention 1700ms ease-out infinite, tutorial-attention-edge 1700ms ease-out infinite'
              : undefined,
          }}
        />
      )}

      {showSpotlightRing && revealed.map((rect, index) => (
        rect && reveals[index]?.ring ? (
          <div
            key={`reveal-ring-${index}`}
            data-tutorial-ring={interactive ? 'interactive' : 'look'}
            className="absolute"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              border: `3px solid ${nudging ? 'rgba(250, 204, 21, 0.98)' : 'rgba(255,255,255,0.96)'}`,
              boxShadow: showSpotlightRingShadow
                ? '0 0 0 2px rgba(15, 23, 42, 0.65), 0 18px 36px rgba(15, 23, 42, 0.28)'
                : 'none',
              borderRadius: '10px',
              pointerEvents: 'none',
              animation: interactive
                ? 'tutorial-attention 1700ms ease-out infinite, tutorial-attention-edge 1700ms ease-out infinite'
                : undefined,
            }}
          />
        ) : null
      ))}

      {/* The pulse that stands in for the click the tutorial is about to make, so an
          action the user did not perform still looks like something that happened. */}
      {pulseRect && (
        <div
          className="absolute"
          style={{
            left: pulseRect.left - 8,
            top: pulseRect.top - 8,
            width: pulseRect.width + 16,
            height: pulseRect.height + 16,
            borderRadius: '14px',
            pointerEvents: 'none',
            border: '3px solid rgba(56, 189, 248, 0.95)',
            boxShadow: '0 0 0 6px rgba(56, 189, 248, 0.25)',
            animation: 'tutorial-pulse 420ms ease-out',
          }}
        />
      )}

      {/* The tutorial's own cursor: a coloured disc, not an arrow. An arrow is exactly
          what the user's own pointer looks like, so one moving by itself reads as the
          mouse having been taken over rather than as the tutorial demonstrating. */}
      {cursor && (
        <div
          className="absolute"
          style={{
            left: cursor.x,
            top: cursor.y,
            pointerEvents: 'none',
            transform: 'translate(-50%, -50%)',
            transition: `left ${cursorTravelMs}ms cubic-bezier(0.4, 0, 0.2, 1), top ${cursorTravelMs}ms cubic-bezier(0.4, 0, 0.2, 1)`,
            zIndex: 2,
          }}
          data-tutorial-cursor="true"
        >
          {cursor.pressing && (
            <div
              className="absolute"
              style={{
                left: '50%',
                top: '50%',
                width: 52,
                height: 52,
                marginLeft: -26,
                marginTop: -26,
                borderRadius: '9999px',
                border: '2px solid rgba(56, 189, 248, 0.95)',
                animation: 'tutorial-cursor-ripple 520ms ease-out',
              }}
            />
          )}
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: '9999px',
              backgroundColor: 'rgba(56, 189, 248, 0.9)',
              border: '2.5px solid rgba(255, 255, 255, 0.95)',
              animation: cursor.pressing
                ? 'tutorial-cursor-press 520ms ease-out'
                : 'tutorial-cursor-idle 1600ms ease-out infinite',
            }}
          />
        </div>
      )}

      {/* Where the card will actually be once it is saved. Drawn only when the editing
          shell has had to sit somewhere else to stay on screen, so that the author can see
          the box they are placing rather than infer it from the one they are holding. */}
      {showTrueCardOutline && (
        <div
          data-tutorial-card-true-outline="true"
          aria-hidden="true"
          className="absolute rounded-xl border-2 border-dashed border-blue-400/70"
          style={{
            left: trueCard.left,
            top: trueCard.top,
            width: trueCard.width,
            height: trueCard.height,
            pointerEvents: 'none',
          }}
        />
      )}

      <div
        ref={cardRef}
        // Named so a CDP probe can find the card, its spotlight and the dimming without
        // matching on inline styles. docs/TUTORIALS.md explains why walking a tutorial in
        // a real browser is not optional: the unit tests cannot see a card that covers
        // what it describes, or a Next that advances twice.
        data-tutorial-card={step.id}
        // Read by the height measurement above: a card wearing its editing chrome must not
        // be mistaken for the saved box whose height the drag is clamped to.
        data-tutorial-card-editing={editingChrome ? 'true' : undefined}
        // The step is still getting ready: Next is disabled below until it is not. Marked
        // on the card rather than shown as a line of text — the text appeared and
        // disappeared often enough to resize the card and shift it while it was being
        // read, and Next greying out for a moment says the same thing quietly.
        data-tutorial-busy={busy ? 'true' : undefined}
        className="absolute rounded-xl border shadow-2xl"
        style={{
          left: card.left,
          top: card.top,
          width: cardWidth,
          height: authoredCardHeight || undefined,
          maxHeight: cardMaxHeight,
          // The trace belongs to this outer shell. Only the contents below scroll: if the
          // shell itself scrolls, its scrollbar and clipping edge sit on top of the right
          // and bottom strokes as soon as a longer card reaches its maximum height.
          overflow: 'hidden',
          pointerEvents: 'auto',
          backgroundColor: isLight ? 'rgba(255,255,255,0.98)' : 'rgba(17, 24, 39, 0.98)',
          borderColor: isLight ? 'rgba(203, 213, 225, 0.9)' : 'rgba(55, 65, 81, 0.9)',
        }}
      >
        {/* Autoplay's countdown. The card's edge redraws itself over the time this step
            has left, so "it is about to move on" is visible without a number ticking
            down — and the loop closing is the cue that the next step is arriving. */}
        {autoplayRun && (
          <svg
            key={autoplayRun.token}
            className="absolute inset-0 z-[2]"
            width="100%"
            height="100%"
            style={{ pointerEvents: 'none', overflow: 'visible' }}
            data-tutorial-autoplay-trace="true"
          >
            <rect
              // Size this from the SVG's own viewport, not the card's outer dimensions.
              // The SVG lives inside the card border, so using cardWidth/cardHeight made
              // its right and bottom coordinates one border-width too large and clipped
              // half of those strokes. A two-pixel inset on all four *inner* edges keeps
              // the 2.5px line uniform even at fractional display scaling.
              x="2"
              y="2"
              width="calc(100% - 4px)"
              height="calc(100% - 4px)"
              rx="10"
              fill="none"
              stroke="rgba(56, 189, 248, 0.95)"
              strokeWidth="2.5"
              strokeLinecap="round"
              pathLength={TRACE_LENGTH}
              style={{
                '--trace-length': TRACE_LENGTH,
                strokeDasharray: TRACE_LENGTH,
                // The delay is negative when the speed changed mid-step: the ring picks up
                // where it was rather than starting the step over.
                animation: `tutorial-trace ${autoplayRun.ms}ms linear ${autoplayRun.delayMs || 0}ms forwards`,
              }}
            />
          </svg>
        )}

        <div
          data-tutorial-card-scroll="true"
          style={{ height: authoredCardHeight ? '100%' : undefined, maxHeight: cardMaxHeight, overflowY: 'auto' }}
        >
        <div className="px-4 pt-3.5 pb-3">
          <div
            className={`-mx-2 -mt-1 flex items-start gap-2 rounded px-2 py-1 ${editing ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
            data-tutorial-card-drag-handle={editing ? 'true' : undefined}
            onPointerDown={beginCardDrag}
            onPointerMove={moveCardDrag}
            onPointerUp={finishCardDrag}
            onPointerCancel={cancelCardDrag}
            style={editing ? { touchAction: 'none' } : undefined}
            title={editing ? 'Drag to move this tutorial card' : undefined}
          >
            {editingChrome && (
              <span aria-hidden="true" className={`flex-none select-none text-sm leading-none ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                ⠿
              </span>
            )}
            <div className={`min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
              {tutorial.title} · {progressLabel}
            </div>
            {/* Developer tool: edit this step's wording where it stands, straight into the
                definition file. Absent unless the backend says editing is available, which
                it only is from a source checkout. See tutorials/authoring.js. */}
            {authoringEnabled && (
              editingChrome ? (
                <div className="flex flex-none items-center gap-1">
                  <button
                    type="button"
                    data-tutorial-edit-save="true"
                    onClick={saveEditing}
                    className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${isLight ? 'text-[#0099ff] hover:bg-gray-100' : 'text-blue-400 hover:bg-gray-800'}`}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    data-tutorial-edit-reset="true"
                    onClick={resetEditing}
                    title="Reset unsaved edits"
                    aria-label="Reset unsaved edits"
                    className={`rounded p-1 ${isLight ? 'text-gray-500 hover:bg-gray-100 hover:text-gray-700' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 12a9 9 0 1 0 3-6.7" />
                      <path d="M3 4v6h6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditing}
                    className={`rounded px-1.5 py-0.5 text-[11px] ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-800'}`}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  data-tutorial-edit-open="true"
                  onClick={startEditing}
                  title="Edit this step's wording"
                  aria-label="Edit this step's wording"
                  className={`flex-none rounded p-0.5 transition-colors ${isLight ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-600' : 'text-gray-500 hover:bg-gray-800 hover:text-gray-300'}`}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              )
            )}
          </div>
          {previewSection && !editingChrome && (
            <h2
              data-tutorial-section-title="true"
              className={`mt-1 text-base font-semibold leading-snug ${isLight ? 'text-gray-900' : 'text-gray-100'}`}
            >
              {previewSection}
            </h2>
          )}
          {editingChrome ? (
            <>
              {sectionTitle && (
                <input
                  data-tutorial-edit="section"
                  aria-label="Section heading"
                  value={draft?.section || ''}
                  onChange={(event) => setDraft((d) => ({ ...d, section: event.target.value }))}
                  placeholder="Section heading"
                  className={`mt-1 w-full rounded border px-2 py-1 text-base font-semibold ${
                    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-gray-800 text-gray-100'
                  }`}
                />
              )}
              <input
                data-tutorial-edit="title"
                value={draft?.title || ''}
                onChange={(event) => setDraft((d) => ({ ...d, title: event.target.value }))}
                placeholder="Title"
                className={`mt-1 w-full rounded border px-2 py-1 text-sm font-semibold ${
                  isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-gray-800 text-gray-100'
                }`}
              />
              <textarea
                data-tutorial-edit="body"
                value={draft?.body || ''}
                onChange={(event) => setDraft((d) => ({ ...d, body: event.target.value }))}
                placeholder="Body"
                rows={6}
                className={`mt-1.5 w-full resize-y rounded border px-2 py-1 text-sm leading-relaxed ${
                  isLight ? 'border-gray-300 bg-white text-gray-800' : 'border-gray-600 bg-gray-800 text-gray-200'
                }`}
              />
              {draft?.copy !== '' && draft?.copy !== undefined && (
                <input
                  data-tutorial-edit="copy"
                  value={draft.copy}
                  onChange={(event) => setDraft((d) => ({ ...d, copy: event.target.value }))}
                  placeholder="Value offered to the clipboard"
                  className={`mt-1.5 w-full rounded border px-2 py-1 font-mono text-xs ${
                    isLight ? 'border-gray-300 bg-white text-gray-800' : 'border-gray-600 bg-gray-800 text-gray-200'
                  }`}
                />
              )}
            </>
          ) : (
            <>
              <h3
                data-tutorial-step-title="true"
                className={`${previewSection ? 'mt-0.5 text-[13px] font-medium' : 'mt-1 text-sm font-semibold'} ${isLight ? 'text-gray-900' : 'text-gray-100'}`}
              >
                {previewTitle}
              </h3>
              <p className={`mt-1.5 text-sm leading-relaxed ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                {previewBody}
              </p>
            </>
          )}
          {editNote && !dragging && (
            <p data-tutorial-edit-note="true" className={`mt-2 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
              {editNote}
            </p>
          )}
          {pendingNavigation && (
            <div
              data-tutorial-unsaved-prompt="true"
              className={`mt-2 rounded-md border px-2.5 py-2 text-xs ${isLight
                ? 'border-amber-300 bg-amber-50 text-amber-900'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-100'}`}
            >
              <p>You have changes to this step that are not saved. Save them before you {pendingNavigation.label}?</p>
              <div className="mt-2 flex flex-wrap gap-3">
                <button type="button" onClick={saveAndLeave} className="font-semibold underline">Save and continue</button>
                <button type="button" onClick={discardAndLeave} className="font-semibold underline">Discard them</button>
                <button type="button" onClick={keepEditing} className="font-semibold underline">Keep editing</button>
              </div>
            </div>
          )}
          {/* A value the step asks for, offered to the clipboard. Telling someone to type
              out a nineteen-character coordinate string is asking them to make a typo. */}
          {copyValue && (
            <button
              type="button"
              data-tutorial-copy={copyValue}
              data-tutorial-copy-fills={copyFills ? 'true' : undefined}
              onClick={copyStepValue}
              title={copyFills ? 'Put this in the box' : 'Copy to the clipboard'}
              className={`mt-2 flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ${
                isLight ? 'border-gray-200 hover:bg-gray-50' : 'border-gray-700 hover:bg-gray-800'
              }`}
            >
              <code className={`min-w-0 flex-1 truncate font-mono text-xs ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>
                {copyValue}
              </code>
              <span className={`flex-none text-[11px] font-semibold ${isLight ? 'text-[#0099ff]' : 'text-blue-400'}`}>
                {copied ? (copyFills ? 'Filled in' : 'Copied') : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {copyFills ? (
                      /* Into a box, rather than two stacked sheets: the icon has to say
                         where the value is going, or the chip looks like it only copies. */
                      <>
                        <path d="M12 3v10" />
                        <path d="m8 9 4 4 4-4" />
                        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                      </>
                    ) : (
                      <>
                        <rect x="9" y="9" width="12" height="12" rx="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </>
                    )}
                  </svg>
                )}
              </span>
            </button>
          )}
          {nudging && (
            <p className={`mt-2 text-xs font-semibold ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
              That part is not needed for this step — press Next to carry on.
            </p>
          )}
          {state.compatibilitySkip?.length > 0 && (
            <p className={`mt-2 rounded-md px-2 py-1.5 text-xs ${isLight ? 'bg-amber-50 text-amber-800' : 'bg-amber-500/10 text-amber-200'}`}>
              Skipped {state.compatibilitySkip.length} unavailable step{state.compatibilitySkip.length === 1 ? '' : 's'}: {state.compatibilitySkip.join(', ')}.
            </p>
          )}
          {runtimeProblem && (
            <div className={`mt-2 rounded-md border px-2.5 py-2 text-xs ${isLight ? 'border-red-200 bg-red-50 text-red-800' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
              <p>{runtimeProblem}</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={retryPreparation} className="font-semibold underline">Retry</button>
                <button type="button" onClick={guardLeaving(skip, 'skip this step')} className="font-semibold underline">Skip this step</button>
                <button type="button" onClick={guardLeaving(exit, 'exit the tutorial')} className="font-semibold underline">Exit</button>
              </div>
            </div>
          )}
        </div>

        <div className={`flex items-center justify-between gap-2 border-t px-4 py-2.5 ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
          <div className="flex items-center gap-1">
            <button type="button" className={quietButton} onClick={guardLeaving(exit, 'exit the tutorial')}>Exit</button>
            <button
              type="button"
              className={quietButton}
              onClick={() => setAutoplay(!autoplay)}
              title={autoplay ? 'Stop playing the tutorial automatically' : 'Play the tutorial automatically'}
            >
              {autoplay ? 'Pause' : 'Autoplay'}
            </button>
            {/* Speed, as three arrows filled up to the chosen one — a level rather than
                three unrelated buttons, so which way is faster needs no explaining. */}
            <div className="flex items-center" data-tutorial-speed={AUTOPLAY_SPEEDS[speedIndex]?.id || ''}>
              {AUTOPLAY_SPEEDS.map((speed, index) => (
                <button
                  key={speed.id}
                  type="button"
                  data-tutorial-speed-step={index}
                  aria-label={speed.label}
                  aria-pressed={index === speedIndex}
                  title={speed.label}
                  onClick={() => setSpeedIndex(index)}
                  className="px-0 py-1 cursor-pointer"
                  style={{ lineHeight: 0 }}
                >
                  <svg width="11" height="14" viewBox="0 0 11 14" aria-hidden="true">
                    <path
                      d="M2 2 L8 7 L2 12 Z"
                      fill={index <= speedIndex
                        ? (isLight ? '#0099ff' : '#60a5fa')
                        : (isLight ? '#d1d5db' : '#4b5563')}
                    />
                  </svg>
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {state.stepIndex > 0 && (
              <button type="button" className={quietButton} onClick={guardLeaving(back, 'go back')}>Back</button>
            )}
            {waitingOnUser && !isLastStep && (
              <button type="button" className={quietButton} onClick={guardLeaving(skip, 'skip this step')}>Skip</button>
            )}
            <button
              type="button"
              className={primaryButton}
              // The static ring is not decoration: the overlay's reduced-motion rule turns
              // every animation off, and without it that reader would get no cue at all.
              style={nudgeNext ? {
                boxShadow: '0 0 0 3px rgba(56, 189, 248, 0.30)',
                animation: 'tutorial-next-nudge 2200ms ease-in-out infinite',
              } : undefined}
              data-tutorial-next-nudge={nudgeNext ? 'true' : undefined}
              onClick={guardLeaving(next, isLastStep ? 'finish' : 'move on')}
              disabled={Boolean(busy)}
            >
              {isLastStep ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
        </div>
        {editingChrome && (
          <>
            <div
              data-tutorial-card-resize="right"
              aria-label="Resize tutorial card width"
              title="Drag to resize width"
              className={`group absolute bottom-3 right-0 top-8 z-[4] w-2 cursor-ew-resize ${resizing === 'right' ? 'bg-blue-400/15' : ''}`}
              style={{ touchAction: 'none' }}
              onPointerDown={beginCardResize('right')}
              onPointerMove={moveCardResize}
              onPointerUp={finishCardResize}
              onPointerCancel={cancelCardResize}
            >
              <span className="absolute bottom-2 right-0 top-2 w-px bg-blue-400/60 group-hover:bg-blue-400" />
            </div>
            <div
              data-tutorial-card-resize="bottom"
              aria-label="Resize tutorial card height"
              title="Drag to resize height"
              className={`group absolute bottom-0 left-3 right-3 z-[4] h-2 cursor-ns-resize ${resizing === 'bottom' ? 'bg-blue-400/15' : ''}`}
              style={{ touchAction: 'none' }}
              onPointerDown={beginCardResize('bottom')}
              onPointerMove={moveCardResize}
              onPointerUp={finishCardResize}
              onPointerCancel={cancelCardResize}
            >
              <span className="absolute bottom-0 left-2 right-2 h-px bg-blue-400/60 group-hover:bg-blue-400" />
            </div>
            <div
              data-tutorial-card-resize="corner"
              aria-label="Resize tutorial card width and height"
              title="Drag to resize width and height"
              className={`absolute bottom-0 right-0 z-[5] h-4 w-4 cursor-nwse-resize ${resizing === 'corner' ? 'bg-blue-400/20' : ''}`}
              style={{ touchAction: 'none' }}
              onPointerDown={beginCardResize('corner')}
              onPointerMove={moveCardResize}
              onPointerUp={finishCardResize}
              onPointerCancel={cancelCardResize}
            >
              <span className="absolute bottom-1 right-1 h-2 w-2 border-b border-r border-blue-400/80" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
