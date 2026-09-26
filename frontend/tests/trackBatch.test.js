import assert from 'node:assert/strict'
import test from 'node:test'

import { applySettingsChange, batchLabel, groupFilesByType, suggestStartIndex } from '../src/utils/trackBatch.js'

test('files are grouped by type in the given order, untyped last', () => {
  const files = [
    { id: 1, type: 'gff' }, { id: 2, type: 'bigwig' }, { id: 3, type: '' }, { id: 4, type: 'bigwig' }, { id: 5, type: 'bed' },
  ]
  const groups = groupFilesByType(files, ['bigwig', 'vcf', 'bed', 'gff'])
  assert.deepEqual(groups.map((g) => [g.type, g.files.map((f) => f.id)]), [['bigwig', [2, 4]], ['bed', [5]], ['gff', [1]], ['', [3]]])
})

test('names follow the pattern: prefix, file name and a number', () => {
  assert.equal(batchLabel({}, 'brain rep1', 0), 'brain rep1')
  assert.equal(batchLabel({ prefix: 'lung', useFileName: false, numbered: true, startIndex: 1 }, 'x', 0), 'lung 1')
  assert.equal(batchLabel({ prefix: 'lung', useFileName: false, numbered: true, startIndex: 6 }, 'x', 4), 'lung 10')
  assert.equal(batchLabel({ prefix: 'lung', useFileName: true, numbered: false }, 'ATAC rep2', 0), 'lung ATAC rep2')
  assert.equal(batchLabel({ prefix: '', useFileName: true, numbered: true, startIndex: 3 }, 'rep', 1), 'rep 4')
  // Everything off still names the track after its file.
  assert.equal(batchLabel({ prefix: ' ', useFileName: false, numbered: false }, 'rep', 0), 'rep')
})

test('numbering carries on from tracks already named with the prefix', () => {
  const existing = ['lung 1', 'lung 2', 'Lung 5', 'lung atac 7', 'lungs 9', 'brain 12', 'lung']
  assert.equal(suggestStartIndex(existing, 'lung'), 8)
  assert.equal(suggestStartIndex(existing, 'brain'), 13)
  assert.equal(suggestStartIndex(existing, 'liver'), 1)
  assert.equal(suggestStartIndex(existing, ''), 1)
  assert.equal(suggestStartIndex(['a.b 2'], 'a.b'), 3) // the prefix is text, not a pattern
})

test('applySettingsChange carries only the changed fields onto a track', () => {
    const before = { display_mode: 'signal', color: '#111111', bigwig: { scale: 'auto', zone_scale: 'file' } }
    const after = { display_mode: 'zoned_heatmap', color: '#111111', bigwig: { scale: 'auto', zone_scale: 'fixed' } }
    const own = { display_mode: 'signal', color: '#ff0000', bigwig: { scale: 'fixed', zone_scale: 'file', max: 40 } }
    assert.deepEqual(applySettingsChange(before, after, own), {
        display_mode: 'zoned_heatmap', color: '#ff0000', bigwig: { scale: 'fixed', zone_scale: 'fixed', max: 40 },
    })
    assert.deepEqual(applySettingsChange(before, before, own), own)
})
