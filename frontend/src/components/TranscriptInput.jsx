import { useState } from 'react'

const SECONDARY_ACCENT = '#00B692'

// Clean padlock SVG icons
const LockedIcon = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z" />
    </svg>
)

const UnlockedIcon = ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h2c0-1.66 1.34-3 3-3s3 1.34 3 3v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z" />
    </svg>
)

function GenomeInputBox({
    label,
    labelContent = null,
    inputValue,
    onInputChange,
    resolved,
    loading,
    error,
    onResolve,
    onSelectTranscript,
    theme,
}) {
    const [expanded, setExpanded] = useState(false)
    const isLight = theme === 'light'

    const labelClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const inputClass = isLight
        ? 'bg-gray-50 border-gray-300 text-gray-900 placeholder-gray-400 focus:ring-blue-500 focus:border-blue-500'
        : 'bg-gray-700 border-gray-600 text-white placeholder-gray-500 focus:ring-blue-500'
    const buttonClass = isLight
        ? 'bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-300'
        : 'bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600'

    const handleSubmit = (e) => {
        e.preventDefault()
        if (inputValue.trim()) {
            setExpanded(false)
            onResolve(inputValue.trim())
        }
    }

    const selectedTx = resolved?.transcripts?.find(t => t.id === resolved.selectedTranscriptId)
    const otherTranscripts = resolved?.transcripts?.filter(t => t.id !== resolved.selectedTranscriptId) || []

    return (
        <div className="space-y-2">
            {labelContent ? (
                <div className="block min-h-[24px]">
                    {labelContent}
                </div>
            ) : (
                <label className={`block text-xs font-semibold ${labelClass}`}>
                    {label}
                </label>
            )}
            <form onSubmit={handleSubmit} className="flex gap-2">
                <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => { onInputChange(e.target.value); setExpanded(false) }}
                    placeholder="Gene name, gene ID, or transcript ID"
                    className={`flex-1 ${inputClass} border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2`}
                    disabled={loading}
                />
                <button
                    type="submit"
                    disabled={loading || !inputValue.trim()}
                    className={`${buttonClass} disabled:cursor-not-allowed text-white text-sm font-medium px-3 py-1.5 rounded transition-colors`}
                >
                    {loading ? '...' : 'Go'}
                </button>
            </form>

            {error && (
                <p className="text-red-400 text-xs">{error}</p>
            )}

            {resolved && (
                <div className={`text-xs space-y-1 pl-1 ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                    {/* Gene info */}
                    {resolved.gene && (
                        <div className="flex items-center gap-1.5">
                            {resolved.gene.name && (
                                <span className="font-semibold">{resolved.gene.name}</span>
                            )}
                            <span className={isLight ? 'text-gray-400' : 'text-gray-500'}>{resolved.gene.id}</span>
                        </div>
                    )}

                    {/* Selected transcript */}
                    {selectedTx && (
                        <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <span className={`font-mono ${isLight ? 'text-[#0099ff]' : 'text-blue-400'}`}>
                                    {selectedTx.id}
                                </span>
                                {selectedTx.is_canonical && (
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-400'}`}>
                                        canonical
                                    </span>
                                )}
                            </div>
                            {selectedTx.biotype && (
                                <div className={`${isLight ? 'text-gray-500' : 'text-gray-400'} leading-tight break-words`}>
                                    {selectedTx.biotype}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Expandable transcript list */}
                    {otherTranscripts.length > 0 && (
                        <>
                            <button
                                type="button"
                                onClick={() => setExpanded(!expanded)}
                                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${expanded
                                    ? (isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/50 text-blue-300')
                                    : (isLight ? 'bg-gray-100 text-gray-500 hover:bg-blue-50 hover:text-blue-600' : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-300')
                                    }`}
                            >
                                {expanded ? '− Hide' : `+${otherTranscripts.length} more`}
                            </button>
                            {expanded && (
                                <div className="space-y-0.5 ml-1">
                                    {otherTranscripts.map(tx => (
                                        <div
                                            key={tx.id}
                                            onClick={() => { onSelectTranscript(tx.id); setExpanded(false) }}
                                            className={`px-2 py-1 rounded cursor-pointer transition-colors ${isLight ? 'hover:bg-blue-50' : 'hover:bg-blue-900/20'}`}
                                        >
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className={`font-mono ${isLight ? 'text-[#0099ff]' : 'text-blue-400'}`}>
                                                    {tx.id}
                                                </span>
                                                {tx.is_canonical && (
                                                    <span className={`text-[10px] px-1 py-0.5 rounded-full ${isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-400'}`}>
                                                        canonical
                                                    </span>
                                                )}
                                            </div>
                                            {tx.biotype && (
                                                <span className={`${isLight ? 'text-gray-500' : 'text-gray-400'} leading-tight break-words block mt-0.5`}>
                                                    {tx.biotype}
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

export default function TranscriptInput({
    // Reference side
    refLabel = 'G1 Reference',
    refTag = 'G1',
    refPillLabel = '',
    onRefPillClick = null,
    refInput,
    onRefInputChange,
    refResolved,
    refLoading,
    refError,
    onResolveRef,
    onSelectRefTranscript,
    // Target side
    tgtLabel = 'G2 Secondary',
    tgtTag = 'G2',
    tgtPillLabel = '',
    onTgtPillClick = null,
    tgtInput,
    onTgtInputChange,
    tgtResolved,
    tgtLoading,
    tgtError,
    onResolveTgt,
    onSelectTgtTranscript,
    // Alignment
    onRunAlignment,
    onViewInBrowser,
    alignmentAction = 'Run',
    alignmentLoaded = false,
    loading,
    // Flank controls
    refFlankBp,
    tgtFlankBp,
    flankLocked,
    onRefFlankChange,
    onTgtFlankChange,
    onToggleLock,
    theme,
}) {
    const isLight = theme === 'light'

    const panelClass = isLight
        ? 'bg-white border border-gray-200 shadow-sm'
        : 'bg-gray-800'
    const textClass = isLight ? 'text-gray-700' : 'text-gray-300'
    const labelClass = isLight ? 'text-gray-500' : 'text-gray-400'
    const buttonClass = isLight
        ? 'bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-300'
        : 'bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600'

    const bothResolved = refResolved?.selectedTranscriptId && tgtResolved?.selectedTranscriptId

    const renderGenomeLabel = (pillLabel, fallbackLabel, missingMessage, onPillClick, isSecondary = false) => {
        const isActive = !!pillLabel
        const isClickable = !!(onPillClick && isActive)
        const displayText = pillLabel || fallbackLabel
        const activeBg = isSecondary
            ? SECONDARY_ACCENT
            : (isLight ? '#0099ff' : '#0077cc')

        return (
            <button
                type="button"
                onClick={() => isClickable && onPillClick()}
                disabled={!isClickable}
                className="inline-flex max-w-[180px] min-w-[110px] items-center rounded-full border px-3 py-1.5 text-xs font-medium"
                style={{
                    backgroundColor: isActive
                        ? activeBg
                        : (isLight ? '#ffffff' : '#1E2938'),
                    color: isActive
                        ? '#ffffff'
                        : (isLight ? '#4b5563' : '#9ca3af'),
                    borderColor: isActive
                        ? 'transparent'
                        : (isLight ? '#d1d5db' : '#4b5563'),
                    cursor: isClickable ? 'pointer' : 'default',
                    opacity: isClickable || isActive ? 1 : 0.95,
                }}
                title={isClickable
                    ? `${displayText} (click to deactivate)`
                    : (isActive ? displayText : `${displayText} — ${missingMessage}`)}
            >
                <span className="truncate">{displayText}</span>
            </button>
        )
    }

    return (
        <div className={`${panelClass} rounded-lg p-4`}>
            <h3 className={`text-sm font-semibold ${textClass} mb-3`}>
                Feature Alignment
            </h3>

            <div className="space-y-4">
                <GenomeInputBox
                    label={refLabel}
                    labelContent={renderGenomeLabel(refPillLabel, refLabel, 'Select primary genome from the genome bar', onRefPillClick, false)}
                    inputValue={refInput}
                    onInputChange={onRefInputChange}
                    resolved={refResolved}
                    loading={refLoading}
                    error={refError}
                    onResolve={onResolveRef}
                    onSelectTranscript={onSelectRefTranscript}
                    theme={theme}
                />

                <GenomeInputBox
                    label={tgtLabel}
                    labelContent={renderGenomeLabel(tgtPillLabel, tgtLabel, 'Select secondary genome from the genome bar', onTgtPillClick, true)}
                    inputValue={tgtInput}
                    onInputChange={onTgtInputChange}
                    resolved={tgtResolved}
                    loading={tgtLoading}
                    error={tgtError}
                    onResolve={onResolveTgt}
                    onSelectTranscript={onSelectTgtTranscript}
                    theme={theme}
                />

                {/* Flanking sliders with padlock */}
                <div className="flex gap-2">
                    <div className="flex flex-col justify-center">
                        <button
                            type="button"
                            onClick={onToggleLock}
                            className={`p-1 rounded transition-colors ${flankLocked
                                ? (isLight ? 'text-[#0099ff] hover:bg-blue-50' : 'text-blue-400 hover:bg-gray-700')
                                : (isLight ? 'text-gray-400 hover:bg-gray-100' : 'text-gray-500 hover:bg-gray-700')
                                }`}
                            title={flankLocked ? 'Sliders linked' : 'Sliders independent'}
                        >
                            {flankLocked
                                ? <LockedIcon className="w-5 h-5" />
                                : <UnlockedIcon className="w-5 h-5" />
                            }
                        </button>
                    </div>

                    <div className="flex-1 space-y-2">
                        <div>
                            <label className={`block text-xs ${labelClass} mb-1`}>
                                {refTag} flanking: {refFlankBp}bp
                            </label>
                            <input
                                type="range"
                                min="0"
                                max="500"
                                step="50"
                                value={refFlankBp}
                                onChange={(e) => onRefFlankChange(parseInt(e.target.value))}
                                className={`w-full ${isLight ? 'light-slider' : 'dark-slider'}`}
                                disabled={loading}
                            />
                        </div>

                        <div>
                            <label className={`block text-xs ${labelClass} mb-1`}>
                                {tgtTag} flanking: {tgtFlankBp}bp
                            </label>
                            <input
                                type="range"
                                min="0"
                                max="500"
                                step="50"
                                value={tgtFlankBp}
                                onChange={(e) => onTgtFlankChange(parseInt(e.target.value))}
                                className={`w-full ${isLight ? 'light-slider' : 'dark-slider'}`}
                                disabled={loading}
                            />
                        </div>
                    </div>
                </div>

                <button
                    type="button"
                    onClick={onRunAlignment}
                    disabled={loading || !bothResolved || alignmentLoaded}
                    className={`w-full ${buttonClass} disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded transition-colors`}
                >
                    {loading ? 'Loading...' : `${alignmentAction} Alignment`}
                </button>
                {alignmentLoaded && (
                    <button
                        type="button"
                        onClick={onViewInBrowser}
                        disabled={loading}
                        className={`w-full bg-[#8b5cf6] hover:bg-[#7c3aed] text-white font-medium py-2 px-4 rounded transition-colors`}
                    >
                        View Region in Browser
                    </button>
                )}
            </div>
        </div>
    )
}
