import configuration from './configuration.js'
import download from './download.js'
import genomeSelector from './genomeSelector.js'
import customGenome from './customGenome.js'
import genomeBrowser from './genomeBrowser.js'
import app from './app.js'

export const TUTORIAL_TARGET_VIEWS = Object.freeze([
  app,
  configuration,
  download,
  genomeSelector,
  customGenome,
  genomeBrowser,
])

const contracts = TUTORIAL_TARGET_VIEWS.flatMap((view) => (
  view.targets.map((target) => Object.freeze({
    contractVersion: 1,
    authoringVisible: true,
    ...target,
    ...(view.viewId === 'genome_browser' && !['browser.globalControls', 'browser.hideInactive', 'browser.tracks', 'browser.detail', 'browser.flatten', 'browser.unfocus', 'browser.biotypes', 'browser.pan', 'browser.zoom', 'browser.linkRegion', 'browser.linkGene'].includes(target.id) && !target.id.startsWith('browser.biotype.') ? { parameters: { ...target.parameters, recipeId: { type: 'string', required: false } } } : {}),
    viewId: view.viewId,
  }))
))

export const TUTORIAL_TARGETS = Object.freeze(contracts)
export const TUTORIAL_TARGET_BY_ID = new Map(contracts.map((target) => [target.id, target]))

function escapeAttribute(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(value))
  return String(value).replace(/["\\]/g, '\\$&')
}

function interpolate(template, params = {}, attribute = false) {
  return String(template || '').replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key) => {
    const value = params[key]
    return attribute ? escapeAttribute(value ?? '') : String(value ?? '')
  })
}

export function tutorialTarget(targetId) {
  return TUTORIAL_TARGET_BY_ID.get(String(targetId || '').trim()) || null
}

export function targetRef(targetId, params = {}, version = null) {
  const contract = tutorialTarget(targetId)
  return {
    id: String(targetId || '').trim(),
    version: Number(version || contract?.contractVersion || 1),
    ...(params && Object.keys(params).length ? { params: { ...params } } : {}),
  }
}

export function validateTargetRef(ref) {
  const problems = []
  if (!ref || typeof ref !== 'object') return ['Target reference is missing.']
  const contract = tutorialTarget(ref.id)
  if (!contract) return [`Unknown tutorial target "${String(ref.id || '')}".`]
  if (Number(ref.version || 1) !== Number(contract.contractVersion || 1)) {
    problems.push(`${contract.label} requires target contract v${ref.version}; this app supports v${contract.contractVersion}.`)
  }
  for (const [name, rule] of Object.entries(contract.parameters || {})) {
    const value = ref.params?.[name]
    if (rule.required && (value === undefined || value === null || String(value) === '')) {
      problems.push(`${contract.label} needs parameter "${name}".`)
    }
    if (rule.type === 'enum' && value !== undefined && !rule.values?.includes(String(value))) {
      problems.push(`${contract.label} parameter "${name}" must be one of ${rule.values.join(', ')}.`)
    }
  }
  const extras = Object.keys(ref.params || {}).filter((name) => !contract.parameters?.[name])
  if (extras.length) problems.push(`${contract.label} has unknown parameters: ${extras.join(', ')}.`)
  return problems
}

function unscopedSelector(ref) {
  const contract = tutorialTarget(ref?.id)
  if (!contract || validateTargetRef(ref).length) return ''
  if (contract.anchor) return `[data-tour-id="${escapeAttribute(contract.anchor)}"]`
  if (contract.anchorTemplate) {
    const anchor = interpolate(contract.anchorTemplate, ref.params)
    return `[data-tour-id="${escapeAttribute(anchor)}"]`
  }
  if (contract.selector) return contract.selector
  if (contract.selectorTemplate) return interpolate(contract.selectorTemplate, ref.params, true)
  return ''
}

export function targetRefSelector(ref) {
  const selector = unscopedSelector(ref)
  return selector && ref?.params?.recipeId ? `[data-tutorial-genome="${escapeAttribute(ref.params.recipeId)}"] ${selector}` : selector
}

