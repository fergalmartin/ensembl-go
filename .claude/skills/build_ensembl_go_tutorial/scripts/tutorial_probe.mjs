#!/usr/bin/env node
/**
 * tutorial_probe.mjs — drive an Ensembl Go tutorial in headless Chrome and report what
 * each step actually draws.
 *
 * The unit tests are pure logic and source-reading tripwires; every serious defect in the
 * tutorial stack was found by running the thing. This does the three sweeps that find them:
 *
 *   forward   press Next from step 1 to the end
 *   backward  jump to the last step, then press Back to step 1
 *   jump      start at every step directly, one cold run each
 *
 * and records, per step: the card's box, every drawn ring, whether the step was still
 * preparing or busy, any runtime problem, and how the card overlaps its own highlight.
 * `--mode all` runs the three and diffs forward against backward, which is the check that
 * catches a step whose state depends on how it was reached.
 *
 * Usage:
 *   node tutorial_probe.mjs --document <tutorial.json> [--mode forward|backward|jump|all]
 *        [--url http://localhost:5173] [--port 9333] [--window 1600x1100]
 *        [--chrome <path>] [--out <report.json>] [--attach] [--settle 2500]
 *
 * WARNING: starting a tutorial calls resetTutorialWorkspace, which removes
 * <output_dir>/.ensembl_go_tutorial and reinstalls the tutorial datasets. A builder open in
 * the user's own window needs "Reset scene" afterwards. Say so before running this.
 *
 * Chrome runs as a separate browser instance, so this does not disturb the user's Electron
 * window — but anything written through to the backend is shared.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function parseArgs(argv) {
  const args = { mode: 'all', url: 'http://localhost:5173', port: 9333, window: '1600x1100', settle: 2500 }
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    if (name === 'attach') { args.attach = true; continue }
    args[name] = argv[++i]
  }
  args.port = Number(args.port)
  args.settle = Number(args.settle)
  return args
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} -> ${response.status}`)
  return response.json()
}

async function launchChrome({ chrome, port, window }) {
  const [width, height] = String(window).split('x')
  const profile = mkdtempSync(join(tmpdir(), 'tutorial-probe-'))
  const child = spawn(chrome || CHROME_DEFAULT, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore', detached: false })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return child } catch { await sleep(250) }
  }
  child.kill()
  throw new Error(`Chrome did not open a debugging port on ${port}`)
}

/** A minimal CDP client. Node 24 has a global WebSocket, so there is nothing to install. */
class Session {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static async open(port) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`)
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
    if (!page) throw new Error('No page target to attach to')
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new Session(socket)
  }

  send(method, params = {}) {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() { try { this.socket.close() } catch { /* already gone */ } }
}

/* ------------------------------------------------------------------ page-side helpers */

/** Read everything the overlay is currently drawing. Returned by value, so keep it plain. */
const READ_STATE = `
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const card = document.querySelector('[data-tutorial-card]')
  const rings = [...document.querySelectorAll('[data-tutorial-ring]')].map((el) => ({
    kind: el.getAttribute('data-tutorial-ring'), ...box(el),
  }))
  // The overlay names its own problem. This used to grep the card's paragraphs for
  // "could not", which reported any card whose body happened to contain that phrase as a
  // broken step — a false positive that costs more time than the check saves.
  const problem = document.querySelector('[data-tutorial-problem]')?.getAttribute('data-tutorial-problem') || ''
  return {
    stepId: card?.getAttribute('data-tutorial-card') || '',
    title: document.querySelector('[data-tutorial-step-title]')?.textContent.trim() || '',
    section: document.querySelector('[data-tutorial-section-title]')?.textContent.trim() || '',
    card: box(card),
    busy: card?.hasAttribute('data-tutorial-busy') || false,
    preparing: document.querySelector('[data-tutorial-preparing]')?.getAttribute('data-tutorial-preparing') || '',
    complete: Boolean(document.querySelector('[data-tutorial-overlay="complete"]')),
    running: Boolean(document.querySelector('[data-tutorial-overlay]')),
    rings,
    problem,
  }
`

/** Wait until the step has stopped preparing, then read it. */
function settledState(timeoutMs) {
  return `
    const deadline = Date.now() + ${timeoutMs}
    let state
    for (;;) {
      state = await (async () => { ${READ_STATE} })()
      if (state.stepId && !state.busy && !state.preparing) break
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 120))
    }
    return state
  `
}

const cardButton = (label) => `
  const card = document.querySelector('[data-tutorial-card]')
  if (!card) return { pressed: false, reason: 'no card' }
  const button = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
  if (!button) return { pressed: false, reason: 'no ' + ${JSON.stringify(label)} + ' button' }
  if (button.disabled) return { pressed: false, reason: ${JSON.stringify(label)} + ' is disabled' }
  button.click()
  return { pressed: true }
