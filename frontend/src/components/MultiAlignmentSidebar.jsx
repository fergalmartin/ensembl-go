import { useEffect, useMemo, useState } from 'react'

const LockedIcon = ({ className = '' }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z" />
    </svg>
)

const UnlockedIcon = ({ className = '' }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h2c0-1.66 1.34-3 3-3s3 1.34 3 3v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z" />
    </svg>
)

function clampMin(value, min, fallback) {
    const num = Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.max(min, num)
}

function flankSlider({
    isLight,
    labelClass,
    label,
    value,
    min = 0,
    max = 1000,
    step = 10,
    disabled = false,
    onChange,
}) {
    return (
        <div>
            <label className={`block text-xs ${labelClass} mb-1`}>
                {label}
            </label>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onInput={(e) => onChange?.(Math.max(min, parseInt(e.currentTarget.value || `${min}`, 10) || min))}
                onChange={(e) => onChange?.(Math.max(min, parseInt(e.currentTarget.value || `${min}`, 10) || min))}
                className={`w-full ${isLight ? 'light-slider' : 'dark-slider'}`}
                disabled={disabled}
            />
        </div>
    )
}

function SectionToggle({ isLight, open, onClick, titleExpand, titleCollapse }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${isLight
                ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'}`}
            title={open ? titleCollapse : titleExpand}
        >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                {open
                    ? <polyline points="18 15 12 9 6 15" />
                    : <polyline points="6 9 12 15 18 9" />}
            </svg>
        </button>
    )
}

