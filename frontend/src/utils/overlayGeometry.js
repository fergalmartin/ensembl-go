// Geometry shared by the overlays that dim the app and cut holes in the dimming.
//
// Two overlays need this: the screenshot selection overlay, which cuts holes so the
// user can see what they are about to capture, and the tutorial overlay, which cuts a
// hole so the user can see *and click* the control a step is about. Both work in
// container-relative coordinates: rects arrive from `getBoundingClientRect()` (viewport
// coordinates) and are clipped and rebased against the container they are drawn into.
//
// Everything here is pure, so the awkward cases — a target scrolled half out of view, a
// hole flush against an edge, a zero-area container — are settled in tests rather than
// by squinting at the running app.

/** How dark the app goes outside a tutorial's cutouts.
 *
 * Enough that the highlighted thing is unmistakably the subject, and no more: the app
 * behind it is still the reader's own app and they should be able to see where they are
 * in it. Read by playback, by the preparing dim, and by the builder's preview, so the
 * three can never disagree about what a step will look like. */
// The tutorial card's own defaults. Shared because the builder previews the same card:
// if it assumes a different width or a fixed height, the box an author drags there is not
// the box a reader gets, and the positions it can reach are not the positions available.
export const TUTORIAL_CARD_WIDTH = 380
export const TUTORIAL_CARD_MARGIN = 12

export function tutorialDimColor(theme) {
  return theme === 'light' ? 'rgba(15, 23, 42, 0.24)' : 'rgba(2, 6, 23, 0.44)'
}

/** Clip a viewport rect to a container, returning container-relative coordinates.
 *  Returns null when the rect lies entirely outside the container, which callers treat
 *  as "this target is not currently visible". */
export function clipRectToContainer(rect, containerRect) {
  if (!rect || !containerRect) return null
  const left = Math.max(0, rect.left - containerRect.left)
  const top = Math.max(0, rect.top - containerRect.top)
  const right = Math.min(containerRect.width, rect.right - containerRect.left)
  const bottom = Math.min(containerRect.height, rect.bottom - containerRect.top)
  const width = right - left
  const height = bottom - top
  if (!(width > 0 && height > 0)) return null
  return { left, top, width, height }
}

const CLIPPING_OVERFLOW = new Set(['auto', 'clip', 'hidden', 'scroll'])

/** The part of an element that can actually be seen through all of its clipping
 *  ancestors, expressed in container-relative coordinates.
 *
 *  `getBoundingClientRect()` alone is not enough for a tutorial anchor inside a
 *  scroller. An element scrolled above an `overflow-y: auto` panel still has plausible
 *  viewport coordinates; drawing those coordinates produces a spotlight around an empty
 *  patch elsewhere on the page. Intersecting it with every ancestor that clips overflow
 *  makes the measurement match what the user can see.
 *
 *  A fixed-position element is the exception, and had to be taught: it is laid out
 *  against the viewport, so whatever happens to scroll above it does not clip it. A
 *  centred dialog lost the top of its spotlight to the app's own scrolling content region
 *  until this walked past it. Only an ancestor that becomes the dialog's containing block
 *  — a transform, a filter, `contain: paint` — can clip a fixed element, so the walk
 *  starts clipping again from there.
 *
 *  `readStyle` is injectable so the ancestor maths stays testable without a DOM. */
export function visibleElementRect(
  element,
  containerRect = viewportRect(),
  readStyle = (node) => window.getComputedStyle(node)
) {
  if (!element?.getBoundingClientRect || !containerRect) return null

  let visible = element.getBoundingClientRect()
  if (!(visible?.width > 0 && visible?.height > 0)) return null

  visible = intersectRects(visible, containerRect)
  if (!visible) return null

  visible = clipRectToClippingAncestors(visible, element, readStyle)
  if (!visible) return null

  // Last, and in viewport coordinates: the sticky control bar covers the target rather
  // than clipping it, so nothing in the ancestor walk can see it.
  visible = rectClearOfOccluders(visible, element)
  if (!visible) return null

  return clipRectToContainer(visible, containerRect)
}

