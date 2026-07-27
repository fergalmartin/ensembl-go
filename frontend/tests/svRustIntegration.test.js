import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('the standard structural-variation view uses the JavaScript renderer only', async () => {
  const view = await source('src/components/StructuralVariationView.jsx')
  assert.doesNotMatch(view, /RustStructuralVariationView/)
  assert.doesNotMatch(view, /enableRustRenderBar/)
  assert.match(view, /<StructuralVariationThreeGenomeView/)
})

test('the standard configuration and build do not expose or build the experimental renderer', async () => {
  const configuration = await source('src/components/ConfigurationView.jsx')
  const app = await source('src/App.jsx')
  const packageJson = JSON.parse(await source('package.json'))
  assert.doesNotMatch(configuration, /Enable SV Rust render bar/)
  assert.doesNotMatch(app, /enable_sv_rust_render_bar/)
  assert.doesNotMatch(packageJson.scripts.dev, /wasm|rust/i)
  assert.doesNotMatch(packageJson.scripts.build, /wasm|rust/i)
})

test('the worker owns authenticated API requests, stale epochs, snapshots, and disposal', async () => {
  const worker = await source('src/workers/svRustRenderer.worker.js')
  assert.match(worker, /headers\.set\(config\.tokenHeader/)
  assert.match(worker, /isCurrentSvEpoch\(loadEpoch, epoch\)/)
  assert.match(worker, /convertToBlob\(\{ type: 'image\/png' \}\)/)
  assert.match(worker, /case 'dispose'/)
  assert.match(worker, /responseCache\.setLimit\(CACHE_LIMIT_BYTES - sceneBytes\)/)
  assert.match(worker, /publishScene\(nextScene, datasetLabel, 'base',/)
  assert.match(worker, /pendingRequests\.get\(cacheKey\)/)
  assert.match(worker, /fetchJson\('\/api\/sv\/alignments'/)
  assert.match(worker, /query_side: 'reference'/)
  assert.match(worker, /query_side: 'alt'/)
  assert.match(worker, /publishScene\(alignmentScene, datasetLabel, 'alignments'/)
})

test('worker CSP and screenshot rasterization remain available', async () => {
  const csp = await source('index.html')
  const screenshot = await source('src/utils/screenshotExport.js')
  assert.doesNotMatch(csp, /wasm-unsafe-eval/)
  assert.match(csp, /worker-src 'self' blob:/)
  assert.match(screenshot, /data-screenshot-raster-proxy/)
})
