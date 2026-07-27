import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SEQUENCE_TRACK_HEIGHT,
  getGenomeBrowserPanelSizing,
  getAnchoredContentPageScrollDelta,
  getAnchoredContentScrollTop,
  getFeatureRowAnchor,
  getFeatureRowTargetY,
  shouldRenderViewportTranscriptStructures,
} from '../src/components/genomeBrowserViewportLayout.js'

test('sequence track height is fixed', () => {
  assert.equal(SEQUENCE_TRACK_HEIGHT, 36)
})

test('a single non-adaptive browser fills its allocated viewport without sizing from canvas content', () => {
  assert.deepEqual(getGenomeBrowserPanelSizing(1, false), {
    usesContentHeight: false,
    fillsAvailableHeight: true,
    fixedPanelHeight: null,
  })
})

test('multi-browser and adaptive layouts retain their explicit sizing modes', () => {
  assert.equal(getGenomeBrowserPanelSizing(3, false).fixedPanelHeight, 390)
  assert.deepEqual(getGenomeBrowserPanelSizing(1, true), {
    usesContentHeight: true,
    fillsAvailableHeight: false,
    fixedPanelHeight: null,
  })
})

test('gene structures switch as one viewport only after every visible transcript result is ready', () => {
  const common = {
    viewSpan: 400_000,
    detailMaxSpan: 500_000,
    geneIds: ['gene-a', 'gene-b'],
  }

  assert.equal(shouldRenderViewportTranscriptStructures({
    ...common,
    transcriptCache: { 'gene-a': [{}] },
  }), false)

  assert.equal(shouldRenderViewportTranscriptStructures({
    ...common,
    transcriptCache: { 'gene-a': [{}], 'gene-b': [] },
  }), true)
})

test('all genes return to blocks together above the transcript-detail zoom threshold', () => {
  assert.equal(shouldRenderViewportTranscriptStructures({
    viewSpan: 500_001,
    detailMaxSpan: 500_000,
    geneIds: ['gene-a', 'gene-b'],
    transcriptCache: { 'gene-a': [{}], 'gene-b': [{}] },
  }), false)
})

test('the transcript subrow under the pointer is captured semantically', () => {
  assert.deepEqual(getFeatureRowAnchor({
    baseGeneY: 100,
    pointerY: 254,
    rowPitch: 20,
    midOffset: 10,
    transcriptIds: ['tx0', 'tx1', 'tx2', 'tx3', 'tx4', 'tx5', 'tx6', 'tx7'],
  }), {
    rowIndex: 7,
    transcriptId: 'tx7',
    rowOffset: 4,
  })
})

test('a transcript anchor follows the same transcript when row packing changes', () => {
  assert.equal(getFeatureRowTargetY({
    baseGeneY: 36,
    rowPitch: 20,
    midOffset: 10,
    transcriptId: 'tx7',
    fallbackRowIndex: 7,
    rowOffset: 4,
    visibleTranscriptIds: ['tx2', 'tx4', 'tx7'],
  }), 90)
})

test('a disappearing transcript row maps to the collapsed gene row', () => {
  assert.equal(getFeatureRowTargetY({
    baseGeneY: 36,
    rowPitch: 20,
    midOffset: 10,
    transcriptId: 'tx7',
    fallbackRowIndex: 7,
    rowOffset: 4,
    visibleTranscriptIds: [],
  }), 50)
})

test('a collapsed gene maps to the first corresponding row when detail appears', () => {
  assert.equal(getFeatureRowTargetY({
    baseGeneY: 80,
    rowPitch: 20,
    midOffset: 10,
    fallbackRowIndex: 0,
    visibleTranscriptIds: ['canonical', 'alternative'],
  }), 90)
})

test('scroll anchoring keeps the resolved feature row under the pointer', () => {
  assert.equal(getAnchoredContentScrollTop({
    contentY: 400,
    viewportY: 150,
    maxScrollTop: 600,
  }), 250)

  assert.equal(getAnchoredContentPageScrollDelta({
    containerTop: 100,
    contentY: 400,
    clientY: 450,
  }), 50)
})