export function targetRefAnchor(ref) {
  const contract = tutorialTarget(ref?.id)
  if (!contract || validateTargetRef(ref).length) return null
  if (ref.params?.recipeId) return { selector: targetRefSelector(ref) }
  if (contract.anchor) return contract.anchor
  if (contract.anchorTemplate) return interpolate(contract.anchorTemplate, ref.params)
  const selector = targetRefSelector(ref)
  return selector ? { selector } : null
}

export function targetRefFromElement(element) {
  if (!element) return null
  const pill = element.closest?.('[data-tutorial-pill]')
  if (pill && element.matches?.('button')) return targetRef('app.datasetPill', { dataset: pill.getAttribute('data-tutorial-pill') })
  const tourId = element.getAttribute?.('data-tour-id') || ''
  const recipeId = element.closest?.('[data-tutorial-genome]')?.getAttribute('data-tutorial-genome')
  const picked = (id, params = {}) => targetRef(id, { ...params, ...(recipeId && tutorialTarget(id)?.parameters?.recipeId ? { recipeId } : {}) })
  for (const contract of contracts) {
    if (contract.anchor === tourId) return picked(contract.id)
    if (contract.anchorTemplate && tourId) {
      const keys = [...contract.anchorTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1])
      const pattern = '^' + contract.anchorTemplate
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\{[A-Za-z][A-Za-z0-9]*\\\}/g, '(.+)') + '$'
      const match = tourId.match(new RegExp(pattern))
      if (match) return picked(contract.id, Object.fromEntries(keys.map((key, index) => [key, match[index + 1]])))
    }
    const selector = contract.selector
    if (selector && element.matches?.(selector)) return picked(contract.id)
    if (contract.selectorTemplate) {
      const attr = contract.selectorTemplate.match(/^\[([^=]+)=\\?"\{([^}]+)\}\\?"\]$/)
      if (attr && element.hasAttribute?.(attr[1])) return picked(contract.id, { [attr[2]]: element.getAttribute(attr[1]) })
    }
  }
  return null
}

export function targetRefFromAnchor(anchor) {
  const scoped = typeof anchor === 'object' && anchor?.selector?.match(/^\[data-tutorial-genome="([^"]+)"\] (.+)$/)
  if (scoped) {
    const ref = targetRefFromAnchor({ selector: scoped[2] }) || targetRefFromAnchor(scoped[2].match(/^\[data-tour-id="([^"]+)"\]$/)?.[1])
    if (ref) return targetRef(ref.id, { ...ref.params, recipeId: scoped[1] })
  }

  const selector = typeof anchor === 'object' ? String(anchor?.selector || '') : ''
  const tourId = typeof anchor === 'string' ? anchor : ''
  for (const contract of contracts) {
    if (tourId && contract.anchor === tourId) return targetRef(contract.id)
    if (selector && contract.selector === selector) return targetRef(contract.id)
    if (tourId && contract.anchorTemplate) {
      const keys = [...contract.anchorTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1])
      const escaped = contract.anchorTemplate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = '^' + escaped.replace(/\\\{[A-Za-z][A-Za-z0-9]*\\\}/g, '(.+)') + '$'
      const match = tourId.match(new RegExp(pattern))
      if (match) return targetRef(contract.id, Object.fromEntries(keys.map((key, index) => [key, match[index + 1]])))
    }
    if (selector && contract.selectorTemplate) {
      const keys = [...contract.selectorTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1])
      const escaped = contract.selectorTemplate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = '^' + escaped.replace(/\\\{[A-Za-z][A-Za-z0-9]*\\\}/g, '(.+)') + '$'
      const match = selector.match(new RegExp(pattern))
      if (match) return targetRef(contract.id, Object.fromEntries(keys.map((key, index) => [key, match[index + 1]])))
    }
  }
  return null
}

export function findTargetElement(ref, root = document) {
  const selector = targetRefSelector(ref)
  if (!selector || !root?.querySelector) return null
  try { return root.querySelector(selector) } catch { return null }
}

export function targetSupports(ref, capability) {
  return Boolean(tutorialTarget(ref?.id)?.capabilities?.includes(capability))
}
