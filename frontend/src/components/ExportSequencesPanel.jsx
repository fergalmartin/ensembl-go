import { useState, useMemo, useCallback, useEffect } from 'react'
import FileBrowserModal from './FileBrowserModal'

import { API_BASE } from '../backendRuntime'
import { mergeTranscriptFeatureAvailability } from '../utils/transcriptSequenceFeatures'

// radio inputs are forced to w-4 (16px); gap-2 = 8px → text starts at 24px = ml-6
const RADIO_INDENT = 'ml-6'

const FEATURE_OPTIONS = [
  { key: 'genomic',    label: 'Genomic',     slug: 'genomic' },
  { key: 'transcript', label: 'Transcript',  slug: 'transcript' },
  { key: 'cds',        label: 'CDS',         slug: 'cds' },
  { key: 'exons',      label: 'Exons',       slug: 'exons' },
  { key: 'utr5',       label: "5\u2019 UTR", slug: '5primeutr' },
  { key: 'utr3',       label: "3\u2019 UTR", slug: '3primeutr' },
  { key: 'introns',    label: 'Introns',     slug: 'introns' },
]

const HEADER_FIELD_OPTIONS = [
  { key: 'canonical_status', label: 'Canonical / MANE status', defaultOn: true  },
  { key: 'location',         label: 'Genomic location',        defaultOn: true  },
  { key: 'strand',           label: 'Strand',                  defaultOn: true  },
  { key: 'length',           label: 'Feature length (bp)',     defaultOn: true  },
  { key: 'exon_number',      label: 'Exon / intron number',   defaultOn: false },
  { key: 'biotype',          label: 'Biotype',                 defaultOn: false },
]

const OUTPUT_STRUCTURE_OPTIONS = [
  {
    value: 'single',
    label: 'One file for selected sequence features across all selected transcript IDs',
  },
  {
    value: 'per_transcript',
    label: 'One file per transcript ID for all selected sequence features',
  },
  {
    value: 'per_feature',
    label: 'One file per transcript ID \u2013 feature type pair',
  },
]

function featureSlug(key) {
  return FEATURE_OPTIONS.find((f) => f.key === key)?.slug || key
}

function makeTimestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

// The drawer's sequence viewer greys out the same options from the same rules,
// so the availability logic lives in one place. Exports offer a feature if any
// selected transcript can produce records for it.
function computeFeatureAvailability(txList) {
  return mergeTranscriptFeatureAvailability(txList)
}

function buildSuggestedFilename(geneId, selectedKeys, compress) {
  const slug = selectedKeys.length === 1
    ? featureSlug(selectedKeys[0])
    : selectedKeys.length === 0
      ? 'no_features'
      : 'mixed_features'
  const base = `${geneId || 'export'}_${slug}_${makeTimestamp()}.fa`
  return compress ? `${base}.gz` : base
}

// Returns up to MAX_PREVIEW filenames to show in the preview grid
function buildFilePreview(scopedTranscripts, selectedKeys, outputStructure, compress) {
  const MAX_PREVIEW = 9
  const ext  = compress ? '.fa.gz' : '.fa'
  const slug = selectedKeys.length === 1 ? featureSlug(selectedKeys[0]) : 'mixed_features'

  if (outputStructure === 'per_transcript') {
    return scopedTranscripts.slice(0, MAX_PREVIEW).map((tx) => `${tx.id}_${slug}${ext}`)
  }
  if (outputStructure === 'per_feature') {
    if (scopedTranscripts.length === 0 || selectedKeys.length === 0) return []
    const result = []
    outer: for (const tx of scopedTranscripts) {
      for (const k of selectedKeys) {
        result.push(`${tx.id}_${featureSlug(k)}${ext}`)
        if (result.length >= MAX_PREVIEW) break outer
      }
    }
    return result
  }
  return []
}

