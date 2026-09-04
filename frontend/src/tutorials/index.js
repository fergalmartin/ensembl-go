// Every tutorial the app offers, in the order the Tutorials view lists them.
//
// Adding one means writing the definition beside this file and adding it here. The test
// suite validates whatever this exports, so a new tutorial gets its typos caught
// without anyone writing a test for it. See docs/TUTORIALS.md.

import gettingStarted from './gettingStarted.js'
import browserInDepth from './browserInDepth.js'
import { analyseTutorialCompatibility, materializeTutorialDocument } from '../utils/tutorialDocument.js'
import { GENERATED_TUTORIALS } from './generatedTutorials.js'
import { TUTORIAL_JSON_BUILTINS_ENABLED } from './authoring.js'
import gettingStartedDocument from './documents/getting-started.tutorial.json' with { type: 'json' }
import browserInDepthDocument from './documents/browser-in-depth.tutorial.json' with { type: 'json' }

export const BUILTIN_TUTORIAL_DOCUMENTS = Object.freeze([
  gettingStartedDocument,
  browserInDepthDocument,
])

const builtinSources = TUTORIAL_JSON_BUILTINS_ENABLED
  ? BUILTIN_TUTORIAL_DOCUMENTS
  : [gettingStarted, browserInDepth]

function runtimeShape(source) {
  const materialized = materializeTutorialDocument(source)
  if (source?.format !== 'ensembl-go-tutorial') return materialized
  const { format: _format, schemaVersion: _schemaVersion, ...runtime } = materialized
  return runtime
}

// Playback keeps the established runtime shape. JSON documents cross the normalisation
// boundary here; the old JS objects take the other branch unchanged for rollback.
export const TUTORIALS = Object.freeze([
  ...builtinSources.map(runtimeShape),
  ...GENERATED_TUTORIALS.map(runtimeShape),
])

const runtimeTutorials = new Map()
const runtimeTutorialDocuments = new Map()

function copyDocument(document) {
  return JSON.parse(JSON.stringify(document))
}

export function registerRuntimeTutorial(tutorial) {
  if (tutorial?.format === 'ensembl-go-tutorial') {
    runtimeTutorialDocuments.set(String(tutorial.id || '').trim(), copyDocument(tutorial))
  }
  const base = materializeTutorialDocument(tutorial)
  const report = analyseTutorialCompatibility(tutorial)
  const materialized = {
    ...base,
    compatibility: report,
    steps: (base.steps || []).map((step) => ({
      ...step,
      ...(report.unavailableSteps[String(step.id)]
        ? { compatibilityUnavailable: report.unavailableSteps[String(step.id)] }
        : {}),
    })),
  }
  const id = String(materialized?.id || '').trim()
  if (!id) return null
  runtimeTutorials.set(id, materialized)
  return materialized
}

export function removeRuntimeTutorial(tutorialId) {
  const id = String(tutorialId || '').trim()
  runtimeTutorialDocuments.delete(id)
  return runtimeTutorials.delete(id)
}

export function getRuntimeTutorialDocument(tutorialId) {
  const document = runtimeTutorialDocuments.get(String(tutorialId || '').trim())
  return document ? copyDocument(document) : null
}

export function runtimeTutorialsList() {
  return Array.from(runtimeTutorials.values())
}

export function getTutorial(tutorialId) {
  const id = String(tutorialId || '').trim()
  if (!id) return null
  return runtimeTutorials.get(id) || TUTORIALS.find((tutorial) => tutorial.id === id) || null
}

// Editing a step's wording from the card rewrites this file, and a plain module change
// makes Vite reload the whole page — which ends the tutorial you were reading. Accepting
// the update keeps the session alive; the runtime already applied the edit in memory.
if (import.meta.hot) import.meta.hot.accept()
