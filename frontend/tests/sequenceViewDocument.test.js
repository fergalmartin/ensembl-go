import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HEADER_ROWS,
  buildDocument,
  documentRow,
  documentRowsForRange,
  rowOfRecord,
  sectionAtRow,
  sectionForCoord,
} from '../src/utils/sequenceViewDocument.js'
import { buildDisplayLayout } from '../src/utils/sequenceViewDisplay.js'

const layoutOf = (start, end) => buildDisplayLayout({ region: { start, end } })

// Three records of 10, 5 and 2 rows.
const RECORDS = [
  { key: 'a', record: { label: 'BRCA1' }, layout: layoutOf(1, 600) },
  { key: 'b', record: { label: 'TP53' }, layout: layoutOf(1001, 1300) },
  { key: 'c', record: { label: 'exon 1' }, layout: layoutOf(5001, 5120) },
]

test('a plain region is one section with no name above it', () => {
  const doc = buildDocument([{ key: 'region', record: null, layout: layoutOf(1, 600) }])
  assert.equal(doc.sections.length, 1)
  assert.equal(doc.sections[0].headerRow, null)
  assert.equal(doc.sections[0].firstRow, 0)
  assert.equal(doc.totalRows, 10)
  assert.equal(doc.named, false)
})

test('records are stacked, each costing a row for its name', () => {
  const doc = buildDocument(RECORDS)
  assert.equal(doc.named, true)
  assert.deepEqual(doc.sections.map((s) => [s.headerRow, s.firstRow, s.rows]), [
    [0, 1, 10],
    [11, 12, 5],
    [17, 18, 2],
  ])
  assert.equal(doc.totalRows, (HEADER_ROWS + 10) + (HEADER_ROWS + 5) + (HEADER_ROWS + 2))
})

test('a row is either a name or a row of that record’s own sequence', () => {
  const doc = buildDocument(RECORDS)
  const header = documentRow(doc, 0)
  assert.equal(header.kind, 'header')
  assert.equal(header.section.record.label, 'BRCA1')

  const first = documentRow(doc, 1)
  assert.equal(first.kind, 'sequence')
  assert.equal(first.local, 0, 'the first row of that record, not of the document')

  const last = documentRow(doc, 10)
  assert.equal(last.local, 9)

  // Straight over the join into the next record.
  assert.equal(documentRow(doc, 11).kind, 'header')
  assert.equal(documentRow(doc, 11).section.record.label, 'TP53')
  assert.equal(documentRow(doc, 12).local, 0)
})

test('every row of the document resolves, and none resolves twice', () => {
  const doc = buildDocument(RECORDS)
  const seen = new Set()
  for (let row = 0; row < doc.totalRows; row += 1) {
    const entry = documentRow(doc, row)
    assert.ok(entry, `row ${row} resolves to nothing`)
    const id = `${entry.section.key}:${entry.kind}:${entry.local ?? 'h'}`
    assert.ok(!seen.has(id), `${id} drawn twice`)
    seen.add(id)
  }
  assert.equal(seen.size, doc.totalRows)
})

test('rows outside the document resolve to nothing', () => {
  const doc = buildDocument(RECORDS)
  assert.equal(documentRow(doc, -1), null)
  assert.equal(documentRow(doc, doc.totalRows), null)
  assert.equal(sectionAtRow(doc, doc.totalRows), null)
  assert.equal(documentRow(null, 0), null)
})

test('a record whose layout is not ready yet claims no rows', () => {
  // Left out rather than guessed at: a document that claimed rows it could not
  // draw would leave the scroller pointing at nothing.
  const doc = buildDocument([
    { key: 'a', record: { label: 'BRCA1' }, layout: layoutOf(1, 600) },
    { key: 'b', record: { label: 'waiting' }, layout: null },
  ])
  assert.equal(doc.sections.length, 1)
  assert.equal(doc.totalRows, 11)
})

test('an empty collection is an empty document rather than a broken one', () => {
  const doc = buildDocument([])
  assert.equal(doc.totalRows, 0)
  assert.equal(doc.sections.length, 0)
  assert.equal(documentRow(doc, 0), null)
  assert.deepEqual(documentRowsForRange(doc, 0, 10), [])
})

test('a run of rows crosses the joins between records', () => {
  const doc = buildDocument(RECORDS)
  const rows = documentRowsForRange(doc, 9, 5)
  assert.deepEqual(rows.map((r) => `${r.section.key}/${r.kind}`), [
    'a/sequence', 'a/sequence', 'b/header', 'b/sequence', 'b/sequence',
  ])
})

test('a run asked for past the end stops at the end', () => {
  const doc = buildDocument(RECORDS)
  assert.equal(documentRowsForRange(doc, doc.totalRows - 2, 50).length, 2)
})

test('a record can be found by name, to be scrolled to', () => {
  const doc = buildDocument(RECORDS)
  assert.equal(rowOfRecord(doc, 'a'), 0)
  assert.equal(rowOfRecord(doc, 'b'), 11)
  assert.equal(rowOfRecord(doc, 'nothing'), null)
})

test('a coordinate finds the record that holds it', () => {
  const doc = buildDocument(RECORDS)
  assert.equal(sectionForCoord(doc, 300).key, 'a')
  assert.equal(sectionForCoord(doc, 1100).key, 'b')
  assert.equal(sectionForCoord(doc, 900), null, 'between two records')
})

test('overlapping records answer with the one drawn first', () => {
  // Two picked genes can share sequence, and the reader is looking at whichever
  // came first in the list.
  const doc = buildDocument([
    { key: 'first', record: { label: 'A' }, layout: layoutOf(1, 600) },
    { key: 'second', record: { label: 'B' }, layout: layoutOf(400, 900) },
  ])
  assert.equal(sectionForCoord(doc, 500).key, 'first')
  assert.equal(sectionForCoord(doc, 700).key, 'second')
})
