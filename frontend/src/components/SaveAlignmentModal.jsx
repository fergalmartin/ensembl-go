import { useState, useEffect, useCallback } from 'react'
import { getGenomeKey } from '../utils/genomeIdentity'

function speciesItemKey(species) {
  return getGenomeKey(species)
}

function buildDefaultName(result, activeSpeciesByKey) {
  if (!result) return 'alignment'
  const rows = Array.isArray(result.rows) ? result.rows : []
  const firstRow = rows[0]
  const geneId = (firstRow?.query || firstRow?.transcript_id || 'alignment')
    .replace(/[^\w\-]/g, '_')
    .slice(0, 40)
  const count = result.included_count || rows.length || 0
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${geneId}_${count}genomes_${ts}`
}

export default function SaveAlignmentModal({
  open,
  theme = 'dark',
  result,
  activeSpeciesByKey,
  onSave,
  onClose,
}) {
  const isLight = theme === 'light'
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null) // { ok: bool, text: string }

  useEffect(() => {
    if (open) {
      setName(buildDefaultName(result, activeSpeciesByKey))
      setMessage(null)
      setSaving(false)
    }
  }, [open, result, activeSpeciesByKey])

  const rows = Array.isArray(result?.rows) ? result.rows : []

  const handleSave = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setMessage({ ok: false, text: 'Please enter a name.' })
      return
    }
    setSaving(true)
    setMessage(null)
    const res = await onSave({ name: trimmed })
    setSaving(false)
    if (res?.ok) {
      setMessage({ ok: true, text: `Saved as "${res.name}"` })
    } else {
      setMessage({ ok: false, text: res?.error || 'Save failed.' })
    }
  }, [name, onSave])

  if (!open) return null

  const overlayBg = isLight ? 'bg-black/40' : 'bg-black/60'
  const panelBg = isLight ? 'bg-white border border-gray-200 shadow-xl' : 'bg-gray-800 border border-gray-700 shadow-xl'
  const textClass = isLight ? 'text-gray-900' : 'text-gray-100'
  const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const inputClass = isLight
    ? 'bg-white border border-gray-300 text-gray-900 focus:border-blue-500'
    : 'bg-gray-700 border border-gray-600 text-gray-100 focus:border-blue-400'

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${overlayBg}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div className={`${panelBg} rounded-lg w-full max-w-md mx-4 p-5`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className={`text-base font-semibold ${textClass}`}>Save alignment</h2>
          <button
            onClick={onClose}
            className={`${subTextClass} hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none`}
          >
            ×
          </button>
        </div>

        {/* Name input */}
        <label className={`block text-xs font-medium ${subTextClass} mb-1`}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
          className={`w-full text-sm rounded px-3 py-2 mb-4 outline-none ${inputClass}`}
          placeholder="alignment_name"
          disabled={saving || message?.ok}
        />

        {/* Genome pills */}
        {rows.length > 0 && (
          <div className="mb-4">
            <div className={`text-xs font-medium ${subTextClass} mb-1.5`}>
              Genomes ({rows.length})
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
              {rows.map((row) => {
                const key = row.genome_key || row.genome || ''
                const species = activeSpeciesByKey?.get(key)
                const label = species?.common_name || species?.scientific_name || key
                const assembly = species?.assembly_name || species?.assembly || ''
                return (
                  <span
                    key={key}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs whitespace-nowrap
                      ${isLight ? 'bg-blue-100 text-blue-800' : 'bg-blue-900/40 text-blue-300'}`}
                  >
                    {label}
                    {assembly && <span className={`opacity-60`}>{assembly}</span>}
                  </span>
                )
              })}
            </div>
          </div>
        )}

        {/* Status message */}
        {message && (
          <div className={`rounded px-3 py-2 text-xs mb-4 ${
            message.ok
              ? (isLight ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-green-900/30 border border-green-700 text-green-300')
              : (isLight ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-red-900/30 border border-red-700 text-red-300')
          }`}>
            {message.text}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className={`px-4 py-1.5 rounded text-sm transition-colors
              ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
          >
            {message?.ok ? 'Close' : 'Cancel'}
          </button>
          {!message?.ok && (
            <button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="px-4 py-1.5 rounded text-sm font-medium bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-not-allowed text-white transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
