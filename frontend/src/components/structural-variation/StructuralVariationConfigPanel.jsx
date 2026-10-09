import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../../backendRuntime.js'
import { buildSvConfigSummary, svConfigValidationFeedback } from '../../utils/svConfigSummary.js'
import FileBrowserModal from '../FileBrowserModal'

/** Loading makes alignments available; text editing is an explicit secondary action. */
export function StructuralVariationConfigPanel({ theme, catalog, outputDir, activeSpecies, inactiveSpecies, onChanged, onLoaded, onClose }) {
  const isLight = theme === 'light'
  const [selectedPath, setSelectedPath] = useState('')
  const [text, setText] = useState('')
  const [loadedText, setLoadedText] = useState('')
  const [configDocument, setConfigDocument] = useState(null)
  const [missingFiles, setMissingFiles] = useState([])
  const [filesChecked, setFilesChecked] = useState(false)
  const [diagnostics, setDiagnostics] = useState([])
  const [feedback, setFeedback] = useState(null)
  const [operation, setOperation] = useState('')
  const [editing, setEditing] = useState(false)
  const [browserMode, setBrowserMode] = useState('')
  const textareaRef = useRef(null)
  const initialPathRef = useRef((catalog?.configs || []).at(-1)?.path || '')

  const configs = useMemo(() => (Array.isArray(catalog?.configs) ? catalog.configs : []), [catalog])
  const registryPath = String(catalog?.registry_path || '')
  const isDirty = text !== loadedText
  const busy = Boolean(operation)
  const summary = useMemo(() => buildSvConfigSummary(configDocument, {
    missingFiles, filesChecked, catalog, configPath: selectedPath, activeSpecies, inactiveSpecies,
  }), [configDocument, missingFiles, filesChecked, catalog, selectedPath, activeSpecies, inactiveSpecies])

  const panelClass = isLight ? 'border-gray-200 bg-white text-gray-900' : 'border-gray-700 bg-[#0f172a] text-gray-100'
  const mutedClass = isLight ? 'text-gray-600' : 'text-gray-400'
  const buttonClass = `inline-flex h-8 items-center justify-center rounded border px-2.5 text-xs leading-none transition-colors ${
    isLight ? 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100' : 'border-gray-600 bg-slate-800 text-gray-100 hover:bg-slate-700'
  }`
  const selectClass = `h-8 min-w-0 max-w-full rounded border py-0 pl-2 pr-8 text-sm leading-tight ${
    isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-slate-900 text-gray-100'
  }`
  const feedbackClass = feedback?.tone === 'error'
    ? (isLight ? 'border-red-200 bg-red-50 text-red-700' : 'border-red-800 bg-red-950/40 text-red-200')
    : feedback?.tone === 'warning'
      ? (isLight ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-amber-800 bg-amber-950/40 text-amber-200')
      : (isLight ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-sky-800 bg-sky-950/40 text-sky-200')

  const checkText = useCallback(async (value, path) => {
    const res = await fetch(`${API_BASE}/api/sv/config/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: value, base_dir: path ? path.replace(/[^/\\]+$/, '') : '' }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data) throw new Error(data?.detail || `Validation failed (${res.status})`)
    return data
  }, [])

  const load = useCallback(async (path, action = 'Loaded') => {
    setOperation('load')
    setFeedback({ tone: 'info', message: 'Loading alignment configuration…' })
    try {
      const params = new URLSearchParams()
      if (path) params.set('path', path)
      if (outputDir) params.set('output_dir', outputDir)
      const res = await fetch(`${API_BASE}/api/sv/config?${params.toString()}`)
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.detail || `Could not read the configuration (${res.status})`)
      const actualPath = String(data.path || path || '')
      setText(data.text || '')
      setLoadedText(data.text || '')
      setConfigDocument(data.config || null)
      setSelectedPath(actualPath)
      setDiagnostics(data.diagnostics || [])
      setMissingFiles([])
      setFilesChecked(false)
      setEditing(false)
      const result = await checkText(data.text || '', actualPath)
      setDiagnostics(result.diagnostics || [])
      setMissingFiles(result.missing_files || [])
      setFilesChecked(Boolean(result.ok))
      const validationFeedback = svConfigValidationFeedback(result)
      const count = result.alignment_count || 0
      setFeedback(action && result.ok
        ? { tone: validationFeedback.tone, message: `${action} ${count} alignment${count === 1 ? '' : 's'}. ${result.missing_files?.length ? 'Some referenced files are missing; see the summary below.' : 'The alignments are available in the dropdowns above.'}` }
        : validationFeedback)
      return { path: actualPath, action, alignmentCount: count, missingFiles: result.missing_files || [], ok: result.ok }
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not read the configuration.' })
      return null
    } finally {
      setOperation('')
    }
  }, [outputDir, checkText])

  useEffect(() => { load(initialPathRef.current) }, [load])

  const validate = useCallback(async () => {
    setOperation('validate')
    setFeedback({ tone: 'info', message: 'Validating configuration…' })
    try {
      const result = await checkText(text, selectedPath)
      setDiagnostics(result.diagnostics || [])
      if (!isDirty) {
        setMissingFiles(result.missing_files || [])
        setFilesChecked(Boolean(result.ok))
      }
      const nextFeedback = svConfigValidationFeedback(result)
      setFeedback({
        ...nextFeedback,
        message: isDirty && result.ok
          ? `${nextFeedback.message} Save your changes to make them available.`
          : nextFeedback.message,
        checkedAt: Date.now(),
      })
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Validation failed.' })
    } finally {
      setOperation('')
    }
  }, [text, selectedPath, isDirty, checkText])

  const save = useCallback(async (path, attachFile) => {
    const destination = String(path || selectedPath || '')
    if (!destination) {
      setFeedback({ tone: 'error', message: 'Choose where to save first.' })
      return
    }
    setOperation('save')
    setFeedback({ tone: 'info', message: 'Saving configuration…' })
    try {
      const res = await fetch(`${API_BASE}/api/sv/config/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: destination, text, mode: 'replace', attach: Boolean(attachFile) }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.detail || `Save failed (${res.status})`)
      if (!data.ok) {
        setDiagnostics(data.diagnostics || [])
        setFeedback({ tone: 'error', message: 'The configuration has errors, so nothing was written.' })
        return
      }
      await onChanged?.()
      const result = await load(data.path || destination, 'Saved')
      if (result?.ok) onLoaded?.(result)
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Save failed.' })
    } finally {
      setOperation('')
    }
  }, [text, selectedPath, onChanged, onLoaded, load])

  const attach = useCallback(async (path) => {
    setOperation('load')
    setFeedback({ tone: 'info', message: 'Loading alignment configuration…' })
    try {
      const res = await fetch(`${API_BASE}/api/sv/config/attach`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data) throw new Error(data?.detail || `Could not load the configuration (${res.status})`)
      if (!data.ok) {
        setDiagnostics(data.diagnostics || [])
        setFeedback({ tone: 'error', message: 'That configuration has errors, so it was not loaded.' })
        return
      }
      await onChanged?.()
      const result = await load(data.path || path, 'Loaded')
      if (result?.ok) onLoaded?.(result)
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not load the configuration.' })
    } finally {
      setOperation('')
    }
  }, [load, onChanged, onLoaded])

  const detach = useCallback(async (path) => {
    setOperation('detach')
    setFeedback({ tone: 'info', message: 'Stopping use of this configuration…' })
    try {
      const res = await fetch(`${API_BASE}/api/sv/config/detach`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.detail || 'Could not stop using the configuration.')
      await onChanged?.()
      await load('')
      setFeedback({ tone: 'info', message: 'Stopped using that configuration. The file itself is untouched.' })
    } catch (error) {
      setFeedback({ tone: 'error', message: error?.message || 'Could not stop using the configuration.' })
    } finally {
      setOperation('')
    }
  }, [load, onChanged])

  const focusLine = useCallback((line) => {
    setEditing(true)
    // Wait for the explicitly opened editor to mount before focusing the line.
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element || !line) return
      const lines = text.split('\n')
      const offset = lines.slice(0, Math.max(0, line - 1)).reduce((sum, item) => sum + item.length + 1, 0)
      element.focus()
      element.setSelectionRange(offset, offset + (lines[line - 1] || '').length)
      element.scrollTop = Math.max(0, (line - 3) * (element.scrollHeight / Math.max(1, lines.length)))
    })
  }, [text])

  return (
    <section aria-label="Alignment configuration" aria-busy={busy} className={`mt-1 w-full md:col-span-full border ${panelClass}`}>
      <div className={`flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
        <span className="font-semibold">Alignment configuration</span>
        <select aria-label="Alignment configuration file" className={selectClass} value={selectedPath} onChange={(event) => load(event.target.value)} disabled={busy}>
          <option value={registryPath}>This installation{registryPath ? '' : ' (no output directory)'}</option>
          {selectedPath && selectedPath !== registryPath && !configs.some((item) => item.path === selectedPath) && <option value={selectedPath}>{selectedPath}</option>}
          {configs.map((item) => <option key={item.path} value={item.path}>{item.label || item.path}{item.exists ? '' : ' (file missing)'}</option>)}
        </select>
        <button type="button" className={buttonClass} onClick={() => setBrowserMode('load')} disabled={busy}>Load file</button>
        {selectedPath && selectedPath !== registryPath && <button type="button" className={buttonClass} onClick={() => detach(selectedPath)} disabled={busy}>Stop using</button>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} onClick={validate} disabled={busy || !text}>{operation === 'validate' ? 'Validating…' : 'Validate'}</button>
          <button type="button" className={buttonClass} onClick={() => setEditing((prev) => !prev)} disabled={busy}>{editing ? 'Show summary' : 'Edit configuration'}</button>
          {editing && <>
            <button type="button" className={buttonClass} onClick={() => save(selectedPath, false)} disabled={busy || !isDirty}>{isDirty ? 'Save' : 'Saved'}</button>
            <button type="button" className={buttonClass} onClick={() => setBrowserMode('save')} disabled={busy}>Save as</button>
          </>}
          <button type="button" className={buttonClass} onClick={onClose} disabled={busy}>Close summary</button>
        </span>
      </div>

      {feedback && <div role="status" aria-live="polite" aria-atomic="true" className={`m-3 rounded border px-3 py-2 text-sm ${feedbackClass}`}>
        {feedback.message}
        {feedback.checkedAt && <span className="ml-2 text-xs">Checked at {new Date(feedback.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.</span>}
      </div>}
      {diagnostics.length > 0 && <div className="px-3 pb-3 text-xs">
        {diagnostics.map((item, index) => <button key={`${item.pointer}-${index}`} type="button" className={`mt-1 block w-full text-left ${item.severity === 'error' ? (isLight ? 'text-red-600' : 'text-red-300') : (isLight ? 'text-amber-700' : 'text-amber-300')}`} onClick={() => focusLine(item.line)} title={item.pointer ? `at ${item.pointer}` : ''}>
          {item.line ? `Line ${item.line}: ` : ''}{item.message}
        </button>)}
      </div>}

      {!editing && configDocument && <div className="px-3 pb-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Loaded alignments</h3>
          <span className={`text-xs ${mutedClass}`}>{summary.alignmentCount} alignment{summary.alignmentCount === 1 ? '' : 's'} · {summary.genomeCount} genome{summary.genomeCount === 1 ? '' : 's'} · {summary.readyCount} ready to select</span>
        </div>
        <p className={`mb-3 text-sm ${mutedClass}`}>
          You can close this summary and choose an Anchor, a Region, and a Second genome from the dropdowns above. Add a Third genome for a three-genome comparison.
        </p>
        {isDirty && <p className={`mb-3 text-xs ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>You have unsaved edits. This summary shows the currently loaded alignments; save your configuration to apply the changes.</p>}
        {summary.rows.length === 0 ? <p className={`py-2 text-sm ${mutedClass}`}>No alignments in this configuration. Load a file or register an alignment to get started.</p> : <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className={mutedClass}><tr><th className="px-2 py-2">Alignment</th><th className="px-2 py-2">Reference → target</th><th className="px-2 py-2">Tracks</th><th className="px-2 py-2">Availability</th></tr></thead>
            <tbody>{summary.rows.map((row, index) => <tr key={`${row.id}-${index}`} className={`border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
              <td className="px-2 py-2 font-medium">{row.label}</td>
              <td className="px-2 py-2">{row.reference} → {row.target}</td>
              <td className="px-2 py-2">{row.trackCount}</td>
              <td className={`px-2 py-2 ${row.status === 'Ready to select' ? (isLight ? 'text-emerald-700' : 'text-emerald-300') : row.status === 'Missing files' || row.status === 'Download genomes' || row.status === 'Genomes unavailable' ? (isLight ? 'text-amber-700' : 'text-amber-300') : mutedClass}`}>
                {row.status}{row.missingFiles.length > 0 && <div className="mt-1 break-all text-[11px]">Missing: {row.missingFiles.join(', ')}</div>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
        {summary.rows.some((row) => row.status === 'Download genomes' || row.status === 'Genomes unavailable') && <p className={`mt-3 text-xs ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>Some genomes need local data before their alignments can be selected. Use Download or Genome Selector to prepare them.</p>}
      </div>}

      {editing && <>
        <p className={`px-3 pb-2 text-xs ${mutedClass}`}>Use key = value fields with --- between alignments, or JSON. Validate checks your edits; Save applies them.</p>
        <textarea ref={textareaRef} aria-label="Configuration text" className={`h-80 w-full resize-y px-3 py-2 font-mono text-[12px] leading-5 outline-none ${isLight ? 'bg-white text-gray-900' : 'bg-[#0b1220] text-gray-100'}`} spellCheck={false} value={text} onChange={(event) => {
          setText(event.target.value)
          setFeedback(null)
          setDiagnostics([])
        }} />
      </>}

      <FileBrowserModal isOpen={Boolean(browserMode)} onClose={() => setBrowserMode('')} onSelect={(path) => {
        const mode = browserMode
        setBrowserMode('')
        if (mode === 'load') attach(path)
        else save(path, true)
      }} initialPath={outputDir || ''} mode={browserMode === 'save' ? 'save' : 'file'} defaultFileName="sv-alignments.cfg" theme={theme} extensions={['.json', '.cfg']} />
    </section>
  )
}