export default function MultiAlignmentSidebar({
    theme = 'dark',
    rows = [],
    rowDisplayMetaByGenomeKey = {},
    globalFlanks = { flank5: 100, flank3: 100 },
    globalFlanksLocked = true,
    globalFlankMax = 1000,
    collapseIntrons = false,
    collapseSourceGenomeKey = '',
    collapseSourceOptions = [],
    collapsed = false,
    runSettings = {},
    loading = false,
    runDisabled = false,
    alignedGenomeCount = 0,
    unalignedGenomeCount = 0,
    showUpdateNotice = false,
    warnings = [],
    onRowQueryChange,
    onResolveRow,
    onRowSettingChange,
    onGlobalFlanksChange,
    onGlobalFlanksLockToggle,
    onGlobalFlankMaxChange,
    onCollapseIntronsChange,
    onCollapseSourceChange,
    onRunSettingsChange,
    onRunAlignment,
    onSaveAlignment,
    onLoadAlignment,
    hasResult = false,
    onToggleCollapsed = null,
}) {
    const isLight = theme === 'light'
    const [expandedRows, setExpandedRows] = useState({})
    const [globalControlsOpen, setGlobalControlsOpen] = useState(false)
    const [genomesOpen, setGenomesOpen] = useState(true)
    const [visibleCompletionNotices, setVisibleCompletionNotices] = useState([])

    const panelClass = isLight ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-800 border border-gray-700'
    const textClass = isLight ? 'text-gray-800' : 'text-gray-200'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const inputClass = isLight
        ? 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500'
        : 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500'
    const cardClass = isLight ? 'bg-gray-50 border border-gray-200' : 'bg-gray-750 border border-gray-700'

    useEffect(() => {
        setExpandedRows((prev) => {
            const next = {}
            let changed = false
            const rowKeys = new Set((rows || []).map((row) => String(row.genome_key || '')))

            for (const row of rows || []) {
                const key = String(row.genome_key || '')
                if (!key) continue
                if (Object.prototype.hasOwnProperty.call(prev, key)) {
                    next[key] = prev[key]
                } else {
                    next[key] = false
                    changed = true
                }
            }

            for (const key of Object.keys(prev || {})) {
                if (!rowKeys.has(key)) changed = true
            }

            if (!changed && Object.keys(prev || {}).length === Object.keys(next).length) {
                return prev
            }
            return next
        })
    }, [rows])

    const warningMessages = useMemo(
        () => (Array.isArray(warnings) ? warnings.map((msg) => String(msg || '').trim()).filter(Boolean) : []),
        [warnings]
    )

    const completionNoticeMessages = useMemo(
        () => warningMessages.filter((msg) => /^MSA completed in\s+/i.test(msg)),
        [warningMessages]
    )

    const persistentWarningMessages = useMemo(
        () => warningMessages.filter((msg) => !/^MSA completed in\s+/i.test(msg)),
        [warningMessages]
    )

    useEffect(() => {
        setVisibleCompletionNotices(completionNoticeMessages)
        if (completionNoticeMessages.length === 0) return
        const timer = window.setTimeout(() => {
            setVisibleCompletionNotices([])
        }, 5000)
        return () => window.clearTimeout(timer)
    }, [completionNoticeMessages])

    const collapseButtonClass = `w-7 h-7 rounded border flex items-center justify-center transition-colors ${isLight
        ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
        : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'}`

    if (collapsed) {
        return (
            <div className={`${panelClass} h-full rounded-lg p-1.5 flex items-start justify-center`}>
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    className={collapseButtonClass}
                    title="Expand alignment controls"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 6 15 12 9 18" />
                    </svg>
                </button>
            </div>
        )
    }

    const safeGlobalMax = clampMin(globalFlankMax, 100, 1000)

    return (
        <div className={`${panelClass} h-auto rounded-lg p-4 flex flex-col gap-4 overflow-visible`}>
            <div className="flex items-center justify-between">
                <h3 className={`text-sm font-semibold ${textClass}`}>Feature Alignment</h3>
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    className={collapseButtonClass}
                    title="Collapse alignment controls"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 6 9 12 15 18" />
                    </svg>
                </button>
            </div>

            <div className={`rounded-md ${cardClass} overflow-hidden`}>
                <div className={`px-3 py-2.5 border-b flex items-center justify-between ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <span className={`text-xs font-semibold whitespace-nowrap ${textClass}`}>Global controls</span>
                    <SectionToggle
                        isLight={isLight}
                        open={globalControlsOpen}
                        onClick={() => setGlobalControlsOpen((prev) => !prev)}
                        titleExpand="Expand global controls"
                        titleCollapse="Collapse global controls"
                    />
                </div>
                {globalControlsOpen && (
                    <div className="p-3 space-y-3">
                        <div className="relative pr-8 space-y-2">
                            {flankSlider({
                                isLight,
                                labelClass: subTextClass,
                                label: `5' flanking: ${Math.max(0, Number(globalFlanks.flank5) || 0)}bp`,
                                value: Math.max(0, Number(globalFlanks.flank5) || 0),
                                max: safeGlobalMax,
                                disabled: loading,
                                onChange: (next) => onGlobalFlanksChange?.({ flank5: next }),
                            })}
                            {flankSlider({
                                isLight,
                                labelClass: subTextClass,
                                label: `3' flanking: ${Math.max(0, Number(globalFlanks.flank3) || 0)}bp`,
                                value: Math.max(0, Number(globalFlanks.flank3) || 0),
                                max: safeGlobalMax,
                                disabled: loading,
                                onChange: (next) => onGlobalFlanksChange?.({ flank3: next }),
                            })}
                            <div className="absolute right-0 top-1/2 -translate-y-1/2">
                                <button
                                    type="button"
                                    onClick={onGlobalFlanksLockToggle}
                                    className={`p-1 rounded transition-colors ${globalFlanksLocked
                                        ? (isLight ? 'text-[#0099ff] hover:bg-blue-50' : 'text-blue-400 hover:bg-gray-700')
                                        : (isLight ? 'text-gray-400 hover:bg-gray-100' : 'text-gray-500 hover:bg-gray-700')
                                        }`}
                                    title={globalFlanksLocked ? 'Global sliders linked' : 'Global sliders independent'}
                                >
                                    {globalFlanksLocked ? <LockedIcon className="w-5 h-5" /> : <UnlockedIcon className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>
                        <label className={`text-[11px] ${subTextClass} flex items-center gap-1`}>
                            Max flank
                            <input
                                type="number"
                                inputMode="numeric"
                                min={100}
                                step={100}
                                value={safeGlobalMax}
                                onChange={(e) => onGlobalFlankMaxChange?.(clampMin(e.target.value, 100, 1000))}
                                className={`no-number-spin w-20 ${inputClass} border rounded px-1.5 py-0.5 text-[11px]`}
                                disabled={loading}
                            />
                        </label>

                        <div className={`pt-2 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                            <div className={`text-xs font-semibold mb-2 ${textClass}`}>Alignment advanced</div>
                            <div className="space-y-2">
                                <div className={`text-xs ${subTextClass}`}>
                                    Execution profile: <span className={isLight ? 'text-blue-700 font-semibold' : 'text-blue-300 font-semibold'}>balanced</span>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <label className={`text-xs ${subTextClass}`}>
                                        soft_warn_sequences
                                        <input
                                            type="number"
                                            min={2}
                                            value={runSettings.soft_warn_sequences ?? 6}
                                            onChange={(e) => onRunSettingsChange?.({ soft_warn_sequences: Math.max(2, parseInt(e.target.value || '2', 10) || 2) })}
                                            className={`no-number-spin mt-1 w-full ${inputClass} border rounded px-2 py-1 text-xs`}
                                        />
                                    </label>
                                    <label className={`text-xs ${subTextClass}`}>
                                        hard_cap_sequences
                                        <input
                                            type="number"
                                            min={2}
                                            value={runSettings.hard_cap_sequences ?? 10}
                                            onChange={(e) => onRunSettingsChange?.({ hard_cap_sequences: Math.max(2, parseInt(e.target.value || '2', 10) || 2) })}
                                            className={`no-number-spin mt-1 w-full ${inputClass} border rounded px-2 py-1 text-xs`}
                                        />
                                    </label>
                                    <label className={`text-xs ${subTextClass}`}>
                                        max_total_bp
                                        <input
                                            type="number"
                                            min={1000}
                                            step={1000}
                                            value={runSettings.max_total_bp ?? 500000}
                                            onChange={(e) => onRunSettingsChange?.({ max_total_bp: Math.max(1000, parseInt(e.target.value || '1000', 10) || 1000) })}
                                            className={`no-number-spin mt-1 w-full ${inputClass} border rounded px-2 py-1 text-xs`}
                                        />
                                    </label>
                                    <label className={`text-xs ${subTextClass}`}>
                                        timeout_sec
                                        <input
                                            type="number"
                                            min={30}
                                            value={runSettings.timeout_sec ?? 300}
                                            onChange={(e) => onRunSettingsChange?.({ timeout_sec: Math.max(30, parseInt(e.target.value || '30', 10) || 30) })}
                                            className={`no-number-spin mt-1 w-full ${inputClass} border rounded px-2 py-1 text-xs`}
                                        />
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className={`rounded-md ${cardClass} overflow-visible`}>
                <div className={`px-3 py-2.5 border-b flex items-center justify-between ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <span className={`text-xs font-semibold ${textClass}`}>Genomes</span>
                    <SectionToggle
                        isLight={isLight}
                        open={genomesOpen}
                        onClick={() => setGenomesOpen((prev) => !prev)}
                        titleExpand="Expand genomes"
                        titleCollapse="Collapse genomes"
                    />
                </div>
                {genomesOpen && (
                    <div className="p-3 pr-2 space-y-3">
                        {rows.map((row) => {
                            const isExpanded = !!expandedRows[row.genome_key]
                            const transcripts = row?.resolved?.transcripts || []
                            const canExpand = row.status === 'resolved'
                            const rowFlankMax = clampMin(row.settings?.flankMax, 100, 1000)
                            const rowFlanksLocked = Boolean(row.settings?.flanksLocked ?? true)
                            const rowFlank5 = Math.max(0, Number(row.settings?.flank5) || 0)
                            const rowFlank3 = Math.max(0, Number(row.settings?.flank3) || 0)
                            const selectedTranscriptId = row.settings?.selectedTranscriptId || row.resolved?.selectedTranscriptId || ''
                            const selectedTranscript = transcripts.find((tx) => String(tx?.id || '') === String(selectedTranscriptId || ''))
                            const selectedIsCanonical = Boolean(selectedTranscript?.is_canonical)
                            const displayMeta = rowDisplayMetaByGenomeKey?.[row.genome_key] || {}
                            const geneLabel = String(
                                displayMeta?.geneLabel
                                || row?.resolved?.gene?.name
                                || row?.resolved?.gene?.id
                                || row?.query
                                || ''
                            ).trim()

                            return (
                                <div key={row.genome_key} className={`rounded-md p-3 ${cardClass} space-y-2`}>
                                    <div className="flex items-center justify-between gap-2">
                                        <span
                                            className="inline-flex items-center h-6 w-[190px] px-2.5 text-xs font-medium truncate rounded-full border"
                                            style={{
                                                backgroundColor: isLight ? '#0099ff' : '#0077cc',
                                                color: '#ffffff',
                                                borderColor: 'transparent',
                                            }}
                                        >
                                            <span className="truncate">{row.pillLabel}</span>
                                        </span>
                                        <span className={`text-xs font-semibold ${textClass}`}>{row.tag}</span>
                                    </div>

                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={row.query || ''}
                                            onChange={(e) => onRowQueryChange?.(row.genome_key, e.target.value)}
                                            placeholder="Gene name, gene ID, or transcript ID"
                                            className={`flex-1 ${inputClass} border rounded px-2 py-1.5 text-xs`}
                                            disabled={loading}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => onResolveRow?.(row.genome_key)}
                                            disabled={loading || (!String(row.query || '').trim() && row.status !== 'resolving')}
                                            className="px-2 py-1.5 rounded text-xs text-white bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-not-allowed"
                                            title={row.status === 'resolving' ? 'Stop search' : 'Resolve query'}
                                        >
                                            {row.status === 'resolving' ? (
                                                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                                                    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
                                                    <path d="M20 4v5h-5" />
                                                </svg>
                                            ) : 'Go'}
                                        </button>
                                    </div>

                                    {row.error && (
                                        <div className="text-[11px] text-red-400">{row.error}</div>
                                    )}

                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (!canExpand) return
                                            setExpandedRows((prev) => ({ ...prev, [row.genome_key]: !isExpanded }))
                                        }}
                                        disabled={!canExpand}
                                        className={`w-full flex items-center justify-between text-[11px] px-2 py-1.5 rounded border transition-colors ${canExpand
                                            ? (isLight ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600')
                                            : (isLight ? 'bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed' : 'bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed')
                                            }`}
                                        title={canExpand ? (isExpanded ? 'Collapse controls' : 'Expand controls') : 'Resolve a gene first to open controls'}
                                    >
                                        <span className="font-semibold tracking-wide">Controls</span>
                                        <span className={`w-6 h-6 rounded border flex items-center justify-center ${canExpand
                                            ? (isLight ? 'bg-white border-gray-300 text-gray-700' : 'bg-gray-800 border-gray-500 text-gray-200')
                                            : (isLight ? 'bg-gray-100 border-gray-200 text-gray-400' : 'bg-gray-800 border-gray-700 text-gray-500')
                                            }`}>
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                                {isExpanded
                                                    ? <polyline points="18 15 12 9 6 15" />
                                                    : <polyline points="6 9 12 15 18 9" />}
                                            </svg>
                                        </span>
                                    </button>

                                    {canExpand && (
                                        <>
                                            {isExpanded && (
                                                <div className={`rounded p-2 space-y-2 ${isLight ? 'bg-white border border-gray-200' : 'bg-gray-800 border border-gray-700'}`}>
                                                    <label className={`relative flex items-center gap-2 text-xs ${subTextClass} group`}>
                                                        <input
                                                            type="checkbox"
                                                            checked={Boolean(row.settings?.useGeneBoundaries ?? true)}
                                                            onChange={(e) => onRowSettingChange?.(row.genome_key, { useGeneBoundaries: e.target.checked })}
                                                        />
                                                        <span>Use gene boundaries</span>
                                                        <span className={`pointer-events-none absolute left-0 top-full z-20 mt-2 hidden w-64 rounded-md px-2.5 py-2 text-[11px] leading-4 shadow-lg group-hover:block ${isLight ? 'bg-gray-900 text-white border border-gray-700' : 'bg-gray-100 text-gray-900 border border-gray-300'}`}>
                                                            Disabling will use the genomic coords of the selected transcript instead of the gene
                                                        </span>
                                                    </label>
                                                    <label className={`flex items-center gap-2 text-xs ${subTextClass}`}>
                                                        <input
                                                            type="checkbox"
                                                            checked={Boolean(row.settings?.useGlobalFlanks)}
                                                            onChange={(e) => onRowSettingChange?.(row.genome_key, { useGlobalFlanks: e.target.checked })}
                                                        />
                                                        Use global flanks
                                                    </label>
                                                    {!row.settings?.useGlobalFlanks && (
                                                        <div className="space-y-2">
                                                            <div className="relative pr-8 space-y-2">
                                                                {flankSlider({
                                                                    isLight,
                                                                    labelClass: subTextClass,
                                                                    label: `5' flanking: ${Math.round(rowFlank5)}bp`,
                                                                    value: Math.min(rowFlank5, rowFlankMax),
                                                                    max: rowFlankMax,
                                                                    disabled: loading,
                                                                    onChange: (next) => onRowSettingChange?.(row.genome_key, { flank5: next }),
                                                                })}
                                                                {flankSlider({
                                                                    isLight,
                                                                    labelClass: subTextClass,
                                                                    label: `3' flanking: ${Math.round(rowFlank3)}bp`,
                                                                    value: Math.min(rowFlank3, rowFlankMax),
                                                                    max: rowFlankMax,
                                                                    disabled: loading,
                                                                    onChange: (next) => onRowSettingChange?.(row.genome_key, { flank3: next }),
                                                                })}
                                                                <div className="absolute right-0 top-1/2 -translate-y-1/2">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => onRowSettingChange?.(row.genome_key, { flanksLocked: !rowFlanksLocked })}
                                                                        className={`p-1 rounded transition-colors ${rowFlanksLocked
                                                                            ? (isLight ? 'text-[#0099ff] hover:bg-blue-50' : 'text-blue-400 hover:bg-gray-700')
                                                                            : (isLight ? 'text-gray-400 hover:bg-gray-100' : 'text-gray-500 hover:bg-gray-700')
                                                                            }`}
                                                                        title={rowFlanksLocked ? 'Per-genome sliders linked' : 'Per-genome sliders independent'}
                                                                    >
                                                                        {rowFlanksLocked ? <LockedIcon className="w-5 h-5" /> : <UnlockedIcon className="w-5 h-5" />}
                                                                    </button>
                                                                </div>
                                                            </div>
                                                            <label className={`text-[11px] ${subTextClass} flex items-center gap-1`}>
                                                                Max flank
                                                                <input
                                                                    type="number"
                                                                    inputMode="numeric"
                                                                    min={100}
                                                                    step={100}
                                                                    value={rowFlankMax}
                                                                    onChange={(e) => onRowSettingChange?.(row.genome_key, { flankMax: clampMin(e.target.value, 100, 1000) })}
                                                                    className={`no-number-spin w-20 ${inputClass} border rounded px-1.5 py-0.5 text-[11px]`}
                                                                    disabled={loading}
                                                                />
                                                            </label>
                                                        </div>
                                                    )}
                                                    <label className={`flex items-center gap-2 text-xs ${subTextClass}`}>
                                                        <input
                                                            type="checkbox"
                                                            checked={Boolean(row.settings?.overlayAnnotation)}
                                                            onChange={(e) => onRowSettingChange?.(row.genome_key, { overlayAnnotation: e.target.checked })}
                                                        />
                                                        Overlay annotation
                                                    </label>
                                                    {row.settings?.overlayAnnotation && transcripts.length > 0 && (
                                                        <label className={`text-xs ${subTextClass} block`}>
                                                            Transcript
                                                            {(geneLabel || selectedTranscriptId) && (
                                                                <div className="mt-1 mb-1 space-y-1">
                                                                    {geneLabel && (
                                                                        <div className={`text-[11px] font-medium whitespace-nowrap overflow-hidden text-ellipsis ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>
                                                                            {geneLabel}
                                                                        </div>
                                                                    )}
                                                                    {selectedTranscriptId && (
                                                                        <div className="flex items-center gap-1.5 flex-wrap">
                                                                            <span className={`font-mono text-[11px] ${isLight ? 'text-blue-700' : 'text-blue-300'}`}>
                                                                                {selectedTranscriptId}
                                                                            </span>
                                                                            {selectedIsCanonical && (
                                                                                <span className={`text-[10px] leading-[1.1] px-1.5 py-0.5 rounded-full whitespace-nowrap ${isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-400'}`}>
                                                                                    canonical
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                            <select
                                                                value={row.settings?.selectedTranscriptId || row.resolved?.selectedTranscriptId || ''}
                                                                onChange={(e) => onRowSettingChange?.(row.genome_key, { selectedTranscriptId: e.target.value })}
                                                                className={`mt-1 w-full ${inputClass} border rounded px-2 py-1 text-xs`}
                                                            >
                                                                {transcripts.map((tx) => (
                                                                    <option key={tx.id} value={tx.id}>
                                                                        {tx.id}{tx.is_canonical ? ' (canonical)' : ''}
                                                                    </option>
                                                                ))}
                                                            </select>
                                                        </label>
                                                    )}
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>

            {visibleCompletionNotices.length > 0 && (
                <div className={`rounded-md px-3 py-2 text-xs transition-all duration-300 ${isLight ? 'bg-blue-50 border border-blue-200 text-blue-800' : 'bg-blue-900/20 border border-blue-700 text-blue-200'}`}>
                    {visibleCompletionNotices.map((msg, idx) => (
                        <div key={`${idx}-${msg}`}>{msg}</div>
                    ))}
                </div>
            )}

            {persistentWarningMessages.length > 0 && (
                <div className={`rounded-md px-3 py-2 text-xs ${isLight ? 'bg-yellow-50 border border-yellow-200 text-yellow-800' : 'bg-yellow-900/20 border border-yellow-700 text-yellow-300'}`}>
                    {persistentWarningMessages.map((msg, idx) => (
                        <div key={`${idx}-${msg}`}>{msg}</div>
                    ))}
                </div>
            )}

            <div className="space-y-2">
                <button
                    type="button"
                    onClick={onRunAlignment}
                    disabled={loading || runDisabled}
                    className="w-full bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded transition-colors"
                >
                    {loading ? 'Running...' : 'Run alignment'}
                </button>
                {showUpdateNotice && (
                    <div className={`text-xs text-center py-1 ${isLight ? 'text-yellow-700' : 'text-yellow-400'}`}>
                        Run alignment to update region
                    </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={onSaveAlignment}
                        disabled={!hasResult || loading}
                        className={`py-1.5 px-3 rounded text-xs font-medium transition-colors border
                            ${isLight
                                ? 'border-gray-300 text-gray-700 hover:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200 disabled:cursor-not-allowed'
                                : 'border-gray-600 text-gray-300 hover:bg-gray-700 disabled:text-gray-600 disabled:border-gray-700 disabled:cursor-not-allowed'}`}
                    >
                        Save alignment
                    </button>
                    <button
                        type="button"
                        onClick={onLoadAlignment}
                        disabled={loading}
                        className={`py-1.5 px-3 rounded text-xs font-medium transition-colors border
                            ${isLight
                                ? 'border-gray-300 text-gray-700 hover:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200 disabled:cursor-not-allowed'
                                : 'border-gray-600 text-gray-300 hover:bg-gray-700 disabled:text-gray-600 disabled:border-gray-700 disabled:cursor-not-allowed'}`}
                    >
                        Load alignment
                    </button>
                </div>
                <div className={`text-[11px] ${subTextClass}`}>
                    Aligned genome: {Math.max(0, Number(alignedGenomeCount) || 0)} Unaligned genomes: {Math.max(0, Number(unalignedGenomeCount) || 0)}
                </div>
            </div>
        </div>
    )
}
