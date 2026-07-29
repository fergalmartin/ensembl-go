import { useEffect, useMemo, useRef, useState } from 'react'
import { bundleFileTypeLabel } from '../utils/genomeFileTypes'
import { BUNDLE_CELL_MISSING } from '../utils/genomeBundle'

// Review step for importing a portable genome bundle.
//
// One row per genome, one column per file type the document mentions. A filled
// dot means the file is listed and present; a hollow amber ring means it was
// listed but is not on disk. Column headers are rotated so a wide file-type set
// stays readable without forcing an enormous header row; the grid scrolls
// horizontally on its own so the page body never does.

const HEADER_HEIGHT = 74
const LABEL_WIDTH = 260
const CELL_WIDTH = 30

function MatrixCell({ cell, isLight }) {
    if (!cell) {
        return <span className={`block w-2 h-2 rounded-full ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`} />
    }
    if (cell.state === BUNDLE_CELL_MISSING) {
        return (
            <span
                title={cell.path ? `Listed but not found: ${cell.path}` : 'Listed but not found'}
                className={`block w-2.5 h-2.5 rounded-full border-2 ${isLight ? 'border-amber-500' : 'border-amber-400'}`}
            />
        )
    }
    return (
        <span
            title={cell.path || 'Present'}
            className={`block w-2.5 h-2.5 rounded-full ${isLight ? 'bg-[#0099ff]' : 'bg-blue-400'}`}
        />
    )
}

