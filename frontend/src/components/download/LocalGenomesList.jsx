import { useEffect, useMemo, useRef, useState } from 'react'
import { getAssemblyAccession, getAssemblyGenomeKey, normalizeGenomeSourceDatabase } from '../../utils/genomeIdentity.js'
import { IconTrash } from './downloadIcons'
import { GenomeRowActions } from './GenomeRowActions'
import { PanelHeader } from './PanelHeader'

// ---------------------------------------------------------------------------
// Local Genomes List
// ---------------------------------------------------------------------------
export function LocalGenomesList({
    items,
    activeItems = [],
    selectedTypes,
    tasksByItemKey,
    isLight,
    onDownload,
    onDownloadFiles,
    onCancelFiles,
    onDeleteFile,
    onDeleteLocalGenome,
    onDeleteAllLocalGenomes,
    deletingLocalGenomes = false,
    downloading = false,
}) {
    const panelRef = useRef(null)
    const [pendingDeleteKey, setPendingDeleteKey] = useState('')
    const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
    const panelBase = `rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`
    const borderClass = isLight ? 'border-gray-200' : 'border-gray-700'
    const gridCols = 'minmax(0, 2fr) 155px minmax(0, 1fr) 140px 124px'
    const rowBase = `grid items-center border-b text-sm transition-colors ${isLight ? 'border-gray-100 hover:bg-gray-50' : 'border-gray-700/50 hover:bg-gray-700/30'}`
    const thClass = `px-3 py-2 text-left text-xs font-medium ${isLight ? 'text-gray-500' : 'text-gray-400'}`
    const activeSortedItems = useMemo(() => [...activeItems].sort((a, b) => {
        const nameCompare = String(a.scientific_name || '').localeCompare(String(b.scientific_name || ''), undefined, { sensitivity: 'base' })
        if (nameCompare !== 0) return nameCompare
        return String(getAssemblyAccession(a)).localeCompare(String(getAssemblyAccession(b)), undefined, { numeric: true, sensitivity: 'base' })
    }), [activeItems])
    const sortedItems = useMemo(() => [...items].sort((a, b) => {
        const nameCompare = String(a.scientific_name || '').localeCompare(String(b.scientific_name || ''), undefined, { sensitivity: 'base' })
        if (nameCompare !== 0) return nameCompare
        return String(getAssemblyAccession(a)).localeCompare(String(getAssemblyAccession(b)), undefined, { numeric: true, sensitivity: 'base' })
    }), [items])
    const activeTaskCount = activeSortedItems.reduce((sum, item) => {
        const key = getAssemblyGenomeKey(item)
        const tasks = tasksByItemKey?.[key] || []
        return sum + tasks.filter((task) => ['pending', 'downloading'].includes(task.status)).length
    }, 0)
    const failedTaskCount = activeSortedItems.reduce((sum, item) => {
        const key = getAssemblyGenomeKey(item)
        const tasks = tasksByItemKey?.[key] || []
        return sum + tasks.filter((task) => task.status === 'failed').length
    }, 0)
    const localKeys = new Set(sortedItems.map((item) => getAssemblyGenomeKey(item)))
    const visibleActiveItems = activeSortedItems.filter((item) => !localKeys.has(getAssemblyGenomeKey(item)))
    const deletableItems = sortedItems.filter((item) => item?.download_managed)
    const countLabel = [
        `${items.length} local`,
        activeTaskCount > 0 ? `${activeTaskCount} active` : '',
        failedTaskCount > 0 ? `${failedTaskCount} failed` : '',
    ].filter(Boolean).join(' • ')

    const confirmDelete = async (item) => {
        await onDeleteLocalGenome?.(item)
        setPendingDeleteKey('')
    }

    const confirmDeleteAll = async () => {
        await onDeleteAllLocalGenomes?.(deletableItems)
        setPendingDeleteAll(false)
        setPendingDeleteKey('')
    }

    useEffect(() => {
        if (!pendingDeleteKey && !pendingDeleteAll) return undefined
        const clearPendingDelete = () => {
            setPendingDeleteKey('')
            setPendingDeleteAll(false)
        }
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') clearPendingDelete()
        }
        const handlePointerDown = (event) => {
            const target = event.target
            if (target?.closest?.('[data-local-delete-control="true"]')) return
            clearPendingDelete()
        }
        document.addEventListener('keydown', handleKeyDown)
        document.addEventListener('mousedown', handlePointerDown)
        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.removeEventListener('mousedown', handlePointerDown)
        }
    }, [pendingDeleteKey, pendingDeleteAll])

    const deleteAllAction = pendingDeleteAll ? (
        <div className="flex items-center gap-1" data-local-delete-control="true">
            <button
                type="button"
                disabled={deletingLocalGenomes || deletableItems.length === 0}
                onClick={confirmDeleteAll}
                className={`px-2 py-1 rounded text-xs font-semibold whitespace-nowrap ${deletingLocalGenomes || deletableItems.length === 0
                    ? 'opacity-40 cursor-not-allowed'
                    : (isLight ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-red-500 text-white hover:bg-red-400')}`}
                title="This will delete all downloaded data listed here."
            >
                Remove all
            </button>
            <button
                type="button"
                onClick={() => setPendingDeleteAll(false)}
                className={`px-1 py-1 rounded text-xs ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
            >
                Cancel
            </button>
        </div>
    ) : (
        <button
            type="button"
            data-local-delete-control="true"
            disabled={deletableItems.length === 0}
            onClick={() => setPendingDeleteAll(true)}
            className={`p-1 rounded transition-colors ${deletableItems.length === 0
                ? (isLight ? 'text-gray-300 cursor-not-allowed' : 'text-gray-600 cursor-not-allowed')
                : (isLight ? 'text-gray-400 hover:text-red-600 hover:bg-red-50' : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20')}`}
            title={deletableItems.length === 0 ? 'Custom genomes must be deleted manually' : 'Select all listed downloaded data for removal'}
        >
            <IconTrash size={14} />
        </button>
    )

    const renderRow = (item, { active = false } = {}) => {
        const key = getAssemblyGenomeKey(item)
        const localTypes = active ? [] : (Array.isArray(item.types) ? item.types : [])
        const rowPendingDelete = pendingDeleteKey === key
        const canDelete = !active && !!item.download_managed
        const source = item.source_database || normalizeGenomeSourceDatabase(item)
        return (
            <div key={`${active ? 'active' : 'local'}:${key}`} className={rowBase} style={{ gridTemplateColumns: gridCols }}>
                <div className={`px-3 py-2.5 overflow-hidden ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                    <div className="font-medium leading-tight truncate" title={item.scientific_name || item.species_key}>{item.scientific_name || item.species_key}</div>
                    {active ? (
                        <div className={`text-xs mt-0.5 truncate ${isLight ? 'text-blue-700' : 'text-blue-300'}`}>Download in progress</div>
                    ) : item.common_name ? (
                        <div className={`text-xs mt-0.5 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={item.common_name}>{item.common_name}</div>
                    ) : null}
                </div>
                <div className={`px-3 py-2.5 font-mono text-xs truncate ${isLight ? 'text-gray-600' : 'text-gray-400'}`} title={getAssemblyAccession(item)}>
                    {getAssemblyAccession(item)}
                </div>
                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`} title={item.assembly_name || getAssemblyAccession(item)}>
                    {item.assembly_name || getAssemblyAccession(item)}
                </div>
                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={source}>
                    {source}
                </div>
                <div className="px-3 py-2.5">
                    {rowPendingDelete ? (
                        <div className="flex items-center justify-end gap-1">
                            <button
                                type="button"
                                data-local-delete-control="true"
                                disabled={deletingLocalGenomes}
                                onClick={() => confirmDelete(item)}
                                className={`px-2 py-1 rounded text-xs font-semibold ${deletingLocalGenomes
                                    ? 'opacity-40 cursor-not-allowed'
                                    : (isLight ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-red-500 text-white hover:bg-red-400')}`}
                            >
                                Remove
                            </button>
                            <button
                                type="button"
                                data-local-delete-control="true"
                                disabled={deletingLocalGenomes}
                                onClick={() => setPendingDeleteKey('')}
                                className={`px-1 py-1 rounded text-xs ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                            >
                                Cancel
                            </button>
                        </div>
                    ) : (
                        <GenomeRowActions
                            item={item}
                            selectedTypes={selectedTypes}
                            localTypes={localTypes}
                            localFileInfo={active ? null : item}
                            tasksByItemKey={tasksByItemKey}
                            downloading={downloading}
                            isLight={isLight}
                            onDownload={onDownload}
                            onDownloadFiles={onDownloadFiles}
                            onCancelFiles={onCancelFiles}
                            onDeleteFile={onDeleteFile}
                            onDelete={active ? null : () => setPendingDeleteKey(key)}
                            deleteDisabled={!canDelete || deletingLocalGenomes}
                            deleteTitle={canDelete ? 'Remove downloaded files' : (item.delete_blocked_reason || 'Custom genomes must be deleted manually')}
                        />
                    )}
                </div>
            </div>
        )
    }

    return (
        <div className={panelBase} ref={panelRef}>
            <PanelHeader
                title="Local Genomes"
                count={items.length}
                countLabel={countLabel}
                isLight={isLight}
                actions={deleteAllAction}
            />

            <div className={`grid shrink-0 border-t border-b ${borderClass}`} style={{ gridTemplateColumns: gridCols }}>
                <div className={thClass}>Species</div>
                <div className={thClass}>Accession</div>
                <div className={thClass}>Assembly Name</div>
                <div className={thClass}>Source</div>
                <div className={thClass}></div>
            </div>

            {sortedItems.length === 0 && visibleActiveItems.length === 0 ? (
                <div className={`px-4 py-5 text-center text-sm ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                    No local genomes found
                </div>
            ) : (
                <div>
                    {visibleActiveItems.map((item) => renderRow(item, { active: true }))}
                    {sortedItems.map((item) => renderRow(item))}
                </div>
            )}
        </div>
    )
}
