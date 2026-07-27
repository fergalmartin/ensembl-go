import { useState } from 'react'

// Simplified feature colors - merged categories
const FEATURE_COLORS = {
    genomic: { bg: '#60a5fa', label: 'Genomic' },
    exon: { bg: '#60a5fa', label: 'Exon' },
    cds: { bg: '#60a5fa', label: 'CDS' },
    utr: { bg: '#c4b5fd', label: 'UTR' },          // Merged 5'/3' UTR
    utr5: { bg: '#c4b5fd', label: 'UTR' },         // Keep for backward compat
    utr3: { bg: '#c4b5fd', label: 'UTR' },         // Keep for backward compat
    intron: { bg: '#4a5568', label: 'Intronic' },
    intergenic: { bg: '#4a5568', label: 'Intronic' },
    splice: { bg: '#ed8936', label: 'Splice site' },  // Merged donor/acceptor
    splice_site: { bg: '#ed8936', label: 'Splice site' },  // Alias for projection
    donor: { bg: '#ed8936', label: 'Splice site' },   // Keep for backward compat
    acceptor: { bg: '#ed8936', label: 'Splice site' },
    start_codon: { bg: '#0d9488', label: 'Start (ATG)' },
    stop_codon: { bg: '#c026d3', label: 'Stop' },
}

// Unique legend items for display (removes duplicates)
const LEGEND_ITEMS = [
    { key: 'genomic', bg: '#60a5fa', outlineOnly: true, label: 'Genomic' },
    { key: 'exon', bg: '#60a5fa', label: 'Exon' },
    { key: 'cds', bg: '#60a5fa', gradient: 'linear-gradient(90deg, #60a5fa 50%, #bfdbfe 50%)', label: 'CDS' },
    { key: 'utr', bg: '#c4b5fd', label: 'UTR' },
    { key: 'intron', bg: '#4a5568', label: 'Intronic' },
    { key: 'splice', bg: '#ed8936', label: 'Splice site' },
    { key: 'start_codon', bg: '#0d9488', label: 'Start (ATG)' },
    { key: 'stop_codon', bg: '#c026d3', label: 'Stop' },
]

export default function FeatureLegend({ theme, horizontal = false, defaultExpanded = false }) {
    const [expanded, setExpanded] = useState(Boolean(defaultExpanded))
    const isLight = theme === 'light'

    const buttonClass = isLight
        ? 'text-gray-500 hover:text-gray-700'
        : 'text-gray-400 hover:text-white'
    const panelClass = isLight
        ? 'bg-white border border-gray-200 shadow-sm'
        : 'bg-gray-800 border border-gray-700'
    const textClass = isLight ? 'text-gray-700' : 'text-gray-300'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'

    return (
        <div className="relative">
            <button
                onClick={() => setExpanded(!expanded)}
                className={`text-sm ${buttonClass} flex items-center gap-1`}
            >
                <span>Legend</span>
                <svg className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>

            {expanded && (
                <div className={`${horizontal ? 'mt-2' : 'absolute right-0 top-full mt-2'} ${panelClass} rounded-lg p-3 shadow-xl z-50`}>
                    <h4 className={`text-xs font-semibold ${subTextClass} mb-2`}>Feature Colours</h4>
                    <div className={horizontal ? 'flex flex-wrap gap-4' : 'space-y-1'}>
                        {LEGEND_ITEMS.map(({ key, bg, gradient, outlineOnly, label }) => (
                            <div key={key} className="flex items-center gap-2">
                                <div
                                    className="w-4 h-4 rounded"
                                    style={{
                                        background: outlineOnly ? 'transparent' : (gradient ?? bg),
                                        border: `1px solid ${bg}`,
                                    }}
                                />
                                <span className={`text-xs ${textClass}`}>{label}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

export { FEATURE_COLORS }
