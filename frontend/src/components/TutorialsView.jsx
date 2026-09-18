import { useCallback, useEffect, useMemo, useState } from 'react'
import AppButtonIcon from './AppButtonIcon'
import FileBrowserModal from './FileBrowserModal'
import useTutorial from '../hooks/useTutorial'
import { APP_BUTTON_META } from '../appButtonConfig'
import { TUTORIALS, registerRuntimeTutorial } from '../tutorials/index.js'
import { TUTORIAL_BUILDER_ENABLED } from '../tutorials/authoring.js'
import {
  deleteTutorialDraft,
  importTutorialPackage,
  listTutorialDrafts,
  scanTutorialPackage,
  TUTORIAL_DRAFTS_CHANGED_EVENT,
} from '../tutorials/drafts.js'
import { sectionCount, stepCount, tutorialSections, tutorialViewIds } from '../utils/tutorialModel.js'
import { analyseTutorialCompatibility } from '../utils/tutorialDocument.js'
import { OPEN_TUTORIAL_BUILDER_EVENT } from './TutorialBuilderOverlay.jsx'

// The tutorial catalogue. Starting one from here hands control to the overlay, which
// takes over the whole window until the user finishes or leaves.

function AppChip({ viewId, isLight }) {
  const meta = Object.values(APP_BUTTON_META).find((entry) => entry.viewId === viewId)
  if (!meta) return null
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${
        isLight ? 'bg-gray-100 text-gray-700' : 'bg-gray-700/60 text-gray-200'
      }`}
    >
      <AppButtonIcon buttonId={meta.id} isLight={isLight} compact />
      {meta.shortLabel}
    </span>
  )
}

export default function TutorialsView({ theme = 'dark', config = null, onOpenConfiguration = null }) {
  const isLight = theme === 'light'
  const { start, completedIds, isRunning, builderAuthoringEnabled } = useTutorial()
  const [drafts, setDrafts] = useState([])
  const [draftStatus, setDraftStatus] = useState('')
  const [showImportBrowser, setShowImportBrowser] = useState(false)
  const [showAddTutorialMenu, setShowAddTutorialMenu] = useState(false)
  const [pendingImport, setPendingImport] = useState(null)
  const [openStepLists, setOpenStepLists] = useState(() => new Set())

  // A tutorial runs in a scratch directory inside the user's own output directory, so it
  // needs one to exist first. That is no bad thing to insist on: it is the setting the
  // app cannot work without, and the tutorial can then show it rather than ask for it.
  const outputDir = String(config?.output_dir || '').trim()
  const ready = Boolean(outputDir)
  const builderAvailable = Boolean(TUTORIAL_BUILDER_ENABLED && builderAuthoringEnabled && ready)

  const refreshDrafts = useCallback(async () => {
    if (!builderAvailable) return
    try {
      const result = await listTutorialDrafts(outputDir)
      const loaded = (result.drafts || []).map((entry) => entry.tutorial).filter(Boolean)
      loaded.forEach(registerRuntimeTutorial)
      setDrafts(loaded)
    } catch (error) {
      setDraftStatus(error.message)
    }
  }, [builderAvailable, outputDir])

  useEffect(() => {
    if (!builderAvailable) return undefined
    let cancelled = false
    listTutorialDrafts(outputDir)
      .then((result) => {
        if (cancelled) return
        const loaded = (result.drafts || []).map((entry) => entry.tutorial).filter(Boolean)
        loaded.forEach(registerRuntimeTutorial)
        setDrafts(loaded)
      })
      .catch((error) => { if (!cancelled) setDraftStatus(error.message) })
    const changed = (event) => {
      if (!event.detail?.outputDir || event.detail.outputDir === outputDir) refreshDrafts()
    }
    window.addEventListener(TUTORIAL_DRAFTS_CHANGED_EVENT, changed)
    return () => {
      cancelled = true
      window.removeEventListener(TUTORIAL_DRAFTS_CHANGED_EVENT, changed)
    }
  }, [builderAvailable, outputDir, refreshDrafts])

  const catalogueTutorials = useMemo(() => {
    const publishedIds = new Set(TUTORIALS.map((tutorial) => tutorial.id))
    return [
      ...TUTORIALS.map((tutorial) => ({ tutorial, isDraft: false })),
      ...drafts
        .filter((tutorial) => !publishedIds.has(tutorial.id))
        .map((tutorial) => ({ tutorial, isDraft: true })),
    ]
  }, [drafts])

  const openBuilder = (seed = null, editExisting = false) => {
    window.dispatchEvent(new CustomEvent(OPEN_TUTORIAL_BUILDER_EVENT, {
      detail: { seed, editExisting, outputDir, config },
    }))
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl px-6 py-8">
        <h1 className={`text-xl font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
          Tutorials
        </h1>
        <p className={`mt-1.5 max-w-3xl text-sm leading-relaxed ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
          The Tutorials view gives you access to a number of tutorials, with more due to be
          added with time. Each tutorial is broken into sections, with sections broken into
          individual steps. Tutorials are interactive, but an autoplay option is also present
          to automatically complete interactive steps. Each tutorial is a self contained
          environment, often with demo data. Exiting or completing a tutorial will return you
          to your current session and configuration.
          {builderAvailable && ' A tutorial builder is available at the bottom of the list, and existing tutorials can be cloned to subsequently edit within the builder.'}
        </p>

        {draftStatus && <p className={`mt-2 text-xs ${isLight ? 'text-red-700' : 'text-red-300'}`}>{draftStatus}</p>}

        {pendingImport && (
          <div className={`mt-4 rounded-lg border p-4 text-sm ${pendingImport.problems?.length ? (isLight ? 'border-red-200 bg-red-50 text-red-900' : 'border-red-500/30 bg-red-500/10 text-red-100') : (isLight ? 'border-sky-200 bg-sky-50 text-sky-950' : 'border-sky-500/30 bg-sky-500/10 text-sky-100')}`}>
            <div className="font-semibold">Import “{pendingImport.tutorial?.title || 'Tutorial'}”?</div>
            <div className="mt-1 text-xs">{pendingImport.tutorial?.steps?.length || 0} steps · {(pendingImport.packageBytes / 1024).toFixed(1)} KB · {pendingImport.path}</div>
            <div className="mt-1 text-xs opacity-80">
              Author: {pendingImport.tutorial?.author || 'Not supplied'} · Views: {tutorialViewIds(pendingImport.tutorial).join(', ') || 'None'} · Allowed interactions: {(pendingImport.tutorial?.steps || []).reduce((total, step) => total + (step.interactionPolicy?.targets?.length || 0), 0)}
            </div>
            {(pendingImport.tutorial?.datasets || []).length > 0 && <ul className="mt-1 list-disc pl-5 text-xs opacity-80">{pendingImport.tutorial.datasets.map((dataset) => <li key={dataset.id || dataset.recipeId}>{dataset.label || dataset.id} · {dataset.embedded ? 'embedded real data' : 'external recipe'}{dataset.source?.provider ? ` · ${dataset.source.provider}` : ''}</li>)}</ul>}
            {pendingImport.compatibility?.unavailableStepIds?.length > 0 && <p className="mt-2 text-xs text-amber-300">{pendingImport.compatibility.unavailableStepIds.length} step(s) are unavailable in this app and will be skipped during playback.</p>}
            {pendingImport.problems?.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-xs">{pendingImport.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            ) : (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const result = await importTutorialPackage({ outputDir, path: pendingImport.path })
                      registerRuntimeTutorial(result.tutorial)
                      setPendingImport(null)
                      setDraftStatus(`Imported ${result.tutorial.title}.`)
                      await refreshDrafts()
                    } catch (error) { setDraftStatus(error.message) }
                  }}
                  className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
                >
                  Import
                </button>
                <button type="button" onClick={() => setPendingImport(null)} className="rounded-md border border-current/30 px-3 py-1.5 text-xs font-semibold">Cancel</button>
              </div>
            )}
          </div>
        )}

        {!ready && (
          <div
            className={`mt-5 rounded-lg border px-4 py-3 text-sm ${
              isLight ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
            }`}
          >
            <p>
              Set an <strong>output directory</strong> in Configuration before starting a tutorial.
              It is where your genomes and exports are kept, and the tutorial keeps its own
              scratch data inside it — which it removes again when it finishes.
            </p>
            {onOpenConfiguration && (
              <button
                type="button"
                onClick={onOpenConfiguration}
                className={`mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  isLight ? 'bg-amber-600 text-white hover:bg-amber-700' : 'bg-amber-500/80 text-gray-900 hover:bg-amber-400'
                }`}
              >
                Open Configuration
              </button>
            )}
          </div>
        )}

        <div className={`mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2 ${
          // Equal-height rows line the chips, the step count and the estimate up along a
          // shared floor. An expanded step list is half a card taller than its neighbour
          // though, and stretching that neighbour to match strands its footer under a
          // screenful of nothing — so the row goes back to natural heights while any list
          // is open.
          openStepLists.size ? 'items-start' : 'items-stretch'
        }`}>
          {catalogueTutorials.map(({ tutorial, isDraft }) => {
            const done = completedIds.includes(tutorial.id)
            const compatibility = analyseTutorialCompatibility(tutorial)
            const unavailableCount = compatibility.unavailableStepIds.length
            const sections = sectionCount(tutorial)
            return (
              <section
                key={tutorial.id}
                data-tour-id={`tutorial-card-${tutorial.id}`}
                data-tutorial-state={isDraft ? 'draft' : 'published'}
                className={`relative flex min-h-72 flex-col overflow-hidden rounded-xl border p-5 ${
                  isDraft
                    ? (isLight ? 'border-sky-300 bg-sky-50/65 shadow-sm shadow-sky-100' : 'border-sky-500/45 bg-sky-950/25 shadow-sm shadow-sky-950/40')
                    : (isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-800')
                }`}
              >
                {isDraft && <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-sky-500" />}
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                        {tutorial.title}
                      </h2>
                      {done && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            isLight ? 'bg-emerald-50 text-emerald-700' : 'bg-emerald-500/15 text-emerald-300'
                          }`}
                        >
                          Completed
                        </span>
                      )}
                      {isDraft && <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${isLight ? 'bg-sky-100 text-sky-800' : 'bg-sky-500/20 text-sky-200'}`}>Draft tutorial</span>}
                      {unavailableCount > 0 && <span title={compatibility.unavailableStepIds.join(', ')} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${isLight ? 'bg-red-50 text-red-700' : 'bg-red-500/15 text-red-300'}`}>{unavailableCount} unavailable</span>}
                    </div>
                    <p className={`mt-1.5 text-sm leading-relaxed ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                      {tutorial.blurb}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <button
                      type="button"
                      disabled={isRunning || !ready || !compatibility.runnable}
                      title={!compatibility.runnable ? 'No compatible steps are available' : (ready ? '' : 'Set an output directory in Configuration first')}
                      onClick={() => start(tutorial.id, { outputDir })}
                      className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                        isRunning || !ready || !compatibility.runnable
                          ? (isLight ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-gray-700 text-gray-500 cursor-not-allowed')
                          : (isLight ? 'bg-[#0099ff] text-white hover:bg-[#0088e6]' : 'bg-blue-600 text-white hover:bg-blue-500')
                      }`}
                    >
                      {done ? 'Run again' : (unavailableCount ? 'Start available' : 'Start')}
                    </button>
                    {builderAvailable && <button type="button" onClick={() => openBuilder(tutorial, isDraft)} className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${isLight ? 'border-gray-300 text-gray-600 hover:bg-gray-50' : 'border-gray-600 text-gray-300 hover:bg-gray-700'}`}>{isDraft ? 'Edit draft' : 'Clone to draft'}</button>}
                    {builderAvailable && isDraft && <button type="button" onClick={async () => {
                      if (!window.confirm(`Delete the draft “${tutorial.title}”?`)) return
                      try {
                        await deleteTutorialDraft(outputDir, tutorial.id)
                        setDraftStatus(`Deleted ${tutorial.title}.`)
                        await refreshDrafts()
                      } catch (error) { setDraftStatus(error.message) }
                    }} className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${isLight ? 'border-red-200 text-red-700 hover:bg-red-50' : 'border-red-500/30 text-red-300 hover:bg-red-500/10'}`}>Delete draft</button>}
                  </div>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                  {tutorialViewIds(tutorial).map((viewId) => (
                    <AppChip key={viewId} viewId={viewId} isLight={isLight} />
                  ))}
                </div>

                <div className={`mt-3 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                  {sections ? `${sections} section${sections === 1 ? '' : 's'}` : `${stepCount(tutorial)} steps`}
                  {tutorial.estimatedMinutes ? ` · about ${tutorial.estimatedMinutes} minutes` : ''}
                </div>

                <details
                  className={`mt-3 border-t pt-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                  data-tutorial-step-list={tutorial.id}
                  onToggle={(event) => {
                    // Read the state here: React has blanked `currentTarget` by the time
                    // the updater below runs, and a null read takes the whole view down.
                    const isOpen = event.target.open
                    setOpenStepLists((current) => {
                      const next = new Set(current)
                      if (isOpen) next.add(tutorial.id)
                      else next.delete(tutorial.id)
                      return next
                    })
                  }}
                >
                  <summary
                    className={`cursor-pointer select-none text-xs font-semibold ${
                      isLight ? 'text-gray-600 hover:text-gray-900' : 'text-gray-300 hover:text-white'
                    }`}
                  >
                    Browse and jump to steps
                  </summary>
                  <div className={`mt-3 max-h-72 space-y-3 overflow-y-auto rounded-lg border p-1.5 ${
                    isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/35'
                  }`}>
                    {tutorialSections(tutorial).map((group, groupIndex) => (
                      <section
                        key={`${group.title || 'steps'}-${groupIndex}`}
                        data-tutorial-step-section={group.title || undefined}
                      >
                        {group.title && (
                          <h3
                            data-tutorial-section-heading="true"
                            className={`sticky top-0 z-[1] rounded px-2.5 py-1.5 text-xs font-semibold ${
                              isLight ? 'bg-gray-100 text-gray-800' : 'bg-gray-800 text-gray-100'
                            }`}
                          >
                            {group.title}
                          </h3>
                        )}
                        <ol className={`${group.title ? 'mt-1' : ''} space-y-1`}>
                          {group.steps.map(({ step: tutorialStep, stepIndex }) => (
                            <li key={tutorialStep.id}>
                              {(() => {
                                const unavailable = compatibility.unavailableSteps[tutorialStep.id]
                                return (
                              <button
                                type="button"
                                disabled={isRunning || !ready || Boolean(unavailable)}
                                data-tutorial-jump-step={`${tutorial.id}:${tutorialStep.id}`}
                                title={unavailable
                                  ? unavailable.join(' ')
                                  : ready
                                  ? `Start at step ${stepIndex + 1}: ${tutorialStep.title}`
                                  : 'Set an output directory in Configuration first'}
                                onClick={() => start(tutorial.id, { outputDir, stepIndex })}
                                className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors ${
                                  isRunning || !ready || unavailable
                                    ? (isLight ? 'text-gray-400' : 'text-gray-600')
                                    : (isLight
                                      ? 'text-gray-700 hover:bg-white hover:text-gray-950'
                                      : 'text-gray-300 hover:bg-gray-700/70 hover:text-white')
                                }`}
                              >
                                <span className={`w-6 shrink-0 text-right tabular-nums ${
                                  isLight ? 'text-gray-400' : 'text-gray-500'
                                }`}>
                                  {stepIndex + 1}.
                                </span>
                                <span className="font-medium leading-snug">{tutorialStep.title}</span>
                                {unavailable && <span className="ml-auto text-red-400" aria-label="Unavailable step">!</span>}
                              </button>
                                )
                              })()}
                            </li>
                          ))}
                        </ol>
                      </section>
                    ))}
                  </div>
                </details>
              </section>
            )
          })}
          {builderAvailable && (
            <section
              data-tutorial-add-card="true"
              className={`relative flex min-h-72 flex-col items-center justify-center rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
                isLight ? 'border-sky-300/80 bg-sky-50/25 text-gray-700' : 'border-sky-500/40 bg-sky-950/10 text-gray-300'
              }`}
            >
              <button
                type="button"
                aria-label={showAddTutorialMenu ? 'Close add tutorial options' : 'Add a tutorial'}
                aria-expanded={showAddTutorialMenu}
                aria-controls="add-tutorial-options"
                onClick={() => setShowAddTutorialMenu((open) => !open)}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-[#0099ff] text-4xl font-light leading-none text-white shadow-lg shadow-sky-500/25 transition-transform hover:scale-105 hover:bg-[#0088e6] focus:outline-none focus:ring-4 focus:ring-sky-400/30"
              >
                <span aria-hidden="true" className={`transition-transform ${showAddTutorialMenu ? 'rotate-45' : ''}`}>+</span>
              </button>
              <h2 className={`mt-4 text-base font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Add a tutorial</h2>
              {!showAddTutorialMenu ? (
                <p className={`mt-1 max-w-64 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Create a tutorial from scratch or import an existing package.</p>
              ) : (
                <div id="add-tutorial-options" className="mt-4 flex w-full max-w-64 flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddTutorialMenu(false)
                      openBuilder()
                    }}
                    className="rounded-lg bg-[#0099ff] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#0088e6]"
                  >
                    Create new tutorial
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddTutorialMenu(false)
                      setShowImportBrowser(true)
                    }}
                    className={`rounded-lg border px-4 py-2.5 text-sm font-semibold ${isLight ? 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50' : 'border-gray-600 bg-gray-900/70 text-gray-200 hover:bg-gray-800'}`}
                  >
                    Import tutorial
                  </button>
                  <p className={`mt-1 text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-500'}`}>Drafts save automatically in your output directory.</p>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
      <FileBrowserModal
        isOpen={showImportBrowser}
        onClose={() => setShowImportBrowser(false)}
        onSelect={async (path) => {
          setShowImportBrowser(false)
          try {
            const scan = await scanTutorialPackage(path)
            setPendingImport({ ...scan, compatibility: analyseTutorialCompatibility(scan.tutorial) })
          } catch (error) { setDraftStatus(error.message) }
        }}
        initialPath={outputDir}
        mode="file"
        theme={theme}
        extensions={['.egtutorial']}
      />
    </div>
  )
}
