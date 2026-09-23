import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ACHIEVEMENTS, ACHIEVEMENT_CATEGORIES } from '../src/achievements/catalogue.js'
import { hasProgressBar, newlySatisfied, ruleProgress, ruleSatisfied } from '../src/achievements/rules.js'
import { APP_BUTTON_META, DATA_VIEW_BUTTON_IDS, DEFAULT_ACTIVE_APP_BUTTONS } from '../src/appButtonConfig.js'
import { setTutorialSandboxActive } from '../src/tutorials/sandbox.js'
import { browserControlKey } from '../src/achievements/browserControls.js'
import * as tracker from '../src/achievements/tracker.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.join(here, '..', 'src')
const backendRoot = path.join(here, '..', '..', 'backend')
const lock = JSON.parse(fs.readFileSync(path.join(srcRoot, 'achievements', 'achievements.lock.json'), 'utf8'))

// ── The promises made to people who have unlocked things ─────────────────────

test('ids and numbers are unique', () => {
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.id)).size, ACHIEVEMENTS.length)
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.number)).size, ACHIEVEMENTS.length)
})

test('every achievement ever shipped is still in the catalogue with its number', () => {
  const byId = new Map(ACHIEVEMENTS.map((a) => [a.id, a]))
  for (const { id, number } of lock.achievements) {
    assert.ok(byId.has(id), `${id} was removed or renamed — retire it with retired: true instead`)
    assert.equal(byId.get(id).number, number, `${id} changed number`)
  }
})

test('a number is never given to a second achievement', () => {
  const lockedNumbers = new Map(lock.achievements.map(({ id, number }) => [number, id]))
  for (const achievement of ACHIEVEMENTS) {
    const owner = lockedNumbers.get(achievement.number)
    if (owner) assert.equal(owner, achievement.id, `#${achievement.number} already belongs to ${owner}`)
  }
})

test('new achievements are added to the lock file', () => {
  const lockedIds = new Set(lock.achievements.map(({ id }) => id))
  for (const achievement of ACHIEVEMENTS) {
    assert.ok(lockedIds.has(achievement.id), `add ${achievement.id} to achievements.lock.json`)
  }
})

test('numbers run from 1 without gaps', () => {
  const numbers = ACHIEVEMENTS.map((a) => a.number).sort((a, b) => a - b)
  numbers.forEach((number, index) => assert.equal(number, index + 1))
})

test('every achievement is well formed', () => {
  const categories = new Set(ACHIEVEMENT_CATEGORIES.map((c) => c.id))
  for (const achievement of ACHIEVEMENTS) {
    assert.match(achievement.id, /^[a-z0-9_]+$/, achievement.id)
    assert.ok(achievement.name && achievement.description, achievement.id)
    assert.ok(categories.has(achievement.category), `${achievement.id} has unknown category ${achievement.category}`)
    assert.ok(achievement.rule?.type, achievement.id)
  }
})

test('every category icon and per-achievement icon is a real app button', () => {
  for (const category of ACHIEVEMENT_CATEGORIES) assert.ok(APP_BUTTON_META[category.icon], category.icon)
  for (const achievement of ACHIEVEMENTS) {
    if (achievement.icon) assert.ok(APP_BUTTON_META[achievement.icon], achievement.icon)
  }
})

test('there is a visit achievement for every view except Achievements', () => {
  const visited = new Set(
    ACHIEVEMENTS.filter((a) => a.rule.set === 'view.visit' && a.rule.keys).flatMap((a) => a.rule.keys)
  )
  for (const viewId of DATA_VIEW_BUTTON_IDS) {
    if (viewId === 'achievements') continue
    assert.ok(visited.has(viewId), `no visit achievement for ${viewId}`)
  }
})

test('Achievements is offered but not switched on by default', () => {
  assert.ok(DATA_VIEW_BUTTON_IDS.includes('achievements'))
  assert.equal(DEFAULT_ACTIVE_APP_BUTTONS.includes('achievements'), false)
})

// ── Every event the catalogue waits for is actually recorded somewhere ────────

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

function ruleNames(rule, out = []) {
  if (rule.type === 'allOf') rule.rules.forEach((part) => ruleNames(part, out))
  else if (rule.type === 'event' || rule.type === 'count') out.push({ name: rule.event, source: rule.source })
  else if (rule.type === 'distinct') out.push({ name: rule.set, source: rule.source })
  return out
}

test('every event in the catalogue is recorded by a call site', () => {
  const frontendSource = walk(srcRoot)
    .filter((file) => !file.includes(`${path.sep}achievements${path.sep}`))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n')
  const backendSource = ['main.py', 'achievements_store.py']
    .map((file) => fs.readFileSync(path.join(backendRoot, file), 'utf8'))
    .join('\n')
  const missing = []
  for (const achievement of ACHIEVEMENTS) {
    for (const { name, source } of ruleNames(achievement.rule)) {
      const pattern = source === 'backend'
        ? new RegExp(`["']${name.replaceAll('.', '\\.')}["']`)
        : new RegExp(`(trackAchievement|raiseAchievementCount)\\(\\s*['"]${name.replaceAll('.', '\\.')}['"]`)
      if (!pattern.test(source === 'backend' ? backendSource : frontendSource)) missing.push(`${achievement.id}: ${name}`)
    }
  }
  assert.deepEqual([...new Set(missing)], [])
})

// ── Rules ─────────────────────────────────────────────────────────────────────

const facts = (overrides = {}) => ({
  unlocked: {}, counters: {}, distinct: {}, durations: {}, lineage: new Set(), ...overrides,
})