`

/** Wait for the step to actually change, not merely for a moment to pass.
 *
 *  Pressing Next and sleeping a fixed 600ms is wrong for any step that completes on
 *  something *happening* — an analysis running, an index being built, a genome being
 *  registered. Those steps are not "busy" in the overlay's sense; they are waiting on a
 *  signal, and Next pressed again meanwhile does nothing but confuse the sweep, which then
 *  records the same step several times over and drifts out of step with the document.
 *
 *  So: wait for the id to change, then wait for it to stop preparing, then confirm it has
 *  stayed — the protocol `docs/TUTORIALS.md` sets out. A step that never moves is reported
 *  as such rather than silently mistaken for the next one. */
const waitForStepChange = (fromStepId, timeoutMs) => `
  const deadline = Date.now() + ${timeoutMs}
  let state = null
  for (;;) {
    state = await (async () => { ${READ_STATE} })()
    const moved = state.complete || (state.stepId && state.stepId !== ${JSON.stringify(fromStepId)})
    if (moved && !state.busy && !state.preparing) break
    if (Date.now() > deadline) return { ...state, timedOut: true }
    await new Promise((r) => setTimeout(r, 150))
  }
  // Confirm it has settled rather than catching it mid-transition.
  await new Promise((r) => setTimeout(r, 400))
  state = await (async () => { ${READ_STATE} })()
  return { ...state, timedOut: false }
`

const startAtStep = (tutorialId, stepId) => `
  const appButton = document.querySelector('[data-tour-id="app-button-tutorials"]')
  if (appButton) appButton.click()
  for (let i = 0; i < 40 && !document.querySelector('[data-tutorial-step-list=' + JSON.stringify(${JSON.stringify(tutorialId)}) + ']'); i += 1) {
    await new Promise((r) => setTimeout(r, 100))
  }
  const details = document.querySelector('[data-tutorial-step-list=' + JSON.stringify(${JSON.stringify(tutorialId)}) + ']')
  if (!details) return { started: false, reason: 'no card for ' + ${JSON.stringify(tutorialId)} }
  details.open = true
  await new Promise((r) => setTimeout(r, 150))
  const jump = document.querySelector('[data-tutorial-jump-step=' + JSON.stringify(${JSON.stringify(`${tutorialId}:${stepId}`)}) + ']')
  if (!jump) return { started: false, reason: 'no jump link for ' + ${JSON.stringify(stepId)} }
  if (jump.disabled) return { started: false, reason: 'jump link disabled — is an output directory set?' }
  jump.click()
  return { started: true }
