import {
  TUTORIAL_TARGET_BY_ID,
  targetRef,
  targetRefAnchor,
  targetRefFromAnchor,
  tutorialTarget,
  validateTargetRef,
} from '../tutorialTargets/index.js'
import { browserSceneProblems } from './tutorialBrowserScene.js'
import { arrivalGenomeRecipeIds, arrivalPlaylists, browserViewProblems } from './tutorialModel.js'

export const TUTORIAL_DOCUMENT_FORMAT = 'ensembl-go-tutorial'
export const TUTORIAL_DOCUMENT_VERSION = 1
export const TUTORIAL_BUILDER_SAFE_CAPABILITIES = Object.freeze([
  'spotlight', 'activate', 'input', 'set-state', 'scroll', 'pan', 'zoom', 'set-locus', 'read-state',
])

const FORBIDDEN_DOCUMENT_KEYS = new Set(['selector', 'selectorTemplate', 'script', 'javascript', 'code', 'url'])

function plainCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Whether an embedded genome should be active when its tutorial starts.
 *
 * Older tutorial documents predate the builder control and omit autoActivate. Keep
 * those behaving as they always did; only an explicit false leaves a genome available
 * in the selector without selecting it. */
export function tutorialDatasetStartsActive(dataset) {
  return dataset?.autoActivate !== false
}

/** Return a document-ready dataset list with startup activation changed.
 *
 * Passing a recipe id changes one embedded genome; omitting it changes every embedded
 * genome. External recipe references are left alone because the tutorial runtime does
 * not install them into its private workspace. */
export function setTutorialDatasetActivation(datasets, active, recipeId = null) {
  return (Array.isArray(datasets) ? datasets : []).map((dataset) => {
    if (!dataset || typeof dataset !== 'object' || !dataset.embedded) return dataset
    if (recipeId !== null && dataset.recipeId !== recipeId) return dataset
    return { ...dataset, autoActivate: Boolean(active) }
  })
}

export function createTutorialDocument(seed = {}) {
  const now = new Date().toISOString()
  const id = String(seed.id || `tutorial-${Date.now().toString(36)}`).trim()
  return {
    format: TUTORIAL_DOCUMENT_FORMAT,
    schemaVersion: TUTORIAL_DOCUMENT_VERSION,
    id,
    revision: Number(seed.revision || 1),
    title: String(seed.title || 'Untitled tutorial'),
    blurb: String(seed.blurb || 'A custom Ensembl Go tutorial.'),
    estimatedMinutes: Number(seed.estimatedMinutes || 5),
    usesDemoGenome: Boolean(seed.usesDemoGenome),
    completionBody: String(seed.completionBody || 'Tutorial complete.'),
    author: String(seed.author || ''),
    createdAt: String(seed.createdAt || now),
    updatedAt: String(seed.updatedAt || now),
    ...(seed.settings ? { settings: plainCopy(seed.settings) } : {}),
    datasets: Array.isArray(seed.datasets) ? plainCopy(seed.datasets) : [],
    ...(seed.defaultArrive ? { defaultArrive: plainCopy(seed.defaultArrive) } : {}),
    steps: Array.isArray(seed.steps) ? plainCopy(seed.steps) : [],
  }
}

function slug(value) {
  const result = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return result || 'step'
}

export function nextDraftStep(document, options = {}) {
  const steps = Array.isArray(document?.steps) ? document.steps : []
  const previous = options.previousStep || steps.at(-1) || null
  const base = previous ? plainCopy(previous) : {}
  const used = new Set(steps.map((step) => String(step.id || '')))
  const stem = slug(options.title || previous?.title || 'new-step')
  let id = `${stem}-${steps.length + 1}`
  let suffix = 2
  while (used.has(id)) id = `${stem}-${steps.length + 1}-${suffix++}`
  const next = {
    ...base,
    id,
    title: String(options.title || 'New step'),
    body: String(options.body || 'Explain what the user should notice or do in this step.'),
    // Inherit the previous step as the authoring starting point, while avoiding an
    // accidental replay of its exact operation before the author has reviewed it.
    action: { type: 'none' },
    advanceOn: { type: 'manual' },
    ...(options.view ? { view: options.view } : {}),
  }
  delete next.autoplay
  delete next.recordingReview
  return next
}