test('counts and sets report progress towards their target', () => {
  const noteworthy = ACHIEVEMENTS.find((a) => a.id === 'noteworthy')
  assert.deepEqual(ruleProgress(noteworthy.rule, facts({ counters: { 'notes.written': 3 } })), { value: 3, target: 5 })
  assert.equal(ruleSatisfied(noteworthy.rule, facts({ counters: { 'notes.written': 9 } })), true)
  assert.equal(hasProgressBar(noteworthy.rule), true)

  const inspector = ACHIEVEMENTS.find((a) => a.id === 'transcript_inspector')
  const seen = facts({ distinct: { 'seq.context': new Set(['genomic', 'cds', 'something-else']) } })
  assert.deepEqual(ruleProgress(inspector.rule, seen), { value: 2, target: 4 })
})

test('clade achievements read the lineage of every downloaded genome', () => {
  const catty = ACHIEVEMENTS.find((a) => a.id === 'catty')
  const tree = ACHIEVEMENTS.find((a) => a.id === 'tree_of_life')
  const reptilian = ACHIEVEMENTS.find((a) => a.id === 'reptilian')
  const lineage = new Set([2759, 33208, 40674, 33554, 9681])
  assert.equal(ruleSatisfied(catty.rule, facts({ lineage })), true)
  assert.deepEqual(ruleProgress(tree.rule, facts({ lineage: new Set([2, 2759]) })), { value: 2, target: 3 })
  // Turtles, which the Download view's classifier used to file as fish.
  assert.equal(ruleSatisfied(reptilian.rule, facts({ lineage: new Set([7742, 8459]) })), true)
})

test('meta achievements follow the total', () => {
  const unlocked = Object.fromEntries(ACHIEVEMENTS.slice(0, 5).map((a) => [a.id, { at: 'x' }]))
  assert.ok(newlySatisfied(facts({ unlocked })).includes('achievement_novice'))
})

// ── Tracker ───────────────────────────────────────────────────────────────────

function fakeBackend(store = {}) {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const body = { store: { unlocked: {}, counters: {}, distinct: {}, durations_ms: {}, settings: {}, ...store }, readonly: false, lineage_taxa: [] }
    return { ok: true, json: async () => body }
  }
  return calls
}

test('nothing a tutorial does counts, except the tutorial achievements', async () => {
  tracker.__resetAchievementsForTests()
  fakeBackend()
  await tracker.loadAchievements()
  setTutorialSandboxActive(true)
  try {
    tracker.trackAchievement('browser.flatten')
    tracker.trackAchievement('tutorial.completed', 'getting-started')
  } finally {
    setTutorialSandboxActive(false)
  }
  const { facts: state } = tracker.getAchievementsSnapshot()
  assert.equal(state.unlocked.give_me_some_space_2, undefined)
  assert.ok(state.unlocked.path_of_the_scholar)
  tracker.__resetAchievementsForTests()
})

test('unlocks are silent while the view is off, and announced once it is on', async () => {
  tracker.__resetAchievementsForTests()
  fakeBackend()
  const notices = []
  tracker.subscribeAchievementNotices((ids) => notices.push(ids))
  await tracker.loadAchievements()

  tracker.setAchievementsContext({ viewEnabled: false })
  tracker.trackAchievement('browser.flatten')
  tracker.trackAchievement('theme.toLight')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(notices, [])

  tracker.trackAchievement('achievements.enabled')
  tracker.requestAchievementsReveal()
  tracker.setAchievementsContext({ viewEnabled: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(notices.length, 1)
  assert.deepEqual(new Set(notices[0]), new Set(['give_me_some_space_2', 'night_to_day', 'achievements_unlocked']))

  tracker.setAchievementNotifications(false)
  tracker.trackAchievement('seq.find')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(notices.length, 1)
  tracker.__resetAchievementsForTests()
})

test('things tracked before the store loads are kept and evaluated once it does', async () => {
  tracker.__resetAchievementsForTests()
  fakeBackend({ unlocked: { scribe: { at: '2026-01-01T00:00:00Z' } }, counters: { 'notes.written': 4 } })
  tracker.raiseAchievementCount('notes.written', 5)
  assert.equal(tracker.getAchievementsSnapshot().facts.unlocked.noteworthy, undefined)
  await tracker.loadAchievements()
  const { facts: state } = tracker.getAchievementsSnapshot()
  assert.equal(state.unlocked.scribe.at, '2026-01-01T00:00:00Z')
  assert.ok(state.unlocked.noteworthy)
  tracker.__resetAchievementsForTests()
})

test('once every listener is unlocked a call does no work at all', async () => {
  tracker.__resetAchievementsForTests()
  fakeBackend()
  await tracker.loadAchievements()
  tracker.trackAchievement('browser.flatten')
  const before = tracker.getAchievementsSnapshot()
  tracker.trackAchievement('browser.flatten')
  assert.equal(tracker.getAchievementsSnapshot(), before)
  tracker.__resetAchievementsForTests()
})

test('Control freak keys a control by its stable name, never its label', () => {
  const control = (tag, dataset = {}, extra = {}) => ({ tag, dataset, disabled: false, ...extra })
  const target = (el) => ({ closest: () => el })
  assert.equal(browserControlKey(target(control('button', { tourId: 'browser-flatten' }))), 'browser-flatten')
  assert.equal(browserControlKey(target(control('button', { browserControl: 'browser-flip', tourId: 'x' }))), 'browser-flip')
  assert.equal(browserControlKey(target(control('input', { tourId: 'browser-biotype-lncRNA' }))), 'browser-biotype')
  assert.equal(browserControlKey(target(control('button', {}))), '')
  assert.equal(browserControlKey(target(control('button', { tourId: 'browser-pan' }, { disabled: true }))), '')
  assert.equal(browserControlKey(target(null)), '')
})