function intersectRects(rect, clip, clipX = true, clipY = true) {
  if (!rect || !clip) return null
  const left = clipX ? Math.max(rect.left, clip.left) : rect.left
  const top = clipY ? Math.max(rect.top, clip.top) : rect.top
  const right = clipX ? Math.min(rect.right, clip.right) : rect.right
  const bottom = clipY ? Math.min(rect.bottom, clip.bottom) : rect.bottom
  if (!(right > left && bottom > top)) return null
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

/** A rect cut back to what every clipping ancestor of `element` actually shows of it.
 *
 *  Split out of the measurement above because a padded rect has to be put through the
 *  same walk: growing a spotlight by a few pixels for breathing room is what pushes its
 *  ring outside the panel that owns it, onto the page behind. */
export function clipRectToClippingAncestors(
  rect,
  element,
  readStyle = (node) => window.getComputedStyle(node)
) {
  if (!rect || !element) return rect || null
  let visible = rect.right === undefined || rect.bottom === undefined
    ? { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }
    : rect

  const styleOf = (node) => {
    try {
      return readStyle?.(node) || null
    } catch {
      return null
    }
  }
  // Does an ancestor become the containing block of a fixed-position descendant? These
  // are the properties that do it, and they are also the ones that can clip it.
  const holdsFixedChildren = (style) => Boolean(
    String(style?.contain || '').split(/\s+/).includes('paint')
    || (style?.transform && style.transform !== 'none')
    || (style?.filter && style.filter !== 'none')
    || (style?.perspective && style.perspective !== 'none')
  )

  let escapesScrolling = String(styleOf(element)?.position || '') === 'fixed'
  let ancestor = element.parentElement
  while (ancestor) {
    const style = styleOf(ancestor)
    const overflow = String(style?.overflow || '')
    const clipsX = CLIPPING_OVERFLOW.has(String(style?.overflowX || overflow))
    const clipsY = CLIPPING_OVERFLOW.has(String(style?.overflowY || overflow))
    const containsPaint = String(style?.contain || '').split(/\s+/).includes('paint')
    const holdsFixed = holdsFixedChildren(style)
    if ((clipsX || clipsY || containsPaint) && (!escapesScrolling || holdsFixed)) {
      visible = intersectRects(
        visible,
        ancestor.getBoundingClientRect?.(),
        clipsX || containsPaint,
        clipsY || containsPaint
      )
      if (!visible) return null
    }
    // Past its containing block the element is ordinary again; past a fixed ancestor it
    // is not, however far up the walk goes.
    if (holdsFixed) escapesScrolling = false
    if (String(style?.position || '') === 'fixed') escapesScrolling = true
    ancestor = ancestor.parentElement
  }

  return visible
}

/** The app chrome a spotlight has to stay clear of.
 *
 *  The genome browser's general control bar is sticky: it holds its place at the top of
 *  the scroller while the panels and drawers a step points at slide underneath it. Their
 *  rectangles stay perfectly valid — nothing clips them, they are simply covered — so a
 *  spotlight measured from one paints its ring across the control bar and lights up
 *  buttons the step is not talking about. Anything that floats over scrolling content
 *  like that marks itself with `data-tutorial-occluder`. */
export function overlayOccluders(root = (typeof document === 'undefined' ? null : document)) {
  if (!root?.querySelectorAll) return []
  return Array.from(root.querySelectorAll('[data-tutorial-occluder="true"]'))
}

// How much of a rect's width a piece of chrome has to cover before it is treated as lying
// across it rather than beside it. A sticky bar spans the whole scroller; this keeps a
// narrower floating control from trimming a panel it merely overlaps at one corner.
const OCCLUDER_COVERAGE = 0.5

/** Pull a rect out from under the chrome covering it.
 *
 *  Only a buried top or bottom edge moves, and only to the near edge of the chrome: a
 *  panel scrolled half under the control bar keeps everything of it that can be seen.
 *  A target that *is* the chrome — a step pointing at the control bar itself — and one
 *  that lives inside it are left alone, or a spotlight would trim itself away. Returns
 *  null when nothing of the rect is left visible. */
/** The fixed-position ancestor an element lives in (a dialog, a popover), or null. */
function fixedLayerOf(element, readStyle) {
  for (let node = element; node && typeof node === 'object'; node = node.parentElement) {
    try {
      if (readStyle(node)?.position === 'fixed') return node
    } catch {
      return null
    }
  }
  return null
}

const defaultReadStyle = (node) => (typeof window !== 'undefined' ? window.getComputedStyle(node) : null)

export function rectClearOfOccluders(rect, element = null, occluders = overlayOccluders(), readStyle = defaultReadStyle) {
  if (!rect) return null
  let { left, top } = rect
  let right = rect.right ?? rect.left + rect.width
  let bottom = rect.bottom ?? rect.top + rect.height
  // A target in a fixed layer — a dialog over the page — is above the page's chrome, so
  // a bar floating over the panels behind the dialog covers nothing of it. Without this
  // the track picker's first row, level with the browser's control bar behind it, had its
  // spotlight cut through the middle.
  const layer = element && typeof element === 'object' ? fixedLayerOf(element, readStyle) : null
  for (const node of occluders) {
    if (!node?.getBoundingClientRect) continue
    if (element && (node === element || node.contains?.(element) || element.contains?.(node))) continue
    if (layer && !layer.contains?.(node)) continue
    const chrome = node.getBoundingClientRect()
    if (!(chrome.width > 0 && chrome.height > 0)) continue
    const overlap = Math.min(chrome.right, right) - Math.max(chrome.left, left)
    if (!(overlap > 0 && overlap >= (right - left) * OCCLUDER_COVERAGE)) continue
    if (!(chrome.bottom > top && chrome.top < bottom)) continue
    const coversTop = chrome.top <= top
    const coversBottom = chrome.bottom >= bottom
    if (coversTop && coversBottom) return null
    if (coversTop) top = Math.min(bottom, chrome.bottom)
    else if (coversBottom) bottom = Math.max(top, chrome.top)
    // A band lying wholly inside the rect cannot be cut out of a rectangle, so the edge
    // it is nearest gives way. In practice that is the top: the bar sticks to the top of
    // the scroller and a padded rect can start a few pixels above it.
    else if (chrome.top - top <= bottom - chrome.bottom) top = chrome.bottom
    else bottom = chrome.top
  }
  if (!(right > left && bottom > top)) return null
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

export function areSizesEqual(a, b) {
  return a?.width === b?.width && a?.height === b?.height
}

export function areRectsEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.left === b.left
    && a.top === b.top
    && a.width === b.width
    && a.height === b.height
  )
}

