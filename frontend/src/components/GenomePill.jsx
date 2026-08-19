// The genome pill: a name, its assembly, and the dataset badge tucked into the
// corner. Extracted from the top bar so anywhere that needs to say "this genome"
// says it the same way — the stats overview heads each genome's section with
// one. The bar keeps the behaviour (drag, selection, removal); this owns only
// how a pill looks.

import { formatDatasetBadgeLabel, formatDatasetReleaseShortLabel, normalizeGenomeSourceDatabase } from '../utils/genomeIdentity'

/** Badge text and both tooltips for a genome, so every pill labels alike. */
export function genomePillLabels(species) {
    const providerName = normalizeGenomeSourceDatabase(species)
    const releaseLabel = String(species?.dataset_release_short_label || '').trim()
        || formatDatasetReleaseShortLabel(species)
    const datasetPart = releaseLabel ? `dataset: ${releaseLabel}` : ''
    return {
        badge: formatDatasetBadgeLabel(species),
        providerName,
        releaseLabel,
        badgeTooltip: [providerName, datasetPart].filter(Boolean).join(' | '),
        pillTooltip: [
            species?.scientific_name,
            species?.assembly_name || species?.assembly,
            species?.assembly,
            providerName,
            datasetPart,
        ].filter(Boolean).join(' | '),
    }
}

export default function GenomePill({
    displayName,
    displayAssembly = '',
    badge = '',
    badgeTooltip = '',
    tooltip = '',
    isLight = false,
    backgroundColor,
    textColor,
    borderColor,
    borderStyle,
    width,
    minWidth,
    maxWidth,
    paddingLeft,
    onClick = null,
    children = null,
}) {
    const Tag = onClick ? 'button' : 'div'
    return (
        <>
            {badge ? (
                <span
                    className={`absolute right-2 bottom-0 z-10 max-w-[7.5rem] truncate rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none border shadow-sm ${isLight
                        ? 'bg-white text-gray-800 border-gray-300'
                        : 'bg-gray-900 text-gray-100 border-gray-500'
                        }`}
                    title={badgeTooltip}
                >
                    {badge}
                </span>
            ) : null}
            <Tag
                {...(onClick ? { onClick, onMouseDown: (event) => event.stopPropagation() } : {})}
                className="text-xs px-3 py-1.5 rounded-full transition-all duration-200 border font-medium flex items-center gap-1.5"
                style={{ backgroundColor, color: textColor, borderColor, borderStyle, width, minWidth, maxWidth, paddingLeft }}
                title={tooltip}
            >
                {/* Name carries the weight, assembly rides along lighter — the
                    pill reads as one label without the two halves competing. */}
                <span className="truncate font-semibold">{displayName}</span>
                {displayAssembly ? (
                    <span className="truncate font-normal opacity-75">{displayAssembly}</span>
                ) : null}
                {children}
            </Tag>
        </>
    )
}
