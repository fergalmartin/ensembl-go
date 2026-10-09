import { useMemo } from 'react'
import { API_BASE } from '../../backendRuntime.js'
import { checkCustomZones, formatZoneLabel } from '../../utils/zonedScale.js'
import { normalizeVcfDisplayMode } from '../genome-browser/trackSettings.js'
import { ColorSwatch } from '../GenomeColorPicker'
import { BIGWIG_DATA_TYPES, DISPLAY_MODES, basenameFromPath, fallbackGenomeLabel, findGenomeOption, normalizeBedSettings, normalizeBigWigDisplayMode, normalizeBigWigSettings, normalizeSpliceSettings, normalizeVcfSettings } from './trackManagerModel.js'
import { TypeBadge } from './trackManagerParts'

export function TrackCard({ track, isLight, genomeOptions, onDelete, onEdit, selected = false, onToggleSelected, groupNames = [] }) {
    // A card shows a track; editing it — alone or with others — happens in the same
    // dialog that registers tracks, so adding and changing them work the same way.
    const spliceSummary = useMemo(
        () => (track.type === 'splice_junctions' ? normalizeSpliceSettings(track.splice_settings) : null),
        [track.type, track.splice_settings]
    )
    const bigWigSummary = useMemo(() => {
        if (track.type !== 'bigwig') return null
        return normalizeBigWigSettings(track.bigwig_settings)
    }, [track.type, track.bigwig_settings])
    const vcfSummary = useMemo(() => {
        if (track.type !== 'vcf') return null
        return normalizeVcfSettings(track.vcf_settings)
    }, [track.type, track.vcf_settings])
    const bedSummary = useMemo(() => {
        if (!['bed', 'bigbed', 'gff'].includes(track.type)) return null
        return normalizeBedSettings(track.bed_settings)
    }, [track.type, track.bed_settings])

    const genomeName = useMemo(() => {
        const opt = findGenomeOption(genomeOptions, track.genome_key)
        return opt?.label || track.genome_label || fallbackGenomeLabel(track.genome_key) || 'Any genome'
    }, [track.genome_key, track.genome_label, genomeOptions])

    const handleDelete = async () => {
        const inGroups = groupNames.length
            ? `\nIt will also leave ${groupNames.length === 1 ? `the group "${groupNames[0]}"` : `${groupNames.length} groups`}.`
            : ''
        if (!window.confirm(`Remove track "${track.label}"?\n(The file itself will not be deleted.)${inGroups}`)) return
        try {
            await fetch(`${API_BASE}/api/tracks/${track.id}`, { method: 'DELETE' })
            onDelete(track.id)
        } catch {
            // ignore
        }
    }

    const displayModeSummaryId = track.type === 'bigwig'
        ? normalizeBigWigDisplayMode(track.display_mode, bigWigSummary?.data_type)
        : track.type === 'vcf'
            ? normalizeVcfDisplayMode(track.display_mode)
        : track.display_mode

    return (
        // Anchored by label rather than by registry id: the id is minted at registration
        // and a tutorial cannot know it, but the label is exactly what the tutorial typed.
        <div
            data-tour-id={`track-manager-track-${track.id}`}
            data-tutorial-track-label={track.label || ''}
            className={`h-full rounded-xl border p-4 transition-colors ${selected
                ? (isLight ? 'bg-blue-50/60 border-blue-300' : 'bg-blue-900/20 border-blue-600/70')
                : (isLight ? 'bg-white border-gray-200 hover:border-blue-200' : 'bg-gray-800 border-gray-700 hover:border-blue-700/50')}`}
        >
                <div className="flex items-start gap-3">
                    <button
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={`Select ${track.label}`}
                        data-tutorial-engaged={selected ? 'true' : 'false'}
                        data-tutorial-track-select={track.label || ''}
                        onClick={() => onToggleSelected(track.id)}
                        className="-m-2 p-2 shrink-0 rounded-lg"
                    >
                        <input
                            type="checkbox"
                            readOnly
                            tabIndex={-1}
                            checked={selected}
                            className="pointer-events-none rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                    </button>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <TypeBadge type={track.type} small />
                            <span className={`text-sm font-semibold truncate ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{track.label}</span>
                        </div>
                        <p className={`text-xs mt-1 font-mono truncate ${isLight ? 'text-gray-400' : 'text-gray-500'}`} title={track.path}>
                            {basenameFromPath(track.path)}
                        </p>
                        <div className="flex flex-col gap-0.5 mt-1.5">
                            <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                Display mode: {DISPLAY_MODES[track.type]?.find(m => m.id === displayModeSummaryId)?.label || displayModeSummaryId?.replace(/_/g, ' ')}
                            </span>
                            <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                Genome: {genomeName}
                            </span>
                            {bigWigSummary && (
                                <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Data type: {BIGWIG_DATA_TYPES.find((opt) => opt.id === bigWigSummary.data_type)?.label || bigWigSummary.data_type}
                                    {displayModeSummaryId === 'zoned_heatmap'
                                        ? ` · Zones: ${bigWigSummary.zone_scale === 'files'
                                            ? 'shared across files'
                                            : bigWigSummary.zone_scale === 'file'
                                            ? 'scaled to file'
                                            : bigWigSummary.zone_scale === 'custom' && checkCustomZones(bigWigSummary.custom_zones).ok
                                                ? `custom (${bigWigSummary.custom_zones.map((v) => formatZoneLabel(v).slice(1)).join(' / ')})`
                                                : 'fixed'}`
                                        : ''}
                                </span>
                            )}
                            {vcfSummary && (
                                <span className={`text-xs inline-flex items-center gap-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    <span>Colours: genic</span>
                                    <ColorSwatch color={vcfSummary.genic_color} size={12} />
                                    <span>{vcfSummary.genic_color}, intergenic</span>
                                    <ColorSwatch color={vcfSummary.intergenic_color} size={12} />
                                    <span>{vcfSummary.intergenic_color}</span>
                                </span>
                            )}
                            {bedSummary && (
                                <span className={`text-xs inline-flex items-center gap-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    <span>Colour:</span>
                                    {bedSummary.color ? (
                                        <>
                                            <ColorSwatch color={bedSummary.color} size={12} />
                                            <span>{bedSummary.color}</span>
                                        </>
                                    ) : <span>automatic</span>}
                                </span>
                            )}
                            {groupNames.length > 0 && (
                                <span className={`text-xs truncate ${isLight ? 'text-indigo-600' : 'text-indigo-300'}`} title={groupNames.join(', ')}>
                                    In group{groupNames.length === 1 ? '' : 's'}: {groupNames.join(', ')}
                                </span>
                            )}
                            {spliceSummary && (
                                <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    Splice: min {spliceSummary.min_support}; weak &lt; {spliceSummary.weak_max_support + 1}, low &lt; {spliceSummary.low_max_support + 1}, medium &lt; {spliceSummary.medium_max_support + 1}
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        <button
                            onClick={() => onEdit(track)}
                            className={`p-1.5 rounded-lg text-xs ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                            title="Edit"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                        </button>
                        <button
                            onClick={handleDelete}
                            className={`p-1.5 rounded-lg text-xs ${isLight ? 'text-red-400 hover:bg-red-50' : 'text-red-500 hover:bg-red-900/30'}`}
                            title="Remove registration"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                        </button>
                    </div>
                </div>
        </div>
    )
}