export function areRectListsEqual(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (!areRectsEqual(a[i], b[i])) return false
  }
  return true
}

/** The visible viewport as a rect, for overlays that dim the whole window rather than
 *  one container. */
export function viewportRect() {
  const width = (typeof window !== 'undefined' && window.innerWidth)
    || (typeof document !== 'undefined' && document.documentElement?.clientWidth)
    || 0
  const height = (typeof window !== 'undefined' && window.innerHeight)
    || (typeof document !== 'undefined' && document.documentElement?.clientHeight)
    || 0
  return { left: 0, top: 0, right: width, bottom: height, width, height }
}

/** Grow a rect by `padding` on every side, without letting it escape `size`.
 *  Used to leave a little breathing room around a spotlit control. */
/** A spotlight's padded rect: `visible` grown by `padding` on every side where the target
 *  is whole, and not at all where it is cut off.
 *
 *  Trimming the grown rect back to the target's clipping ancestors (the old way) took the
 *  breathing room away wherever a target sat flush against its panel — an app button at
 *  the top of its bar, a header filling its view — and the ring's border, which is drawn
 *  inside the padded rect, then lay over the target's own edge: a ring that is not quite
 *  around the thing it points at. Where the target itself is cut off — a row half
 *  scrolled out of a list, a panel under the sticky control bar — the ring still stops at
 *  the cut, which is what the trimming was for. `full` is the target's whole box.
 *  An inset (negative padding) never escapes anything and applies everywhere. */
export function padVisibleRect(visible, full, padding = 0, size = null) {
  if (!visible) return null
  if (!(padding > 0) || !full) return expandRect(visible, padding, size)
  // Generous: a panel whose edge overhangs its container by a sub-pixel or a pixel is
  // whole for this purpose, and reading it as cut off took the ring's room on that side.
  const tol = 1.5
  const right = visible.right ?? visible.left + visible.width
  const bottom = visible.bottom ?? visible.top + visible.height
  const fullRight = full.right ?? full.left + full.width
  const fullBottom = full.bottom ?? full.top + full.height
  const grown = {
    left: full.left >= visible.left - tol ? visible.left - padding : visible.left,
    top: full.top >= visible.top - tol ? visible.top - padding : visible.top,
    right: fullRight <= right + tol ? right + padding : right,
    bottom: fullBottom <= bottom + tol ? bottom + padding : bottom,
  }
  const rect = { left: grown.left, top: grown.top, width: grown.right - grown.left, height: grown.bottom - grown.top }
  return expandRect(rect, 0, size)
}