`

const EXIT = `
  const card = document.querySelector('[data-tutorial-card]')
  const button = card && [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Exit')
  if (button) button.click()
  return { exited: Boolean(button) }
`

/* ----------------------------------------------------------------------- measurements */

function overlap(card, ring) {
  if (!card || !ring) return null
  const x = Math.max(0, Math.min(card.x + card.w, ring.x + ring.w) - Math.max(card.x, ring.x))
  const y = Math.max(0, Math.min(card.y + card.h, ring.y + ring.h) - Math.max(card.y, ring.y))
  const area = x * y
  const centre = { x: ring.x + ring.w / 2, y: ring.y + ring.h / 2 }
  const centreCovered = centre.x >= card.x && centre.x <= card.x + card.w
    && centre.y >= card.y && centre.y <= card.y + card.h
  return {
    area,
    fractionOfRing: ring.w * ring.h ? Number((area / (ring.w * ring.h)).toFixed(3)) : 0,
    centreCovered,
  }
}

/** Everything worth complaining about on one step. */
function judge(state, declared) {
  const problems = []
  if (!state.stepId) problems.push('no card rendered')
  if (state.problem) problems.push(`runtime problem: ${state.problem}`)
  if (declared.expectsHighlight && !state.rings.length) problems.push('declares a spotlight but drew no ring')
  if (state.busy) problems.push('still busy when measured')
  if (state.preparing) problems.push('still preparing when measured')
  for (const ring of state.rings) {
    if (!ring.w || !ring.h) problems.push('a ring has no area — target clipped out of view?')
  }
  const worst = state.rings
    .map((ring) => overlap(state.card, ring))
    .filter(Boolean)
    .sort((a, b) => b.area - a.area)[0] || null
  if (worst?.centreCovered) problems.push('the card covers the centre of its own highlight')
  return { problems, overlap: worst }
}

/** The state that must match when a step is reached a second time. */
function fingerprint(record) {
  return JSON.stringify({
    stepId: record.stepId,
    title: record.title,
    section: record.section,
    rings: (record.rings || []).map((ring) => [ring.kind, ring.x, ring.y, ring.w, ring.h]),
    card: record.card,
  })
}

/* ---------------------------------------------------------------------------- sweeps */

async function measure(session, step, settle) {
  const state = await session.evaluate(settledState(settle))
  const declared = { expectsHighlight: Boolean(step?.spotlight || step?.anchor || step?.reveals?.length) }
  return { ...state, declaredStepId: step?.id || '', ...judge(state, declared) }
}

async function sweepForward(session, document_, args) {
  const records = []
  const first = document_.steps[0]
  const started = await session.evaluate(startAtStep(document_.id, first.id))
  if (!started.started) throw new Error(`Could not start ${document_.id}: ${started.reason}`)
  for (const step of document_.steps) {
    const record = await measure(session, step, args.settle)
    records.push(record)
    if (step !== document_.steps.at(-1)) {
      const pressed = await session.evaluate(cardButton('Next'))
      if (!pressed.pressed) { record.problems.push(`Next: ${pressed.reason}`); break }
      const moved = await session.evaluate(waitForStepChange(record.stepId, args.settle))
      if (moved.timedOut) {
        record.problems.push(`Next did not advance from ${record.stepId} within ${args.settle}ms`)
        break
      }
    }
  }
  await session.evaluate(EXIT)
  await sleep(400)
  return records
}

async function sweepBackward(session, document_, args) {
  const records = []
  const last = document_.steps.at(-1)
  const started = await session.evaluate(startAtStep(document_.id, last.id))
  if (!started.started) throw new Error(`Could not start ${document_.id}: ${started.reason}`)
  for (const step of [...document_.steps].reverse()) {
    const record = await measure(session, step, args.settle)
    records.push(record)
    if (step !== document_.steps[0]) {
      const pressed = await session.evaluate(cardButton('Back'))
      if (!pressed.pressed) { record.problems.push(`Back: ${pressed.reason}`); break }
      const moved = await session.evaluate(waitForStepChange(record.stepId, args.settle))
      if (moved.timedOut) {
        record.problems.push(`Back did not return from ${record.stepId} within ${args.settle}ms`)
        break
      }
    }
  }
  await session.evaluate(EXIT)
  await sleep(400)
  return records.reverse()
}

async function sweepJump(session, document_, args) {
  const records = []
  for (const step of document_.steps) {
    const started = await session.evaluate(startAtStep(document_.id, step.id))
    if (!started.started) {
      records.push({ declaredStepId: step.id, problems: [`could not jump in: ${started.reason}`], rings: [] })
      continue
    }
    records.push(await measure(session, step, args.settle))
    await session.evaluate(EXIT)
    await sleep(500)
  }
  return records
}

/* ---------------------------------------------------------------------------- report */

function report(name, records) {
  const lines = [`\n## ${name} — ${records.length} steps`]
  let bad = 0
  for (const [index, record] of records.entries()) {
    const id = record.declaredStepId || record.stepId || '?'
    if (record.problems?.length) {
      bad += 1
      lines.push(`  ${String(index + 1).padStart(3)}. ${id}: ${record.problems.join('; ')}`)
    }
    if (record.overlap?.area && !record.overlap.centreCovered && record.overlap.fractionOfRing > 0.25) {
      lines.push(`  ${String(index + 1).padStart(3)}. ${id}: card covers ${Math.round(record.overlap.fractionOfRing * 100)}% of its highlight`)
    }
  }
  lines.push(bad ? `  ${bad} step(s) with problems.` : '  clean.')
  return lines.join('\n')
}

