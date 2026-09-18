import { useState } from 'react'

// The legend itself. The colours and the legend rows it draws live in
// utils/featureColors.js, so that plain modules can read the same palette
// without importing a React component.
import { FEATURE_COLORS, LEGEND_ITEMS } from '../utils/featureColors'

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
