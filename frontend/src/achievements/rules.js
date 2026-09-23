// How far along an achievement is, given the facts the tracker has collected.
//
// Pure functions over plain data, so the view, the tracker and the tests all ask the
// same question the same way. `facts` is:
//
//   {
//     unlocked:  { [id]: { at } },
//     counters:  { [event]: number },
//     distinct:  { [set]: Set<string> },
//     durations: { [metric]: ms },
//     lineage:   Set<number>,   // every clade of every downloaded genome
//   }

import { ACTIVE_ACHIEVEMENTS } from './catalogue.js'

const EMPTY_SET = new Set()

function distinctCount(facts, rule) {
  const seen = facts.distinct?.[rule.set] || EMPTY_SET
  if (!Array.isArray(rule.keys)) return seen.size
  let count = 0
  for (const key of rule.keys) if (seen.has(key)) count += 1
  return count
}

function taxonMet(facts, rule) {
  const lineage = facts.lineage || EMPTY_SET
  return (rule.taxa || []).some((taxid) => lineage.has(taxid))
}

/** Unlocked achievements that count towards meta totals. */
export function unlockedCount(facts) {
  let count = 0
  for (const achievement of ACTIVE_ACHIEVEMENTS) {
    if (facts.unlocked?.[achievement.id]) count += 1
  }
  return count
}

/**
 * `{ value, target }` for a rule. `value >= target` means the rule is satisfied.
 * Durations are reported in milliseconds; the view formats them.
 */
export function ruleProgress(rule, facts) {
  switch (rule?.type) {
    case 'event':
      return { value: Math.min(1, facts.counters?.[rule.event] || 0), target: 1 }
    case 'count':
      return { value: Math.min(rule.target, facts.counters?.[rule.event] || 0), target: rule.target }
    case 'distinct':
      return { value: Math.min(rule.target, distinctCount(facts, rule)), target: rule.target }
    case 'taxon':
      return { value: taxonMet(facts, rule) ? 1 : 0, target: 1 }
    case 'allOf': {
      const parts = rule.rules || []
      const met = parts.filter((part) => {
        const progress = ruleProgress(part, facts)
        return progress.value >= progress.target
      }).length
      return { value: met, target: parts.length }
    }
    case 'meta':
      return { value: Math.min(rule.target, unlockedCount(facts)), target: rule.target }
    case 'duration':
      return { value: Math.min(rule.targetMs, facts.durations?.[rule.metric] || 0), target: rule.targetMs }
    default:
      return { value: 0, target: 1 }
  }
}

export function ruleSatisfied(rule, facts) {
  const { value, target } = ruleProgress(rule, facts)
  return target > 0 && value >= target
}

/** Whether the view should draw a progress bar: only for rules with steps to count. */
export function hasProgressBar(rule) {
  if (!rule) return false
  if (rule.type === 'duration' || rule.type === 'meta') return true
  if (rule.type === 'count' || rule.type === 'distinct') return rule.target > 1
  if (rule.type === 'allOf') return (rule.rules || []).length > 1
  return false
}

/**
 * The names each rule listens to, as `kind:name`, so the tracker can index them.
 * `counter:` for events and counts, `set:` for distinct sets, `duration:` for time,
 * `lineage` for taxon rules and `meta` for achievement totals.
 */
export function ruleInputs(rule, out = new Set()) {
  switch (rule?.type) {
    case 'event':
    case 'count':
      out.add(`counter:${rule.event}`)
      break
    case 'distinct':
      out.add(`set:${rule.set}`)
      break
    case 'duration':
      out.add(`duration:${rule.metric}`)
      break
    case 'taxon':
      out.add('lineage')
      break
    case 'meta':
      out.add('meta')
      break
    case 'allOf':
      for (const part of rule.rules || []) ruleInputs(part, out)
      break
    default:
      break
  }
  return out
}

/** The ids of every achievement whose rule is satisfied but which is not yet unlocked. */
export function newlySatisfied(facts, candidates = ACTIVE_ACHIEVEMENTS) {
  const out = []
  for (const achievement of candidates) {
    if (facts.unlocked?.[achievement.id]) continue
    if (ruleSatisfied(achievement.rule, facts)) out.push(achievement.id)
  }
  return out
}
