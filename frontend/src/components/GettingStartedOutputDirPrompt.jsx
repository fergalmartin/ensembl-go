import { useEffect, useRef, useState } from 'react'

import { API_BASE } from '../backendRuntime'
import FileBrowserModal from './FileBrowserModal'

export const GETTING_STARTED_OUTPUT_DIR_MESSAGE = 'Ensembl Go needs an output directory to download genomes and annotation, write temporary files, convert custom annotation to Ensembl format, save configuration info and run various other tasks. Please set an output directory on the path below to enable full functionality'

/** The one piece of setup the app needs before its data tools can do useful work.
 *
 * Kept separate from ConfigurationView so this remains a small first-run decision rather
 * than embedding the whole configuration screen in a modal. It still uses the same file
 * browser and App-level configuration writer as the full view.
 */
export default function GettingStartedOutputDirPrompt({
  open,
  outputDir = '',
  workingDir = '',
  theme,
  onSave,
  onSkip,
}) {
  const isLight = theme === 'light'
  const [path, setPath] = useState(outputDir)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pathRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setPath(outputDir || '')
    setError('')
  }, [open, outputDir])

  useEffect(() => {
    if (pathRef.current) pathRef.current.scrollLeft = pathRef.current.scrollWidth
  }, [path])

  if (!open) return null

  const closeBrowser = () => {
    setBrowserOpen(false)
  }

  const openBrowser = () => {
    setError('')
    setBrowserOpen(true)
  }

  const savePath = async (candidatePath) => {
    const requestedPath = String(candidatePath || '').trim()
    if (!requestedPath) {
      setError('Choose an output directory or enter its path.')
      return false
    }

    setSaving(true)
    setError('')
    try {
      // The general Configuration view permits free-form paths. At first run it is much
      // kinder to catch a typo now than let the first download fail later.
      const response = await fetch(`${API_BASE}/api/files/list?path=${encodeURIComponent(requestedPath)}`)
      if (!response.ok) throw new Error('Please choose an existing directory, or create a new one.')
      const payload = await response.json()
      if (payload?.requested_path_valid === false) {
        throw new Error('Please choose an existing directory, or create a new one.')
      }
      const resolvedPath = String(payload?.current_path || requestedPath).trim()
      const saved = await onSave?.(resolvedPath)
      if (saved === false) throw new Error('The output directory could not be saved. Please try again.')
      return true
    } catch (caught) {
      setError(String(caught?.message || 'The output directory could not be saved.'))
      return false
    } finally {
      setSaving(false)
    }
  }

  const selectPath = async (selectedPath) => {
    const selectedDirectory = String(selectedPath || '')
    setPath(selectedDirectory)
    setError('')
    closeBrowser()
    await savePath(selectedDirectory)
  }

  const submit = () => savePath(path)

  // `.` is resolved by the backend to Path.home() when no output directory exists.
  // A configured working directory is the only override: Desktop is not a dependable
  // convention on Linux, and it is a poor default place for application data anywhere.
  const initialBrowserPath = path.trim() || workingDir || '.'

  return (
    <>
      <div
        data-getting-started-output-dir="true"
        className="fixed inset-0 z-[180] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      >
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="getting-started-output-dir-title"
          className={`w-full max-w-2xl rounded-2xl border p-6 shadow-2xl ${
            isLight
              ? 'border-gray-200 bg-white text-gray-900'
              : 'border-gray-700 bg-gray-900 text-gray-100'
          }`}
        >
          <h2 id="getting-started-output-dir-title" className="text-xl font-semibold">
            Getting started
          </h2>
          <p className={`mt-3 text-sm leading-relaxed ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
            {GETTING_STARTED_OUTPUT_DIR_MESSAGE}
          </p>

          <label
            htmlFor="getting-started-output-dir-path"
            className={`mt-5 block text-sm font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}
          >
            Output directory
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              ref={pathRef}
              id="getting-started-output-dir-path"
              type="text"
              value={path}
              onChange={(event) => {
                setPath(event.target.value)
                setError('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
              placeholder="/path/to/output/directory"
              autoFocus
              className={`min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm outline-none transition focus:ring-2 ${
                isLight
                  ? 'border-gray-300 bg-white text-gray-900 focus:border-[#0099ff] focus:ring-[#0099ff]/30'
                  : 'border-gray-600 bg-gray-800 text-gray-100 focus:border-blue-500 focus:ring-blue-500/30'
              }`}
            />
            <button
              type="button"
              onClick={openBrowser}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                isLight
                  ? 'border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200'
                  : 'border-gray-600 bg-gray-700 text-gray-200 hover:bg-gray-600'
              }`}
            >
              Browse
            </button>
          </div>

          {error && (
            <p role="alert" className="mt-2 text-sm text-red-500">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onSkip}
              disabled={saving}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              Skip for now
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving || !path.trim()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-500"
            >
              {saving ? 'Saving…' : 'Set output directory'}
            </button>
          </div>
        </section>
      </div>

      <FileBrowserModal
        isOpen={browserOpen}
        onClose={closeBrowser}
        onSelect={selectPath}
        initialPath={initialBrowserPath}
        mode="directory"
        theme={theme}
      />
    </>
  )
}
