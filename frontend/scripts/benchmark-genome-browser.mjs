// Run against an existing Vite dev server. Uses a temporary Chromium profile and
// a synthetic-only page; no installed automation package or user session needed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const executable = process.env.CHROMIUM_PATH
if (!executable) throw new Error('Set CHROMIUM_PATH to a Chrome/Chromium executable.')
const baseUrl = process.env.GENOME_BENCHMARK_URL || 'http://localhost:5173'
const profile = await mkdtemp(join(tmpdir(), 'genome-browser-benchmark-'))
const child = spawn(executable, [
    '--headless=new', '--remote-debugging-port=0', '--window-size=1400,900',
    `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let launchError, stderr = '', socket
child.on('error', (error) => { launchError = error })
child.stderr.on('data', (data) => { stderr += data })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
    let port
    for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw launchError
        try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch { await pause(100) }
    }
    assert.ok(port, `Chromium did not start: ${stderr}`)
    // Google Chrome lists extension and browser-UI targets too; drive the page.
    let tab
    for (let attempt = 0; attempt < 100; attempt++) {
        const targets = await (await fetch(`http://localhost:${port}/json`)).json()
        tab = targets.find((target) => target.type === 'page')
        if (tab) break
        await pause(50)
    }
    assert.ok(tab, 'Chromium did not create a tab')
    socket = new WebSocket(tab.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', reject, { once: true })
    })
    let sequence = 0
    const pending = new Map(), errors = []
    socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data)
        if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 45000)
        pending.set(id, (message) => { clearTimeout(timeout); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result) })
        socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
        assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
        return result.result.value
    }
    await send('Runtime.enable')
    const open = async (query) => {
        errors.length = 0
        await send('Page.navigate', { url: `${baseUrl}/benchmarks/genome-browser.html?${query}` })
        let ready = false
        for (let attempt = 0; attempt < 200; attempt++) {
            if (await evaluate('Boolean(window.fixtureReady?.())')) { ready = true; break }
            await pause(50)
        }
        assert.ok(ready, 'Fixture failed to become ready')
        await pause(1000)
    }
    for (const count of [1, 4, 8, 12]) {
        await open(`n=${count}`)
        // Warm both modes before measuring: cold JIT and transcript arrivals can
        // dominate short measurements and are reported separately by request count.
        await evaluate('window.runBenchmark(false)')
        await evaluate('window.runBenchmark(true)')
        for (const linked of [false, true]) console.log(JSON.stringify(await evaluate(`window.runBenchmark(${linked})`)))
        console.log(`CHECK ${count}: ${await evaluate('window.runChecks()')}`)
        if (count === 12) console.log(`STRESS: ${await evaluate('window.runLinkedStress()')}`)
        assert.deepEqual(errors, [], 'Browser reported runtime errors')
    }
    await open('n=12&instant')
    console.log(`STRESS (immediate responses): ${await evaluate('window.runLinkedStress()')}`)
    assert.deepEqual(errors, [], 'Immediate-response stress fixture reported runtime errors')
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false })
    for (const fallback of [false, true]) {
        await open(`export${fallback ? '&no-observer' : ''}`)
        console.log(`CHECK export${fallback ? ' (no IntersectionObserver)' : ''}: ${await evaluate('window.runExportChecks()')}`)
        assert.deepEqual(errors, [], 'Export fixture reported runtime errors')
    }
} finally {
    socket?.close()
    const stopped = new Promise((resolve) => child.once('exit', resolve))
    if (child.exitCode === null && !launchError) { child.kill(); await stopped }
    await rm(profile, { recursive: true, force: true })
}