function refsFromStep(step) {
  const refs = []
  const add = (ref, capability = 'spotlight', field = '') => {
    if (ref?.id) refs.push({ ref, capability, field })
  }
  add(step?.spotlight?.target || step?.spotlight, 'spotlight', 'spotlight')
  add(step?.openSectionTarget, 'activate', 'openSectionTarget')
  add(step?.sectionContentTarget, 'spotlight', 'sectionContentTarget')
  add(step?.placementTarget, 'spotlight', 'placementTarget')
  add(step?.copyTarget, 'input', 'copyTarget')
  for (const reveal of Array.isArray(step?.reveals) ? step.reveals : []) {
    add(reveal?.target || reveal, 'spotlight', 'reveals')
    add(reveal?.whenTypedTarget, 'input', 'reveals.whenTypedTarget')
  }
  for (const allowed of step?.interactionPolicy?.targets || []) {
    for (const capability of allowed.capabilities || []) add(allowed.target || allowed, capability, 'interactionPolicy')
  }
  const actions = step?.autoplay?.actions || (step?.autoplay?.action ? [step.autoplay.action] : [])
  for (const action of actions) add(action?.target, action?.capability || 'activate', 'action')
  if (step?.action?.target) add(step.action.target, step.action.capability || 'activate', 'action')
  if (step?.advanceOn?.target) {
    add(step.advanceOn.target, step.advanceOn.type === 'input' ? 'input' : 'activate', 'advanceOn')
  }
  for (const target of step?.advanceOn?.targets || []) {
    add(target, 'activate', 'advanceOn.targets')
  }
  for (const preparation of step?.prepare || []) {
    if (preparation?.target) add(preparation.target, preparation.capability || 'set-state', 'prepare')
  }
  for (const arrival of Array.isArray(step?.arrive) ? step.arrive : (step?.arrive ? [step.arrive] : [])) {
    if (arrival?.type === 'selectorList') add(arrival.target, 'spotlight', 'arrive.selectorList')
    if (arrival?.type === 'pageScroll') add(arrival.target, 'spotlight', 'arrive.pageScroll')
  }
  // Legacy definitions participate in compatibility reporting through the same target
  // contracts, without changing their runtime representation.
  const legacy = [
    ['anchor', step?.anchor],
    ['openSection', step?.openSection],
    ['sectionContent', step?.sectionContent],
    ['reveal', step?.reveal?.anchor],
    ['placeAgainst', step?.placeAgainst],
    ['prefill', step?.prefill?.anchor],
    ['advanceOn', step?.advanceOn?.anchor],
    ...(step?.action?.anchors?.length ? [] : [['action', step?.action?.anchor]]),
    ...((step?.action?.anchors || []).map((anchor) => ['action', anchor])),
  ]
  for (const [field, anchor] of legacy) {
    const ref = targetRefFromAnchor(anchor)
    const isTypedAction = field === 'action' && step?.action?.type === 'type'
    const isInputAdvance = field === 'advanceOn' && step?.advanceOn?.type === 'input'
    const capability = field === 'prefill' || isTypedAction || isInputAdvance
      ? 'input'
      : (field === 'action' || field === 'advanceOn' ? 'activate' : 'spotlight')
    if (ref) add(ref, capability, field)
    else if (anchor) refs.push({ missingAnchor: anchor, capability: 'spotlight', field })
  }
  return refs
}

function forbiddenProblems(value, path = 'tutorial', problems = []) {
  if (!value || typeof value !== 'object') return problems
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (FORBIDDEN_DOCUMENT_KEYS.has(key)) problems.push(`${childPath} is not allowed in a portable tutorial.`)
    if (typeof child === 'function') problems.push(`${childPath} contains executable code.`)
    if (child && typeof child === 'object') forbiddenProblems(child, childPath, problems)
    if (typeof child === 'string' && /^(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|file:\/\/)/.test(child)) {
      problems.push(`${childPath} contains an absolute local path.`)
    }
  }
  return problems
}

