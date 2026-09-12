import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMotifs, loadMotifs, saveMotifs, moveMotif, motifSearchKey, resolveMotifSpans, motifLegend } from '../src/components/alignment-explorer/motifs.js'
import { paintMotifSpan } from '../src/components/alignment-explorer/paintMotifs.js'
import { emptyWorkspace, validateLayerWorkspace } from '../src/components/alignment-explorer/layers.js'

const motifs = [
  { id: 'a', pattern: 'ATG', kind: 'literal', enabled: true, color: '#3366cc' },
  { id: 'b', pattern: 'TG.', kind: 'regex', enabled: true, color: '#00b692' },
]
test('top motif wins overlaps; reordering and deactivation reveal the lower motif', () => {
  const spans = { a: [[2, 5]], b: [[0, 4], [4, 8]] }
  assert.deepEqual(resolveMotifSpans(motifs, spans), [[0, 2, '#00b692'], [2, 5, '#3366cc'], [5, 8, '#00b692']])
  const reordered = moveMotif(motifs, 'a', 'b')
  assert.deepEqual(resolveMotifSpans(reordered, spans), [[0, 8, '#00b692']])
  assert.deepEqual(resolveMotifSpans([{ ...motifs[0], enabled: false }, motifs[1]], spans), [[0, 8, '#00b692']])
  assert.deepEqual(motifs.map(m => m.id), ['a', 'b'])
})
test('search keys reuse matches after reordering/recolouring, but exclude inactive motifs', () => {
  assert.equal(motifSearchKey(motifs), motifSearchKey([...motifs].reverse().map(m => ({ ...m, color: '#ffffff' }))))
  assert.notEqual(motifSearchKey(motifs), motifSearchKey([{ ...motifs[0], enabled: false }, motifs[1]]))
  assert.equal(motifSearchKey([{ ...motifs[0], pattern: '' }]), '[]')
})
test('motifs round-trip across sessions and corrupt storage falls back safely', () => {
  let value = null
  const storage = { getItem: () => value, setItem: (_, next) => { value = next } }
  const saved = [motifs[1], { ...motifs[0], enabled: false }]
  assert.equal(saveMotifs(saved, storage), true)
  assert.deepEqual(loadMotifs(storage), saved)
  value = '{bad'; assert.deepEqual(loadMotifs(storage), [])
  assert.deepEqual(normalizeMotifs([null, { id: 'a', color: 'bad' }, { id: 'a' }]), [{ ...motifs[0], pattern: '' }])
  assert.equal(saveMotifs(saved, { setItem: () => { throw Error('quota') } }), false)
  assert.equal(validateLayerWorkspace({ ...emptyWorkspace(), colourScheme: 'motif' }, []).colourScheme, 'motif')
  assert.deepEqual(motifLegend(saved).swatches.map(s => s.label), ['1. TG.'])
})
test('highlight spans clip to tiles and cropped fragments while preserving gaps', () => {
  const spans = [[9, 13, 'blue'], [15, 18, 'blue'], [20, 21, 'teal']]
  const calls = [], ctx = { fillRect(...args) { calls.push([this.fillStyle, ...args]) } }
  const paint = (start, end) => paintMotifSpan(ctx, { spans, start, end, x: 100, scale: 2, fragmentStart: 10, y: 30, height: 24 })
  paint(10, 12); paint(12, 20)
  assert.deepEqual(calls, [['blue', 100, 30, 4, 24], ['blue', 104, 30, 2, 24], ['blue', 110, 30, 6, 24]])
})