function diffSweeps(forward, backward) {
  const lines = ['\n## forward vs backward']
  const byId = new Map(backward.map((record) => [record.declaredStepId, record]))
  let differing = 0
  for (const record of forward) {
    const other = byId.get(record.declaredStepId)
    if (!other) { lines.push(`  ${record.declaredStepId}: not reached going backwards`); differing += 1; continue }
    if (fingerprint(record) !== fingerprint(other)) {
      differing += 1
      lines.push(`  ${record.declaredStepId}: differs when reached with Back`)
      lines.push(`      forward:  ${fingerprint(record)}`)
      lines.push(`      backward: ${fingerprint(other)}`)
    }
  }
  lines.push(differing ? `  ${differing} step(s) differ.` : '  every step looks the same in both directions.')
  return lines.join('\n')
}

/* ------------------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv)
  if (!args.document) {
    console.error('--document <tutorial.json> is required')
    process.exit(2)
  }
  const document_ = JSON.parse(readFileSync(args.document, 'utf8'))
  if (args['tutorial-id']) document_.id = args['tutorial-id']
  if (!Array.isArray(document_.steps) || !document_.steps.length) {
    console.error('That document has no steps.')
    process.exit(2)
  }

  let chrome = null
  if (!args.attach) chrome = await launchChrome(args)
  const session = await Session.open(args.port)
  try {
    await session.send('Page.enable')
    await session.send('Runtime.enable')
    // A page that is not being painted never delivers an animation frame, and arrivals
    // wait for one — a backgrounded window shows nothing but "getting ready".
    await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
    await session.send('Page.navigate', { url: args.url })
    await sleep(4000)

    const results = {}
    const wanted = args.mode === 'all' ? ['forward', 'backward', 'jump'] : [args.mode]
    for (const mode of wanted) {
      if (mode === 'forward') results.forward = await sweepForward(session, document_, args)
      if (mode === 'backward') results.backward = await sweepBackward(session, document_, args)
      if (mode === 'jump') results.jump = await sweepJump(session, document_, args)
    }

    let out = `# ${document_.title || document_.id} — ${document_.steps.length} steps`
    for (const [name, records] of Object.entries(results)) out += report(name, records)
    if (results.forward && results.backward) out += diffSweeps(results.forward, results.backward)
    console.log(out)
    if (args.out) {
      writeFileSync(args.out, JSON.stringify({ tutorial: document_.id, results }, null, 2))
      console.log(`\nFull measurements written to ${args.out}`)
    }
    const anyProblem = Object.values(results).some((records) => records.some((r) => r.problems?.length))
    process.exitCode = anyProblem ? 1 : 0
  } finally {
    session.close()
    if (chrome) chrome.kill()
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