export default function ExportSequencesPanel({
  theme = 'dark',
  sequenceGenome = 'reference',
  resolvedGene = null,
  orderedTranscripts = [],
  activeTranscriptIds = new Set(),
  config = {},
  externalSeedSequence = null,
  onClearExternalSeedSequence = null,
}) {
  const isLight = theme === 'light'
  const [collapsed, setCollapsed] = useState(false)

  const defaultOutputDir = useMemo(() => {
    const base = String(config?.output_dir || '')
    return base ? `${base.replace(/\/$/, '')}/exported_data` : ''
  }, [config?.output_dir])

  const [transcriptScope,  setTranscriptScope]  = useState('active')
  const [featureSelection, setFeatureSelection] = useState({
    genomic: false, transcript: true, cds: false,
    exons: false, utr5: false, utr3: false, introns: false,
  })
  const [orientation,    setOrientation]    = useState({ fwd: true, rev: false })
  const [outputStructure, setOutputStructure] = useState('per_transcript')
  const [outputDir,       setOutputDir]       = useState('')
  const [compress,        setCompress]        = useState(false)
  const [headerFields, setHeaderFields] = useState(() => {
    const init = {}
    for (const f of HEADER_FIELD_OPTIONS) init[f.key] = f.defaultOn
    return init
  })
  const [singleFilename, setSingleFilename] = useState('')
  const [showBrowser,    setShowBrowser]    = useState(false)
  const [exportStatus,   setExportStatus]   = useState(null) // null | 'loading' | 'done' | 'error'
  const [exportResult,   setExportResult]   = useState(null)
  const [exportError,    setExportError]    = useState('')
  const [seedCopyStatus, setSeedCopyStatus] = useState('')

  const geneId = resolvedGene?.id || ''

  const scopedTranscripts = useMemo(() => (
    transcriptScope === 'active'
      ? orderedTranscripts.filter((tx) => activeTranscriptIds.has(tx.id))
      : orderedTranscripts
  ), [transcriptScope, orderedTranscripts, activeTranscriptIds])

  const availability = useMemo(
    () => computeFeatureAvailability(scopedTranscripts),
    [scopedTranscripts],
  )

  const selectedKeys = useMemo(() => (
    FEATURE_OPTIONS.filter((f) => featureSelection[f.key] && availability[f.key]).map((f) => f.key)
  ), [featureSelection, availability])

  const suggestedFilename = useMemo(
    () => buildSuggestedFilename(geneId, selectedKeys, compress),
    [geneId, selectedKeys, compress],
  )

  const effectiveFilename  = singleFilename.trim() || suggestedFilename
  const effectiveOutputDir = outputDir.trim() || defaultOutputDir

  // Reset export feedback when inputs change
  useEffect(() => {
    setExportStatus(null)
    setExportResult(null)
    setExportError('')
  }, [transcriptScope, featureSelection, orientation, outputStructure, outputDir, compress, headerFields])

  // Auto-dismiss toast after 5 seconds
  useEffect(() => {
    if (exportStatus !== 'done' && exportStatus !== 'error') return
    const timer = setTimeout(() => {
      setExportStatus(null)
      setExportResult(null)
      setExportError('')
    }, 5000)
    return () => clearTimeout(timer)
  }, [exportStatus])

  const filePreview = useMemo(
    () => buildFilePreview(scopedTranscripts, selectedKeys, outputStructure, compress),
    [outputStructure, scopedTranscripts, selectedKeys, compress],
  )

  const totalFileCount = useMemo(() => {
    if (outputStructure === 'single') return 1
    if (outputStructure === 'per_transcript') return scopedTranscripts.length
    return scopedTranscripts.length * selectedKeys.length
  }, [outputStructure, scopedTranscripts.length, selectedKeys.length])

  const seededHeader = String(externalSeedSequence?.header || '').trim()
  const seededSequence = String(externalSeedSequence?.sequence || '').replace(/\\s+/g, '').toUpperCase()
  const seededFasta = seededHeader && seededSequence ? `${seededHeader}\\n${seededSequence}` : ''

  const orientationList = useMemo(
    () => ['fwd', 'rev'].filter((k) => orientation[k]),
    [orientation],
  )

  useEffect(() => {
    if (!seedCopyStatus) return
    const timer = setTimeout(() => setSeedCopyStatus(''), 2500)
    return () => clearTimeout(timer)
  }, [seedCopyStatus])

  const handleCopySeededFasta = useCallback(async () => {
    if (!seededFasta) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(seededFasta)
        setSeedCopyStatus('Copied')
      } else {
        setSeedCopyStatus('Clipboard unavailable')
      }
    } catch {
      setSeedCopyStatus('Copy failed')
    }
  }, [seededFasta])

  const handleExport = useCallback(async () => {
    if (selectedKeys.length === 0 || scopedTranscripts.length === 0 || orientationList.length === 0) return
    setExportStatus('loading')
    setExportResult(null)
    setExportError('')
    try {
      const res = await fetch(`${API_BASE}/api/feature_explorer/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          genome:           sequenceGenome || 'reference',
          gene_id:          geneId,
          transcript_ids:   scopedTranscripts.map((tx) => tx.id),
          feature_types:    selectedKeys,
          orientations:     orientationList,
          output_dir:       effectiveOutputDir,
          output_structure: outputStructure,
          filename:         outputStructure === 'single' ? effectiveFilename : null,
          compress,
          header_fields:    headerFields,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.detail || 'Export failed')
      setExportResult(data)
      setExportStatus('done')
    } catch (e) {
      setExportError(e?.message || 'Export failed')
      setExportStatus('error')
    }
  }, [selectedKeys, scopedTranscripts, orientationList, geneId, effectiveOutputDir, outputStructure, effectiveFilename, compress, headerFields, sequenceGenome])

  const canExport = (
    selectedKeys.length > 0 &&
    scopedTranscripts.length > 0 &&
    Boolean(effectiveOutputDir) &&
    orientationList.length > 0
  )
  const activeCount = orderedTranscripts.filter((tx) => activeTranscriptIds.has(tx.id)).length
  const allCount    = orderedTranscripts.length

  // ── Styling shorthands ────────────────────────────────────────────────────
  const sectionClass      = isLight ? 'bg-white border-gray-200' : 'bg-gray-800/80 border-gray-700'
  const headerBorderClass = isLight ? 'border-gray-200' : 'border-gray-700'
  const titleClass        = isLight ? 'text-gray-800' : 'text-gray-100'
  const subLabelClass     = `text-xs font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`
  const bodyTextClass     = isLight ? 'text-gray-700' : 'text-gray-300'
  const dimTextClass      = isLight ? 'text-gray-400' : 'text-gray-600'
  const inputClass        = isLight
    ? 'bg-white border-gray-300 text-gray-800 placeholder-gray-400 focus:border-[#559dc8] focus:ring-[#63acd8]/20'
    : 'bg-gray-900/50 border-gray-600 text-gray-100 placeholder-gray-500 focus:border-sky-400 focus:ring-sky-400/20'
  const btnCollapseClass  = isLight
    ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
    : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
  const accentClass       = isLight ? 'accent-[#63acd8]' : 'accent-sky-400'
  const segActiveClass    = isLight ? 'bg-[#63acd8] text-white border-[#559dc8]' : 'bg-sky-500/80 text-white border-sky-400/80'
  const segInactiveClass  = isLight ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50' : 'bg-gray-800 text-gray-300 border-gray-600 hover:bg-gray-700'
  const dividerClass      = `border-t ${isLight ? 'border-gray-100' : 'border-gray-700/60'}`
  const previewTextClass  = `text-[11px] font-mono truncate ${isLight ? 'text-gray-500' : 'text-gray-500'}`
  const metaTextClass     = `text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`
  const togglePanelCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  return (
    <>
      <div className={`rounded-xl border overflow-hidden ${sectionClass}`}>
        {/* ── Section header ─────────────────────────────────────────────────── */}
        <div
          role="button"
          tabIndex={0}
          onClick={togglePanelCollapsed}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              togglePanelCollapsed()
            }
          }}
          className={`px-4 py-3 flex items-center justify-between border-b cursor-pointer select-none ${headerBorderClass}`}
        >
          <div className={`text-sm font-semibold ${titleClass}`}>Export Sequences</div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              togglePanelCollapsed()
            }}
            className={`w-7 h-7 rounded border flex items-center justify-center transition-colors ${btnCollapseClass}`}
            title={collapsed ? 'Expand export panel' : 'Collapse export panel'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              {collapsed ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
            </svg>
          </button>
        </div>

        {!collapsed && (
          <div className="px-4 py-4 space-y-5">

            {seededFasta && (
              <div className={`rounded-lg border p-3 ${isLight ? 'bg-sky-50 border-sky-200' : 'bg-sky-500/10 border-sky-400/40'}`}>
                <div className={`flex items-center justify-between gap-2 ${isLight ? 'text-sky-800' : 'text-sky-200'}`}>
                  <div className="text-xs font-semibold">Seeded exon sequence</div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleCopySeededFasta}
                      className={`px-2 py-1 rounded text-[11px] font-semibold border transition-colors ${isLight
                        ? 'bg-white text-sky-700 border-sky-300 hover:bg-sky-100'
                        : 'bg-gray-800 text-sky-200 border-sky-400/60 hover:bg-sky-500/20'
                        }`}
                    >
                      Copy FASTA
                    </button>
                    {typeof onClearExternalSeedSequence === 'function' && (
                      <button
                        type="button"
                        onClick={onClearExternalSeedSequence}
                        className={`px-2 py-1 rounded text-[11px] font-semibold border transition-colors ${isLight
                          ? 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
                          : 'bg-gray-800 text-gray-200 border-gray-600 hover:bg-gray-700'
                          }`}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <div className={`mt-2 rounded border px-2 py-1.5 text-[11px] font-mono break-all ${isLight ? 'bg-white border-sky-200 text-sky-900' : 'bg-gray-900/40 border-sky-400/30 text-sky-100'}`}>
                  {seededHeader}
                  <br />
                  {seededSequence}
                </div>
                {seedCopyStatus && (
                  <div className={`mt-1 text-[11px] ${isLight ? 'text-sky-700' : 'text-sky-300'}`}>{seedCopyStatus}</div>
                )}
              </div>
            )}

            {/* ── 1. Transcript scope ──────────────────────────────────────────── */}
            <div>
              <div className={subLabelClass}>Transcripts</div>
              <div className={`mt-2 inline-flex items-center rounded-md border overflow-hidden ${isLight ? 'border-gray-300' : 'border-gray-600'}`}>
                {[
                  { value: 'active', label: `Active (${activeCount})` },
                  { value: 'all',    label: `All (${allCount})` },
                ].map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTranscriptScope(value)}
                    className={`px-3 py-1.5 text-[11px] font-semibold border-r last:border-r-0 ${transcriptScope === value ? segActiveClass : segInactiveClass}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className={dividerClass} />

            {/* ── 2. Features ──────────────────────────────────────────────────── */}
            <div>
              <div className={subLabelClass}>Features to export</div>
              <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-2.5">
                {FEATURE_OPTIONS.map(({ key, label }) => {
                  const avail = availability[key]
                  return (
                    <label
                      key={key}
                      className={`flex items-center gap-2 cursor-pointer select-none ${avail ? bodyTextClass : dimTextClass}`}
                      title={!avail ? 'No transcripts in the current selection have this feature' : undefined}
                    >
                      <input
                        type="checkbox"
                        className={accentClass}
                        checked={Boolean(featureSelection[key]) && avail}
                        disabled={!avail}
                        onChange={(e) => setFeatureSelection((prev) => ({ ...prev, [key]: e.target.checked }))}
                      />
                      <span className="text-xs">{label}</span>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className={dividerClass} />

            {/* ── 3. Output structure ──────────────────────────────────────────── */}
            <div>
              <div className={subLabelClass}>Output files</div>
              <div className="mt-2 space-y-2.5">
                {OUTPUT_STRUCTURE_OPTIONS.map(({ value, label }) => (
                  <label key={value} className={`flex items-start gap-2 cursor-pointer select-none text-xs ${bodyTextClass}`}>
                    {/* w-4 forces radio to 16px so ml-6 (24px = 16+8) aligns sub-content */}
                    <input
                      type="radio"
                      name="export_output_structure"
                      className={`w-4 flex-none mt-0.5 ${accentClass}`}
                      value={value}
                      checked={outputStructure === value}
                      onChange={() => setOutputStructure(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>

              {/* Filename input — single file mode, left-aligned with radio text */}
              {outputStructure === 'single' && (
                <div className={`mt-3 ${RADIO_INDENT}`}>
                  <div className={`${metaTextClass} mb-1`}>Filename</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      className={`flex-1 rounded border px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 ${inputClass}`}
                      value={singleFilename}
                      placeholder={suggestedFilename}
                      onChange={(e) => setSingleFilename(e.target.value)}
                    />
                    {singleFilename && (
                      <button
                        type="button"
                        title="Reset to suggested name"
                        onClick={() => setSingleFilename('')}
                        className={`text-xs px-1.5 py-1 rounded border transition-colors ${isLight ? 'text-gray-500 border-gray-300 hover:bg-gray-100' : 'text-gray-400 border-gray-600 hover:bg-gray-700'}`}
                      >
                        ↺
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* File name preview — per-transcript / per-feature modes */}
              {outputStructure !== 'single' && (
                <div className={`mt-3 ${RADIO_INDENT}`}>
                  <div className={`${metaTextClass} mb-1.5`}>
                    {totalFileCount} {totalFileCount === 1 ? 'file' : 'files'} will be created
                  </div>
                  {filePreview.length > 0 && (
                    <div className="grid grid-cols-3 gap-x-3 gap-y-0.5">
                      {filePreview.map((name, i) => (
                        <div key={i} className={previewTextClass} title={name}>{name}</div>
                      ))}
                      {totalFileCount > filePreview.length && (
                        <div className={`col-span-3 mt-0.5 text-[11px] ${dimTextClass}`}>
                          … and {totalFileCount - filePreview.length} more
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className={dividerClass} />

            {/* ── 4. Output directory ──────────────────────────────────────────── */}
            <div>
              <div className={subLabelClass}>Output directory</div>
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  className={`flex-1 rounded border px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 ${inputClass}`}
                  value={outputDir}
                  placeholder={defaultOutputDir || '/path/to/exported_data'}
                  onChange={(e) => setOutputDir(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowBrowser(true)}
                  className={`px-2.5 py-1.5 rounded border text-xs font-semibold flex-shrink-0 transition-colors ${isLight ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'}`}
                >
                  Browse
                </button>
              </div>
              <div className={`mt-1 text-[11px] ${dimTextClass}`}>
                Directory will be created automatically if it does not exist.
              </div>
            </div>

            <div className={dividerClass} />

            {/* ── 5. Options + FASTA header fields + Export button ─────────────── */}
            <div className="flex flex-col gap-5 sm:flex-row sm:gap-8 sm:items-start">
              {/* Options */}
              <div className="flex-shrink-0">
                <div className={subLabelClass}>Options</div>
                <div className="mt-2 space-y-2">
                  <label className={`flex items-center gap-2 cursor-pointer select-none text-xs ${bodyTextClass}`}>
                    <input
                      type="checkbox"
                      className={accentClass}
                      checked={orientation.fwd}
                      onChange={(e) => setOrientation((prev) => ({ ...prev, fwd: e.target.checked }))}
                    />
                    5&prime; to 3&prime;
                  </label>
                  <label className={`flex items-center gap-2 cursor-pointer select-none text-xs ${bodyTextClass}`}>
                    <input
                      type="checkbox"
                      className={accentClass}
                      checked={orientation.rev}
                      onChange={(e) => setOrientation((prev) => ({ ...prev, rev: e.target.checked }))}
                    />
                    3&prime; to 5&prime; (reverse complement)
                  </label>
                  <label className={`flex items-center gap-2 cursor-pointer select-none text-xs ${bodyTextClass}`}>
                    <input
                      type="checkbox"
                      className={accentClass}
                      checked={compress}
                      onChange={(e) => setCompress(e.target.checked)}
                    />
                    Compress output (.gz)
                  </label>
                </div>
              </div>

              {/* FASTA header fields */}
              <div className="flex-1">
                <div className={subLabelClass}>FASTA header fields</div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                  {HEADER_FIELD_OPTIONS.map(({ key, label }) => (
                    <label key={key} className={`flex items-center gap-2 cursor-pointer select-none text-xs ${bodyTextClass}`}>
                      <input
                        type="checkbox"
                        className={accentClass}
                        checked={Boolean(headerFields[key])}
                        onChange={(e) => setHeaderFields((prev) => ({ ...prev, [key]: e.target.checked }))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {/* Export button — self-end so its bottom aligns with last FASTA header row */}
              <div className="flex-shrink-0 sm:self-end">
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={!canExport || exportStatus === 'loading'}
                  title="Export"
                  className={`w-11 h-11 rounded-lg flex items-center justify-center transition-all duration-200 border-2 ${
                    canExport && exportStatus !== 'loading'
                      ? 'bg-[#0099ff] text-white border-white/40 hover:bg-[#0088ee] shadow-md shadow-[#0099ff]/30'
                      : (isLight
                        ? 'bg-gray-200 text-gray-400 border-transparent cursor-not-allowed'
                        : 'bg-gray-700 text-gray-500 border-transparent cursor-not-allowed')
                  }`}
                >
                  {exportStatus === 'loading' ? (
                    <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 32 32" fill="currentColor" stroke="none" aria-hidden="true">
                      <path d="M3.5999999,2.7C3.5999999,2.8,3.5,2.9000001,3.5,3s0,0.2,0.0999999,0.3L15.5,19.5999985c0.1999998,0.2999992,0.6000004,0.2999992,0.7999992,0.2000008c0.1000004,0,0.1000004-0.1000004,0.2000008-0.2000008L28.3999996,3.3C28.6000004,3,28.5,2.6999998,28.1999989,2.5c-0.1000004-0.0999999-0.2000008-0.0999999-0.2999992-0.0999999H4.0999999C3.9000001,2.4000001,3.7,2.5,3.5999999,2.7z"/>
                      <path d="M29.3353596,29.6499996c1,0,1.666666-0.833334,1.666666-1.6666679v-1.7666645c0-1-0.833334-1.666666-1.666666-1.666666H2.6686926c-0.8333333,0-1.6666666,0.666666-1.6666666,1.666666v1.7666645c0,0.833334,0.6666669,1.6666679,1.6666666,1.6666679H29.3353596z"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>

          </div>
        )}

        <FileBrowserModal
          isOpen={showBrowser}
          onClose={() => setShowBrowser(false)}
          onSelect={(path) => { setOutputDir(path); setShowBrowser(false) }}
          initialPath={effectiveOutputDir || config?.output_dir || '.'}
          mode="directory"
          theme={theme}
        />
      </div>

      {/* ── Export notification toast ─────────────────────────────────────────── */}
      {(exportStatus === 'done' || exportStatus === 'error') && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[460px] max-w-[calc(100vw-2rem)] rounded-xl border shadow-2xl px-4 py-3 text-sm pointer-events-none ${
          exportStatus === 'done'
            ? (isLight
              ? 'bg-white border-green-300 text-green-800'
              : 'bg-gray-800 border-green-600/60 text-green-300')
            : (isLight
              ? 'bg-white border-red-300 text-red-700'
              : 'bg-gray-800 border-red-600/60 text-red-400')
        }`}>
          {exportStatus === 'done' && exportResult && (
            <>
              <div className="font-semibold mb-1.5">
                Export complete — {(exportResult.files || []).length} {(exportResult.files || []).length === 1 ? 'file' : 'files'} written
              </div>
              <div className="space-y-0.5 font-mono text-xs">
                {(exportResult.files || []).slice(0, 5).map((f, i) => (
                  <div key={i} className="truncate">{f}</div>
                ))}
                {(exportResult.files || []).length > 5 && (
                  <div className={`mt-0.5 font-sans ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                    … and {(exportResult.files || []).length - 5} more
                  </div>
                )}
              </div>
              {(exportResult.errors || []).length > 0 && (
                <div className={`mt-2 text-xs font-sans ${isLight ? 'text-amber-700' : 'text-amber-400'}`}>
                  {exportResult.errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </>
          )}
          {exportStatus === 'error' && (
            <div>{exportError || 'Export failed.'}</div>
          )}
        </div>
      )}
    </>
  )
}
