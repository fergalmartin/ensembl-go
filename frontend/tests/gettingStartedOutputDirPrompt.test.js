import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const prompt = readFileSync(
  new URL('../src/components/GettingStartedOutputDirPrompt.jsx', import.meta.url),
  'utf8'
)
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const browser = readFileSync(
  new URL('../src/components/FileBrowserModal.jsx', import.meta.url),
  'utf8'
)

test('first launch without an output directory presents the requested setup prompt', () => {
  assert.match(prompt, />\s*Getting started\s*</)
  assert.match(
    prompt,
    /Ensembl Go needs an output directory to download genomes and annotation, write temporary files, convert custom annotation to Ensembl format, save configuration info and run various other tasks\. Please set an output directory on the path below to enable full functionality/
  )
  assert.match(prompt, /aria-modal="true"/)
  assert.match(prompt, /backdrop-blur-sm/)
})

test('the prompt offers a path, browsing, directory creation and an explicit skip', () => {
  for (const wording of ['Output directory', 'Browse', 'Skip for now', 'Set output directory']) {
    assert.ok(prompt.includes(wording), `missing ${wording}`)
  }
  assert.match(prompt, /api\/files\/list\?path=/, 'typed paths should be checked before saving')
  assert.match(prompt, /requested_path_valid === false/)
  assert.doesNotMatch(prompt, />\s*New [Dd]irectory\s*</, 'directory creation belongs in Browse')
})

test('the Browse menu calls folders directories consistently', () => {
  assert.match(browser, />\s*New Directory\s*</)
  assert.match(browser, /placeholder="Directory name"/)
  assert.doesNotMatch(browser, />\s*New Folder\s*</)
})

test('the browser starts from a configured path or the platform-native home directory', () => {
  assert.match(prompt, /const initialBrowserPath = path\.trim\(\) \|\| workingDir \|\| '\.'/)
  assert.doesNotMatch(prompt, /getDesktopPath|desktopPath/)
})

test('choosing the current Browse directory saves it immediately', () => {
  assert.match(prompt, /const selectPath = async \(selectedPath\)/)
  assert.match(prompt, /await savePath\(selectedDirectory\)/)
})

test('both setup routes show the same output-directory confirmation', () => {
  assert.match(app, /setOutputDirNotification\(outputDir\)/)
  assert.match(app, /data-output-dir-notification="true"/)
  assert.match(app, /Output directory set:/)
  assert.match(app, /\{outputDirNotification\}/)
  assert.match(app, /bg-emerald-500\/90/)
})

test('the launch gate waits for config and can be dismissed for the session', () => {
  assert.match(app, /configLoaded &&[\s\S]*?currentView === 'home'/)
  assert.match(app, /!String\(userConfig\?\.output_dir \|\| ''\)\.trim\(\)/)
  assert.match(app, /!gettingStartedOutputDirDismissed/)
  assert.match(app, /onSkip=\{\(\) => setGettingStartedOutputDirDismissed\(true\)\}/)
})
