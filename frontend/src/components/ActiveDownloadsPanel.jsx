import { useCallback, useMemo, useState } from 'react'
import { buildActiveDownloads } from '../utils/activeDownloads'
import { cancelDownloadTasks, useDownloadTasks } from '../utils/downloadTasksStore'

const CrossIcon = () => (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <line x1="2.4" y1="2.4" x2="7.6" y2="7.6" />
        <line x1="7.6" y1="2.4" x2="2.4" y2="7.6" />
    </svg>
)

/**
 * Every queued and running download, one row per genome, with cancel controls.
 * Shared by the Downloads view and the Genome selector so the two read the same;
 * renders nothing while nothing is downloading.
 */
export default function ActiveDownloadsPanel({ theme = 'dark', className = '' }) {
    const isLight = theme === 'light'
    const tasks = useDownloadTasks()
    const { genomes, downloading, queued, taskIds } = useMemo(() => buildActiveDownloads(tasks), [tasks])
    const [cancellingIds, setCancellingIds] = useState(() => new Set())
    const [error, setError] = useState('')

    const cancel = useCallback(async (ids, { all = false } = {}) => {
        if (!all && ids.length === 0) return
        setError('')
        setCancellingIds((prev) => new Set([...prev, ...ids]))
        try {
            await cancelDownloadTasks({ taskIds: ids, all })
        } catch (e) {
            setError(e?.message || 'Failed to cancel downloads')
        } finally {
            setCancellingIds((prev) => {
                const next = new Set(prev)
                ids.forEach((id) => next.delete(id))
                return next
            })
        }
    }, [])

    if (genomes.length === 0) return null

    const muted = isLight ? 'text-gray-500' : 'text-gray-400'
    const secondary = isLight ? 'text-gray-700' : 'text-gray-300'
    // The Genome selector list's header cells.
    const thBaseClass = `px-4 py-3 text-xs font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500 bg-gray-50' : 'text-gray-400 bg-gray-800'}`
    const thClass = `${thBaseClass} text-left`
    const cancelButtonClass = `px-2 py-1 rounded text-[11px] font-semibold transition-colors disabled:opacity-40 ${isLight
        ? 'text-red-700 hover:bg-red-50'
        : 'text-red-300 hover:bg-red-900/30'}`
    const allCancelling = taskIds.length > 0 && taskIds.every((id) => cancellingIds.has(id))

    return (
        <section
            data-tour-id="active-downloads"
            aria-label="Active downloads"
            className={`rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700'} ${className}`}
        >
            <header className={`flex items-center gap-3 px-4 py-2.5 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <h2 className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Active downloads</h2>
                <span className={`text-xs ${muted}`}>
                    {downloading} downloading{queued > 0 ? ` · ${queued} queued` : ''}
                </span>
                {error ? <span className={`text-xs ${isLight ? 'text-red-700' : 'text-red-300'}`}>{error}</span> : null}
                <button
                    type="button"
                    onClick={() => cancel(taskIds, { all: true })}
                    disabled={allCancelling}
                    className={`ml-auto ${cancelButtonClass}`}
                >
                    Cancel all
                </button>
            </header>

            {/* Laid out as the Genome selector's genome list is — same header type,
                same cell padding, same columns in the same order — with the files
                and their progress in one column at the end. */}
            <div className="max-h-80 overflow-auto">
                <table className="w-full text-sm">
                    <thead className={`sticky top-0 z-10 ${isLight ? 'bg-gray-50' : 'bg-gray-800'}`}>
                        <tr className={`border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                            <th className={thClass}>Species</th>
                            <th className={thClass}>Source</th>
                            <th className={thClass}>Accession</th>
                            <th className={thClass}>Assembly</th>
                            <th className={`${thClass} w-[300px]`}>Progress</th>
                            <th className={`${thBaseClass} w-20 text-right`}>
                                <span className="sr-only">Cancel</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {genomes.map((genome) => {
                            const genomeCancelling = genome.taskIds.every((id) => cancellingIds.has(id))
                            const showCommon = genome.name && genome.name !== genome.scientificName
                            return (
                                <tr key={genome.key} className={`border-b last:border-b-0 ${isLight ? 'border-gray-100' : 'border-gray-700/50'}`}>
                                    <td className={`px-4 py-3 align-middle ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                        <div className="font-medium leading-tight">{genome.scientificName || genome.name}</div>
                                        {showCommon ? <div className={`text-xs mt-0.5 ${muted}`}>{genome.name}</div> : null}
                                    </td>
                                    <td className={`px-4 py-3 text-xs align-middle ${secondary}`}>{genome.source}</td>
                                    <td className={`px-4 py-3 font-mono text-xs align-middle ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>{genome.accession || '-'}</td>
                                    <td className={`px-4 py-3 text-xs align-middle ${secondary}`}>{genome.assemblyName}</td>
                                    <td className="px-4 py-2.5 align-middle">
                                        <div className="space-y-1">
                                            {genome.files.map((file) => {
                                                const isQueued = file.status !== 'downloading'
                                                const percent = Math.round(file.progress * 100)
                                                return (
                                                    <div key={file.id} className="grid grid-cols-[76px_minmax(0,1fr)_46px_20px] items-center gap-2 text-xs">
                                                        <span className={`truncate ${secondary}`} title={file.filename}>{file.typeLabel}</span>
                                                        <div
                                                            className={`h-1 rounded-full overflow-hidden ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`}
                                                            role="progressbar"
                                                            aria-label={`${file.typeLabel} for ${genome.name}`}
                                                            aria-valuemin={0}
                                                            aria-valuemax={100}
                                                            aria-valuenow={isQueued ? undefined : percent}
                                                        >
                                                            {isQueued ? null : (
                                                                <div
                                                                    className={`h-full rounded-full ${isLight ? 'bg-blue-600' : 'bg-blue-400'}`}
                                                                    style={{ width: `${Math.max(2, percent)}%`, transition: 'width 0.4s ease' }}
                                                                />
                                                            )}
                                                        </div>
                                                        <span className={`text-right tabular-nums ${isQueued ? muted : (isLight ? 'text-blue-700' : 'text-blue-300')}`}>
                                                            {isQueued ? 'Queued' : `${percent}%`}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={() => cancel([file.id])}
                                                            disabled={cancellingIds.has(file.id)}
                                                            className={`w-5 h-5 rounded flex items-center justify-center transition-colors disabled:opacity-40 ${isLight
                                                                ? 'text-gray-400 hover:text-red-700 hover:bg-red-50'
                                                                : 'text-gray-500 hover:text-red-300 hover:bg-red-900/30'}`}
                                                            title={`Cancel ${file.typeLabel} download`}
                                                            aria-label={`Cancel ${file.typeLabel} download for ${genome.name}`}
                                                        >
                                                            <CrossIcon />
                                                        </button>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 align-middle text-right">
                                        <button
                                            type="button"
                                            onClick={() => cancel(genome.taskIds)}
                                            disabled={genomeCancelling}
                                            className={cancelButtonClass}
                                            title={`Cancel every download for ${genome.name}`}
                                        >
                                            Cancel
                                        </button>
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    )
}
