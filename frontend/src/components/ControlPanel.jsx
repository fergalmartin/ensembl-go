export default function ControlPanel({
    collapseIntrons,
    onToggleCollapseIntrons,
    collapseSource,
    onCollapseSourceChange,
    refTag = 'G1',
    tgtTag = 'G2',
    theme,
}) {
    const isLight = theme === 'light'
    const panelClass = isLight
        ? 'bg-white border border-gray-200 shadow-sm'
        : 'bg-gray-800'
    const textClass = isLight ? 'text-gray-700' : 'text-gray-300'
    const subTextClass = isLight ? 'text-gray-500' : 'text-gray-400'

    return (
        <div className={`${panelClass} rounded-lg p-4`}>
            <h3 className={`text-sm font-semibold ${textClass} mb-3`}>
                Display Options
            </h3>

            <div className="space-y-3">
                {/* Collapse introns */}
                <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={collapseIntrons}
                            onChange={(e) => onToggleCollapseIntrons(e.target.checked)}
                            className={`rounded border-gray-300 ${isLight ? 'text-[#0099ff] focus:ring-[#0099ff]' : 'text-blue-600 focus:ring-blue-500'}`}
                        />
                        <span className={`text-sm ${textClass}`}>Collapse introns</span>
                    </label>

                    {collapseIntrons && (
                        <div className="ml-6 space-y-1">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="collapseSource"
                                    value="reference"
                                    checked={collapseSource === 'reference'}
                                    onChange={() => onCollapseSourceChange('reference')}
                                    className={isLight ? 'text-[#0099ff]' : 'text-blue-600'}
                                />
                                <span className={`text-xs ${subTextClass}`}>By {refTag} introns</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="radio"
                                    name="collapseSource"
                                    value="target"
                                    checked={collapseSource === 'target'}
                                    onChange={() => onCollapseSourceChange('target')}
                                    className={isLight ? 'text-[#0099ff]' : 'text-blue-600'}
                                />
                                <span className={`text-xs ${subTextClass}`}>By {tgtTag} introns</span>
                            </label>
                        </div>
                    )}
                </div>

            </div>
        </div>
    )
}