export default function GenomeBundlePreviewModal({
    isOpen,
    theme,
    model,
    busy = false,
    selectLoaded = true,
    onSelectLoadedChange,
    onClose,
    onImport,
}) {
    const isLight = theme === 'light'
    const [selected, setSelected] = useState(() => new Set())
    const selectAllRef = useRef(null)

    const importable = useMemo(
        () => (model?.importableIndexes || []),
        [model],
    )

    // Everything importable starts checked each time the modal opens.
    useEffect(() => {
        if (!isOpen) return
        setSelected(new Set(importable))
    }, [isOpen, importable])

    // Without a "Select all" label, a partial selection reading as unchecked
    // would be misleading, so show the indeterminate state.
    useEffect(() => {
        if (!selectAllRef.current) return
        selectAllRef.current.indeterminate = selected.size > 0 && selected.size < importable.length
    }, [selected, importable])

    if (!isOpen || !model) return null

    const modalBg = isLight ? 'bg-white text-gray-900' : 'bg-gray-800 text-gray-100'
    const borderColor = isLight ? 'border-gray-200' : 'border-gray-700'
    const mutedText = isLight ? 'text-gray-500' : 'text-gray-400'
    const rowBorder = isLight ? 'border-gray-100' : 'border-gray-700/60'

    const columns = model.columns || []
    const rows = model.rows || []
    const allSelected = importable.length > 0 && selected.size === importable.length

    const toggleRow = (index) => {
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(index)) next.delete(index)
            else next.add(index)
            return next
        })
    }

    const toggleAll = () => {
        setSelected(allSelected ? new Set() : new Set(importable))
    }

    const gridTemplate = `${LABEL_WIDTH}px repeat(${columns.length}, ${CELL_WIDTH}px)`
    const gridMinWidth = LABEL_WIDTH + columns.length * CELL_WIDTH

    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className={`${modalBg} w-full max-w-4xl rounded-xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden`}>
                <div className={`p-4 border-b ${borderColor} flex justify-between items-start gap-4`}>
                    <div className="min-w-0">
                        <h3 className="text-lg font-semibold">Import genomes from file</h3>
                        <p className={`mt-0.5 text-xs font-mono truncate ${mutedText}`} title={model.path}>
                            {model.path}
                        </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                        <span className={`text-xs ${mutedText}`}>
                            {selected.size} of {model.totalCount} selected
                            {model.validCount !== model.totalCount ? ` · ${model.validCount} usable` : ''}
                        </span>
                        <button
                            type="button"
                            onClick={onClose}
                            className={`p-1 rounded-md transition-colors ${isLight ? 'hover:bg-gray-100' : 'hover:bg-gray-700'}`}
                            aria-label="Close"
                        >
                            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M15 5L5 15M5 5l10 10" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <div className="overflow-x-auto">
                        <div style={{ minWidth: `${gridMinWidth}px` }}>
                            {/* Rotated column headers */}
                            <div
                                className={`grid items-end border-b ${borderColor} px-4`}
                                style={{ gridTemplateColumns: gridTemplate, height: `${HEADER_HEIGHT}px` }}
                            >
                                {/* The select-all sits in the Genome cell, in the
                                    same column as the row checkboxes, so it needs
                                    no label of its own. */}
                                <label
                                    className={`flex items-center gap-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide cursor-pointer ${mutedText}`}
                                    title={allSelected ? 'Deselect all genomes' : 'Select all genomes'}
                                >
                                    <input
                                        ref={selectAllRef}
                                        type="checkbox"
                                        checked={allSelected}
                                        disabled={!importable.length}
                                        onChange={toggleAll}
                                        className="w-3.5 h-3.5 shrink-0 accent-[#0099ff]"
                                    />
                                    Genome
                                </label>
                                {columns.map((fileType) => (
                                    <div key={fileType} className="relative h-full">
                                        <span
                                            className={`absolute bottom-1.5 left-1/2 origin-bottom-left whitespace-nowrap text-[10px] font-semibold ${mutedText}`}
                                            style={{ transform: 'rotate(-45deg)' }}
                                            title={bundleFileTypeLabel(fileType)}
                                        >
                                            {bundleFileTypeLabel(fileType)}
                                        </span>
                                    </div>
                                ))}
                            </div>

                            {rows.map((row) => {
                                const disabled = !row.valid
                                return (
                                    <div
                                        key={row.index}
                                        className={`border-b ${rowBorder} px-4 py-1.5 ${disabled ? 'opacity-60' : ''}`}
                                    >
                                        <div
                                            className="grid items-center"
                                            style={{ gridTemplateColumns: gridTemplate }}
                                        >
                                            <label className={`flex items-center gap-2 min-w-0 pr-3 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                                                <input
                                                    type="checkbox"
                                                    checked={selected.has(row.index)}
                                                    disabled={disabled}
                                                    onChange={() => toggleRow(row.index)}
                                                    className="w-3.5 h-3.5 shrink-0 accent-[#0099ff]"
                                                />
                                                <span className="min-w-0">
                                                    <span className="block text-[11px] font-medium truncate" title={row.label}>
                                                        {row.label}
                                                    </span>
                                                    <span className={`block text-[10px] truncate ${mutedText}`}>
                                                        {[row.sourceDatabase, row.releaseLabel, row.accession]
                                                            .filter(Boolean)
                                                            .join(' · ')}
                                                    </span>
                                                </span>
                                            </label>
                                            {columns.map((fileType) => (
                                                <div key={fileType} className="flex justify-center">
                                                    <MatrixCell cell={row.cells?.[fileType]} isLight={isLight} />
                                                </div>
                                            ))}
                                        </div>

                                        {row.error ? (
                                            <div className={`mt-1 ml-6 text-[10px] ${isLight ? 'text-red-600' : 'text-red-300'}`}>
                                                ⚠ {row.error} — cannot import
                                            </div>
                                        ) : row.missingFiles.length ? (
                                            <div className={`mt-1 ml-6 text-[10px] ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
                                                {row.missingFiles.length === 1
                                                    ? `${bundleFileTypeLabel(row.missingFiles[0].fileType)} not found at ${row.missingFiles[0].path}`
                                                    : `${row.missingFiles.length} files not found — the genome imports without them`}
                                            </div>
                                        ) : null}
                                    </div>
                                )
                            })}

                            {rows.length === 0 ? (
                                <div className={`px-4 py-10 text-center text-xs ${mutedText}`}>
                                    This file lists no genomes.
                                </div>
                            ) : null}
                        </div>
                    </div>
                </div>

                <div className={`border-t ${borderColor} px-4 py-3 flex items-center justify-between gap-3`}>
                    <label
                        className="flex items-center gap-2 text-xs cursor-pointer"
                        title="This will add all the loaded genomes to the selected genomes set in Genome Selector and the genome boxes near the top of the app."
                    >
                        <input
                            type="checkbox"
                            checked={selectLoaded}
                            onChange={(event) => onSelectLoadedChange?.(event.target.checked)}
                            className="w-3.5 h-3.5 accent-[#0099ff]"
                        />
                        Automatically add to selected genomes list
                    </label>
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${isLight ? 'text-gray-600 hover:bg-gray-200' : 'text-gray-300 hover:bg-gray-700'}`}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            disabled={busy || selected.size === 0}
                            onClick={() => onImport?.(Array.from(selected).sort((a, b) => a - b))}
                            className={`px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors ${isLight
                                ? 'bg-[#0099ff] hover:bg-[#0088ee] disabled:bg-gray-300 disabled:cursor-not-allowed'
                                : 'bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed'
                                }`}
                        >
                            {busy ? 'Importing…' : `Import ${selected.size}`}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
