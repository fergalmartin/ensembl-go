import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Neighbourhood gene completion cannot run from another view', async () => {
  const app = await source('src/App.jsx')
  const start = app.indexOf('// Auto-populate focus genes for genomes')
  const end = app.indexOf('// Independent cleanup:', start)

  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const effect = app.slice(start, end)
  const viewGuard = effect.indexOf("if (currentView !== 'neighbourhood') return")
  const fanOut = effect.indexOf('const enabledGenomes =')
  assert.notEqual(viewGuard, -1)
  assert.notEqual(fanOut, -1)
  assert.ok(viewGuard < fanOut, 'the view guard must run before cross-genome work starts')
  assert.match(effect, /\}, \[currentView, neighbourhoodGenomes,/)
})
