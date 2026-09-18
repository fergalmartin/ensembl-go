// The tutorial's handle on the genome Cycle wheel, in the same shape as
// `browserTutorialControls`: a module-level registry the wheel publishes itself on, so
// nothing in the component tree has to know a tutorial exists.
//
// The wheel is the one control in the browser that a tutorial cannot simply click. Its
// gesture is a press, a travel and a release — there is no moment in the middle for a step
// to point at unless the wheel is *held* open across several steps. So a step declares the
// wheel's state instead of performing its gesture, exactly as the Genome Selector's steps
// declare `dialog`: until something opens it there is no element for the spotlight and no
// panel for the card to talk about.
//
// Nothing here does any work of its own. Opening, choosing and closing all go through the
// wheel's own session, so a tutorial's wheel spins, settles and commits the way one the
// reader opened does.

let wheel = null

/** Publish the wheel's controls. Returns the deregistration function.
 *
 *  `controls` is `{ describe(), open(request), choose(request), close() }`, where a
 *  request is `{ genome, action }` — `genome` being a dataset recipe id or a genome key,
 *  and `action` one of `focus`, `add` or `none`. */
export function registerGenomeCycle(controls) {
  wheel = controls
  return () => { if (wheel === controls) wheel = null }
}

const CLOSED = Object.freeze({ open: false, genome: '', action: 'none' })

/** What the wheel is showing. A wheel that is not mounted is a closed one, so a step may
 *  declare `open: false` from any app without first asking whether the browser is there. */
export function describeGenomeCycle() {
  return wheel?.describe?.() || CLOSED
}

/** Whether the wheel matches what a step asked for. Only the keys given are compared, the
 *  same rule the rest of the scene vocabulary follows. */
export function genomeCycleMatches(wanted, actual = describeGenomeCycle()) {
  if (!wanted) return true
  if (wanted.open !== undefined && Boolean(wanted.open) !== Boolean(actual.open)) return false
  if (!wanted.open) return true
  if (wanted.genome !== undefined && String(wanted.genome) !== String(actual.genome || '')) return false
  if (wanted.action !== undefined && String(wanted.action) !== String(actual.action || 'none')) return false
  return true
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Bring the wheel to a declared state.
 *
 *  Idempotent by construction, because an arrival runs on every entry: a wheel already
 *  showing that genome with that action is left alone rather than closed and reopened,
 *  which would throw away the panel previews it captured on the way up.
 *
 *  `alive` is the arrival's own generation check — a newer step must be able to abandon
 *  this one mid-wait rather than reopening a wheel the reader has moved past. */
export async function setGenomeCycle(wanted, alive = () => true) {
  if (!wanted) return true
  const deadline = Date.now() + 4000
  if (!wanted.open) {
    while (alive() && describeGenomeCycle().open) {
      wheel?.close?.()
      if (Date.now() > deadline) return false
      await delay(60)
    }
    return alive()
  }
  // The wheel reads the active genomes and photographs their panels as it opens, so it can
  // only be opened once the scene around it has settled — which is why the cycle is the
  // last thing `applyTutorialBrowserScene` does.
  while (alive() && !describeGenomeCycle().open) {
    wheel?.open?.({ genome: wanted.genome, action: wanted.action })
    if (Date.now() > deadline) return false
    await delay(60)
  }
  if (!alive()) return false
  if (!genomeCycleMatches(wanted)) wheel?.choose?.({ genome: wanted.genome, action: wanted.action })
  return alive()
}

/** What a portable document may say about the wheel. */
export function genomeCycleProblems(cycle, known = new Set()) {
  if (cycle === undefined) return []
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) return ['Genome cycle must be an object.']
  const problems = []
  if (cycle.open !== undefined && typeof cycle.open !== 'boolean') problems.push('Genome cycle open must be true or false.')
  if (cycle.action !== undefined && !['focus', 'add', 'none'].includes(cycle.action)) problems.push('Genome cycle action must be focus, add or none.')
  if (cycle.genome !== undefined) {
    if (typeof cycle.genome !== 'string' || !cycle.genome) problems.push('Genome cycle genome must name a dataset.')
    else if (known.size && !known.has(cycle.genome)) problems.push(`Genome cycle names an unattached dataset: ${cycle.genome}.`)
  }
  return problems
}
