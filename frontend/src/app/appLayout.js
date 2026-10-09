// App-wide layout constants, the Genome Selector's pending-genome hand-off
// (localStorage key and refresh event), the previous-session playlist ids, and
// scroll-position holding across view switches.

export const SELECTOR_PENDING_GENOMES_STORAGE_KEY = 'ensembl_selector_pending_genomes'

export const SELECTOR_REFRESH_EVENT = 'ensembl:selector-refresh'

// How long leaving the configuration view waits for its save before going anyway.
// A local save answers in tens of milliseconds; this only has to be longer than that.
export const CONFIG_SAVE_NAV_WAIT_MS = 1500

// The width of the scroll affordance that overlays each end of the app button strip when
// it has somewhere to scroll to. It sits on top of the strip rather than beside it so
// that arriving and leaving does not shift the buttons under the user's cursor.
export const TOP_BAR_SCROLL_ARROW_PX = 30

// The drawer's own border already occupies the first pixel of where the strip begins, so
// its header band is that much shorter for the two to end on the same line.
export const DRAWER_BORDER_PX = 1

// The drawer's own horizontal padding. Applied as a value rather than a class because
// the drawer's offset is computed from it: the panel is pulled left by exactly this plus
// its border so that the preview grid lines up with the real buttons.
export const DRAWER_PADDING_X = 16

export const PREVIOUS_SESSION_PLAYLIST_ID = '__previous_session__'

export const NEXT_PREVIOUS_SESSION_PLAYLIST_ID = '__next_previous_session__'

export function readPendingSelectorGenomeIds() {
  if (typeof window === 'undefined' || !window.sessionStorage) return new Set()
  try {
    const raw = window.sessionStorage.getItem(SELECTOR_PENDING_GENOMES_STORAGE_KEY)
    const parsed = JSON.parse(raw || '[]')
    return new Set(Array.isArray(parsed) ? parsed.map((entry) => String(entry || '').trim()).filter(Boolean) : [])
  } catch {
    return new Set()
  }
}

export function writePendingSelectorGenomeIds(ids) {
  if (typeof window === 'undefined' || !window.sessionStorage) return
  try {
    window.sessionStorage.setItem(SELECTOR_PENDING_GENOMES_STORAGE_KEY, JSON.stringify(Array.from(ids)))
  } catch {
    // Ignore session storage failures; the selector can still refresh normally.
  }
}

/**
 * Scroll `node` to `target` and keep it there while the page is still growing into
 * place: content that arrives in stages (the browser's panels size themselves as their
 * data lands) would otherwise clamp the offset, or the browser's scroll anchoring would
 * shift it. Lets go once the height has been still for `settleMs`, after `maxMs`, or the
 * moment the reader scrolls. Returns a function that stops it early.
 */
export function holdScrollTop(node, target, { settleMs = 750, maxMs = 8000, onDone = null } = {}) {
  let frame = 0
  const startedAt = performance.now()
  let lastHeight = -1
  let stableSince = startedAt
  const stop = () => {
    cancelAnimationFrame(frame)
    node.removeEventListener('wheel', finish)
    node.removeEventListener('pointerdown', finish)
    window.removeEventListener('keydown', finish)
  }
  const finish = () => {
    stop()
    onDone?.()
  }
  const hold = () => {
    const now = performance.now()
    const height = node.scrollHeight
    if (height !== lastHeight) {
      lastHeight = height
      stableSince = now
    }
    const reachable = height - node.clientHeight
    const wanted = Math.min(target, Math.max(0, reachable))
    if (Math.abs(node.scrollTop - wanted) > 1) node.scrollTop = wanted
    if ((reachable >= target && now - stableSince > settleMs) || now - startedAt > maxMs) {
      finish()
      return
    }
    frame = requestAnimationFrame(hold)
  }
  node.addEventListener('wheel', finish, { passive: true })
  node.addEventListener('pointerdown', finish)
  window.addEventListener('keydown', finish)
  hold()
  return stop
}
