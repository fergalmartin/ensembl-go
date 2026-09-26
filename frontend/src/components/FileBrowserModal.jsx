import { useState, useEffect, useRef } from 'react'
import { API_BASE } from '../backendRuntime'
import { mergeSelection, rangeBetween } from '../utils/fileSelection'

export default function FileBrowserModal({
    isOpen,
    onClose,
    onSelect,
    initialPath,
    mode = 'file',
    theme,
    extensions = [],
    defaultFileName = '',
    footerContent = null,
    // File mode only: tick several files, even across folders, and hand them over
    // together through onSelectMany. Clicking a file with nothing ticked still picks just
    // that file, as it always has.
    multiple = false,
    onSelectMany = null,
    // Told each folder the browser shows, so a caller can reopen it where the user was.
    onDirectoryChange = null,
}) {
    const [currentPath, setCurrentPath] = useState(initialPath || '.')
    const [items, setItems] = useState([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [selectedItem, setSelectedItem] = useState(null) // For directory selection or single file highlight
    const [showAll, setShowAll] = useState(false)
    const [activeExtensions, setActiveExtensions] = useState([])
    const [saveFileName, setSaveFileName] = useState(defaultFileName)
    // Ticked files, by path, in the order they were ticked. Paths are absolute, so a
    // selection survives moving between folders.
    const [checkedPaths, setCheckedPaths] = useState([])
    const allowMany = multiple && mode === 'file' && typeof onSelectMany === 'function'
    // The file a Shift-click ranges from: the last one clicked or ticked.
    const [anchorPath, setAnchorPath] = useState(null)
    // A drag across rows: where it started and what was ticked before it.
    const dragRef = useRef(null)
    // A drag that ends on the row it began on still fires that row's click; this eats it.
    const suppressClickRef = useRef(false)

    // New Directory State
    const [isCreatingDirectory, setIsCreatingDirectory] = useState(false)
    const [newDirectoryName, setNewDirectoryName] = useState('')

    const pathRef = useRef(null)

    // Auto-scroll path to end when it changes
    useEffect(() => {
        if (pathRef.current) {
            pathRef.current.scrollLeft = pathRef.current.scrollWidth
        }
    }, [currentPath])

    const isLight = theme === 'light'

    // Re-point an open browser when the directory it was asked for changes.
    //
    // Keying only on `isOpen` meant the path was read once, when it opened, and a later
    // change was ignored — so anything that opened the browser and *then* said where it
    // should be looking left it in the previous directory with no sign anything was wrong.
    // A tutorial framing a step around one folder is the case that found this; the same
    // would happen to any caller that sets a directory while the browser is already up.
    useEffect(() => {
        if (isOpen) {
            const startPath = initialPath || '.'
            setCurrentPath(startPath)
            setSaveFileName(defaultFileName)
            setIsCreatingDirectory(false)
            setNewDirectoryName('')
            setSelectedItem(null)
            setCheckedPaths([])
            setAnchorPath(null)
            fetchItems(startPath)
            // Reset filters: activeExtensions = all extensions passed, showAll = false (unless no extensions)
            if (extensions && extensions.length > 0) {
                setActiveExtensions(extensions)
                setShowAll(false)
            } else {
                setActiveExtensions([])
                setShowAll(true)
            }
        }
        // `initialPath` included deliberately: see above. It is the directory the caller
        // asked for, not where the user has since navigated to — that is `currentPath`,
        // which this does not watch, so browsing around is never interrupted.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, initialPath])

    const fetchItems = async (path) => {
        setLoading(true)
        setError(null)
        try {
            // Encode path for URL
            const encodedPath = encodeURIComponent(path)
            const res = await fetch(`${API_BASE}/api/files/list?path=${encodedPath}`)
            if (!res.ok) {
                const err = await res.json()
                throw new Error(err.detail || 'Failed to list files')
            }
            const data = await res.json()
            setItems(data.items)
            // Update current path to the absolute path returned by backend
            if (data.current_path && data.current_path !== currentPath) {
                setCurrentPath(data.current_path)
            }
            onDirectoryChange?.(data.current_path || path)
        } catch (e) {
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }

    const handleItemClick = (item, event = null) => {
        if (item.name === '..') {
            fetchItems(item.path)
            setSelectedItem(null)
            return
        }

        if (item.is_dir) {
            // If navigating, double click or just click?
            // Standard web behavior: click to navigate
            fetchItems(item.path)
            setSelectedItem(null)
        } else {
            // It's a file. Shift-click takes the range from the last file clicked, Cmd/Ctrl
            // adds or removes one, and once anything is ticked a plain click does too,
            // rather than throwing the selection away for this one file.
            if (allowMany) {
                if (suppressClickRef.current) {
                    suppressClickRef.current = false
                    return
                }
                if (event?.shiftKey && anchorPath) {
                    setCheckedPaths((prev) => mergeSelection(prev, rangeBetween(visibleFilePaths, anchorPath, item.path)))
                    return
                }
                if (event?.metaKey || event?.ctrlKey || checkedPaths.length > 0) {
                    toggleChecked(item.path)
                    return
                }
            }
            if (mode === 'file' || mode === 'file-or-directory') {
                setSelectedItem(item)
                onSelect(item.path, { kind: 'file' })
                onClose()
            } else if (mode === 'save') {
                setSelectedItem(item)
                setSaveFileName(item.name)
            }
        }
    }

    const toggleChecked = (path) => {
        setCheckedPaths((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]))
        setAnchorPath(path)
    }

    // The checkbox's own click, which also ranges on Shift.
    const handleCheckboxClick = (item, event) => {
        event.stopPropagation()
        if (event.shiftKey && anchorPath) {
            setCheckedPaths((prev) => mergeSelection(prev, rangeBetween(visibleFilePaths, anchorPath, item.path)))
            return
        }
        toggleChecked(item.path)
    }

    // Click-and-drag: pressing on a file and moving over others ticks every row passed,
    // added to whatever was ticked before the drag began.
    const handleRowMouseDown = (item, event) => {
        if (!allowMany || item.is_dir || event.button !== 0) return
        if (event.shiftKey || event.metaKey || event.ctrlKey) return
        dragRef.current = { start: item.path, base: checkedPaths, moved: false }
        // No text selection while dragging across names.
        event.preventDefault()
    }
    const handleRowMouseEnter = (item, event) => {
        const drag = dragRef.current
        if (!drag || item.is_dir || !(event.buttons & 1)) return
        if (!drag.moved && item.path === drag.start) return
        drag.moved = true
        setCheckedPaths(mergeSelection(drag.base, rangeBetween(visibleFilePaths, drag.start, item.path)))
        setAnchorPath(drag.start)
    }
    useEffect(() => {
        if (!isOpen || !allowMany) return undefined
        const handleMouseUp = () => {
            const drag = dragRef.current
            dragRef.current = null
            if (!drag?.moved) return
            // The click that may follow this mouseup belongs to the drag, not to a pick.
            // Cleared after it, so it can never swallow a later click.
            suppressClickRef.current = true
            setTimeout(() => { suppressClickRef.current = false }, 0)
        }
        window.addEventListener('mouseup', handleMouseUp)
        return () => window.removeEventListener('mouseup', handleMouseUp)
    }, [isOpen, allowMany])

    const handleAddChecked = () => {
        if (!checkedPaths.length) return
        onSelectMany(checkedPaths.slice())
        onClose()
    }

    const handleSelectDirectory = (path) => {
        if (mode !== 'directory' && mode !== 'file-or-directory') return
        onSelect(path, { kind: 'directory' })
        onClose()
    }

    const handleSaveFile = () => {
        const filename = String(saveFileName || '').trim()
        if (!filename) return
        const separator = currentPath.endsWith('/') ? '' : '/'
        onSelect(`${currentPath}${separator}${filename}`, { kind: 'file' })
        onClose()
    }

    const handleCreateDirectory = async () => {
        if (!newDirectoryName.trim()) return

        try {
            // Remove trailing slash if present
            const base = currentPath.endsWith('/') ? currentPath.slice(0, -1) : currentPath;
            const newPath = `${base}/${newDirectoryName.trim()}`;

            const res = await fetch(`${API_BASE}/api/files/mkdir`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: newPath })
            });

            if (res.ok) {
                await fetchItems(currentPath);
                setIsCreatingDirectory(false)
                setNewDirectoryName('')
            } else {
                const payload = await res.json().catch(() => ({}))
                setError(payload?.detail || 'Failed to create directory')
            }
        } catch (e) {
            setError(`Error creating directory: ${e.message}`)
        }
    }

    // What the list shows: directories always, files by the extension filters.
    const visibleItems = (list) => list.filter((item) => {
        if (item.is_dir) return true
        if (mode === 'directory') return false
        if (showAll) return true
        if (!extensions || extensions.length === 0) return true
        return activeExtensions.some((ext) => item.name.toLowerCase().endsWith(ext.toLowerCase()))
    })
    const visibleFiles = visibleItems(items).filter((item) => !item.is_dir)
    const visibleFilePaths = visibleFiles.map((item) => item.path)
    const allVisibleChecked = visibleFiles.length > 0 && visibleFiles.every((item) => checkedPaths.includes(item.path))

    // Styles
    const modalBg = isLight ? 'bg-white' : 'bg-gray-800'
    const textColor = isLight ? 'text-gray-900' : 'text-gray-100'
    const borderColor = isLight ? 'border-gray-200' : 'border-gray-700'
    const hoverBg = isLight ? 'hover:bg-gray-100' : 'hover:bg-gray-700'
    const activeBg = isLight ? 'bg-blue-50' : 'bg-blue-900/30'

    if (!isOpen) return null

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div
                data-tour-id="file-browser"
                className={`${modalBg} w-full max-w-3xl rounded-xl shadow-2xl flex flex-col max-h-[80vh] overflow-hidden`}
            >
                {/* Header */}
                <div className={`p-4 border-b ${borderColor} flex justify-between items-center`}>
                    <h3 className={`text-lg font-semibold ${textColor}`}>
                        {mode === 'directory'
                            ? 'Select Directory'
                            : mode === 'file-or-directory'
                                ? 'Select File or Directory'
                                : mode === 'save'
                                    ? 'Save File'
                                    : allowMany ? 'Select Files' : 'Select File'}
                    </h3>
                    <button data-tour-id="file-browser-close" onClick={onClose} className={`p-1 rounded-md ${hoverBg} transition-colors`}>
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M15 5L5 15M5 5l10 10" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </button>
                </div>

                {/* Path Bar */}
                <div
                    ref={pathRef}
                    data-tour-id="file-browser-path"
                    className={`px-4 py-2 ${isLight ? 'bg-white' : 'bg-gray-900/50'} border-b ${borderColor} flex items-center gap-2 overflow-x-auto whitespace-nowrap`}
                >
                    <span className="text-gray-500 text-sm font-mono">path:</span>
                    <span className={`text-sm font-mono ${textColor}`}>{currentPath}</span>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-2 min-h-[300px]">
                    {loading ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full"></div>
                        </div>
                    ) : error ? (
                        <div className="text-red-400 p-4 text-center">
                            <p>{error}</p>
                            <button
                                onClick={() => fetchItems('.')}
                                className="mt-2 text-sm text-blue-400 hover:underline"
                            >
                                Go to Home
                            </button>
                        </div>
                    ) : (
                        <div data-tour-id="file-browser-list" className="space-y-0.5">
                            {visibleItems(items)
                                .map((item) => {
                                    const isChecked = allowMany && checkedPaths.includes(item.path)
                                    const isSelected = selectedItem?.path === item.path || isChecked
                                    return (
                                        <div
                                            key={item.path}
                                            data-tour-id={`file-browser-entry-${item.name}`}
                                            onClick={(event) => handleItemClick(item, event)}
                                            onMouseDown={(event) => handleRowMouseDown(item, event)}
                                            onMouseEnter={(event) => handleRowMouseEnter(item, event)}
                                            className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors select-none ${isSelected ? activeBg : hoverBg
                                                }`}
                                        >
                                            {allowMany && (
                                                item.is_dir ? (
                                                    <span className="w-4 shrink-0" aria-hidden="true" />
                                                ) : (
                                                    // A generous target around a small box: a click that lands
                                                    // just off it still ticks rather than picking the file.
                                                    <button
                                                        type="button"
                                                        role="checkbox"
                                                        aria-checked={isChecked}
                                                        aria-label={`Select ${item.name}`}
                                                        onMouseDown={(event) => event.stopPropagation()}
                                                        onClick={(event) => handleCheckboxClick(item, event)}
                                                        className="-my-2 -ml-3 pl-3 pr-2 py-2 shrink-0 flex items-center rounded-lg"
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            readOnly
                                                            tabIndex={-1}
                                                            checked={isChecked}
                                                            className="pointer-events-none rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                        />
                                                    </button>
                                                )
                                            )}
                                            <div className={isLight ? 'text-gray-500' : 'text-gray-400'}>
                                                {item.name === '..' ? (
                                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                        <path d="M11 17l-5-5m0 0l5-5m-5 5h8a2 2 0 012 2v2" strokeLinecap="round" strokeLinejoin="round" />
                                                    </svg>
                                                ) : item.is_dir ? (
                                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                        <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" strokeLinecap="round" strokeLinejoin="round" />
                                                    </svg>
                                                ) : (
                                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                        <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" />
                                                    </svg>
                                                )}
                                            </div>
                                            <div className={`flex-1 truncate text-sm ${textColor}`}>
                                                {item.name}
                                            </div>
                                            {item.size > 0 && (
                                                <div className="text-xs text-gray-500 font-mono">
                                                    {(item.size / 1024).toFixed(1)} KB
                                                </div>
                                            )}
                                            {mode === 'file-or-directory' && item.is_dir && item.name !== '..' ? (
                                                <button
                                                    type="button"
                                                    onClick={(event) => {
                                                        event.stopPropagation()
                                                        handleSelectDirectory(item.path)
                                                    }}
                                                    className={`shrink-0 px-2.5 py-1 rounded text-xs font-medium transition-colors ${isLight
                                                        ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                                                        : 'bg-blue-900/30 text-blue-300 hover:bg-blue-900/50'
                                                        }`}
                                                >
                                                    Select
                                                </button>
                                            ) : null}
                                        </div>
                                    )
                                })}
                            {items.length === 0 && (
                                <div className="text-center text-gray-500 py-8 text-sm">
                                    Empty directory
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className={`border-t ${borderColor} ${isLight ? 'bg-white' : 'bg-gray-900/50'}`}>
                    {/* Extension filters row */}
                    {extensions && extensions.length > 0 && (
                        <div className={`px-4 pt-3 pb-2 flex items-center gap-3 flex-wrap`}>
                            <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={showAll}
                                    onChange={(e) => setShowAll(e.target.checked)}
                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                                <span className={`text-sm font-medium whitespace-nowrap ${textColor}`}>All Files</span>
                            </label>

                            <div className={`w-px h-4 ${isLight ? 'bg-gray-300' : 'bg-gray-600'}`}></div>

                            {extensions.map(ext => (
                                <label key={ext} className={`flex items-center gap-1.5 cursor-pointer ${showAll ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                    <input
                                        type="checkbox"
                                        checked={showAll || activeExtensions.includes(ext)}
                                        disabled={showAll}
                                        onChange={(e) => {
                                            if (e.target.checked) {
                                                setActiveExtensions(prev => [...prev, ext])
                                            } else {
                                                setActiveExtensions(prev => prev.filter(x => x !== ext))
                                            }
                                        }}
                                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    <span className={`text-sm whitespace-nowrap ${textColor}`}>{ext}</span>
                                </label>
                            ))}
                        </div>
                    )}

                    {footerContent ? (
                        <div className={`px-4 py-3 border-t ${borderColor}`}>
                            {footerContent}
                        </div>
                    ) : null}

                    {/* Action buttons row */}
                    <div className={`px-4 py-3 flex items-center justify-end gap-3 ${(extensions && extensions.length > 0) || footerContent ? `border-t ${borderColor}` : ''}`}>
                        {mode === 'save' && !isCreatingDirectory ? (
                            <input
                                type="text"
                                value={saveFileName}
                                onChange={(event) => setSaveFileName(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') handleSaveFile()
                                }}
                                placeholder="Filename"
                                className={`mr-auto min-w-0 flex-1 max-w-sm px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
                                    ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
                                    : 'bg-gray-800 border-gray-600 text-gray-100 focus:ring-blue-500/40'
                                    }`}
                            />
                        ) : null}
                        {isCreatingDirectory ? (
                            <div className="flex items-center gap-2 mr-auto animate-in fade-in slide-in-from-right-4 duration-200">
                                <input
                                    type="text"
                                    value={newDirectoryName}
                                    onChange={(e) => setNewDirectoryName(e.target.value)}
                                    placeholder="Directory name"
                                    className={`px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 w-40 ${isLight
                                        ? 'bg-white border-gray-300 focus:ring-blue-500/40 focus:border-blue-500'
                                        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'
                                        }`}
                                    autoFocus
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleCreateDirectory()
                                        if (e.key === 'Escape') setIsCreatingDirectory(false)
                                    }}
                                />
                                <button
                                    onClick={handleCreateDirectory}
                                    className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                                >
                                    Create
                                </button>
                                <button
                                    onClick={() => setIsCreatingDirectory(false)}
                                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${isLight ? 'text-gray-600 hover:bg-gray-200' : 'text-gray-300 hover:bg-gray-700'}`}
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <button
                                onClick={() => {
                                    setNewDirectoryName('')
                                    setIsCreatingDirectory(true)
                                }}
                                className={`mr-auto px-4 py-2 rounded-lg text-sm font-medium transition-colors ${isLight ? 'text-gray-600 hover:bg-gray-200' : 'text-gray-300 hover:bg-gray-700'
                                    }`}
                            >
                                New Directory
                            </button>
                        )}

                        {allowMany && (
                            <div className={`flex items-center gap-3 text-sm ${textColor}`}>
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                    <input
                                        data-tour-id="file-browser-select-all"
                                        type="checkbox"
                                        checked={allVisibleChecked}
                                        disabled={visibleFiles.length === 0}
                                        onChange={(e) => {
                                            const paths = visibleFiles.map((item) => item.path)
                                            setCheckedPaths((prev) => (e.target.checked
                                                ? [...prev, ...paths.filter((p) => !prev.includes(p))]
                                                : prev.filter((p) => !paths.includes(p))))
                                        }}
                                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    <span className="whitespace-nowrap">Select all here</span>
                                </label>
                                {checkedPaths.length === 0 && (
                                    <span className={`hidden md:inline whitespace-nowrap text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                        Shift-click, Cmd/Ctrl-click or drag to choose several
                                    </span>
                                )}
                                {checkedPaths.length > 0 && (
                                    <>
                                        <span className={`whitespace-nowrap ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{checkedPaths.length} selected</span>
                                        <button
                                            type="button"
                                            onClick={() => setCheckedPaths([])}
                                            className="text-xs text-blue-500 hover:underline"
                                        >
                                            Clear
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                        <button
                            onClick={onClose}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${isLight ? 'text-gray-600 hover:bg-gray-200' : 'text-gray-300 hover:bg-gray-700'
                                }`}
                        >
                            Cancel
                        </button>
                        {allowMany && (
                            <button
                                data-tour-id="file-browser-add-selected"
                                onClick={handleAddChecked}
                                disabled={checkedPaths.length === 0}
                                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {checkedPaths.length > 1 ? `Add ${checkedPaths.length} files` : 'Add file'}
                            </button>
                        )}
                        {(mode === 'directory' || mode === 'file-or-directory') && (
                            <button
                                onClick={() => handleSelectDirectory(currentPath)}
                                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors text-white bg-blue-600 hover:bg-blue-700`}
                            >
                                {mode === 'file-or-directory' ? 'Use This Directory' : 'Select Current Directory'}
                            </button>
                        )}
                        {mode === 'save' && (
                            <button
                                onClick={handleSaveFile}
                                disabled={!String(saveFileName || '').trim()}
                                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                            >
                                Save
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
