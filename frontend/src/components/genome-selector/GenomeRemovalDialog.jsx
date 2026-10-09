import { useEffect, useMemo, useState } from 'react'
import { getAssemblyAccession } from '../../utils/genomeIdentity.js'
import { formatBytes, partitionRemovalTargets, registeredRemovalFiles } from '../../utils/genomeRemovalSelection.js'
import { itemKey } from './genomeSelectorModel.js'
import { IconChevron, IconClipboard } from './selectorIcons'

/**
 * Confirming a removal.
 *
 * Two intentions get their own button, because they are not the same thing:
 * forgetting a genome, and deleting its data. The preview comes from the backend
 * so the list of files is what will actually be deleted, and the files the user
 * supplied are named in full — they are the ones people worry about.
 */
export function GenomeRemovalDialog({ isOpen, theme, targets, preview, onClose, onRemove }) {
    const isLight = theme === 'light'
    const [expanded, setExpanded] = useState(false)
    const [affectedFilesExpanded, setAffectedFilesExpanded] = useState(false)
    const [copiedPath, setCopiedPath] = useState('')
    const [includeManual, setIncludeManual] = useState(true)

    useEffect(() => {
        if (isOpen) {
            setExpanded(false)
            setAffectedFilesExpanded(false)
            setCopiedPath('')
            setIncludeManual(true)
        }
    }, [isOpen])

    const { manual, downloaded, missing } = useMemo(
        () => partitionRemovalTargets(targets || []),
        [targets],
    )
    const knownAffectedFiles = useMemo(
        () => registeredRemovalFiles(targets || []),
        [targets],
    )

    if (!isOpen || !(targets || []).length) return null

    const plans = preview?.status === 'ready' ? (preview.plans || []) : []
    const totals = preview?.totals || {}
    const protectedFiles = plans.flatMap((plan) => plan.protected || [])
    const leftInPlace = plans.flatMap((plan) => plan.left_in_place || [])
    const previewAffectedFiles = plans.flatMap((plan) => plan.deletable || [])
    const affectedFiles = preview?.status === 'ready' ? previewAffectedFiles : knownAffectedFiles
    const deletableCount = Number(totals.files || 0)
    const canDeleteData = downloaded.length > 0 || manual.length > 0
    const deleteScopeCount = includeManual ? downloaded.length + manual.length : downloaded.length
    const deregisterLabel = targets.length === 1 ? 'Deregister genome' : 'Deregister genomes'

    const heading = (targets || []).length === 1
        ? `Remove ${targets[0].scientific_name || targets[0].species_key}?`
        : `Remove ${targets.length} genomes?`

    const copyAffectedPath = async (path) => {
        const value = String(path || '')
        if (!value || !navigator?.clipboard?.writeText) return
        try {
            await navigator.clipboard.writeText(value)
            setCopiedPath(value)
            window.setTimeout(() => setCopiedPath((current) => current === value ? '' : current), 1600)
        } catch {
            // The full path remains available in the tooltip if clipboard access
            // is unavailable in the current runtime.
        }
    }

    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className={`w-full max-w-2xl rounded-xl border shadow-2xl max-h-[85vh] flex flex-col ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                <div className={`px-5 py-4 border-b flex items-center justify-between ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <h3 className={`text-base font-bold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{heading}</h3>
                    <button
                        type="button"
                        onClick={onClose}
                        className={`w-7 h-7 rounded flex items-center justify-center ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                    >
                        &#10005;
                    </button>
                </div>

                <div className="px-5 py-4 overflow-y-auto text-sm space-y-4">
                    <ul className={`space-y-1 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                        {(targets || []).slice(0, expanded ? targets.length : 6).map((item) => (
                            <li key={itemKey(item)} className="flex items-center gap-2">
                                <span className="font-medium">{item.scientific_name || item.species_key}</span>
                                <span className="opacity-60 text-xs font-mono">{getAssemblyAccession(item) || item.assembly}</span>
                                {item.is_manual ? (
                                    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${isLight ? 'bg-indigo-100 text-indigo-700' : 'bg-indigo-900/40 text-indigo-300'}`}>
                                        added manually
                                    </span>
                                ) : null}
                            </li>
                        ))}
                        {!expanded && targets.length > 6 ? (
                            <li>
                                <button type="button" onClick={() => setExpanded(true)} className="text-xs underline opacity-70 hover:opacity-100">
                                    show {targets.length - 6} more
                                </button>
                            </li>
                        ) : null}
                    </ul>

                    <div className={`rounded-lg border px-3 py-2.5 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/40'}`}>
                        {preview?.status === 'loading' ? (
                            <span className="text-xs opacity-70">Checking what is on disk…</span>
                        ) : preview?.status === 'error' ? (
                            <span className={`text-xs ${isLight ? 'text-red-700' : 'text-red-300'}`}>
                                Could not check what is on disk: {preview.error}
                            </span>
                        ) : (
                            <div className="text-xs space-y-1">
                                <div>
                                    <span className="font-semibold">{deletableCount}</span> file{deletableCount === 1 ? '' : 's'} would be deleted
                                    {totals.bytes ? <> — frees up to <span className="font-semibold">{formatBytes(totals.bytes)}</span></> : null}
                                </div>
                                {downloaded.length > 0 ? (
                                    <div className="opacity-80">{downloaded.length} downloaded genome{downloaded.length === 1 ? '' : 's'} in your data folder</div>
                                ) : null}
                                {missing.length > 0 ? (
                                    <div className="opacity-80">{missing.length} playlist entr{missing.length === 1 ? 'y has' : 'ies have'} no local files — they can only be forgotten</div>
                                ) : null}
                                {downloaded.length > 0 ? (
                                    <div className="opacity-80">
                                        Deregistering removes the genome from this list while leaving its
                                        downloaded files untouched.
                                    </div>
                                ) : null}
                                {leftInPlace.length > 0 ? (
                                    <div className="opacity-80">
                                        Attached track hub files stay on disk ({leftInPlace.map((entry) => formatBytes(entry.bytes)).join(', ')}).
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>

                    <div className={`rounded-lg border overflow-hidden ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/30'}`}>
                        <button
                            type="button"
                            onClick={() => setAffectedFilesExpanded((current) => !current)}
                            className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left text-xs font-semibold transition-colors ${isLight
                                ? 'text-gray-800 hover:bg-gray-50'
                                : 'text-gray-200 hover:bg-gray-800'
                                }`}
                            aria-expanded={affectedFilesExpanded}
                        >
                            <span>
                                Affected files
                                {` (${affectedFiles.length})`}
                            </span>
                            <IconChevron open={affectedFilesExpanded} size={13} />
                        </button>
                        {affectedFilesExpanded ? (
                            <div className={`border-t px-3 py-2.5 ${isLight ? 'border-gray-200 bg-gray-50/60' : 'border-gray-700 bg-gray-900/50'}`}>
                                {affectedFiles.length === 0 ? (
                                    <div className="text-xs opacity-70">
                                        {preview?.status === 'loading'
                                            ? 'Checking for generated files…'
                                            : 'No files would be deleted.'}
                                    </div>
                                ) : (
                                    <>
                                        {preview?.status === 'loading' ? (
                                            <div className="mb-2 text-[11px] opacity-70">
                                                Showing registered paths now; checking for generated sidecars…
                                            </div>
                                        ) : preview?.status === 'error' ? (
                                            <div className={`mb-2 text-[11px] ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
                                                Showing registered paths; the additional disk check was unavailable.
                                            </div>
                                        ) : null}
                                        <ul className="space-y-1.5">
                                            {affectedFiles.map((entry, index) => {
                                                const path = String(entry?.path || '')
                                                return (
                                                    <li key={`${path}-${index}`} className="flex min-w-0 items-center gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => copyAffectedPath(path)}
                                                            className={`flex-none rounded p-1 transition-colors ${isLight
                                                                ? 'text-gray-500 hover:bg-gray-200 hover:text-gray-800'
                                                                : 'text-gray-400 hover:bg-gray-700 hover:text-gray-100'
                                                                }`}
                                                            title={copiedPath === path ? 'Copied' : 'Copy full path'}
                                                            aria-label={copiedPath === path ? 'Path copied' : `Copy ${path}`}
                                                        >
                                                            <IconClipboard size={13} />
                                                        </button>
                                                        <span
                                                            className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-mono ${isLight ? 'text-gray-700' : 'text-gray-300'}`}
                                                            style={{ direction: 'rtl', textAlign: 'left' }}
                                                            title={path}
                                                        >
                                                            {path}
                                                        </span>
                                                    </li>
                                                )
                                            })}
                                        </ul>
                                    </>
                                )}
                            </div>
                        ) : null}
                    </div>

                    {manual.length > 0 ? (
                        <div className={`rounded-lg border px-3 py-2.5 text-xs ${isLight ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-amber-700/60 bg-amber-900/20 text-amber-100'}`}>
                            <div className="font-semibold">
                                {manual.length} genome{manual.length === 1 ? ' was' : 's were'} added manually.
                            </div>
                            <p className="mt-1">
                                Only files Ensembl Go generated for them are deleted — the index, sequence
                                and annotation indexes, and any annotation it converted. The files you
                                supplied are left exactly where they are:
                            </p>
                            <ul className="mt-1.5 space-y-0.5 font-mono break-all">
                                {protectedFiles.slice(0, 8).map((entry) => (
                                    <li key={entry.path}>{entry.path}</li>
                                ))}
                                {protectedFiles.length > 8 ? <li className="font-sans opacity-70">…and {protectedFiles.length - 8} more</li> : null}
                            </ul>
                        </div>
                    ) : null}

                    {manual.length > 0 && downloaded.length > 0 ? (
                        <label className={`flex items-center gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                            <input
                                type="checkbox"
                                checked={includeManual}
                                onChange={(event) => setIncludeManual(event.target.checked)}
                                className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                            />
                            Include the manually added genomes
                        </label>
                    ) : null}
                </div>

                <div className={`px-5 py-4 border-t flex flex-wrap items-center gap-2 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <button
                        type="button"
                        onClick={() => onRemove({ deleteData: false, includeManual: true })}
                        className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${isLight
                            ? 'bg-white border-gray-300 text-gray-800 hover:bg-gray-100'
                            : 'bg-transparent border-gray-600 text-gray-200 hover:bg-gray-700'
                            }`}
                        title="Forget these genomes. Nothing on disk is touched."
                    >
                        {deregisterLabel}
                    </button>
                    <button
                        type="button"
                        disabled={!canDeleteData || deleteScopeCount === 0}
                        onClick={() => onRemove({ deleteData: true, includeManual })}
                        className={`px-3 py-2 rounded-lg text-xs font-bold text-white transition-colors ${!canDeleteData || deleteScopeCount === 0
                            ? 'bg-gray-400 cursor-not-allowed'
                            : 'bg-red-600 hover:bg-red-500'
                            }`}
                        title="Delete the files Ensembl Go downloaded or generated, then forget the genomes."
                    >
                        {manual.length > 0 && downloaded.length > 0 && !includeManual
                            ? `Delete data · downloads only (${downloaded.length})`
                            : `Delete data (${deleteScopeCount})`}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className={`ml-auto px-3 py-2 rounded-lg text-xs font-medium ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-700'}`}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}
