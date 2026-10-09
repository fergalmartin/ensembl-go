import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { API_BASE } from '../../backendRuntime.js'
import { getAssemblyAccession, normalizeGenomeProvider } from '../../utils/genomeIdentity.js'
import { IconDownload, IconDownloaded, IconFiles, IconTrash, IconUpDown } from './downloadIcons'
import { alignmentFileLabel, availabilityFileId, chooseFilesForTypes, compactFileLabel, localFilePathForAvailabilityFile, selectAssemblyDisplayFiles, selectPrimaryDatasetFiles, sortAvailabilityReleases, sortFilesByCompactLabel, taskForAvailabilityFile, withRequiredMetadataFiles } from './downloadModel.js'

export function FileAvailabilityDropdown({ item, selectedTypes, localTypes = [], localFileInfo = null, itemTasks = [], onDownloadFiles, onCancelFiles, onDeleteFile, isLight }) {
    const popoverRef = useRef(null)
    const scrollBodyRef = useRef(null)
    const triggerRef = useRef(null)
    const dismissTimerRef = useRef(null)
    const [open, setOpen] = useState(false)
    const [popoverPlacement, setPopoverPlacement] = useState(null)
    const [loading, setLoading] = useState(false)
    const [availability, setAvailability] = useState(null)
    const [error, setError] = useState('')
    const [expandedReleaseKeys, setExpandedReleaseKeys] = useState(new Set())
    const [datasetSectionOpenByKey, setDatasetSectionOpenByKey] = useState({})
    const [selectedFileIds, setSelectedFileIds] = useState(new Set())
    const localTypeSet = useMemo(() => new Set((Array.isArray(localTypes) ? localTypes : []).map((type) => String(type || '').trim()).filter(Boolean)), [localTypes])

    const clearDismissTimer = useCallback(() => {
        if (dismissTimerRef.current) {
            window.clearTimeout(dismissTimerRef.current)
            dismissTimerRef.current = null
        }
    }, [])

    const scheduleDismiss = useCallback(() => {
        clearDismissTimer()
        dismissTimerRef.current = window.setTimeout(() => {
            dismissTimerRef.current = null
            setOpen(false)
        }, 1000)
    }, [clearDismissTimer])

    useEffect(() => () => clearDismissTimer(), [clearDismissTimer])

    useEffect(() => {
        if (!open) clearDismissTimer()
    }, [clearDismissTimer, open])

    const handlePopoverWheel = useCallback((event) => {
        const scrollEl = scrollBodyRef.current
        event.stopPropagation()
        event.preventDefault()
        if (!scrollEl) return

        const target = event.target
        const targetInScrollBody = target ? scrollEl.contains(target) : false
        if (!targetInScrollBody) return

        const deltaUnit = event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
                ? scrollEl.clientHeight
                : 1
        const deltaY = event.deltaY * deltaUnit
        const deltaX = event.deltaX * deltaUnit

        if (deltaY) scrollEl.scrollTop += deltaY
        if (deltaX) scrollEl.scrollLeft += deltaX
    }, [])

    useEffect(() => {
        if (!open) return undefined
        const popoverEl = popoverRef.current
        if (!popoverEl) return undefined
        popoverEl.addEventListener('wheel', handlePopoverWheel, { capture: true, passive: false })
        return () => {
            popoverEl.removeEventListener('wheel', handlePopoverWheel, true)
        }
    }, [handlePopoverWheel, open])

    const allFiles = useMemo(() => {
        const assemblyFiles = Array.isArray(availability?.assembly_files) ? availability.assembly_files : []
        const releases = Array.isArray(availability?.dataset_releases) ? availability.dataset_releases : []
        return [
            ...assemblyFiles,
            ...releases.flatMap((release) => Array.isArray(release?.files) ? release.files : []),
        ]
    }, [availability])

    const isFileLocal = useCallback((file) => {
        if (!file) return false
        const localPath = localFilePathForAvailabilityFile(file, item, localFileInfo)
        if (localFileInfo) return Boolean(localPath)
        return localTypeSet.has(file?.type)
    }, [item, localFileInfo, localTypeSet])

    const resetSelectionFromToolbar = useCallback((nextAvailability, nextReleaseKey) => {
        const selected = chooseFilesForTypes({
            ...nextAvailability,
            default_dataset_release_key: nextReleaseKey || nextAvailability?.default_dataset_release_key,
        }, Array.from(selectedTypes))
            .filter((file) => {
                if (!file) return false
                const localPath = localFilePathForAvailabilityFile(file, item, localFileInfo)
                if (localFileInfo) return !localPath
                return !localTypeSet.has(file?.type)
            })
        setSelectedFileIds(new Set(selected.map(availabilityFileId)))
    }, [item, localFileInfo, localTypeSet, selectedTypes])

    const sortedFiles = useCallback((files) => {
        const familyOrder = {
            fasta: 0,
            metadata: 1,
            gff3: 10,
            gff3_index: 11,
            gtf: 12,
            gtf_index: 13,
            embl: 14,
            cdna: 20,
            cdna_index: 21,
            protein: 30,
            protein_index: 31,
            xref: 40,
            xref_index: 41,
            homology: 50,
            alignment: 70,
            other_annotation: 90,
        }
        return [...(Array.isArray(files) ? files : [])].sort((a, b) => {
            const oa = familyOrder[a?.type] ?? 80
            const ob = familyOrder[b?.type] ?? 80
            if (oa !== ob) return oa - ob
            return String(a?.filename || '').localeCompare(String(b?.filename || ''), undefined, { numeric: true, sensitivity: 'base' })
        })
    }, [])

    const updatePopoverPlacement = useCallback(() => {
        const trigger = triggerRef.current
        if (!trigger || typeof window === 'undefined') return
        const rect = trigger.getBoundingClientRect()
        const margin = 16
        const gap = 8
        const width = Math.min(680, Math.max(280, window.innerWidth - (margin * 2)))
        const left = Math.min(
            Math.max(margin, rect.right - width),
            Math.max(margin, window.innerWidth - width - margin),
        )
        const spaceBelow = window.innerHeight - rect.bottom - gap - margin
        const spaceAbove = rect.top - gap - margin
        const openAbove = spaceBelow < 300 && spaceAbove > spaceBelow
        const availableHeight = Math.max(220, openAbove ? spaceAbove : spaceBelow)
        const maxHeight = Math.min(540, availableHeight)
        const top = Math.max(margin, Math.min(window.innerHeight - margin - maxHeight, rect.bottom + gap))
        setPopoverPlacement({
            left,
            width,
            maxHeight,
            bodyMaxHeight: Math.max(160, maxHeight - 104),
            ...(openAbove
                ? { bottom: Math.max(margin, window.innerHeight - rect.top + gap) }
                : { top }),
        })
    }, [])

    useEffect(() => {
        if (!open) return undefined
        const handlePointerDown = (event) => {
            if (popoverRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return
            setOpen(false)
        }
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('mousedown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open])

    useEffect(() => {
        if (!open) return undefined
        updatePopoverPlacement()
        const frameId = window.requestAnimationFrame(updatePopoverPlacement)
        window.addEventListener('resize', updatePopoverPlacement)
        window.addEventListener('scroll', updatePopoverPlacement, true)
        return () => {
            window.cancelAnimationFrame(frameId)
            window.removeEventListener('resize', updatePopoverPlacement)
            window.removeEventListener('scroll', updatePopoverPlacement, true)
        }
    }, [open, updatePopoverPlacement])

    useEffect(() => {
        if (!open || availability) return
        let cancelled = false
        const fetchAvailability = async () => {
            setLoading(true)
            setError('')
            try {
                const params = new URLSearchParams({
                    provider: normalizeGenomeProvider(item),
                    include_directory_listing: 'true',
                })
                const res = await fetch(`${API_BASE}/api/remote/files/${item.species_key}/${encodeURIComponent(getAssemblyAccession(item))}/availability?${params.toString()}`)
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(data?.detail || 'Could not load available files')
                if (cancelled) return
                const defaultReleaseKey = data?.default_dataset_release_key || data?.dataset_releases?.[0]?.key || ''
                setAvailability(data)
                setExpandedReleaseKeys(new Set(defaultReleaseKey ? [defaultReleaseKey] : []))
                setDatasetSectionOpenByKey({})
                resetSelectionFromToolbar(data, defaultReleaseKey)
            } catch (e) {
                if (!cancelled) setError(e?.message || 'Could not load available files')
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        fetchAvailability()
        return () => { cancelled = true }
    }, [availability, item, open, resetSelectionFromToolbar])

    const releases = useMemo(() => sortAvailabilityReleases(availability?.dataset_releases), [availability])
    const assemblyFiles = selectAssemblyDisplayFiles(sortedFiles(availability?.assembly_files))

    const toggleFile = (file) => {
        const id = availabilityFileId(file)
        setSelectedFileIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
                return next
            }
            next.add(id)
            return next
        })
    }

    const toggleReleaseOpen = (releaseKey) => {
        setExpandedReleaseKeys((prev) => {
            const next = new Set(prev)
            next.has(releaseKey) ? next.delete(releaseKey) : next.add(releaseKey)
            return next
        })
    }

    const isDatasetSectionOpen = (releaseKey, section) => {
        const key = `${releaseKey}:${section}`
        if (Object.prototype.hasOwnProperty.call(datasetSectionOpenByKey, key)) {
            return !!datasetSectionOpenByKey[key]
        }
        return section === 'primary'
    }

    const toggleDatasetSectionOpen = (releaseKey, section) => {
        const key = `${releaseKey}:${section}`
        setDatasetSectionOpenByKey((prev) => ({
            ...prev,
            [key]: !isDatasetSectionOpen(releaseKey, section),
        }))
    }

    const toggleAllFiles = (files) => {
        setSelectedFileIds((prev) => {
            const next = new Set(prev)
            const ids = (Array.isArray(files) ? files : []).map(availabilityFileId)
            const allSelected = ids.length > 0 && ids.every((id) => next.has(id))
            ids.forEach((id) => {
                if (allSelected) next.delete(id)
            })
            if (!allSelected) {
                ids.forEach((id) => next.add(id))
            }
            return next
        })
    }

    const selectedFiles = allFiles.filter((file) => selectedFileIds.has(availabilityFileId(file)))
    const visibleSelectedFiles = selectedFiles.filter((file) => file?.type !== 'metadata')
    const selectedActiveFiles = visibleSelectedFiles.filter((file) => {
        const task = taskForAvailabilityFile(file, itemTasks, item)
        return ['pending', 'downloading'].includes(String(task?.status || ''))
    })
    const visibleDownloadFiles = visibleSelectedFiles.filter((file) => {
        const task = taskForAvailabilityFile(file, itemTasks, item)
        return !['pending', 'downloading'].includes(String(task?.status || ''))
    })
    const selectedHasLocalFiles = visibleDownloadFiles.some((file) => isFileLocal(file))
    const showCancelButton = visibleSelectedFiles.length > 0 && visibleDownloadFiles.length === 0 && selectedActiveFiles.length > 0

    const renderFileRow = (file, { label = compactFileLabel(file), primary = false } = {}) => {
        const localPath = localFilePathForAvailabilityFile(file, item, localFileInfo)
        const downloaded = isFileLocal(file)
        const task = taskForAvailabilityFile(file, itemTasks, item)
        const taskStatus = String(task?.status || '')
        const active = ['pending', 'downloading'].includes(taskStatus)
        const gridClass = file?.type === 'alignment'
            ? 'grid-cols-[18px_minmax(180px,0.9fr)_minmax(180px,1.1fr)_28px_28px]'
            : 'grid-cols-[18px_142px_minmax(160px,1fr)_28px_28px]'
        const statusIcon = taskStatus === 'downloading'
            ? (
                <span className={`inline-flex items-center justify-center ${isLight ? 'text-blue-700' : 'text-blue-300'}`} title={`Downloading ${Math.round((Number(task?.progress || 0)) * 100)}%`}>
                    <IconDownload size={13} progress={Number(task?.progress || 0)} />
                </span>
            )
            : taskStatus === 'pending'
                ? (
                    <span className={`inline-flex items-center justify-center ${isLight ? 'text-gray-400' : 'text-gray-500'}`} title="Queued">
                        <IconDownload size={14} />
                    </span>
                )
                : downloaded
                    ? (
                        <span className={`inline-flex items-center justify-center ${isLight ? 'text-green-600' : 'text-green-300'}`} title="Downloaded">
                            <IconDownloaded size={15} />
                        </span>
                    )
                    : null
        return (
        <div key={availabilityFileId(file)} className={`grid ${gridClass} items-center gap-2 px-2 py-1.5 rounded text-xs ${active ? (isLight ? 'bg-blue-50/60' : 'bg-blue-900/15') : (isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-700/40')}`}>
            <input
                type="checkbox"
                checked={selectedFileIds.has(availabilityFileId(file))}
                onChange={() => toggleFile(file)}
                className="rounded"
            />
            <span className={`min-w-0 truncate font-semibold leading-5 ${primary ? (isLight ? 'text-gray-800' : 'text-gray-100') : (isLight ? 'text-gray-600' : 'text-gray-300')}`} title={label}>
                {label}
            </span>
            <span className={`min-w-0 truncate font-mono leading-5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={file.filename}>{file.filename}</span>
            <span className="min-h-[22px] flex items-center justify-center">
                {statusIcon}
            </span>
            <span className="min-h-[22px] flex items-center justify-center">
                {downloaded && localPath && (
                    <button
                        type="button"
                        title="Delete this downloaded file"
                        onClick={(event) => {
                            event.stopPropagation()
                            onDeleteFile?.(item, file, localPath)
                        }}
                        className={`w-6 h-6 inline-flex items-center justify-center rounded transition-colors ${isLight ? 'text-gray-400 hover:text-red-600 hover:bg-red-50' : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20'}`}
                    >
                        <IconTrash size={12} />
                    </button>
                )}
            </span>
        </div>
        )
    }

    const renderDatasetSubsection = (releaseKey, section, label, files, renderFile) => {
        if (!Array.isArray(files) || files.length === 0) return null
        const openSection = isDatasetSectionOpen(releaseKey, section)
        const allSelected = files.length > 0 && files.every((file) => selectedFileIds.has(availabilityFileId(file)))
        return (
            <div>
                <div className="flex items-center justify-between gap-2 px-2 pb-0.5">
                    <button
                        type="button"
                        onClick={() => toggleDatasetSectionOpen(releaseKey, section)}
                        className={`min-w-0 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-left ${isLight ? 'text-gray-400 hover:text-gray-600' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        <IconUpDown open={openSection} size={11} />
                        <span>{label}</span>
                        <span className="font-medium tracking-normal normal-case">({files.length})</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => toggleAllFiles(files)}
                        className={`text-xs font-semibold ${isLight ? 'text-blue-700 hover:text-blue-900' : 'text-blue-300 hover:text-blue-100'}`}
                    >
                        {allSelected ? 'Deselect all' : 'Select all'}
                    </button>
                </div>
                {openSection && (
                    <div className="grid grid-cols-1 gap-y-1">
                        {files.map(renderFile)}
                    </div>
                )}
            </div>
        )
    }

    const popover = open && typeof document !== 'undefined' ? createPortal(
        <div
            ref={popoverRef}
            className={`fixed z-[240] w-[680px] max-w-[calc(100vw-2rem)] rounded-lg border shadow-xl ${isLight ? 'bg-white border-gray-200 text-gray-900' : 'bg-gray-800 border-gray-700 text-gray-100'}`}
            style={{
                left: popoverPlacement?.left,
                top: popoverPlacement?.top,
                bottom: popoverPlacement?.bottom,
                width: popoverPlacement?.width,
                maxHeight: popoverPlacement?.maxHeight,
                visibility: popoverPlacement ? 'visible' : 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseEnter={clearDismissTimer}
            onMouseLeave={scheduleDismiss}
        >
            <div className={`px-3 py-2 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <div className="text-xs font-bold uppercase tracking-widest">Available data</div>
                <div
                    className={`text-xs mt-0.5 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}
                    title={[item.scientific_name, item.common_name && `(${item.common_name})`, item.assembly_name, getAssemblyAccession(item)].filter(Boolean).join(' · ')}
                >
                    {[item.scientific_name, item.common_name && `(${item.common_name})`, item.assembly_name, getAssemblyAccession(item)].filter(Boolean).join(' · ')}
                </div>
            </div>
            {loading ? (
                <div className={`px-3 py-4 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Loading files…</div>
            ) : error ? (
                <div className="px-3 py-4 text-sm text-red-500">{error}</div>
            ) : (
                <div
                    ref={scrollBodyRef}
                    className="overflow-y-auto overscroll-contain p-3 space-y-3"
                    style={{ maxHeight: popoverPlacement?.bodyMaxHeight || 420 }}
                >
                    <div>
                        <div className="flex items-center justify-between gap-2 mb-1">
                            <div className={`text-[11px] font-bold uppercase tracking-widest ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Assembly</div>
                        </div>
                        {assemblyFiles.length === 0 ? (
                            <div className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>No softmasked assembly listed</div>
                        ) : (
                            <div className="grid grid-cols-1 gap-y-1">
                                {assemblyFiles.map((file) => renderFileRow(file, { label: 'Assembly', primary: true }))}
                            </div>
                        )}
                    </div>
                    {releases.length === 0 ? (
                        <div className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>No dated dataset releases listed</div>
                    ) : releases.map((release) => {
                        const releaseFiles = sortedFiles(release?.files)
                        const primaryFiles = selectPrimaryDatasetFiles(releaseFiles)
                        const primaryIds = new Set(primaryFiles.map(availabilityFileId))
                        const alignmentFiles = sortFilesByCompactLabel(releaseFiles.filter((file) => file?.type === 'alignment'))
                        const otherFiles = sortFilesByCompactLabel(releaseFiles.filter((file) => (
                            !primaryIds.has(availabilityFileId(file)) && file?.type !== 'alignment'
                        )))
                        const releaseOpen = expandedReleaseKeys.has(release.key)
                        const directoryUrl = String(release?.directory_url || '').trim()
                        return (
                            <div key={release.key} className={`rounded-md border ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                                <div className={`flex items-center justify-between gap-2 px-3 py-2 ${isLight ? 'bg-gray-50' : 'bg-gray-750'}`}>
                                    <div className="min-w-0">
                                        <button
                                            type="button"
                                            onClick={() => toggleReleaseOpen(release.key)}
                                            className="flex items-center gap-2 min-w-0 text-left"
                                        >
                                            <IconUpDown open={releaseOpen} size={12} />
                                            <span className={`text-[11px] font-bold uppercase tracking-widest ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                                                {release.label || release.key}
                                            </span>
                                            {release.is_default && (
                                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/40 text-blue-200'}`}>Latest</span>
                                            )}
                                        </button>
                                        {directoryUrl && (
                                            <a
                                                href={directoryUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                                className={`block pl-5 mt-0.5 truncate text-[11px] font-mono ${isLight ? 'text-blue-700 hover:text-blue-900' : 'text-blue-300 hover:text-blue-100'}`}
                                                title={directoryUrl}
                                            >
                                            {directoryUrl}
                                            </a>
                                        )}
                                    </div>
                                </div>
                                {releaseOpen && (
                                    <div className="p-2">
                                        {releaseFiles.length === 0 ? (
                                            <div className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>No dataset files listed</div>
                                        ) : (
                                            <div className="space-y-2">
                                                {renderDatasetSubsection(
                                                    release.key,
                                                    'primary',
                                                    'Primary',
                                                    primaryFiles,
                                                    (file) => renderFileRow(file, { label: compactFileLabel(file, true), primary: true }),
                                                )}
                                                {renderDatasetSubsection(
                                                    release.key,
                                                    'alignments',
                                                    'Alignments',
                                                    alignmentFiles,
                                                    (file) => renderFileRow(file, { label: alignmentFileLabel(file) }),
                                                )}
                                                {renderDatasetSubsection(
                                                    release.key,
                                                    'other',
                                                    'Other',
                                                    otherFiles,
                                                    (file) => renderFileRow(file, { label: compactFileLabel(file) }),
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
            <div className={`px-3 py-2 border-t flex items-center justify-between gap-2 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-750'}`}>
                <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{visibleSelectedFiles.length} selected</span>
                <button
                    type="button"
                    disabled={visibleSelectedFiles.length === 0}
                    onClick={() => {
                        if (showCancelButton) {
                            onCancelFiles?.(withRequiredMetadataFiles(visibleSelectedFiles, allFiles))
                            return
                        }
                        onDownloadFiles(withRequiredMetadataFiles(visibleDownloadFiles, allFiles), { force: selectedHasLocalFiles })
                        setOpen(false)
                    }}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold text-white ${visibleSelectedFiles.length === 0
                        ? 'bg-gray-400 cursor-not-allowed'
                        : showCancelButton
                            ? 'bg-red-600 hover:bg-red-500'
                            : 'bg-blue-600 hover:bg-blue-500'}`}
                >
                    {showCancelButton ? 'Cancel' : 'Download'}
                </button>
            </div>
        </div>,
        document.body,
    ) : null

    return (
        <div className="relative">
            <button
                ref={triggerRef}
                type="button"
                title="Choose exact files"
                onClick={(e) => {
                    e.stopPropagation()
                    clearDismissTimer()
                    setOpen((prev) => {
                        const next = !prev
                        if (next) setPopoverPlacement(null)
                        return next
                    })
                }}
                className={`w-8 h-8 inline-flex items-center justify-center rounded-md border transition-colors ${isLight
                    ? 'text-gray-500 border-gray-200 hover:text-gray-800 hover:bg-gray-50'
                    : 'text-gray-400 border-gray-700 hover:text-gray-100 hover:bg-gray-700'}`}
            >
                <IconFiles size={15} />
            </button>
            {popover}
        </div>
    )
}
