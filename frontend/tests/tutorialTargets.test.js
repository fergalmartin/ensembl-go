import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  TUTORIAL_TARGETS,
  TUTORIAL_TARGET_VIEWS,
  targetRef,
  targetRefFromAnchor,
  targetRefSelector,
  validateTargetRef,
} from '../src/tutorialTargets/index.js'
import { BUILTIN_TUTORIAL_DOCUMENTS, TUTORIALS } from '../src/tutorials/index.js'
import gettingStartedLegacy from '../src/tutorials/gettingStarted.js'
import browserInDepthLegacy from '../src/tutorials/browserInDepth.js'
import { analyseTutorialCompatibility, legacyTutorialToDocument } from '../src/utils/tutorialDocument.js'

test('the target catalogue has unique stable ids and complete contracts', () => {
  const ids = TUTORIAL_TARGETS.map((target) => target.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(
    TUTORIAL_TARGET_VIEWS.filter((view) => view.viewId !== 'app').map((view) => view.viewId),
    ['configuration', 'download', 'genome_selector', 'genome_browser'],
  )
  for (const target of TUTORIAL_TARGETS) {
    assert.match(target.id, /^[a-z][A-Za-z0-9.]+$/)
    assert.ok(target.label)
    assert.ok(target.kind)
    assert.equal(target.contractVersion, 1)
    assert.ok(['read', 'sandbox-write'].includes(target.safety))
    assert.ok(target.capabilities.includes('spotlight'))
    assert.ok(target.anchor || target.anchorTemplate || target.selector || target.selectorTemplate)
  }
})

test('every advertised target has a binding in an application component', () => {
  const roots = [
    new URL('../src/App.jsx', import.meta.url),
    new URL('../src/components/', import.meta.url),
  ]
  const files = []
  const visit = (url) => {
    const location = url instanceof URL ? url : new URL(`file://${url}`)
    const filename = location.pathname
    const stat = fs.statSync(filename)
    if (stat.isFile()) {
      files.push(filename)
      return
    }
    for (const entry of fs.readdirSync(filename, { withFileTypes: true })) {
      const child = path.join(filename, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (/\.[jt]sx?$/.test(entry.name)) files.push(child)
    }
  }
  roots.forEach(visit)
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  for (const target of TUTORIAL_TARGETS) {
    const binding = target.anchor || target.anchorTemplate || target.selector || target.selectorTemplate
    const stableFragment = binding
      .replace(/\{[^}]+\}/g, '')
      .replace(/^\[/, '')
      .replace(/[=\]"\\]/g, '')
      .replace(/true$/, '')
    assert.ok(source.includes(binding) || source.includes(stableFragment), `${target.id} has no component binding`)
  }
})

test('parameterised targets round-trip through legacy anchors without leaking selectors', () => {
  const ref = targetRef('focus.sequenceType', { featureType: 'protein' })
  assert.deepEqual(validateTargetRef(ref), [])
  assert.equal(targetRefSelector(ref), '[data-tour-id="focus-sequence-protein"]')
  assert.deepEqual(targetRefFromAnchor('focus-sequence-protein'), ref)
  assert.ok(validateTargetRef(targetRef('focus.sequenceType', { featureType: 'made-up' })).length)

  const playlistRef = targetRef('selector.addToPlaylist', {
    genomeKey: 'ensembl::Homo_sapiens::GCA_000001405.29',
  })
  assert.deepEqual(validateTargetRef(playlistRef), [])
  assert.deepEqual(
    targetRefFromAnchor('selector-playlist-ensembl::Homo_sapiens::GCA_000001405.29'),
    playlistRef,
  )
})

test('the application shell exposes the complete selected-genomes strip', () => {
  const ref = targetRef('app.genomePills')
  assert.deepEqual(validateTargetRef(ref), [])
  assert.equal(targetRefSelector(ref), '[data-tour-id="app-genome-pills"]')
  assert.deepEqual(targetRefFromAnchor('app-genome-pills'), ref)
})

test('both built-in tutorials are fully described by the compatibility catalogue', () => {
  for (const tutorial of TUTORIALS) {
    const report = analyseTutorialCompatibility(tutorial)
    assert.deepEqual(report.fatal, [], tutorial.id)
    assert.deepEqual(report.unavailableStepIds, [], tutorial.id)
    assert.equal(report.runnableStepCount, tutorial.steps.length)
  }
})

test('the JSON built-ins stay equivalent to their rollback source definitions', () => {
  const legacy = [gettingStartedLegacy, browserInDepthLegacy]
  BUILTIN_TUTORIAL_DOCUMENTS.forEach((document, index) => {
    assert.deepEqual(legacyTutorialToDocument(legacy[index], {
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }), document)
  })
})
