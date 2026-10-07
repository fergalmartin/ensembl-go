import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_GENOME_COLOR } from '../genomeColorSchemes'
import { genomePillColors } from '../utils/genomePillColors'
import DrawerChevron from './DrawerChevron'
import { CogGlyph, DrawerIconButton, DrawerSectionHeading, LockGlyph, VerticalChevronGlyph } from './focusDrawerChrome'
import { focusDrawerPalette } from './focusDrawerStyle'

// Feature Alignment's controls, as a drawer on the right of the view in the same
// chrome as the browser's and the sequence view's drawers: a band with the collapse
// arrow, a search across every genome, then each genome as a row rather than a card,
// with its options folding open underneath it.

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

/** Two flank sliders with the lock that ties them together, and the cap on both. */
function FlankControls({ isLight, palette, inputClass, flank5, flank3, max, locked, disabled, onFlankChange, onLockToggle, onMaxChange, lockTitle }) {
    return (
        <div className="space-y-2">
            <div className="relative pr-8 space-y-2">
                {flankSlider({
                    isLight,
                    labelClass: palette.subTextClass,
                    label: `5' flanking: ${Math.round(flank5)}bp`,
                    value: Math.min(flank5, max),
                    max,
                    disabled,
                    onChange: (next) => onFlankChange({ flank5: next }),
                })}
                {flankSlider({
                    isLight,
                    labelClass: palette.subTextClass,
                    label: `3' flanking: ${Math.round(flank3)}bp`,
                    value: Math.min(flank3, max),
                    max,
                    disabled,
                    onChange: (next) => onFlankChange({ flank3: next }),
                })}
                <div className="absolute right-0 top-1/2 -translate-y-1/2">
                    <DrawerIconButton
                        onClick={onLockToggle}
                        title={lockTitle}
                        accent={locked ? palette.accent : palette.divider}
                        rowHoverClass={palette.rowHoverClass}
                        compact
                    ><LockGlyph locked={locked} size={16} /></DrawerIconButton>
                </div>
            </div>
            <label className={`text-[11px] ${palette.subTextClass} flex items-center gap-1`}>
                Max flank
                <input
                    type="number"
                    inputMode="numeric"
                    min={100}
                    step={100}
                    value={max}
                    onChange={(e) => onMaxChange(clampMin(e.target.value, 100, 1000))}
                    className={`no-number-spin w-20 ${inputClass} border rounded px-1.5 py-0.5 text-[11px]`}
                    disabled={disabled}
                />
            </label>
        </div>
    )
}

