import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  buildSvAuxTrackRenderWindow,
  getSvAuxTrackGeometryWidth,
  getSvAuxTrackMatrix,
  getSvAuxTrackTransform,
} from '../src/utils/svAuxTrackTransform.js'

test('SV auxiliary tracks translate cached geometry during a pan preview', () => {
  const transform = getSvAuxTrackTransform(
    { chrom: '11', start: 100, end: 200 },
    { chrom: '11', start: 125, end: 225 },
    1000,
  )

  assert.deepEqual(transform, {
    scaleX: 1,
    translateX: -250,
    canTransform: true,
    isIdentity: false,
  })
})

test('SV auxiliary tracks scale around the preview window during zoom', () => {
  const zoomIn = getSvAuxTrackTransform(
    { chrom: '11', start: 100, end: 200 },
    { chrom: '11', start: 125, end: 175 },
    1000,
  )
  assert.equal(zoomIn.scaleX, 2)
  assert.equal(zoomIn.translateX, -500)
  assert.equal(getSvAuxTrackMatrix(zoomIn, 38), 'matrix(2 0 0 1 -500 38)')

  const zoomOut = getSvAuxTrackTransform(
    { chrom: '11', start: 100, end: 200 },
    { chrom: '11', start: 50, end: 250 },
    1000,
  )
  assert.equal(zoomOut.scaleX, 0.5)
  assert.equal(zoomOut.translateX, 250)
})

test('SV auxiliary tracks do not reuse geometry across chromosomes', () => {
  const transform = getSvAuxTrackTransform(
    { chrom: '11', start: 100, end: 200 },
    { chrom: '12', start: 100, end: 200 },
    1000,
  )
  assert.equal(transform.canTransform, false)
})

test('SV auxiliary tracks render a two-window halo at the original pixel density', () => {
  const viewWindow = { chrom: '11', start: 100_000, end: 150_000 }
  const renderWindow = buildSvAuxTrackRenderWindow(viewWindow)
  const geometryWidth = getSvAuxTrackGeometryWidth(viewWindow, renderWindow, 1000)

  assert.deepEqual(renderWindow, { chrom: '11', start: 0, end: 250_000 })
  assert.equal(geometryWidth, 5000)
  assert.deepEqual(
    getSvAuxTrackTransform(renderWindow, viewWindow, 1000, geometryWidth),
    { scaleX: 1, translateX: -2000, canTransform: true, isIdentity: false },
  )

  const twoWindowsRight = { chrom: '11', start: 200_000, end: 250_000 }
  assert.deepEqual(
    getSvAuxTrackTransform(renderWindow, twoWindowsRight, 1000, geometryWidth),
    { scaleX: 1, translateX: -4000, canTransform: true, isIdentity: false },
  )
})

test('regular pair and trio views project auxiliary data from committed windows', async () => {
  const source = await readFile(
    new URL('../src/components/StructuralVariationView.jsx', import.meta.url),
    'utf8',
  )

  assert.match(source, /window=\{baseTgtWindow\}\s+displayWindow=\{displayTgtWindow\}/)
  assert.match(source, /window=\{baseTopWindow\}\s+displayWindow=\{displayTopWindow\}/)
  assert.match(source, /window=\{baseBottomWindow\}\s+displayWindow=\{displayBottomWindow\}/)
  assert.equal([...source.matchAll(/window=\{viewRefWindow\}\s+displayWindow=\{displayRefWindow\}/g)].length, 2)
  assert.equal([...source.matchAll(/displayReferenceWindow=\{displayRefWindow\}/g)].length, 3)
  assert.match(source, /const signalPaths = useMemo/)
  assert.match(source, /const referenceIntervalRects = useMemo/)
  assert.match(source, /const targetIntervalRects = useMemo/)
})
