import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REMOVAL_FILL_ALL,
  REMOVAL_FILL_NONE,
  REMOVAL_FILL_SELECTED,
  computeSelectAllChecked,
  flaggedItems,
  formatBytes,
  nextRemovalFlags,
  partitionRemovalTargets,
  registeredRemovalFiles,
  selectableItems,
  toggleRemovalFlag,
} from '../src/utils/genomeRemovalSelection.js'

const item = (assembly, overrides = {}) => ({
  species_key: 'Test_species',
  assembly,
  provider: 'ensembl',
  ...overrides,
})

const keyOf = (assembly) => `ensembl::Test_species::${assembly}`

const rows = [item('A1'), item('A2'), item('A3')]

test('select-all is binary and stays checked for a partial selection', () => {
  assert.equal(computeSelectAllChecked(rows, new Set()), false)
  assert.equal(computeSelectAllChecked(rows, new Set([keyOf('A1')])), true)
  assert.equal(computeSelectAllChecked(rows, new Set(rows.map((row) => keyOf(row.assembly)))), true)
})

test('rows with no local files are ignored by the binary select-all state', () => {
  const withMissing = [...rows, item('A4', { is_missing: true })]

  assert.equal(selectableItems(withMissing).length, 3)
  assert.equal(
    computeSelectAllChecked(withMissing, new Set(rows.map((row) => keyOf(row.assembly)))),
    true,
  )
})

test('an empty list leaves the binary select-all checkbox unchecked', () => {
  assert.equal(computeSelectAllChecked([], new Set()), false)
})

test('the "all" shortcut flags every filtered row', () => {
  const flags = nextRemovalFlags(new Set(), REMOVAL_FILL_ALL, { filteredItems: rows })
  assert.deepEqual([...flags].sort(), [keyOf('A1'), keyOf('A2'), keyOf('A3')].sort())
})

test('the "selected" shortcut flags only the genomes in use', () => {
  const flags = nextRemovalFlags(new Set(), REMOVAL_FILL_SELECTED, {
    filteredItems: rows,
    selectedKeys: new Set([keyOf('A2')]),
  })
  assert.deepEqual([...flags], [keyOf('A2')])
})

test('the "none" shortcut clears everything, including rows off screen', () => {
  const flags = nextRemovalFlags(new Set([keyOf('A9')]), REMOVAL_FILL_NONE, { filteredItems: rows })
  assert.equal(flags.size, 0)
})

test('narrowing the filter does not silently unflag what is off screen', () => {
  const flags = nextRemovalFlags(new Set([keyOf('A9')]), REMOVAL_FILL_ALL, { filteredItems: [rows[0]] })
  assert.ok(flags.has(keyOf('A9')))
  assert.ok(flags.has(keyOf('A1')))
})

test('flagging a row toggles it, and a missing row can never be flagged', () => {
  let flags = toggleRemovalFlag(new Set(), rows[0])
  assert.ok(flags.has(keyOf('A1')))
  flags = toggleRemovalFlag(flags, rows[0])
  assert.equal(flags.size, 0)

  assert.equal(toggleRemovalFlag(new Set(), item('A4', { is_missing: true })).size, 0)
})

test('removal flags are independent of the active selection', () => {
  // The two sets must never be derived from each other: browsing a genome and
  // deleting it are different intentions.
  const selected = new Set([keyOf('A1')])
  const flags = toggleRemovalFlag(new Set(), rows[1])

  assert.ok(selected.has(keyOf('A1')))
  assert.equal(flags.has(keyOf('A1')), false)
  assert.ok(flags.has(keyOf('A2')))
})

test('targets split by what removing them can actually do', () => {
  const targets = [
    item('A1'),
    item('A2', { is_manual: true }),
    item('A3', { is_missing: true }),
  ]
  const { downloaded, manual, missing } = partitionRemovalTargets(targets)

  assert.deepEqual(downloaded.map((row) => row.assembly), ['A1'])
  assert.deepEqual(manual.map((row) => row.assembly), ['A2'])
  assert.deepEqual(missing.map((row) => row.assembly), ['A3'])
})

test('flagged items come back in table order', () => {
  const flags = new Set([keyOf('A3'), keyOf('A1')])
  assert.deepEqual(flaggedItems(rows, flags).map((row) => row.assembly), ['A1', 'A3'])
})

test('sizes read as rough figures', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(12 * 1024 * 1024 * 1024), '12 GB')
})

test('registered downloaded paths are available before a disk preview finishes', () => {
  const files = registeredRemovalFiles([
    item('A1', {
      files: {
        fasta: '/data/a.fa',
        gff3: '/data/a.gff3',
        index: '/data/a.index.db',
      },
    }),
  ])

  assert.deepEqual(files.map((entry) => entry.path), [
    '/data/a.fa',
    '/data/a.gff3',
    '/data/a.index.db',
  ])
})

test('manual source files are excluded from immediate removal candidates', () => {
  const files = registeredRemovalFiles([
    item('A1', {
      is_manual: true,
      files: {
        fasta: '/user/a.fa',
        gff3: '/user/a.gff3',
        index: '/user/a.index.db',
      },
      artifacts: {
        source_annotation: '/user/source.gtf',
        converted_annotation: '/user/a.ensembl.gff3',
      },
    }),
  ])

  assert.deepEqual(files.map((entry) => entry.path), [
    '/user/a.index.db',
    '/user/a.ensembl.gff3',
  ])
})