export function validateTutorialDocument(document, options = {}) {
  const problems = []
  const portable = options.portable !== false
  if (document?.format !== TUTORIAL_DOCUMENT_FORMAT) problems.push(`Tutorial format must be "${TUTORIAL_DOCUMENT_FORMAT}".`)
  if (Number(document?.schemaVersion) !== TUTORIAL_DOCUMENT_VERSION) {
    problems.push(`Tutorial schema v${document?.schemaVersion || '?'} is not supported; this app supports v${TUTORIAL_DOCUMENT_VERSION}.`)
  }
  const documentId = String(document?.id || '').trim()
  if (!documentId) problems.push('Tutorial has no id.')
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(documentId)) problems.push('Tutorial ids must contain lowercase letters, numbers and hyphens only.')
  if (!String(document?.title || '').trim()) problems.push('Tutorial has no title.')
  if (!Array.isArray(document?.steps) || document.steps.length === 0) problems.push('Tutorial has no steps.')
  if (document.settings?.genomeColors && (!Array.isArray(document.settings.genomeColors) || document.settings.genomeColors.some((c) => !/^#[0-9a-f]{6}$/i.test(c)))) problems.push('Tutorial genome colours must be six-digit hex colours.')
  const seen = new Set()
  for (const [index, step] of (document?.steps || []).entries()) {
    const where = `Step ${index + 1}`
    if (!String(step?.id || '').trim()) problems.push(`${where} has no id.`)
    else if (seen.has(step.id)) problems.push(`${where} duplicates step id "${step.id}".`)
    else seen.add(step.id)
    if (!String(step?.title || '').trim()) problems.push(`${where} has no title.`)
    if (!String(step?.body || '').trim()) problems.push(`${where} has no body.`)
    if (step.autoplayDemo) {
      problems.push(...browserViewProblems(step.autoplayDemo, `${where} autoplay demonstration`))
      for (const move of step.autoplayDemo.moves || []) {
        if (move.panelKey && !document.datasets?.some((d) => d.recipeId === move.panelKey)) problems.push(`${where}: demonstration names an unattached genome.`)
      }
    }
    for (const scene of [step.action?.type === 'browserScene' ? step.action : null, step.completeWhen, ...[step.arrive].flat().filter((a) => a?.type === 'browserScene')].filter(Boolean)) {
      problems.push(...browserSceneProblems(scene, document.datasets).map((p) => `${where}: ${p}`))
    }
    for (const requirement of refsFromStep(step)) {
      if (requirement.missingAnchor) continue
      for (const issue of validateTargetRef(requirement.ref)) problems.push(`${where}: ${issue}`)
      const contract = tutorialTarget(requirement.ref.id)
      if (contract && !contract.capabilities?.includes(requirement.capability)) {
        problems.push(`${where}: ${contract.label} does not support ${requirement.capability}.`)
      }
      if (!TUTORIAL_BUILDER_SAFE_CAPABILITIES.includes(requirement.capability)) {
        problems.push(`${where}: capability ${requirement.capability} is not allowed.`)
      }
      if (step.view && contract?.viewId && contract.viewId !== 'app' && step.view !== contract.viewId) {
        problems.push(`${where}: ${contract.label} belongs to ${contract.viewId}, not ${step.view}.`)
      }
    }
  }
  if (portable) forbiddenProblems(document, 'tutorial', problems)
  return [...new Set(problems)]
}

export function analyseTutorialCompatibility(tutorial, options = {}) {
  const knownDatasets = new Set(options.knownDatasets || ['builtin:ensemblus-welcomus@1', 'builtin:grch38-reg4@1'])
  const unavailableSteps = {}
  const documentProblems = tutorial?.format === TUTORIAL_DOCUMENT_FORMAT
    ? validateTutorialDocument(tutorial)
    : []
  // Target/capability problems are isolated to their step below. Structural and
  // portability problems make the document itself unsafe or ambiguous and block it.
  const fatal = documentProblems.filter((problem) => !/^Step \d+:/.test(problem))
  const missingDocumentDatasets = (tutorial?.datasets || []).flatMap((dataset) => {
    const id = String(dataset?.id || dataset || '')
    return id && !knownDatasets.has(id) && !dataset?.embedded
      ? [`Dataset recipe "${id}" is unavailable.`]
      : []
  })

  for (const [index, step] of (tutorial?.steps || []).entries()) {
    const reasons = [...missingDocumentDatasets, ...documentProblems.filter((p) => p.startsWith(`Step ${index + 1}:`))]
    for (const requirement of refsFromStep(step)) {
      if (requirement.missingAnchor) {
        const shown = typeof requirement.missingAnchor === 'string'
          ? requirement.missingAnchor
          : requirement.missingAnchor?.selector
        reasons.push(`No target contract describes ${shown || requirement.field}.`)
        continue
      }
      const contract = TUTORIAL_TARGET_BY_ID.get(requirement.ref.id)
      if (!contract) reasons.push(`Target "${requirement.ref.id}" is not available.`)
      else {
        reasons.push(...validateTargetRef(requirement.ref))
        if (!contract.capabilities?.includes(requirement.capability)) {
          reasons.push(`${contract.label} no longer supports ${requirement.capability}.`)
        }
        if (step.view && contract.viewId && contract.viewId !== 'app' && step.view !== contract.viewId) {
          reasons.push(`${contract.label} belongs to ${contract.viewId}, not ${step.view}.`)
        }
      }
    }
    for (const dataset of step?.datasets || []) {
      const id = String(dataset?.id || dataset || '')
      if (id && !knownDatasets.has(id) && !dataset?.embedded) reasons.push(`Dataset recipe "${id}" is unavailable.`)
    }
    // A step that arrives with genomes selected names them by recipe id. Detaching a
    // dataset would otherwise leave the step silently selecting one genome fewer.
    const attachedRecipeIds = new Set(
      (tutorial?.datasets || []).map((dataset) => String(dataset?.recipeId || '')).filter(Boolean),
    )
    for (const arrival of Array.isArray(step?.arrive) ? step.arrive : (step?.arrive ? [step.arrive] : [])) {
      // A playlist's members are named the same way a selection's are, so a detached
      // dataset has to be reported from both.
      if (arrival?.type === 'playlists') {
        for (const playlist of arrivalPlaylists(arrival)) {
          for (const recipeId of playlist.genomes) {
            if (!attachedRecipeIds.has(recipeId)) {
              reasons.push(`The playlist "${playlist.name}" names dataset "${recipeId}", which is no longer attached.`)
            }
          }
        }
        continue
      }
      if (arrival?.type !== 'genomeSelection') continue
      for (const recipeId of arrivalGenomeRecipeIds(arrival)) {
        if (!attachedRecipeIds.has(recipeId)) {
          reasons.push(`This step selects genome "${recipeId}", which is no longer attached to the tutorial.`)
        }
      }
    }
    if (reasons.length) unavailableSteps[String(step.id || index)] = [...new Set(reasons)]
  }
  const unavailableIds = Object.keys(unavailableSteps)
  const total = tutorial?.steps?.length || 0
  return {
    compatible: fatal.length === 0 && unavailableIds.length === 0,
    runnable: fatal.length === 0 && unavailableIds.length < total,
    fatal,
    documentProblems,
    unavailableSteps,
    unavailableStepIds: unavailableIds,
    runnableStepCount: Math.max(0, total - unavailableIds.length),
    totalStepCount: total,
  }
}

export function materializeTutorialDocument(document) {
  if (document?.format !== TUTORIAL_DOCUMENT_FORMAT) return document
  const steps = (document.steps || []).map((source) => {
    const step = plainCopy(source)
    const spotlightRef = step?.spotlight?.target || step?.spotlight
    if (spotlightRef?.id) {
      step.anchor = targetRefAnchor(spotlightRef)
      const targetPresentation = tutorialTarget(spotlightRef.id)?.presentation
      if (targetPresentation?.scrollIntoView && !step.anchorScroll) {
        step.anchorScroll = targetPresentation.scrollIntoView
      }
      if (targetPresentation?.deferUntilReady && step.deferUntilReady === undefined) {
        step.deferUntilReady = true
      }
    }
    if (step.openSectionTarget?.id) step.openSection = targetRefAnchor(step.openSectionTarget)
    if (step.sectionContentTarget?.id) step.sectionContent = targetRefAnchor(step.sectionContentTarget)
    if (step.placementTarget?.id) step.placeAgainst = targetRefAnchor(step.placementTarget)
    if (step.copyTarget?.id) step.copyInto = targetRefAnchor(step.copyTarget)
    const authoredArrivals = Array.isArray(step?.arrive) ? step.arrive : (step?.arrive ? [step.arrive] : [])
    if (authoredArrivals.length) {
      const positioned = new Set(['selectorList', 'pageScroll'])
      const arrivals = authoredArrivals.map((arrival) => {
        if (!positioned.has(arrival?.type) || !arrival.target?.id) return arrival
        const { target, ...rest } = arrival
        return { ...rest, anchor: targetRefAnchor(target) }
      })
      step.arrive = Array.isArray(step.arrive) ? arrivals : arrivals[0]
      // A step whose arrival moves the page must not be drawn until it has stopped
      // moving, or the spotlight is struck around wherever the target was passing.
      if (arrivals.some((arrival) => (
        (arrival?.type === 'selectorList' && arrival.center !== false)
        || arrival?.type === 'pageScroll'
      )) && step.deferUntilReady === undefined) {
        step.deferUntilReady = true
      }
    }
    const authoredReveals = step.reveals || []
    if (authoredReveals.length) {
      step.reveals = authoredReveals.map((reveal) => ({
        anchor: targetRefAnchor(reveal.target || reveal),
        ...(reveal.whenTypedTarget ? { whenTyped: targetRefAnchor(reveal.whenTypedTarget) } : {}),
        ...(reveal.ring ? { ring: true } : {}),
      }))
      step.reveal = { ...(step.reveal || {}), ...step.reveals[0] }
    }
    if (step.advanceOn?.target) {
      step.advanceOn = { ...step.advanceOn, anchor: targetRefAnchor(step.advanceOn.target) }
      delete step.advanceOn.target
    }
    if (step.advanceOn?.targets?.length) {
      step.advanceOn = {
        ...step.advanceOn,
        anchors: step.advanceOn.targets.map(targetRefAnchor).filter(Boolean),
      }
      delete step.advanceOn.targets
    }
    const authoredActions = step?.autoplay?.actions || (step?.autoplay?.action ? [step.autoplay.action] : [])
    if (authoredActions.length) {
      const first = authoredActions[0]
      if (authoredActions.every((action) => action.capability === 'activate')) {
        const anchors = authoredActions.map((action) => targetRefAnchor(action.target)).filter(Boolean)
        step.action = anchors.length === 1
          ? { type: 'click', anchor: anchors[0], ...(step.autoplay?.options || {}) }
          : { type: 'click', anchors, ...(step.autoplay?.options || {}) }
      } else if (first.capability === 'input') {
        step.action = {
          type: 'type',
          anchor: targetRefAnchor(first.target),
          value: String(first.value || ''),
          submit: first.submit !== false,
          ...(first.overwrite !== undefined ? { overwrite: Boolean(first.overwrite) } : {}),
          ...(step.autoplay?.options || {}),
        }
      } else if (first.capability === 'set-locus') {
        step.action = {
          type: 'browserView',
          ...(first.target?.params?.recipeId ? { panelKey: first.target.params.recipeId } : {}),
          ...(first.browserView || {}),
          ...(first.value ? { locus: String(first.value) } : {}),
        }
      }
    }
    if (step.interactionPolicy) {
      const allowed = step.interactionPolicy.targets || []
      step.interactive = allowed.length > 0
      if (allowed.some((entry) => entry.target?.id === 'browser.viewport'
        && entry.capabilities?.length === 1 && entry.capabilities[0] === 'zoom')) {
        step.interaction = 'zoom-only'
      }
    }
    delete step.spotlight
    delete step.openSectionTarget
    delete step.sectionContentTarget
    delete step.placementTarget
    delete step.copyTarget
    delete step.autoplay
    return step
  })
  return { ...plainCopy(document), steps }
}

/** The controls a legacy step leaves usable, as the document spells them out.
 *
 *  Derived from the spotlight, because that is all the runtime shape has to go on: a
 *  legacy step lights one thing and everything inside the cutout stays live. That breaks
 *  down as soon as the lit thing is a region holding more than one control — a search box
 *  beside the button that submits it — where the region itself has no capability of its
 *  own and the derivation would call the step look-only. Such a step names its controls in
 *  `allow`, which is inert in the runtime shape (the whole cutout is live there either
 *  way) and exists so the rollback can still say what the document says.
 */
function legacyAllowedTargets(step, spotlight) {
  const declared = Array.isArray(step?.allow) ? step.allow : []
  if (declared.length) {
    return declared
      .map((entry) => {
        const ref = targetRefFromAnchor(entry?.anchor)
        const capability = String(entry?.capability || '').trim()
        return ref && capability ? { target: ref, capabilities: [capability] } : null
      })
      .filter(Boolean)
  }
  const capabilities = interactionCapabilities(step, spotlight)
  return spotlight && capabilities.length ? [{ target: spotlight, capabilities }] : []
}

function interactionCapabilities(step, ref) {
  if (!ref || step?.interactive === false) return []
  if (step?.interaction === 'zoom-only') return ['zoom']
  const capabilities = tutorialTarget(ref.id)?.capabilities || []
  if (capabilities.includes('input')) return ['input']
  if (capabilities.includes('activate')) return ['activate']
  const browserCapabilities = ['pan', 'zoom'].filter((capability) => capabilities.includes(capability))
  return browserCapabilities
}

function portableAction(action) {
  if (!action || action.type === 'none') return []
  if (action.type === 'click') {
    return (action.anchors || (action.anchor ? [action.anchor] : []))
      .map((anchor) => targetRefFromAnchor(anchor))
      .filter(Boolean)
      .map((target) => ({ target, capability: 'activate' }))
  }
  if (action.type === 'type') {
    const target = targetRefFromAnchor(action.anchor)
    return target ? [{
      target,
      capability: 'input',
      value: String(action.value || ''),
      submit: action.submit !== false,
      ...(action.overwrite !== undefined ? { overwrite: Boolean(action.overwrite) } : {}),
    }] : []
  }
  if (action.type === 'browserView') {
    const { type: _type, locus, ...browserView } = action
    return [{
      target: targetRef('browser.viewport'),
      capability: 'set-locus',
      ...(locus ? { value: String(locus) } : {}),
      ...(Object.keys(browserView).length ? { browserView } : {}),
    }]
  }
  return []
}

function portableActionOptions(action) {
  if (!['click', 'type'].includes(action?.type)) return {}
  const options = { ...action }
  for (const key of ['type', 'anchor', 'anchors', 'value', 'submit', 'overwrite']) delete options[key]
  return options
}

/** Upgrade a checked-in legacy definition to the portable document model.
 *
 * The source definition remains useful as a rollback while the JSON path is being
 * exercised. All DOM knowledge is replaced by target references here, so the resulting
 * document can also be exported without carrying selectors or source expressions. */
export function legacyTutorialToDocument(tutorial, options = {}) {
  if (tutorial?.format === TUTORIAL_DOCUMENT_FORMAT) return createTutorialDocument(tutorial)
  const steps = (tutorial?.steps || []).map((legacy) => {
    const step = plainCopy(legacy)
    const spotlight = targetRefFromAnchor(step.anchor)
    const openSectionTarget = targetRefFromAnchor(step.openSection)
    const placementTarget = targetRefFromAnchor(step.placeAgainst)
    const copyTarget = targetRefFromAnchor(step.copyInto)
    const portableReveals = (step.reveals?.length ? step.reveals : (step.reveal ? [step.reveal] : [])).map((entry) => ({
      target: entry.target || targetRefFromAnchor(entry.anchor),
      ...(entry.whenTyped ? { whenTypedTarget: targetRefFromAnchor(entry.whenTyped) } : {}),
      ...(entry.ring ? { ring: true } : {}),
    })).filter((entry) => entry.target)
    const revealTarget = targetRefFromAnchor(step.reveal?.anchor)
    const whenTypedTarget = targetRefFromAnchor(step.reveal?.whenTyped)
    const advanceTarget = targetRefFromAnchor(step.advanceOn?.anchor)
    const inferredAction = step.action || (step.prefill
      ? { type: 'type', anchor: step.prefill.anchor, value: step.prefill.value, submit: true }
      : null)
    const actions = portableAction(inferredAction)
    const actionOptions = portableActionOptions(inferredAction)
    delete step.anchor
    delete step.openSection
    delete step.placeAgainst
    delete step.copyInto
    delete step.allow
    delete step.reveal
    delete step.reveals
    delete step.prefill
    delete step.action
    if (step.advanceOn?.anchor) {
      step.advanceOn = { ...step.advanceOn }
      delete step.advanceOn.anchor
    }
    return {
      ...step,
      ...(spotlight ? { spotlight: { target: spotlight } } : {}),
      ...(openSectionTarget ? { openSectionTarget } : {}),
      ...(placementTarget ? { placementTarget } : {}),
      ...(copyTarget ? { copyTarget } : {}),
      ...(revealTarget ? { reveals: [{
        target: revealTarget,
        ...(whenTypedTarget ? { whenTypedTarget } : {}),
      }] } : {}),
      ...(portableReveals.length ? { reveals: portableReveals } : {}),
      interactionPolicy: plainCopy(legacy.interactionPolicy) || { targets: legacyAllowedTargets(legacy, spotlight) },
      ...(inferredAction?.type === 'browserScene' ? { action: plainCopy(inferredAction) } : {}),
      ...(advanceTarget ? { advanceOn: { ...step.advanceOn, target: advanceTarget } } : {}),
      ...(actions.length ? {
        autoplay: {
          ...(actions.length === 1 ? { action: actions[0] } : { actions }),
          ...(Object.keys(actionOptions).length ? { options: actionOptions } : {}),
        },
      } : {}),
    }
  })
  return createTutorialDocument({
    ...plainCopy(tutorial),
    ...options,
    steps,
  })
}

export function targetRefForLegacyAnchor(anchor) {
  return targetRefFromAnchor(anchor)
}

export function defaultSpotlightForTarget(targetId, params = {}) {
  return { target: targetRef(targetId, params) }
}
