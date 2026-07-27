import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const fixtureUrl = (name) => new URL(`./fixtures/sv-renderer/${name}`, import.meta.url)

async function fixture(name) {
  return JSON.parse(await readFile(fixtureUrl(name), 'utf8'))
}

function assertAllTrackCoverage(scene) {
  assert.ok(scene.alignments.length >= 2)
  assert.ok(scene.alignments.some((block) => block.strand === '-' || block.kind === 'inversion'))
  assert.ok(scene.variants.length)
  assert.ok(scene.transcripts.some((transcript) => transcript.exons.length))
  assert.ok(scene.signal_tracks.length)
  assert.ok(scene.interval_tracks.some((track) => track.features.length))
  assert.deepEqual(scene.fixture.zoomThresholdSpans, [...scene.fixture.zoomThresholdSpans].sort((a, b) => b - a))
}

test('pair fixture is deterministic and covers sequence-level light rendering', async () => {
  const scene = await fixture('pair-light.json')
  assert.equal(scene.windows.length, 2)
  assert.equal(scene.theme, 'light')
  assert.equal(scene.compact, false)
  assert.equal(scene.sequences.length, 2)
  assertAllTrackCoverage(scene)
})

test('trio fixture covers compact dark rendering and both alignment panels', async () => {
  const scene = await fixture('trio-dark-compact.json')
  assert.equal(scene.windows.length, 3)
  assert.equal(scene.theme, 'dark')
  assert.equal(scene.compact, true)
  assert.deepEqual(new Set(scene.alignments.map((block) => block.panel)), new Set(['upper', 'lower']))
  assertAllTrackCoverage(scene)
})
