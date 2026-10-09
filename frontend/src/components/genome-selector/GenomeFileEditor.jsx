import React from 'react'
import { basenameFromPath } from '../../utils/customGenomeImport.js'
import { genomeAnalysisKind, isAnalysableGenomeFileType } from '../../utils/genomeAnalysis.js'
import { GENOME_FILE_EDITOR_TYPES, MANUAL_GENOME_FILE_EDITOR_TYPES, localFileTypeLabel, orderBundleFileTypes } from '../../utils/genomeFileTypes.js'
import { IconTrash } from '../ConfigurationView'
import ValidationReportPanel from '../ValidationReportPanel'
import { itemKey } from './genomeSelectorModel.js'

export function GenomeFileEditor({
    item,
    effectiveFiles,
    isLight,
    theme,
    confirmDeleteFile,
    setConfirmDeleteFile,
    onDeleteFile,
    onBrowse,
    onSavePath,
    analysisByType = {},
    onAnalyse,
}) {
    const genomeKey = itemKey(item)
    // A hand-added genome only ever has the three base types, but one registered
    // from a bundle can carry the full download set — show whatever it actually
    // has rather than silently hiding files it came with.
    const fileTypes = React.useMemo(() => {
        if (!item.is_manual) return GENOME_FILE_EDITOR_TYPES
        const extras = Object.keys(effectiveFiles || {}).filter((type) => (
            !MANUAL_GENOME_FILE_EDITOR_TYPES.includes(type) && effectiveFiles[type]
        ))
        return [...MANUAL_GENOME_FILE_EDITOR_TYPES, ...orderBundleFileTypes(extras)]
    }, [item.is_manual, effectiveFiles])

    const [editPaths, setEditPaths] = React.useState(() => ({ ...effectiveFiles }))
    const [openAnalysisTypes, setOpenAnalysisTypes] = React.useState({})
    const [pendingAnalysisTypes, setPendingAnalysisTypes] = React.useState({})
    React.useEffect(() => { setEditPaths({ ...effectiveFiles }) }, [effectiveFiles])

    const inputBg = isLight
        ? 'bg-white border-gray-200 text-gray-800 placeholder-gray-300 focus:border-[#0099ff] focus:ring-[#0099ff]/30'
        : 'bg-gray-800 border-gray-600 text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:ring-blue-500/30'
    const browseBtn = isLight
        ? 'bg-gray-100 text-gray-600 hover:bg-gray-200 border border-gray-300'
        : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
    const deleteBtn = isLight
        ? 'text-gray-400 hover:text-red-600 hover:bg-red-50'
        : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20'
    const rowHover = isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-700/30'
    const rowText = isLight ? 'text-gray-700' : 'text-gray-300'
    const pathText = isLight ? 'text-gray-500' : 'text-gray-400'
    const gridTemplateColumns = '132px 150px minmax(180px,1fr) 190px'

    const handleBlur = (type, value) => {
        const prev = effectiveFiles[type] || ''
        if (value !== prev) onSavePath(type, value)
    }

    return (
        <div className={`rounded-lg border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800/60 border-gray-700'}`}>
            <div className={`grid items-center gap-2 px-3 py-2 border-b text-[10px] font-bold uppercase tracking-widest ${isLight ? 'bg-gray-50 border-gray-200 text-gray-500' : 'bg-gray-750 border-gray-700 text-gray-400'}`} style={{ gridTemplateColumns }}>
                <span>Type</span>
                <span>File</span>
                <span>Path</span>
                <span className="text-right">Actions</span>
            </div>
            <div className={`divide-y ${isLight ? 'divide-gray-100' : 'divide-gray-700/60'}`}>
                {fileTypes.map((type) => {
                    const path = effectiveFiles[type] || ''
                    const editPath = editPaths[type] ?? path
                    const isConfirmingDelete = confirmDeleteFile?.fileType === type && confirmDeleteFile?.path === path && itemKey(confirmDeleteFile?.item) === genomeKey
                    const typeLabel = localFileTypeLabel(type, item.is_manual)
                    const filename = basenameFromPath(editPath || path)
                    const analysis = analysisByType[type] || null
                    const locallyBusy = Boolean(pendingAnalysisTypes[type])
                    const analysisBusy = locallyBusy || analysis?.status === 'queued' || analysis?.status === 'running'
                    const hasAnalysis = analysis?.status === 'success' && analysis?.report
                    const analysisOpen = Boolean(openAnalysisTypes[type])
                    const canAnalyse = isAnalysableGenomeFileType(type) && Boolean(path)
                    const analysisProgress = Math.max(0, Math.min(100, Number(analysis?.progress || 0)))
                    const displayedAnalysis = analysis || (locallyBusy
                        ? {
                            status: 'queued',
                            progress: 0,
                            message: 'Starting analysis',
                            report: null,
                            error: null,
                        }
                        : null)

                    const handleAnalyseClick = async () => {
                        if (hasAnalysis && !analysisOpen) {
                            setOpenAnalysisTypes((prev) => ({ ...prev, [type]: true }))
                            return
                        }
                        setOpenAnalysisTypes((prev) => ({ ...prev, [type]: true }))
                        if (analysisBusy) return
                        setPendingAnalysisTypes((prev) => ({ ...prev, [type]: true }))
                        try {
                            await onAnalyse?.(type)
                        } finally {
                            setPendingAnalysisTypes((prev) => ({ ...prev, [type]: false }))
                        }
                    }

                    return (
                        <React.Fragment key={type}>
                            <div
                                className={`grid items-center gap-2 px-3 py-1.5 text-xs ${rowHover}`}
                                style={{ gridTemplateColumns }}
                            >
                                <span className={`min-w-0 truncate font-semibold ${rowText}`} title={typeLabel}>
                                    {typeLabel}
                                </span>
                                <span className={`min-w-0 truncate font-mono ${pathText}`} title={filename || `No ${typeLabel} file`}>
                                    {filename || '-'}
                                </span>
                                <div className="min-w-0">
                                    <input
                                        type="text"
                                        value={editPath}
                                        placeholder={`No ${typeLabel} file`}
                                        onChange={(e) => setEditPaths((prev) => ({ ...prev, [type]: e.target.value }))}
                                        onFocus={(e) => { e.target.scrollLeft = 0 }}
                                        onBlur={(e) => {
                                            handleBlur(type, e.target.value)
                                            requestAnimationFrame(() => {
                                                if (e.target) e.target.scrollLeft = e.target.scrollWidth
                                            })
                                        }}
                                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
                                        ref={(el) => { if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth }}
                                        className={`w-full min-w-0 px-2 py-1 rounded border text-xs font-mono transition-colors focus:outline-none focus:ring-1 ${inputBg}`}
                                    />
                                </div>
                                <div className="flex items-center gap-1 justify-end">
                                    {isAnalysableGenomeFileType(type) && (
                                        <button
                                            type="button"
                                            onClick={handleAnalyseClick}
                                            disabled={!canAnalyse || analysisBusy}
                                            aria-busy={analysisBusy}
                                            className={`h-7 px-2 rounded text-[10px] font-semibold transition-colors border inline-flex items-center gap-1.5 ${analysisBusy
                                                ? (isLight
                                                    ? 'bg-blue-100 text-blue-800 border-blue-300 cursor-wait'
                                                    : 'bg-blue-900/50 text-blue-200 border-blue-600 cursor-wait')
                                                : canAnalyse
                                                ? (isLight
                                                    ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                                                    : 'bg-blue-900/30 text-blue-300 border-blue-700/40 hover:bg-blue-900/50')
                                                : (isLight
                                                    ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-default'
                                                    : 'bg-gray-800 text-gray-500 border-gray-700 cursor-default')
                                                }`}
                                            title={hasAnalysis
                                                ? (analysisOpen ? `Reanalyse the ${typeLabel} file` : 'Show the saved analysis')
                                                : `Analyse the ${typeLabel} file`}
                                        >
                                            {analysisBusy ? (
                                                <span
                                                    className="w-3 h-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"
                                                    aria-hidden="true"
                                                />
                                            ) : null}
                                            <span aria-live="polite">
                                                {analysisBusy
                                                ? (analysisProgress > 0 ? `Analysing ${Math.round(analysisProgress)}%` : 'Analysing…')
                                                : (hasAnalysis ? (analysisOpen ? 'Reanalyse' : 'View analysis') : (analysis?.status === 'failed' ? 'Retry analysis' : 'Analyse'))}
                                            </span>
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => onBrowse(type)}
                                        className={`w-7 h-7 rounded text-xs transition-colors inline-flex items-center justify-center ${browseBtn}`}
                                        title={`Browse for ${typeLabel} file`}
                                    >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                        </svg>
                                    </button>
                                    {isConfirmingDelete ? (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => onDeleteFile(confirmDeleteFile)}
                                                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${isLight ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-red-900/40 text-red-400 hover:bg-red-900/60'}`}
                                            >
                                                Delete
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setConfirmDeleteFile(null)}
                                                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                                            >
                                                Cancel
                                            </button>
                                        </>
                                    ) : (
                                            <button
                                                type="button"
                                                onClick={() => path && setConfirmDeleteFile({ path, fileType: type, item })}
                                                disabled={!path}
                                                className={`p-1 rounded transition-colors ${path ? deleteBtn : 'opacity-20 cursor-default'}`}
                                                title={path ? `Delete ${typeLabel} file` : `No ${typeLabel} file to delete`}
                                            >
                                                <IconTrash size={13} />
                                            </button>
                                    )}
                                </div>
                            </div>
                            {analysisOpen && displayedAnalysis ? (
                                <div className={`px-3 py-3 ${isLight ? 'bg-blue-50/30' : 'bg-blue-950/10'}`}>
                                    <ValidationReportPanel
                                        kind={genomeAnalysisKind(type)}
                                        theme={theme}
                                        status={displayedAnalysis.status}
                                        progress={displayedAnalysis.progress}
                                        stage={displayedAnalysis.stage}
                                        message={displayedAnalysis.message}
                                        counters={displayedAnalysis.counters}
                                        report={displayedAnalysis.report}
                                        error={displayedAnalysis.error}
                                        analysedAt={displayedAnalysis.analysed_at}
                                        onClose={() => setOpenAnalysisTypes((prev) => ({ ...prev, [type]: false }))}
                                    />
                                </div>
                            ) : null}
                        </React.Fragment>
                    )
                })}
            </div>
        </div>
    )
}
