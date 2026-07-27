export default function RecentHistory({ items, onSelect, theme }) {
    const isLight = theme === 'light'
    const panelClass = isLight
        ? 'bg-white border border-gray-200 shadow-sm'
        : 'bg-gray-800'
    const textClass = isLight ? 'text-gray-700' : 'text-gray-300'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-500'
    const hoverClass = isLight ? 'hover:bg-gray-100' : 'hover:bg-gray-700'

    if (!items || items.length === 0) {
        return (
            <div className={`${panelClass} rounded-lg p-4`}>
                <h3 className={`text-sm font-semibold ${textClass} mb-3`}>
                    Recent Alignments
                </h3>
                <p className={`text-xs ${subTextClass}`}>No recent alignments</p>
            </div>
        )
    }

    const cleanId = (id) => id ? id.replace('transcript:', '') : ''

    return (
        <div className={`${panelClass} rounded-lg p-4`}>
            <h3 className={`text-sm font-semibold ${textClass} mb-3`}>
                Recent Alignments
            </h3>

            <div className="space-y-1 max-h-64 overflow-y-auto">
                {items.map((item, idx) => {
                    const refId = cleanId(item.transcript_id)
                    const tgtId = cleanId(item.target_transcript_id || item.transcript_id)
                    return (
                        <button
                            key={idx}
                            onClick={() => onSelect(item.transcript_id, item.target_transcript_id || item.transcript_id)}
                            className={`w-full text-left px-2 py-1.5 rounded ${hoverClass} transition-colors group`}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <div className="truncate min-w-0">
                                    <span className={`text-xs font-mono ${textClass}`}>{refId}</span>
                                    {tgtId !== refId && (
                                        <>
                                            <span className={`text-xs mx-1 ${subTextClass}`}>/</span>
                                            <span className={`text-xs font-mono ${subTextClass}`}>{tgtId}</span>
                                        </>
                                    )}
                                </div>
                                <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${item.identity >= 95 ? 'bg-green-100 text-green-700' :
                                    item.identity >= 80 ? 'bg-yellow-100 text-yellow-700' :
                                        'bg-red-100 text-red-700'
                                    }`}>
                                    {item.identity.toFixed(1)}%
                                </span>
                            </div>
                        </button>
                    )
                })}
            </div>
        </div>
    )
}
