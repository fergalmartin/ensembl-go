// What a panel should do with the answer to its readiness poll.
//
// The browser asks /api/browse/regions whether a genome can be drawn yet, and
// used to treat every status it did not specifically recognise as "still
// coming". That is right for a genome whose index is being built and wrong for
// everything else: a build that failed answers 500 for ever, and the panel sat
// on a spinner for the life of the process rather than saying so.

/** The gene index is still being built. Keep polling; this one resolves itself. */
export const INDEX_BUILDING_STATUS = 425

// A genome that has only just been added answers 404 until its files land in
// the configuration, so an absent genome is given a little while to appear
// before the panel calls it an error.
export const MAX_ABSENT_ATTEMPTS = 8

const RETRY_DELAYS_MS = [800, 1200, 1800, 2500]
export const MAX_RETRY_DELAY_MS = 3000

/**
 * How long to wait before the next readiness poll.
 * Backs off so a build that takes minutes is not polled hundreds of times.
 */
export function readinessRetryDelay(attempt = 0) {
  const index = Math.max(0, Math.floor(Number(attempt) || 0))
  return RETRY_DELAYS_MS[index] ?? MAX_RETRY_DELAY_MS
}

/**
 * Classify a readiness poll.
 *
 * @param {object} outcome
 * @param {boolean} outcome.ok       the response was 2xx
 * @param {number}  outcome.status   HTTP status, 0 for a network failure
 * @param {number}  outcome.regionCount  regions the response carried
 * @param {number}  outcome.attempt  how many times this genome has been asked
 * @returns {'ready'|'pending'|'error'}
 */
export function classifyReadiness({ ok = false, status = 0, regionCount = 0, attempt = 0 } = {}) {
  if (ok) {
    // A genome with neither an annotation nor a readable FASTA answers with an
    // empty list. There is nothing to draw, so this is not ready — but it is
    // also not an error while the configuration is still settling.
    return Number(regionCount) > 0 ? 'ready' : 'pending'
  }

  const code = Number(status) || 0

  // No response at all: the backend is starting up or was restarted under us.
  if (code === 0) return 'pending'

  if (code === INDEX_BUILDING_STATUS) return 'pending'
  if (code === 408 || code === 429) return 'pending'

  // The genome is not in the configuration. Real once things have settled,
  // which is what the attempt budget is for.
  if (code === 404) return Number(attempt) < MAX_ABSENT_ATTEMPTS ? 'pending' : 'error'

  // 400 is an unusable genome key, 409 an index that cannot be used as it
  // stands, 5xx a build that failed. None of these clear up on their own.
  if (code >= 400) return 'error'

  return 'pending'
}
