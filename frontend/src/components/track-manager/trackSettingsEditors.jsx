import { useEffect, useState } from 'react'
import { checkCustomZones, formatZoneLabel, initialCustomZones } from '../../utils/zonedScale.js'
import { TrackColorField } from './TrackColor'
import { BIGWIG_DATA_TYPES, BIGWIG_DEFAULTS, DISPLAY_MODES, SPLICE_ANNOTATED_OPTIONS, SPLICE_CANONICAL_OPTIONS, TYPE_COLORS, VCF_SETTINGS_DEFAULTS, applyBigWigDataTypeChange, normalizeBedSettings, normalizeBigWigDataType, normalizeBigWigDisplayMode, normalizeBigWigSettings, normalizeSpliceSettings, normalizeVcfSettings, zoneScaleOptions } from './trackManagerModel.js'

/** Four boxes for where each zone ends, checked as they are typed. */
export function CustomZonesEditor({ zones, onChange, isLight, inputCls }) {
    const fromZones = (list) => [0, 1, 2, 3].map((i) => {
        const v = Array.isArray(list) ? list[i] : undefined
        return Number.isFinite(v) ? String(v) : ''
    })
    const [drafts, setDrafts] = useState(() => fromZones(zones))
    // Follow zones set from outside (switching to custom, a reset) without fighting the
    // boxes while they are typed in: only when they no longer describe what is shown.
    useEffect(() => {
        const shown = checkCustomZones(drafts).zones
        const incoming = Array.isArray(zones) ? zones : []
        const same = shown.every((v, i) => Object.is(v, Number(incoming[i])) || (Number.isNaN(v) && Number.isNaN(Number(incoming[i]))))
        if (!same) setDrafts(fromZones(zones))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [zones])
    const check = checkCustomZones(drafts)
    const update = (index, text) => {
        const next = drafts.slice()
        next[index] = text
        setDrafts(next)
        onChange(checkCustomZones(next).zones)
    }
    return (
        <div className="mb-3">
            <div className="grid grid-cols-2 gap-2">
                {drafts.map((text, index) => (
                    <label key={index} className={`flex items-center gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                        <span className="w-24 shrink-0">Zone {index + 1} up to</span>
                        <input
                            type="text"
                            inputMode="decimal"
                            value={text}
                            onChange={(e) => update(index, e.target.value)}
                            aria-invalid={!check.ok && !Number.isFinite(check.zones[index]) ? 'true' : undefined}
                            className={inputCls}
                        />
                    </label>
                ))}
            </div>
            <p className={`mt-1 text-xs ${check.ok
                ? (isLight ? 'text-gray-500' : 'text-gray-400')
                : (isLight ? 'text-red-600' : 'text-red-400')}`}
            >
                {check.ok
                    ? `Values above ${formatZoneLabel(check.zones[3]).slice(1)} fill the top zone.`
                    : check.message}
            </p>
        </div>
    )
}

export function SpliceSettingsEditor({ value, onChange, isLight }) {
    const settings = normalizeSpliceSettings(value)
    const weakLt = Number(settings.weak_max_support) + 1
    const lowLt = Number(settings.low_max_support) + 1
    const mediumLt = Number(settings.medium_max_support) + 1
    const [minSupportInput, setMinSupportInput] = useState(String(settings.min_support))
    const [weakLtInput, setWeakLtInput] = useState(String(weakLt))
    const [lowLtInput, setLowLtInput] = useState(String(lowLt))
    const [mediumLtInput, setMediumLtInput] = useState(String(mediumLt))

    useEffect(() => { setMinSupportInput(String(settings.min_support)) }, [settings.min_support])
    useEffect(() => { setWeakLtInput(String(weakLt)) }, [weakLt])
    useEffect(() => { setLowLtInput(String(lowLt)) }, [lowLt])
    useEffect(() => { setMediumLtInput(String(mediumLt)) }, [mediumLt])

    const cleanNumericInput = (raw) => String(raw || '').replace(/[^\d]/g, '')
    const commitMinSupport = () => {
        const parsed = Number.parseInt(minSupportInput, 10)
        onChange({ ...settings, min_support: Number.isFinite(parsed) && parsed > 0 ? parsed : 1 })
    }
    const commitWeakLt = () => {
        const parsed = Number.parseInt(weakLtInput, 10)
        const lt = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
        onChange({ ...settings, weak_max_support: Math.max(0, lt - 1) })
    }
    const commitLowLt = () => {
        const parsed = Number.parseInt(lowLtInput, 10)
        const lt = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
        onChange({ ...settings, low_max_support: Math.max(0, lt - 1) })
    }
    const commitMediumLt = () => {
        const parsed = Number.parseInt(mediumLtInput, 10)
        const lt = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
        onChange({ ...settings, medium_max_support: Math.max(0, lt - 1) })
    }
    const inputCls = `w-full px-2.5 py-1.5 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40'}`
    const labelCls = `block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`
    return (
        <div className={`rounded-lg border p-3 space-y-2 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
            <div className="grid grid-cols-1 gap-2">
                <div>
                    <label className={labelCls}>Min support</label>
                    <input
                        type="text"
                        inputMode="numeric"
                        value={minSupportInput}
                        onChange={(e) => setMinSupportInput(cleanNumericInput(e.target.value))}
                        onBlur={commitMinSupport}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commitMinSupport()
                                e.currentTarget.blur()
                            }
                        }}
                        className={inputCls}
                    />
                </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
                <div>
                    <label className={labelCls}>Weak (&lt;)</label>
                    <input
                        type="text"
                        inputMode="numeric"
                        value={weakLtInput}
                        onChange={(e) => setWeakLtInput(cleanNumericInput(e.target.value))}
                        onBlur={commitWeakLt}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commitWeakLt()
                                e.currentTarget.blur()
                            }
                        }}
                        className={inputCls}
                    />
                </div>
                <div>
                    <label className={labelCls}>Low (&lt;)</label>
                    <input
                        type="text"
                        inputMode="numeric"
                        value={lowLtInput}
                        onChange={(e) => setLowLtInput(cleanNumericInput(e.target.value))}
                        onBlur={commitLowLt}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commitLowLt()
                                e.currentTarget.blur()
                            }
                        }}
                        className={inputCls}
                    />
                </div>
                <div>
                    <label className={labelCls}>Medium (&lt;)</label>
                    <input
                        type="text"
                        inputMode="numeric"
                        value={mediumLtInput}
                        onChange={(e) => setMediumLtInput(cleanNumericInput(e.target.value))}
                        onBlur={commitMediumLt}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                commitMediumLt()
                                e.currentTarget.blur()
                            }
                        }}
                        className={inputCls}
                    />
                </div>
            </div>
            <p className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                Rule: weak cutoff ≥ min support, low {'>'} weak, medium {'>'} low. High is support ≥ medium cutoff.
            </p>
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <label className={labelCls}>Canonical filter</label>
                    <select
                        value={settings.canonical_mode}
                        onChange={(e) => onChange({ ...settings, canonical_mode: e.target.value })}
                        className={inputCls}
                    >
                        {SPLICE_CANONICAL_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className={labelCls}>Annotation filter</label>
                    <select
                        value={settings.annotated_mode}
                        onChange={(e) => onChange({ ...settings, annotated_mode: e.target.value })}
                        className={inputCls}
                    >
                        {SPLICE_ANNOTATED_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                    </select>
                </div>
            </div>
            <label className={`flex items-center gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                <input
                    type="checkbox"
                    checked={!!settings.show_arrows}
                    onChange={(e) => onChange({ ...settings, show_arrows: e.target.checked })}
                />
                Show direction arrows
            </label>
        </div>
    )
}

export function VcfSettingsEditor({ settings, onChange, isLight, trackLabel = '' }) {
    const normalized = normalizeVcfSettings(settings)
    return (
        <div className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
            <div className="grid grid-cols-2 gap-3">
                <TrackColorField
                    label="Genic colour"
                    color={normalized.genic_color}
                    defaultColor={VCF_SETTINGS_DEFAULTS.genic_color}
                    onChange={(genic_color) => onChange({ ...normalized, genic_color })}
                    isLight={isLight}
                    previewKind="variants"
                    pickerTitle="Genic variant colour"
                    pickerSubtitle={trackLabel}
                />
                <TrackColorField
                    label="Intergenic colour"
                    color={normalized.intergenic_color}
                    defaultColor={VCF_SETTINGS_DEFAULTS.intergenic_color}
                    onChange={(intergenic_color) => onChange({ ...normalized, intergenic_color })}
                    isLight={isLight}
                    previewKind="variants"
                    pickerTitle="Intergenic variant colour"
                    pickerSubtitle={trackLabel}
                />
            </div>
        </div>
    )
}

export function BedSettingsEditor({ settings, trackType, onChange, isLight, trackLabel = '' }) {
    const normalized = normalizeBedSettings(settings)
    return (
        <div className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
        <TrackColorField
            color={normalized.color}
            defaultColor={TYPE_COLORS[trackType] || TYPE_COLORS.bed}
            onChange={(color) => onChange({ color })}
            isLight={isLight}
            previewKind="intervals"
            pickerTitle="Track colour"
            pickerSubtitle={trackLabel}
            automatic
        />
        </div>
    )
}

export function BigWigSettingsEditor({
    settings,
    displayMode,
    // More than one: the settings are shared by that many files registered together, and
    // "scaled to the file" means scaled across all of them.
    sharedFileCount = 1,
    onSettingsChange,
    onDisplayModeChange,
    onDataTypeChange,
    onDataTypeSelect,
    selectedDataType = '',
    requireDataTypeSelection = false,
    isLight,
    // Anchored by the caller: the wizard and an editing track card both render this, and
    // an anchor resolves to the first match, so only one of them may carry the ids.
    dataTypeTourId,
    displayModeTourId,
}) {
    const normalized = normalizeBigWigSettings(settings)
    const hasDataTypeSelection = !requireDataTypeSelection || !!selectedDataType
    const effectiveDataType = hasDataTypeSelection
        ? normalizeBigWigDataType(selectedDataType || normalized.data_type, normalized.data_type)
        : ''
    const effectiveSettings = hasDataTypeSelection
        ? normalizeBigWigSettings({ data_type: effectiveDataType }, normalized)
        : normalized
    const inputCls = `w-full px-2.5 py-1.5 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40'}`
    const labelCls = `block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`

    const handleDataType = (nextType) => {
        const token = String(nextType || '').trim()
        if (!token) return
        onDataTypeSelect?.(token)
        const changed = applyBigWigDataTypeChange(nextType, displayMode, normalized)
        if (onDataTypeChange) {
            onDataTypeChange(changed.settings, changed.display_mode)
            return
        }
        onSettingsChange(changed.settings)
        onDisplayModeChange(changed.display_mode)
    }

    const resetPlotColor = () => {
        const defaults = BIGWIG_DEFAULTS[effectiveSettings.data_type]
        onSettingsChange({
            ...effectiveSettings,
            plot_color: defaults.plot_color,
            use_default_plot_color: true,
        })
    }

    const resetZonedColors = () => {
        const defaults = BIGWIG_DEFAULTS[effectiveSettings.data_type]
        onSettingsChange({
            ...effectiveSettings,
            zoned_colors: defaults.zoned_colors.slice(0, 4),
            use_default_zoned_colors: true,
        })
    }

    return (
        <div className={`rounded-lg border p-3 space-y-3 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
            <div>
                <label className={labelCls}>Data type</label>
                <select
                    data-tour-id={dataTypeTourId}
                    value={requireDataTypeSelection ? selectedDataType : effectiveSettings.data_type}
                    onChange={(e) => handleDataType(e.target.value)}
                    className={inputCls}
                >
                    {requireDataTypeSelection && <option value="">Select data type…</option>}
                    {BIGWIG_DATA_TYPES.map((opt) => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                </select>
            </div>
            {hasDataTypeSelection ? (
                <>
                    <div>
                        <label className={labelCls}>Display mode</label>
                        <select
                            data-tour-id={displayModeTourId}
                            value={displayMode}
                            onChange={(e) => onDisplayModeChange(normalizeBigWigDisplayMode(e.target.value, effectiveSettings.data_type))}
                            className={inputCls}
                        >
                            {(DISPLAY_MODES.bigwig || []).map((m) => (
                                <option key={m.id} value={m.id}>{m.label}</option>
                            ))}
                        </select>
                    </div>
                    {displayMode === 'signal_plot' ? (
                        <div>
                            <TrackColorField
                                label="Plot colour"
                                color={effectiveSettings.plot_color}
                                defaultColor={BIGWIG_DEFAULTS[effectiveSettings.data_type].plot_color}
                                onChange={(plot_color) => {
                                    if (plot_color === BIGWIG_DEFAULTS[effectiveSettings.data_type].plot_color) {
                                        resetPlotColor()
                                        return
                                    }
                                    onSettingsChange({ ...effectiveSettings, plot_color, use_default_plot_color: false })
                                }}
                                isLight={isLight}
                                previewKind="signal"
                                pickerTitle="Plot colour"
                            />
                        </div>
                    ) : (
                        <div>
                            <label className={labelCls}>Zone scale</label>
                            <select
                                value={effectiveSettings.zone_scale}
                                onChange={(e) => {
                                    const zoneScale = e.target.value
                                    // Custom starts from this track's own zones, else the last ones
                                    // saved on any track, else the fixed ones.
                                    onSettingsChange(zoneScale === 'custom'
                                        ? { ...effectiveSettings, zone_scale: zoneScale, custom_zones: initialCustomZones(effectiveSettings.custom_zones) }
                                        : { ...effectiveSettings, zone_scale: zoneScale })
                                }}
                                className={inputCls}
                            >
                                {zoneScaleOptions(sharedFileCount, effectiveSettings).map((opt) => (
                                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                                ))}
                            </select>
                            <p className={`mt-1 mb-3 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                {zoneScaleOptions(sharedFileCount, effectiveSettings).find((opt) => opt.id === effectiveSettings.zone_scale)?.hint}
                            </p>
                            {effectiveSettings.zone_scale === 'custom' && (
                                <CustomZonesEditor
                                    zones={effectiveSettings.custom_zones}
                                    onChange={(customZones) => onSettingsChange({ ...effectiveSettings, custom_zones: customZones })}
                                    isLight={isLight}
                                    inputCls={inputCls}
                                />
                            )}
                            <label className={labelCls}>Zone colours</label>
                            <div className="grid grid-cols-2 gap-2">
                                {effectiveSettings.zoned_colors.map((color, idx) => (
                                    <TrackColorField
                                        key={idx}
                                        compact
                                        label={`Zone ${idx + 1}`}
                                        color={color}
                                        defaultColor={BIGWIG_DEFAULTS[effectiveSettings.data_type].zoned_colors[idx]}
                                        onChange={(nextColor) => {
                                            const next = effectiveSettings.zoned_colors.slice(0, 4)
                                            next[idx] = nextColor
                                            onSettingsChange({
                                                ...effectiveSettings,
                                                zoned_colors: next,
                                                use_default_zoned_colors: false,
                                            })
                                        }}
                                        isLight={isLight}
                                        previewKind="signal"
                                        pickerTitle={`Zone ${idx + 1} colour`}
                                    />
                                ))}
                            </div>
                            <button
                                type="button"
                                onClick={resetZonedColors}
                                className={`mt-2 px-2.5 py-1.5 rounded-md text-xs font-medium ${isLight ? 'text-blue-700 bg-blue-50 hover:bg-blue-100' : 'text-blue-300 bg-blue-900/30 hover:bg-blue-900/50'}`}
                            >
                                Reset to defaults
                            </button>
                        </div>
                    )}
                </>
            ) : (
                <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                    Select a data type to load display mode and color defaults.
                </p>
            )}
        </div>
    )
}

/**
 * One track type's options: BigWig plot settings, display mode, splice filters, colours.
 * The same editor serves a single file, a whole type group, and one file of a group given
 * settings of its own, so the three never drift apart. It carries the tutorial's anchors:
 * only one is ever on screen at a time.
 */
export function TypeSettingsEditor({ type, value, onChange, isLight, labelCls, inputCls, trackLabel = '', sharedFileCount = 1, allowAutomatic = true }) {
    const patch = (next) => onChange({ ...value, ...next })
    if (!type) return null
    return (
        <div className="space-y-4">
            {type === 'bigwig' && (
                <div data-tour-id="track-wizard-bigwig">
                    <label className={labelCls}>BigWig plot settings</label>
                    <BigWigSettingsEditor
                        dataTypeTourId="track-wizard-datatype"
                        displayModeTourId="track-wizard-display"
                        settings={value.bigWigSettings}
                        displayMode={value.displayMode}
                        onSettingsChange={(next) => patch({ bigWigSettings: normalizeBigWigSettings(next, value.bigWigSettings) })}
                        onDisplayModeChange={(mode) => patch({ displayMode: mode })}
                        onDataTypeChange={(nextSettings, nextDisplayMode) => {
                            const normalized = normalizeBigWigSettings(nextSettings, value.bigWigSettings)
                            patch({
                                bigWigSettings: normalized,
                                bigWigDataType: normalizeBigWigDataType(normalized.data_type, ''),
                                displayMode: normalizeBigWigDisplayMode(nextDisplayMode, normalized.data_type),
                            })
                        }}
                        onDataTypeSelect={(dataType) => patch({ bigWigDataType: dataType })}
                        selectedDataType={value.bigWigDataType}
                        requireDataTypeSelection
                        sharedFileCount={sharedFileCount}
                        isLight={isLight}
                    />
                </div>
            )}
            {type !== 'bigwig' && (DISPLAY_MODES[type] || []).length > 1 && (
                <div>
                    <label className={labelCls}>Display mode</label>
                    <select
                        data-tour-id="track-wizard-display-mode"
                        value={value.displayMode}
                        onChange={(e) => patch({ displayMode: e.target.value })}
                        className={inputCls}
                    >
                        {type === 'gff' && allowAutomatic && (
                            <option value="">Automatic (gene models if the file has transcripts)</option>
                        )}
                        {(DISPLAY_MODES[type] || []).map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                    </select>
                </div>
            )}
            {type === 'splice_junctions' && (
                <div>
                    <label className={labelCls}>Splice filters</label>
                    <SpliceSettingsEditor
                        value={value.spliceSettings}
                        onChange={(next) => patch({ spliceSettings: next })}
                        isLight={isLight}
                    />
                </div>
            )}
            {type === 'vcf' && (
                <div data-tour-id="track-wizard-vcf">
                    <label className={labelCls}>VCF colours</label>
                    <VcfSettingsEditor
                        trackLabel={trackLabel}
                        settings={value.vcfSettings}
                        onChange={(next) => patch({ vcfSettings: normalizeVcfSettings(next, value.vcfSettings) })}
                        isLight={isLight}
                    />
                </div>
            )}
            {['bed', 'bigbed', 'gff'].includes(type) && (
                <div>
                    <label className={labelCls}>Colour</label>
                    <BedSettingsEditor
                        trackLabel={trackLabel}
                        settings={value.bedSettings}
                        trackType={type}
                        onChange={(next) => patch({ bedSettings: normalizeBedSettings(next) })}
                        isLight={isLight}
                    />
                </div>
            )}
        </div>
    )
}