export function expandRect(rect, padding = 0, size = null) {
  if (!rect) return null
  const grown = {
    left: rect.left - padding,
    top: rect.top - padding,
    width: rect.width + (padding * 2),
    height: rect.height + (padding * 2),
  }
  if (!size) return grown
  const maxWidth = Math.max(0, Math.round(size.width || 0))
  const maxHeight = Math.max(0, Math.round(size.height || 0))
  const left = Math.max(0, Math.min(maxWidth, grown.left))
  const top = Math.max(0, Math.min(maxHeight, grown.top))
  const right = Math.max(0, Math.min(maxWidth, grown.left + grown.width))
  const bottom = Math.max(0, Math.min(maxHeight, grown.top + grown.height))
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Turn overlapping rectangles into the same covered area expressed as non-overlapping
 *  rectangles.
 *
 *  Tutorial steps can reveal a large panel and spotlight a control inside it. Passing
 *  both rectangles straight to an even/odd SVG path cuts the overlap twice, which fills
 *  that exact control back in. Subtracting the area already represented from each new
 *  rectangle preserves the union without any double-cut regions. */
export function nonOverlappingRects(rects) {
  const valid = (Array.isArray(rects) ? rects : []).filter(
    (rect) => rect && rect.width > 0 && rect.height > 0
  )
  const result = []

  const subtract = (subject, cutter) => {
    const subjectRight = subject.left + subject.width
    const subjectBottom = subject.top + subject.height
    const cutterRight = cutter.left + cutter.width
    const cutterBottom = cutter.top + cutter.height
    const left = Math.max(subject.left, cutter.left)
    const top = Math.max(subject.top, cutter.top)
    const right = Math.min(subjectRight, cutterRight)
    const bottom = Math.min(subjectBottom, cutterBottom)
    if (right <= left || bottom <= top) return [subject]

    const pieces = []
    if (top > subject.top) {
      pieces.push({ left: subject.left, top: subject.top, width: subject.width, height: top - subject.top })
    }
    if (bottom < subjectBottom) {
      pieces.push({ left: subject.left, top: bottom, width: subject.width, height: subjectBottom - bottom })
    }
    if (left > subject.left) {
      pieces.push({ left: subject.left, top, width: left - subject.left, height: bottom - top })
    }
    if (right < subjectRight) {
      pieces.push({ left: right, top, width: subjectRight - right, height: bottom - top })
    }
    return pieces
  }

  for (const rect of valid) {
    let uncovered = [rect]
    for (const existing of result) {
      uncovered = uncovered.flatMap((piece) => subtract(piece, existing))
      if (uncovered.length === 0) break
    }
    result.push(...uncovered)
  }
  return result
}

/** An SVG path that fills `size` and punches `rects` out of it.
 *  Relies on `fill-rule="evenodd"`: the outer rectangle winds one way, each cutout the
 *  other, so the cutouts read as holes. */
export function cutoutPathD(size, rects) {
  const width = Math.max(1, Math.round(size?.width || 0))
  const height = Math.max(1, Math.round(size?.height || 0))
  const parts = [`M0 0H${width}V${height}H0Z`]
  for (const rect of Array.isArray(rects) ? rects : []) {
    if (!rect) continue
    if (!(rect.width > 0 && rect.height > 0)) continue
    const right = rect.left + rect.width
    const bottom = rect.top + rect.height
    parts.push(`M${rect.left} ${rect.top}H${right}V${bottom}H${rect.left}Z`)
  }
  return parts.join(' ')
}

/** The rectangles covering `size` everywhere except `hole`, as up to four bands
 *  (above, below, left, right).
 *
 *  This is what lets the tutorial overlay dim the app while leaving the spotlit control
 *  genuinely clickable: rather than one full-screen element that swallows every click,
 *  it renders these bands, so no overlay element sits over the hole at all. A null or
 *  degenerate hole covers everything, which is the right answer for a step whose anchor
 *  has scrolled out of view — dim, but nothing to click through to. */
export function blockerRects(size, hole, padding = 0) {
  const width = Math.max(0, Math.round(size?.width || 0))
  const height = Math.max(0, Math.round(size?.height || 0))
  if (!(width > 0 && height > 0)) return []
  const full = [{ left: 0, top: 0, width, height }]
  if (!hole) return full

  const bounds = expandRect(hole, padding, { width, height })
  if (!bounds || !(bounds.width > 0 && bounds.height > 0)) return full

  const { left, top } = bounds
  const right = left + bounds.width
  const bottom = top + bounds.height

  const rects = []
  if (top > 0) rects.push({ left: 0, top: 0, width, height: top })
  if (bottom < height) rects.push({ left: 0, top: bottom, width, height: height - bottom })
  if (left > 0) rects.push({ left: 0, top, width: left, height: bottom - top })
  if (right < width) rects.push({ left: right, top, width: width - right, height: bottom - top })
  return rects
}

/** Where to put the step card so it neither covers the thing it is describing nor falls
 *  off the screen.
 *
 *  Both failures are worse than they sound: a card over the target hides the very control
 *  the user is being asked to use, and a card past the bottom edge hides its own buttons.
 *  So the preferred side is tried first, then the others, and only a genuinely
 *  impossible fit falls back to overlapping — which is fine over something large like the
 *  genome browser and unavoidable when the target fills the screen.
 */
export function placeCard(size, hole, card, preferred = 'bottom', options = {}) {
  const width = Math.max(0, Math.round(size?.width || 0))
  const height = Math.max(0, Math.round(size?.height || 0))
  const cardWidth = Math.max(0, Math.round(card?.width || 0))
  const cardHeight = Math.max(0, Math.round(card?.height || 0))
  const margin = Number.isFinite(card?.margin) ? card.margin : 12
  const gap = Number.isFinite(card?.gap) ? card.gap : 16

  const centred = {
    left: Math.max(margin, Math.round((width - cardWidth) / 2)),
    top: Math.max(margin, Math.round((height - cardHeight) / 2)),
    placement: 'center',
    overlaps: false,
  }
  if (!hole || preferred === 'center') return centred

  const clamp = (value, max) => Math.min(Math.max(margin, value), Math.max(margin, max))
  const holeRight = hole.left + hole.width
  const holeBottom = hole.top + hole.height

  // Where the card sits along the axis it is *not* offset on. `start` lines its leading
  // edge up with the target's, which is the default and what every step wanted until one
  // wanted otherwise; `end` lines up the trailing edges; `center` splits the difference.
  //
  // Aligned against `alignTo` when given — the target itself rather than the padded ring
  // drawn around it — so "bottom edges level" means level with the control, which is what
  // someone looking at it means by it.
  const align = ['start', 'center', 'end'].includes(options.align) ? options.align : 'start'
  const box = options.alignTo || hole
  const boxRight = box.left + box.width
  const boxBottom = box.top + box.height
  const alignedTop = align === 'end'
    ? boxBottom - cardHeight
    : align === 'center' ? box.top + ((box.height - cardHeight) / 2) : box.top
  const alignedLeft = align === 'end'
    ? boxRight - cardWidth
    : align === 'center' ? box.left + ((box.width - cardWidth) / 2) : box.left

  const candidates = {
    bottom: { left: clamp(Math.round(alignedLeft), width - cardWidth - margin), top: holeBottom + gap },
    top: { left: clamp(Math.round(alignedLeft), width - cardWidth - margin), top: hole.top - gap - cardHeight },
    right: { left: holeRight + gap, top: clamp(Math.round(alignedTop), height - cardHeight - margin) },
    left: { left: hole.left - gap - cardWidth, top: clamp(Math.round(alignedTop), height - cardHeight - margin) },
  }

  const order = [preferred, 'bottom', 'top', 'right', 'left'].filter(
    (name, index, list) => candidates[name] && list.indexOf(name) === index
  )

  const fits = (pos) => (
    pos.left >= margin
    && pos.top >= margin
    && pos.left + cardWidth <= width - margin
    && pos.top + cardHeight <= height - margin
  )
  const overlapsHole = (pos) => !(
    pos.left >= holeRight || pos.left + cardWidth <= hole.left
    || pos.top >= holeBottom || pos.top + cardHeight <= hole.top
  )

  // Pinned: the author named a side, and that is where it goes. Clamped onto the screen
  // rather than moved to a different side, because a card that relocates when the thing
  // behind it changes size is the problem the pinning was reached for in the first place.
  if (options.pinned && candidates[preferred]) {
    const pos = candidates[preferred]
    const clamped = {
      left: clamp(pos.left, width - cardWidth - margin),
      top: clamp(pos.top, height - cardHeight - margin),
    }
    return { ...clamped, placement: preferred, overlaps: overlapsHole(clamped) }
  }

  for (const name of order) {
    const pos = candidates[name]
    if (fits(pos) && !overlapsHole(pos)) return { ...pos, placement: name, overlaps: false }
  }
  // Nothing clears the target. Take the first that at least stays on screen.
  for (const name of order) {
    const pos = candidates[name]
    if (fits(pos)) return { ...pos, placement: name, overlaps: overlapsHole(pos) }
  }
  return { ...centred, overlaps: overlapsHole(centred) }
}

/** The smallest rect containing all of `rects`, or null when there are none.
 *
 *  Used when a step lights up more than one thing: the card has to clear everything that
 *  was lit, not only the step's own target, or it lands on top of the very list the step
 *  is asking the user to watch. */
export function unionRect(rects) {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of Array.isArray(rects) ? rects : []) {
    if (!rect || !(rect.width > 0 && rect.height > 0)) continue
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.left + rect.width)
    bottom = Math.max(bottom, rect.top + rect.height)
  }
  if (!(right > left && bottom > top)) return null
  return { left, top, width: right - left, height: bottom - top }
}
