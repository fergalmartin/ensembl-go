// Editing a tutorial's wording from inside the running app.
//
// A developer tool, and one that is meant to be removed. Everything it needs is here and
// in backend/tutorial_authoring.py: set `TUTORIAL_AUTHORING` to false — or take the
// backend's flag down, which the frontend then follows — and the pencil disappears, the
// card goes back to being read-only, and nothing else has to be unpicked.
//
// Why it exists: refining tutorial copy means reading it in place, at the width the card
// actually is, next to the thing it describes. Noticing an awkward sentence, finding it
// in a definition file, editing it and coming back to look again is slow enough that
// awkward sentences survive the process. So the card is editable where it stands and the
// edit is written back into the definition, which is where the wording ships from.

import { API_BASE } from '../backendRuntime.js'

/** The switch. False here and the feature is gone from the UI entirely. */
export const TUTORIAL_AUTHORING = true

/** The new builder is deliberately a separate switch from the proven in-card editor.
 * Turning this off removes drafts, recording and packages while leaving today's
 * tutorials and their source authoring path unchanged. */
export const TUTORIAL_BUILDER_ENABLED = true

/** Built-ins now run from promoted schema-v1 JSON. Set false for an immediate rollback
 * to the untouched JavaScript definitions while the document path is hardened. */
export const TUTORIAL_JSON_BUILTINS_ENABLED = true

/** The fields a card will let you edit — its words, and nothing behavioural. */
export const EDITABLE_FIELDS = Object.freeze(['section', 'title', 'body', 'copy'])

/** Whether the backend will accept an edit. It refuses outside a source checkout, so a
 *  packaged build reports false and the control never appears. */
export async function fetchAuthoringEnabled() {
  if (!TUTORIAL_AUTHORING) return false
  try {
    const response = await fetch(`${API_BASE}/api/tutorial/authoring`)
    if (!response.ok) return false
    const payload = await response.json()
    return Boolean(payload?.enabled)
  } catch {
    return false
  }
}

export async function fetchBuilderEnabled() {
  if (!TUTORIAL_BUILDER_ENABLED) return false
  try {
    const response = await fetch(`${API_BASE}/api/tutorial/authoring`)
    if (!response.ok) return false
    const payload = await response.json()
    return Boolean(payload?.builder_enabled)
  } catch {
    return false
  }
}

/** Write one step's field back into the file that holds its words.
 *
 *  Resolves to `{ saved, interpolationDropped, followed, file }`.
 *
 *  `interpolationDropped` says the value used to be built from an expression —
 *  `${REG4.symbol}` — which the app had no way to recover from the rendered text, so it
 *  has been written out literally. `followed` names the constant the value came from when
 *  the step referred to one rather than spelling it out, in which case the edit landed in
 *  that constant's module and every other step reading it has changed too. Both are worth
 *  telling whoever pressed Save: they are the edits that do more than they look like. */
export async function saveStepText({ tutorialId, stepId, field, value }) {
  if (!TUTORIAL_AUTHORING) return { saved: false }
  const response = await fetch(`${API_BASE}/api/tutorial/authoring/step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tutorial_id: tutorialId, step_id: stepId, field, value }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.detail || 'Could not save the wording')
  return {
    saved: true,
    interpolationDropped: Boolean(payload?.interpolation_dropped),
    followed: String(payload?.followed || ''),
    file: String(payload?.file || '').split('/').pop(),
  }
}

/** Save a manually placed card as fractions of the viewport.
 *  Normalized coordinates keep the authored position meaningful after a resize instead
 *  of preserving pixels from the display on which the tutorial happened to be edited. */
export async function saveStepPosition({ tutorialId, stepId, position }) {
  if (!TUTORIAL_AUTHORING) return { saved: false }
  const x = Number(position?.x)
  const y = Number(position?.y)
  const response = await fetch(`${API_BASE}/api/tutorial/authoring/step-position`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tutorial_id: tutorialId, step_id: stepId, x, y }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.detail || 'Could not save the card position')
  return {
    saved: true,
    position: { x, y },
    file: String(payload?.file || '').split('/').pop(),
  }
}

/** Save the edge or edges changed by an edit-mode resize. */
export async function saveStepSize({ tutorialId, stepId, size }) {
  if (!TUTORIAL_AUTHORING) return { saved: false }
  const body = { tutorial_id: tutorialId, step_id: stepId }
  if (size?.width !== undefined) body.width = Number(size.width)
  if (size?.height !== undefined) body.height = Number(size.height)
  const response = await fetch(`${API_BASE}/api/tutorial/authoring/step-size`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.detail || 'Could not save the card dimensions')
  return {
    saved: true,
    size: payload?.size || size,
    file: String(payload?.file || '').split('/').pop(),
  }
}
