import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const view = readFileSync(new URL('../src/components/TutorialsView.jsx', import.meta.url), 'utf8')
const provider = readFileSync(new URL('../src/hooks/useTutorial.jsx', import.meta.url), 'utf8')

test('tutorial cards expose their step titles and can start directly at one', () => {
  assert.match(view, /data-tutorial-step-list=\{tutorial\.id\}/)
  assert.match(view, /tutorialSections\(tutorial\)\.map\(\(group, groupIndex\)/)
  assert.match(view, /data-tutorial-section-heading="true"/)
  assert.match(view, /group\.steps\.map\(\(\{ step: tutorialStep, stepIndex \}\)/)
  assert.match(view, /\{tutorialStep\.title\}/)
  assert.match(view, /start\(tutorial\.id, \{ outputDir, stepIndex \}\)/)
  assert.match(provider, /initTutorialState\(next, \{ startedAt: Date\.now\(\), stepIndex \}\)/)
})

test('collapsed tutorial cards share a stable catalogue height', () => {
  assert.match(view, /flex min-h-72 flex-col overflow-hidden rounded-xl border p-5/)
  assert.match(view, /className=\{`mt-auto border-t pt-3/)
})

test('published tutorials precede visually distinct drafts and the add card comes last', () => {
  assert.match(view, /TUTORIALS\.map\(\(tutorial\) => \(\{ tutorial, isDraft: false \}\)\)/)
  assert.match(view, /\.map\(\(tutorial\) => \(\{ tutorial, isDraft: true \}\)\)/)
  assert.match(view, /data-tutorial-state=\{isDraft \? 'draft' : 'published'\}/)
  assert.match(view, /Draft tutorial/)
  assert.ok(view.indexOf('catalogueTutorials.map') < view.indexOf('data-tutorial-add-card="true"'))
})

test('the ghost tutorial card opens create and import choices from its plus button', () => {
  assert.match(view, /aria-label=\{showAddTutorialMenu \? 'Close add tutorial options' : 'Add a tutorial'\}/)
  assert.match(view, /Create new tutorial/)
  assert.match(view, /Import tutorial/)
  assert.match(view, /setShowImportBrowser\(true\)/)
})
