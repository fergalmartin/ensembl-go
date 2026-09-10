import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PREVIEW_GENES,
  PREVIEW_REGION,
  previewGeneLayout,
  previewRegionLabel,
} from '../src/utils/genomeColorPreview.js'

test('the preview shows genes on both strands, stacked around the ruler', () => {
  const layout = previewGeneLayout()
  assert.equal(layout.genes.length, PREVIEW_GENES.length)
  const forward = layout.genes.filter((gene) => gene.strand === 1)
  const reverse = layout.genes.filter((gene) => gene.strand === -1)
  assert.ok(forward.length > 0 && reverse.length > 0)
  for (const gene of forward) assert.ok(gene.centerY < layout.ruler.y, gene.name)
  for (const gene of reverse) assert.ok(gene.centerY > layout.ruler.y, gene.name)
})

test('every gene stays inside the track and its exons stay inside the gene', () => {
  const layout = previewGeneLayout({ width: 260, height: 120 })
  for (const gene of layout.genes) {
    assert.ok(gene.x >= layout.track.left - 0.001, gene.name)
    assert.ok(gene.x + gene.width <= layout.track.right + 0.001, gene.name)
    assert.ok(gene.y >= 0 && gene.y + gene.exonHeight <= layout.height, gene.name)
    for (const exon of gene.exons) {
      assert.ok(exon.x >= gene.x - 0.001 && exon.x + exon.width <= gene.x + gene.width + 0.001, gene.name)
      assert.ok(exon.width > 0, gene.name)
    }
  }
})

test('a wider preview stretches the track rather than moving the genes off it', () => {
  const narrow = previewGeneLayout({ width: 200 })
  const wide = previewGeneLayout({ width: 400 })
  assert.ok(wide.track.width > narrow.track.width)
  assert.equal(wide.genes.length, narrow.genes.length)
  assert.ok(wide.genes[0].width > narrow.genes[0].width)
})

test('a gene with no exons is left out rather than drawn as a bare line', () => {
  const layout = previewGeneLayout({ genes: [{ id: 'empty', name: 'X', strand: 1, row: 0, exons: [] }] })
  assert.deepEqual(layout.genes, [])
})

test('the region reads the way the browser writes one', () => {
  assert.equal(
    previewRegionLabel(PREVIEW_REGION),
    `1:${PREVIEW_REGION.start.toLocaleString()}-${PREVIEW_REGION.end.toLocaleString()}`,
  )
})