export default function MultiAlignmentSidebar({
    theme = 'dark',
    rows = [],
    genomeColorsByKey = {},
    rowDisplayMetaByGenomeKey = {},
    globalFlanks = { flank5: 100, flank3: 100 },
    globalFlanksLocked = true,
    globalFlankMax = 1000,
    collapsed = false,
    runSettings = {},
    loading = false,
    runDisabled = false,
    alignedGenomeCount = 0,
    unalignedGenomeCount = 0,
    showUpdateNotice = false,
    warnings = [],
    onSearchAll,
    onRowQueryChange,
    onResolveRow,
    onRowSettingChange,
    onGlobalFlanksChange,
    onGlobalFlanksLockToggle,
    onGlobalFlankMaxChange,
    onRunSettingsChange,
    onRunAlignment,
    onSaveAlignment,
    onLoadAlignment,
    hasResult = false,
    onToggleCollapsed = null,
}) {
    const isLight = theme === 'light'
    const palette = focusDrawerPalette(isLight)
    const [expandedRows, setExpandedRows] = useState({})
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [genomesOpen, setGenomesOpen] = useState(true)
    const [sharedQuery, setSharedQuery] = useState('')
    const [visibleCompletionNotices, setVisibleCompletionNotices] = useState([])

    const inputClass = isLight
        ? 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500'
        : 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500'
    const secondaryButtonClass = `py-1.5 px-3 rounded text-xs font-medium transition-colors border ${isLight
        ? 'border-gray-300 text-gray-700 hover:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200 disabled:cursor-not-allowed'
        : 'border-gray-600 text-gray-300 hover:bg-gray-700 disabled:text-gray-600 disabled:border-gray-700 disabled:cursor-not-allowed'}`

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

    const toggleButton = (
        <DrawerIconButton
            onClick={() => onToggleCollapsed?.()}
            title={collapsed ? 'Show alignment controls' : 'Hide alignment controls'}
            accent={palette.accent}
            rowHoverClass={palette.rowHoverClass}
            expanded={!collapsed}
        >
            <DrawerChevron pointsRight={!collapsed} size={20} />
        </DrawerIconButton>
    )

    // Collapsed: the narrow rail the other drawers leave behind, with the way back
    // out where a reader expects it.
    if (collapsed) {
        return (
            <div className="h-full rounded-lg border overflow-hidden flex flex-col" style={palette.surface}>
                <div className="flex-none flex items-center justify-center py-1.5" style={palette.band}>
                    {toggleButton}
                </div>
            </div>
        )
    }

    const safeGlobalMax = clampMin(globalFlankMax, 100, 1000)
    const resolvedCount = rows.filter((row) => row.status === 'resolved').length
    const canSearchAll = Boolean(sharedQuery.trim()) && rows.length > 0 && !loading

    return (
        <div className="rounded-lg border overflow-visible flex flex-col" style={palette.surface}>
            <div className="flex-none flex items-center gap-2 pl-1 pr-3 py-1.5 rounded-t-lg" style={palette.band}>
                {toggleButton}
                <div className="min-w-0">
                    <div className="text-sm font-semibold leading-tight">Feature Alignment</div>
                    <div className="text-[11px] leading-tight opacity-75">
                        {rows.length
                            ? `${resolvedCount} of ${rows.length} genome${rows.length === 1 ? '' : 's'} resolved`
                            : 'No genomes with annotation active'}
                    </div>
                </div>
            </div>

            {/* One gene for every genome, the way Homology searches them all. */}
            <form
                className="flex gap-2 px-3 pt-3 pb-2"
                onSubmit={(event) => {
                    event.preventDefault()
                    if (canSearchAll) onSearchAll?.(sharedQuery.trim())
                }}
            >
                <input
                    type="text"
                    value={sharedQuery}
                    onChange={(e) => setSharedQuery(e.target.value)}
                    placeholder="Gene symbol or ID across all genomes"
                    aria-label="Gene symbol or ID across all genomes"
                    className={`flex-1 min-w-0 ${inputClass} border rounded px-2 py-1.5 text-xs`}
                    disabled={loading}
                />
                <button
                    type="submit"
                    disabled={!canSearchAll}
                    className="px-3 py-1.5 rounded text-xs font-medium text-white bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-not-allowed whitespace-nowrap"
                >
                    Search all
                </button>
            </form>

            <div className="pt-1">
                <DrawerSectionHeading label="Genomes" count={rows.length} divider={palette.divider} subTextClass={palette.subTextClass}>
                    <DrawerIconButton
                        onClick={() => setGenomesOpen((prev) => !prev)}
                        title={genomesOpen ? 'Collapse genomes' : 'Expand genomes'}
                        accent={palette.accent}
                        rowHoverClass={palette.rowHoverClass}
                        expanded={genomesOpen}
                        compact
                    ><VerticalChevronGlyph pointsDown={!genomesOpen} size={17} /></DrawerIconButton>
                </DrawerSectionHeading>
                {genomesOpen && rows.map((row, idx) => {
                    const isExpanded = !!expandedRows[row.genome_key]
                    const transcripts = row?.resolved?.transcripts || []
                    const canExpand = row.status === 'resolved'
                    const rowFlankMax = clampMin(row.settings?.flankMax, 100, 1000)
                    const rowFlanksLocked = Boolean(row.settings?.flanksLocked ?? true)
                    const selectedTranscriptId = row.settings?.selectedTranscriptId || row.resolved?.selectedTranscriptId || ''
                    const selectedTranscript = transcripts.find((tx) => String(tx?.id || '') === String(selectedTranscriptId || ''))
                    const selectedIsCanonical = Boolean(selectedTranscript?.is_canonical)
                    const displayMeta = rowDisplayMetaByGenomeKey?.[row.genome_key] || {}
                    const pillColors = genomePillColors(
                        genomeColorsByKey[row.genome_key] || DEFAULT_GENOME_COLOR,
                        { isLight, state: 'active' }
                    )
                    const geneLabel = String(
                        displayMeta?.geneLabel
                        || row?.resolved?.gene?.name
                        || row?.resolved?.gene?.id
                        || ''
                    ).trim()

                    return (
                        <div
                            key={row.genome_key}
                            className={`px-3 py-2.5 space-y-2 ${idx > 0 ? 'border-t' : ''}`}
                            style={{ borderColor: palette.divider }}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <span
                                    className="inline-flex items-center h-6 max-w-[230px] px-2.5 text-xs font-medium truncate rounded-full border"
                                    style={{
                                        backgroundColor: pillColors.backgroundColor,
                                        color: pillColors.textColor,
                                        borderColor: pillColors.borderColor,
                                    }}
                                >
                                    <span className="truncate">{row.pillLabel}</span>
                                </span>
                                <span className={`text-xs font-semibold ${palette.subTextClass}`}>{row.tag}</span>
                            </div>

                            <form
                                className="flex gap-2"
                                onSubmit={(event) => {
                                    event.preventDefault()
                                    onResolveRow?.(row.genome_key)
                                }}
                            >
                                <input
                                    type="text"
                                    value={row.query || ''}
                                    onChange={(e) => onRowQueryChange?.(row.genome_key, e.target.value)}
                                    placeholder="Gene name, gene ID, or transcript ID"
                                    className={`flex-1 min-w-0 ${inputClass} border rounded px-2 py-1.5 text-xs`}
                                    disabled={loading}
                                />
                                <button
                                    type="submit"
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
                            </form>

                            {/* What it resolved to, and the way into its options. */}
                            <div className="flex items-center gap-1.5 min-h-[22px]">
                                <div className="min-w-0 flex-1 flex items-center gap-1.5 text-[11px]">
                                    {row.error ? (
                                        <span className="text-red-400 truncate">{row.error}</span>
                                    ) : canExpand && selectedTranscriptId ? (
                                        <>
                                            {geneLabel ? <span className={`font-medium truncate ${palette.textClass}`}>{geneLabel}</span> : null}
                                            <span className={`font-mono truncate ${isLight ? 'text-blue-700' : 'text-blue-300'}`}>{selectedTranscriptId}</span>
                                            {selectedIsCanonical && (
                                                <span className={`flex-none text-[10px] leading-[1.1] px-1.5 py-0.5 rounded-full ${isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-400'}`}>
                                                    canonical
                                                </span>
                                            )}
                                        </>
                                    ) : (
                                        <span className={palette.subTextClass}>
                                            {row.status === 'resolving' ? 'Resolving…' : 'Not resolved yet'}
                                        </span>
                                    )}
                                </div>
                                <DrawerIconButton
                                    onClick={() => {
                                        if (!canExpand) return
                                        setExpandedRows((prev) => ({ ...prev, [row.genome_key]: !isExpanded }))
                                    }}
                                    title={canExpand ? (isExpanded ? 'Hide options' : 'Transcript, boundaries and flanks') : 'Resolve a gene first to set its options'}
                                    accent={canExpand ? palette.accent : palette.divider}
                                    rowHoverClass={canExpand ? palette.rowHoverClass : ''}
                                    expanded={isExpanded}
                                    compact
                                ><CogGlyph size={16} /></DrawerIconButton>
                            </div>

                            {canExpand && isExpanded && (
                                <div className="space-y-2 pt-1">
                                    {transcripts.length > 0 && (
                                        <label className={`text-xs ${palette.subTextClass} block`}>
                                            Transcript
                                            <select
                                                value={selectedTranscriptId}
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
                                    <label className={`relative flex items-center gap-2 text-xs ${palette.subTextClass} group`}>
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
                                    <label className={`flex items-center gap-2 text-xs ${palette.subTextClass}`}>
                                        <input
                                            type="checkbox"
                                            checked={Boolean(row.settings?.overlayAnnotation)}
                                            onChange={(e) => onRowSettingChange?.(row.genome_key, { overlayAnnotation: e.target.checked })}
                                        />
                                        Overlay annotation
                                    </label>
                                    <label className={`flex items-center gap-2 text-xs ${palette.subTextClass}`}>
                                        <input
                                            type="checkbox"
                                            checked={Boolean(row.settings?.useGlobalFlanks)}
                                            onChange={(e) => onRowSettingChange?.(row.genome_key, { useGlobalFlanks: e.target.checked })}
                                        />
                                        Use global flanks
                                    </label>
                                    {!row.settings?.useGlobalFlanks && (
                                        <FlankControls
                                            isLight={isLight}
                                            palette={palette}
                                            inputClass={inputClass}
                                            flank5={Math.max(0, Number(row.settings?.flank5) || 0)}
                                            flank3={Math.max(0, Number(row.settings?.flank3) || 0)}
                                            max={rowFlankMax}
                                            locked={rowFlanksLocked}
                                            disabled={loading}
                                            lockTitle={rowFlanksLocked ? 'Per-genome sliders linked' : 'Per-genome sliders independent'}
                                            onFlankChange={(patch) => onRowSettingChange?.(row.genome_key, patch)}
                                            onLockToggle={() => onRowSettingChange?.(row.genome_key, { flanksLocked: !rowFlanksLocked })}
                                            onMaxChange={(value) => onRowSettingChange?.(row.genome_key, { flankMax: value })}
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            <div className="pt-1 pb-1">
                <DrawerSectionHeading label="Flanks & settings" divider={palette.divider} subTextClass={palette.subTextClass}>
                    <DrawerIconButton
                        onClick={() => setSettingsOpen((prev) => !prev)}
                        title={settingsOpen ? 'Collapse flanks and settings' : 'Expand flanks and settings'}
                        accent={palette.accent}
                        rowHoverClass={palette.rowHoverClass}
                        expanded={settingsOpen}
                        compact
                    ><VerticalChevronGlyph pointsDown={!settingsOpen} size={17} /></DrawerIconButton>
                </DrawerSectionHeading>
                {settingsOpen && (
                    <div className="px-3 pt-1 pb-2 space-y-3">
                        <FlankControls
                            isLight={isLight}
                            palette={palette}
                            inputClass={inputClass}
                            flank5={Math.max(0, Number(globalFlanks.flank5) || 0)}
                            flank3={Math.max(0, Number(globalFlanks.flank3) || 0)}
                            max={safeGlobalMax}
                            locked={globalFlanksLocked}
                            disabled={loading}
                            lockTitle={globalFlanksLocked ? 'Global sliders linked' : 'Global sliders independent'}
                            onFlankChange={(patch) => onGlobalFlanksChange?.(patch)}
                            onLockToggle={onGlobalFlanksLockToggle}
                            onMaxChange={(value) => onGlobalFlankMaxChange?.(value)}
                        />
                        <div className="space-y-2">
                            <div className={`text-xs ${palette.subTextClass}`}>
                                Execution profile: <span className={isLight ? 'text-blue-700 font-semibold' : 'text-blue-300 font-semibold'}>balanced</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <label className={`text-xs ${palette.subTextClass}`}>
                                    soft_warn_sequences
                                    <input
                                        type="number"
                                        min={2}
                                        value={runSettings.soft_warn_sequences ?? 6}
                                        onChange={(e) => onRunSettingsChange?.({ soft_warn_sequences: Math.max(2, parseInt(e.target.value || '2', 10) || 2) })}
                                        className={`no-number-spin mt-1 w-full ${inputClass} border rounded px-2 py-1 text-xs`}
                                    />
                                </label>
                                <label className={`text-xs ${palette.subTextClass}`}>
                                    hard_cap_sequences
                                    <input
                                        type="number"
                                        min={2}
                                        value={runSettings.hard_cap_sequences ?? 10}
                                        onChange={(e) => onRunSettingsChange?.({ hard_cap_sequences: Math.max(2, parseInt(e.target.value || '2', 10) || 2) })}
                                        className={`no-number-spin mt-1 w-full ${inputClass} border rounded px-2 py-1 text-xs`}
                                    />
                                </label>
                                <label className={`text-xs ${palette.subTextClass}`}>
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
                                <label className={`text-xs ${palette.subTextClass}`}>
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
                )}
            </div>

            <div className="px-3 pt-3 pb-3 space-y-2 border-t" style={{ borderColor: palette.divider }}>
                {visibleCompletionNotices.length > 0 && (
                    <div className={`rounded-md px-3 py-2 text-xs ${isLight ? 'bg-blue-50 text-blue-800' : 'bg-blue-900/20 text-blue-200'}`}>
                        {visibleCompletionNotices.map((msg, idx) => (
                            <div key={`${idx}-${msg}`}>{msg}</div>
                        ))}
                    </div>
                )}
                {persistentWarningMessages.length > 0 && (
                    <div className={`rounded-md px-3 py-2 text-xs ${isLight ? 'bg-yellow-50 text-yellow-800' : 'bg-yellow-900/20 text-yellow-300'}`}>
                        {persistentWarningMessages.map((msg, idx) => (
                            <div key={`${idx}-${msg}`}>{msg}</div>
                        ))}
                    </div>
                )}
                <button
                    type="button"
                    onClick={onRunAlignment}
                    disabled={loading || runDisabled}
                    className="w-full bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded transition-colors"
                >
                    {loading ? 'Running...' : 'Run alignment'}
                </button>
                {showUpdateNotice && (
                    <div className={`text-xs text-center ${isLight ? 'text-yellow-700' : 'text-yellow-400'}`}>
                        Run alignment to update region
                    </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={onSaveAlignment} disabled={!hasResult || loading} className={secondaryButtonClass}>
                        Save alignment
                    </button>
                    <button type="button" onClick={onLoadAlignment} disabled={loading} className={secondaryButtonClass}>
                        Load alignment
                    </button>
                </div>
                <div className={`text-[11px] ${palette.subTextClass}`}>
                    Aligned genomes: {Math.max(0, Number(alignedGenomeCount) || 0)} · Unaligned: {Math.max(0, Number(unalignedGenomeCount) || 0)}
                </div>
            </div>
        </div>
    )
}
