import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FileBrowserModal from './FileBrowserModal'
import { trackAchievement } from '../achievements/tracker.js'
import {
  SCREENSHOT_SCALE_OPTIONS,
  buildDefaultScreenshotName,
  ensureScreenshotFilename,
  normalizeScreenshotFormat,
  normalizeAllowedScreenshotFormats,
  resolveDefaultScreenshotFormat,
} from '../utils/screenshotExport'

function buildInitialFilename(target) {
  if (typeof target?.buildDefaultFilename === 'function') {
    const customName = String(target.buildDefaultFilename() || '').trim()
    if (customName) return customName
  }
  return buildDefaultScreenshotName()
}

export default function ScreenshotExportModal({
  open,
  theme = 'dark',
  target = null,
  outputDir = '',
  onSave,
  onClose,
}) {
  const isLight = theme === 'light'
  const [filename, setFilename] = useState('')
  const [directory, setDirectory] = useState('')
  const [format, setFormat] = useState('svg')
  const [scale, setScale] = useState(2)
  const [quality, setQuality] = useState(92)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)
  const [showDirectoryBrowser, setShowDirectoryBrowser] = useState(false)
  const didSeedOpenRef = useRef(false)
  const autoCloseTimerRef = useRef(null)
  const allowedFormats = useMemo(
    () => normalizeAllowedScreenshotFormats(target?.allowedFormats),
    [target?.allowedFormats]
  )

  const clearAutoCloseTimer = useCallback(() => {
    if (autoCloseTimerRef.current) {
      clearTimeout(autoCloseTimerRef.current)
      autoCloseTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (open) {
      if (didSeedOpenRef.current) return
      didSeedOpenRef.current = true
      setFilename(buildInitialFilename(target))
      setDirectory(String(outputDir || '').trim())
      setFormat(resolveDefaultScreenshotFormat(target))
      setScale(2)
      setQuality(92)
      setSaving(false)
      setMessage(null)
      setShowDirectoryBrowser(false)
      return
    }
    didSeedOpenRef.current = false
    clearAutoCloseTimer()
    setShowDirectoryBrowser(false)
  }, [clearAutoCloseTimer, open, outputDir, target])

  useEffect(() => {
    if (!open) return undefined
    if (!message?.ok) return undefined
    clearAutoCloseTimer()
    const timer = setTimeout(() => {
      autoCloseTimerRef.current = null
      onClose?.()
    }, 2000)
    autoCloseTimerRef.current = timer
    return () => clearTimeout(timer)
  }, [clearAutoCloseTimer, message, onClose, open])

  useEffect(() => () => {
    clearAutoCloseTimer()
  }, [clearAutoCloseTimer])

  const normalizedFormat = useMemo(() => normalizeScreenshotFormat(format), [format])
  const effectiveFormat = allowedFormats.includes(normalizedFormat)
    ? normalizedFormat
    : resolveDefaultScreenshotFormat({ allowedFormats, defaultFormat: target?.defaultFormat })
  const resolvedFilename = useMemo(
    () => ensureScreenshotFilename(filename, effectiveFormat),
    [effectiveFormat, filename]
  )
  const browserInitialPath = useMemo(() => {
    const raw = String(outputDir || '').trim().replace(/\/+$/, '')
    if (!raw) return '.'
    return raw.endsWith('/screenshots') ? (raw.slice(0, -'/screenshots'.length) || raw) : raw
  }, [outputDir])
  const canSave = Boolean(String(outputDir || '').trim()) && Boolean(filename.trim()) && Boolean(directory.trim()) && !saving

  const handleSave = useCallback(async () => {
    if (!canSave) {
      setMessage({ ok: false, text: String(outputDir || '').trim() ? 'Please enter a file name and directory.' : 'Set an Output Directory in Configuration to enable screenshots.' })
      return
    }
    setSaving(true)
    setMessage(null)
    const result = await onSave?.({
      filename: resolvedFilename,
      directory: directory.trim(),
      format: effectiveFormat,
      scale,
      quality,
      target,
    })
    setSaving(false)
    if (result?.ok) {
      trackAchievement('screenshot.taken')
      setMessage({ ok: true, text: `Saved to ${result.path || resolvedFilename}` })
      clearAutoCloseTimer()
      autoCloseTimerRef.current = setTimeout(() => {
        autoCloseTimerRef.current = null
        onClose?.()
      }, 2000)
    } else {
      setMessage({ ok: false, text: result?.error || 'Screenshot export failed.' })
    }
  }, [canSave, clearAutoCloseTimer, directory, effectiveFormat, onClose, onSave, outputDir, quality, resolvedFilename, scale, target])

  if (!open) return null

  const overlayBg = isLight ? 'bg-black/40' : 'bg-black/60'
  const panelBg = isLight ? 'bg-white border border-gray-200 shadow-xl' : 'bg-gray-800 border border-gray-700 shadow-xl'
  const textClass = isLight ? 'text-gray-900' : 'text-gray-100'
  const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const inputClass = isLight
    ? 'bg-white border border-gray-300 text-gray-900 focus:border-blue-500'
    : 'bg-gray-700 border border-gray-600 text-gray-100 focus:border-blue-400'

  return (
    <>
      <div
        className={`fixed inset-0 z-50 flex items-center justify-center ${overlayBg}`}
        onClick={(event) => { if (event.target === event.currentTarget) onClose?.() }}
      >
        <div className={`${panelBg} rounded-lg w-full max-w-lg mx-4 p-5`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className={`text-base font-semibold ${textClass}`}>Export screenshot</h2>
              <p className={`text-xs mt-1 ${subTextClass}`}>
                {target?.label ? `Capture ${target.label}` : 'Capture current view'}
              </p>
            </div>
            <button
              onClick={onClose}
              className={`${subTextClass} hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none`}
            >
              ×
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <label className={`block text-xs font-medium ${subTextClass} mb-1`}>File name</label>
              <input
                type="text"
                value={filename}
                onChange={(event) => setFilename(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') handleSave() }}
                className={`w-full text-sm rounded px-3 py-2 outline-none ${inputClass}`}
                placeholder="ens_screenshot_20260101_120000"
                disabled={saving}
              />
              <div className={`text-[11px] mt-1 ${subTextClass}`}>Final file: {resolvedFilename}</div>
            </div>

            <div>
              <label className={`block text-xs font-medium ${subTextClass} mb-1`}>Destination</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                  className={`flex-1 text-sm rounded px-3 py-2 outline-none ${inputClass}`}
                  disabled={saving || !String(outputDir || '').trim()}
                  placeholder={String(outputDir || '').trim() ? `${outputDir}/screenshots` : 'Set Output Directory in Configuration'}
                />
                <button
                  type="button"
                  onClick={() => setShowDirectoryBrowser(true)}
                  disabled={saving || !String(outputDir || '').trim()}
                  className={`px-3 py-2 rounded text-sm transition-colors ${String(outputDir || '').trim()
                    ? 'bg-[#0099ff] hover:bg-[#0088ee] text-white'
                    : (isLight ? 'bg-gray-100 text-gray-400' : 'bg-gray-700 text-gray-500')}`}
                >
                  Browse
                </button>
              </div>
              {!String(outputDir || '').trim() && (
                <div className={`text-[11px] mt-1 ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
                  Set an Output Directory in Configuration to enable screenshot export.
                </div>
              )}
            </div>

            <div>
              <label className={`block text-xs font-medium ${subTextClass} mb-1`}>Format</label>
              <div className="flex items-center gap-2">
                {allowedFormats.map((candidate) => {
                  const active = effectiveFormat === candidate
                  return (
                    <button
                      key={candidate}
                      type="button"
                      onClick={() => setFormat(candidate)}
                      className="px-3 py-1.5 rounded text-sm font-medium transition-colors"
                      style={{
                        backgroundColor: active ? '#0099ff' : (isLight ? '#f3f4f6' : '#374151'),
                        color: active ? '#ffffff' : (isLight ? '#374151' : '#e5e7eb'),
                      }}
                    >
                      {candidate === 'jpeg' ? 'JPEG' : candidate.toUpperCase()}
                    </button>
                  )
                })}
                <div className="ml-auto" />
                <button
                  onClick={onClose}
                  className={`px-3 py-1.5 rounded text-sm transition-colors ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                >
                  {message?.ok ? 'Close' : 'Cancel'}
                </button>
                {!message?.ok && (
                  <button
                    onClick={handleSave}
                    disabled={!canSave}
                    className="px-3 py-1.5 rounded text-sm font-medium bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-not-allowed text-white transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                )}
              </div>
            </div>

            {effectiveFormat !== 'svg' && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={`block text-xs font-medium ${subTextClass} mb-1`}>Scale</label>
                  <select
                    value={String(scale)}
                    onChange={(event) => setScale(Number(event.target.value) || 1)}
                    className={`w-full text-sm rounded px-3 py-2 outline-none ${inputClass}`}
                    disabled={saving}
                  >
                    {SCREENSHOT_SCALE_OPTIONS.map((value) => (
                      <option key={value} value={String(value)}>{value}x</option>
                    ))}
                  </select>
                </div>

                {effectiveFormat === 'jpeg' && (
                  <div>
                    <label className={`block text-xs font-medium ${subTextClass} mb-1`}>JPEG quality</label>
                    <input
                      type="range"
                      min="70"
                      max="100"
                      step="1"
                      value={quality}
                      onChange={(event) => setQuality(Number(event.target.value) || 92)}
                      className="w-full"
                      disabled={saving}
                    />
                    <div className={`text-[11px] mt-1 ${subTextClass}`}>{quality}</div>
                  </div>
                )}
              </div>
            )}

            {message && (
              <div className={`rounded px-3 py-2 text-xs leading-relaxed break-all whitespace-normal ${message.ok
                ? (isLight ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-green-900/30 border border-green-700 text-green-300')
                : (isLight ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-red-900/30 border border-red-700 text-red-300')}`}
              >
                {message.text}
              </div>
            )}
          </div>
        </div>
      </div>

      <FileBrowserModal
        isOpen={showDirectoryBrowser}
        onClose={() => setShowDirectoryBrowser(false)}
        onSelect={(path) => {
          setDirectory(path)
          setShowDirectoryBrowser(false)
        }}
        initialPath={browserInitialPath}
        mode="directory"
        theme={theme}
      />
    </>
  )
}
