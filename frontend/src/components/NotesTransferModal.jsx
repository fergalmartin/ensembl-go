// Getting notes out of the app, and back in.
//
// One component, two modes, because they share the plumbing — but they are
// separate dialogs to the reader: the Notes toolbar opens whichever one was
// asked for, and each is sized for its own job. Export needs room for a tree
// and a note reader; import is a short form, and forcing it into the same
// frame left it mostly empty.
//
// Two things about the shape are deliberate:
//
//   * Export is a dialog rather than a mode inside the Notes view. An export
//     wants active and archived notes visible together, and the view's
//     Active/Archived switch shows one set at a time.
//   * Import cannot apply anything until it has scanned. That is enforced by
//     the Apply button needing a scan digest, not by remembering to ask.
//
// Filtering decides only what the tree shows; the export sends the selection
// and nothing else. Every rule about what is selected is in
// utils/notesTransferModel.js.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../backendRuntime'
import FileBrowserModal from './FileBrowserModal'
import NotesTransferTree from './NotesTransferTree'
import {
    DEFAULT_MERGE_STRATEGY,
    DEFAULT_TRANSFER_FORMAT,
    DEFAULT_TRANSFER_NOTE_SET,
    MERGE_STRATEGIES,
    SPREADSHEET_CAVEAT,
    TRANSFER_FORMATS,
    TRANSFER_NOTE_SETS,
    allExpandableNodeIds,
    buildTransferTree,
    computeSelectionStates,
    defaultTransferFilename,
    describeStrategy,
    filterNotesForTransfer,
    noteIdsForTagSelection,
    projectedDeletions,
    selectionSummary,
    summariseScan,
    toggleNode,
    transferFormat,
} from '../utils/notesTransferModel'
import { buildTagCatalogue, sortTagCatalogue } from '../utils/noteTags'
import { noteDisplayTitle, noteTimestampLabel } from '../utils/geneNotes'

const IMPORT_EXTENSIONS = ['.json', '.csv', '.tsv']

function CloseGlyph() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
        </svg>
    )
}

export default function NotesTransferModal({
    open,
    theme = 'dark',
    notes = [],
    activeGenomes = [],
    outputDir = '',
    mode = 'export',
    onImported = null,
    onNotify = null,
    onClose,
}) {
    const isLight = theme === 'light'

    // ── export state ──
    const [selectedIds, setSelectedIds] = useState(() => new Set())
    const [expanded, setExpanded] = useState(() => new Set())
    const [query, setQuery] = useState('')
    const [selectedTags, setSelectedTags] = useState([])
    const [tagMatchMode, setTagMatchMode] = useState('all')
    const [noteSet, setNoteSet] = useState(DEFAULT_TRANSFER_NOTE_SET)
    const [format, setFormat] = useState(DEFAULT_TRANSFER_FORMAT)
    const [filename, setFilename] = useState('')
    const [directory, setDirectory] = useState('')
    const [previewNote, setPreviewNote] = useState(null)
    const [exporting, setExporting] = useState(false)
    const [exportMessage, setExportMessage] = useState(null)
    const [overwritePrompt, setOverwritePrompt] = useState(false)
    const [showDirectoryBrowser, setShowDirectoryBrowser] = useState(false)

    // ── import state ──
    const [importPath, setImportPath] = useState('')
    const [scan, setScan] = useState(null)
    const [scanning, setScanning] = useState(false)
    const [strategy, setStrategy] = useState(DEFAULT_MERGE_STRATEGY)
    const [confirmingDestructive, setConfirmingDestructive] = useState(false)
    const [applying, setApplying] = useState(false)
    const [importMessage, setImportMessage] = useState(null)
    const [showFileBrowser, setShowFileBrowser] = useState(false)
    const seededRef = useRef('')

    useEffect(() => {
        if (!open) {
            seededRef.current = ''
            return
        }
        if (seededRef.current === mode) return
        seededRef.current = mode
        setSelectedIds(new Set())
        setExpanded(new Set())
        setQuery('')
        setSelectedTags([])
        setNoteSet(DEFAULT_TRANSFER_NOTE_SET)
        setFormat(DEFAULT_TRANSFER_FORMAT)
        setFilename(defaultTransferFilename(DEFAULT_TRANSFER_FORMAT))
        setDirectory(String(outputDir || '').trim())
        setPreviewNote(null)
        setExportMessage(null)
        setOverwritePrompt(false)
        setImportPath('')
        setScan(null)
        setStrategy(DEFAULT_MERGE_STRATEGY)
        setConfirmingDestructive(false)
        setImportMessage(null)
    }, [mode, open, outputDir])

    useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => { if (event.key === 'Escape') onClose?.() }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [onClose, open])

    // Changing format keeps the stem and swaps the extension, so a name the user
    // typed is not thrown away.
    useEffect(() => {
        const chosen = transferFormat(format)
        if (!chosen) return
        setFilename((current) => {
            const trimmed = String(current || '').trim()
            if (!trimmed) return defaultTransferFilename(format)
            const stem = trimmed.replace(/\.(json|csv|tsv)$/i, '')
            return `${stem}${chosen.ext}`
        })
    }, [format])

    const notesById = useMemo(() => new Map((notes || []).map((note) => [note.id, note])), [notes])

    const tagCatalogue = useMemo(
        () => sortTagCatalogue(buildTagCatalogue(notes || []), 'popular'),
        [notes],
    )

    const visibleNotes = useMemo(() => filterNotesForTransfer(notes, {
        query, selectedTags, tagMatchMode, noteSet, selectedIds,
    }), [notes, query, selectedTags, tagMatchMode, noteSet, selectedIds])

    const tree = useMemo(
        () => buildTransferTree(visibleNotes, activeGenomes),
        [visibleNotes, activeGenomes],
    )
    const states = useMemo(() => computeSelectionStates(tree, selectedIds), [tree, selectedIds])
    const summary = useMemo(
        () => selectionSummary(tree, selectedIds, notesById),
        [tree, selectedIds, notesById],
    )

    // "Selected only" with nothing selected is a dead end, so it hands back.
    useEffect(() => {
        if (noteSet === 'selected' && selectedIds.size === 0) setNoteSet(DEFAULT_TRANSFER_NOTE_SET)
    }, [noteSet, selectedIds])

    const scanSummary = useMemo(() => summariseScan(scan), [scan])
    const strategyMeta = describeStrategy(strategy)
    const wouldDelete = useMemo(() => projectedDeletions(scan, strategy), [scan, strategy])

    const handleToggleExpanded = useCallback((nodeId) => {
        setExpanded((current) => {
            const next = new Set(current)
            if (next.has(nodeId)) next.delete(nodeId)
            else next.add(nodeId)
            return next
        })
    }, [])

    const handleToggleSelected = useCallback((node) => {
        setSelectedIds((current) => toggleNode(current, tree, node, states))
        setExportMessage(null)
        setOverwritePrompt(false)
    }, [states, tree])

    const handleSelectAllVisible = useCallback(() => {
        setSelectedIds((current) => {
            const next = new Set(current)
            for (const id of (tree.leafIdsByNode.get('root') || [])) next.add(id)
            return next
        })
    }, [tree])

    /**
     * Choosing a tag says what you want, not just what you want to look at, so
     * the match becomes the selection and the tree opens onto it. Clearing the
     * last tag leaves the selection alone — it is the user's now — and only
     * closes the branches back up.
     */
    const applyTagFilter = useCallback((nextTags) => {
        setSelectedTags(nextTags)
        if (nextTags.length === 0) {
            setExpanded(new Set())
            return
        }
        const matched = noteIdsForTagSelection(notes, {
            selectedTags: nextTags, tagMatchMode, noteSet,
        })
        setSelectedIds(new Set(matched))
        const matchedTree = buildTransferTree(
            filterNotesForTransfer(notes, { query, selectedTags: nextTags, tagMatchMode, noteSet }),
            activeGenomes,
        )
        setExpanded(new Set(allExpandableNodeIds(matchedTree)))
    }, [activeGenomes, notes, noteSet, query, tagMatchMode])

    const toggleTagFilter = useCallback((label) => {
        applyTagFilter(selectedTags.includes(label)
            ? selectedTags.filter((tag) => tag !== label)
            : [...selectedTags, label])
    }, [applyTagFilter, selectedTags])

    const handleTagMatchMode = useCallback((nextMode) => {
        setTagMatchMode(nextMode)
        if (selectedTags.length === 0) return
        setSelectedIds(new Set(noteIdsForTagSelection(notes, {
            selectedTags, tagMatchMode: nextMode, noteSet,
        })))
    }, [notes, noteSet, selectedTags])

    const clearFilters = useCallback(() => {
        setQuery('')
        setSelectedTags([])
        setNoteSet('both')
    }, [])

    const runExport = useCallback(async (mode) => {
        if (selectedIds.size === 0 || !filename.trim() || !directory.trim()) return
        setExporting(true)
        setExportMessage(null)
        try {
            const res = await fetch(`${API_BASE}/api/notes/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    directory: directory.trim(),
                    filename: filename.trim(),
                    format,
                    note_ids: [...selectedIds],
                    mode,
                }),
            })
            const payload = await res.json().catch(() => ({}))
            if (res.status === 409) {
                setOverwritePrompt(true)
                setExportMessage({ ok: false, text: payload?.detail || 'That file already exists.' })
                return
            }
            if (!res.ok) {
                setExportMessage({ ok: false, text: payload?.detail || `Export failed (${res.status})` })
                return
            }
            setOverwritePrompt(false)
            const missing = (payload.missing_ids || []).length
            // Succeeding closes the dialog and says so from outside it. Leaving
            // it open after a write is what made it unclear whether anything
            // had happened at all.
            onNotify?.({
                ok: true,
                title: `Exported ${payload.count} note${payload.count === 1 ? '' : 's'}`,
                lines: [payload.path],
                note: missing
                    ? `${missing} selected note${missing === 1 ? ' was' : 's were'} no longer in the store.`
                    : '',
            })
            onClose?.()
        } catch (error) {
            setExportMessage({ ok: false, text: `Export failed: ${error.message}` })
        } finally {
            setExporting(false)
        }
    }, [directory, filename, format, onClose, onNotify, selectedIds])

    const runScan = useCallback(async (path) => {
        const target = String(path || '').trim()
        if (!target) return
        setScanning(true)
        setScan(null)
        setImportMessage(null)
        setConfirmingDestructive(false)
        try {
            const res = await fetch(`${API_BASE}/api/notes/import/scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: target }),
            })
            const payload = await res.json().catch(() => ({}))
            if (!res.ok) {
                setImportMessage({ ok: false, text: payload?.detail || `Could not read that file (${res.status})` })
                return
            }
            setScan(payload)
        } catch (error) {
            setImportMessage({ ok: false, text: `Could not read that file: ${error.message}` })
        } finally {
            setScanning(false)
        }
    }, [])

    const runApply = useCallback(async () => {
        // Structurally impossible to apply an unscanned file: the digest only
        // exists once a scan has run.
        if (!scan?.digest || applying) return
        setApplying(true)
        setImportMessage(null)
        try {
            const res = await fetch(`${API_BASE}/api/notes/import/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: scan.path,
                    digest: scan.digest,
                    store_digest: scan.store_digest,
                    strategy,
                }),
            })
            const payload = await res.json().catch(() => ({}))
            if (res.status === 409) {
                setImportMessage({
                    ok: false,
                    text: 'That file changed since it was scanned. Scanning it again.',
                })
                setScan(null)
                runScan(scan.path)
                return
            }
            if (!res.ok) {
                const detail = payload?.detail
                setImportMessage({
                    ok: false,
                    text: (typeof detail === 'string' ? detail : detail?.message) || `Import failed (${res.status})`,
                })
                return
            }
            const parts = []
            if (payload.added) parts.push(`${payload.added} added`)
            if (payload.updated) parts.push(`${payload.updated} updated`)
            if (payload.deleted) parts.push(`${payload.deleted} deleted`)
            if (payload.skipped) parts.push(`${payload.skipped} skipped`)
            if (payload.unchanged) parts.push(`${payload.unchanged} unchanged`)
            setConfirmingDestructive(false)
            onImported?.()
            onNotify?.({
                ok: true,
                title: parts.length ? `Import complete — ${parts.join(', ')}` : 'Import complete — nothing changed',
                lines: payload.backup_paths || [],
                note: [
                    (payload.backup_paths || []).length ? 'A copy of your previous notes was saved first.' : '',
                    payload.store_changed ? 'Some notes changed while you were reviewing the scan.' : '',
                ].filter(Boolean).join(' '),
            })
            onClose?.()
        } catch (error) {
            setImportMessage({ ok: false, text: `Import failed: ${error.message}` })
        } finally {
            setApplying(false)
        }
    }, [applying, onClose, onImported, onNotify, runScan, scan, strategy])

    if (!open) return null

    const isExport = mode !== 'import'

    const panelBg = isLight ? 'bg-white border-gray-200' : 'bg-[#1a2232] border-gray-700'
    const borderClass = isLight ? 'border-gray-200' : 'border-gray-700'
    const textPrimary = isLight ? 'text-gray-900' : 'text-gray-100'
    const textSecondary = isLight ? 'text-gray-500' : 'text-gray-400'
    const inputClass = `w-full rounded border px-2 py-1 text-sm ${isLight ? 'border-gray-300 bg-white text-gray-900' : 'border-gray-600 bg-[#111827] text-gray-100'}`
    const subtleBg = isLight ? 'bg-[#f8fafc]' : 'bg-[#161d29]'
    const primaryButton = 'rounded bg-[#0099ff] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#0088ee] disabled:bg-gray-500 disabled:cursor-default'
    const ghostButton = `rounded border px-3 py-1.5 text-sm ${isLight ? 'border-gray-300 text-gray-700 hover:bg-gray-100' : 'border-gray-600 text-gray-200 hover:bg-[#273449]'}`
    const dangerButton = 'rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:bg-gray-500 disabled:cursor-default'

    const segment = (active) => `px-2.5 py-1 text-xs ${active ? 'bg-[#0077cc] text-white' : `${textSecondary} ${isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'}`}`

    const messageBox = (message) => (message ? (
        <div className={`rounded border px-3 py-2 text-xs ${message.ok
            ? (isLight ? 'border-green-300 bg-green-50 text-green-800' : 'border-green-700 bg-green-950/40 text-green-300')
            : (isLight ? 'border-red-300 bg-red-50 text-red-800' : 'border-red-700 bg-red-950/40 text-red-300')}`}>
            {message.text}
        </div>
    ) : null)

    const chosenFormat = transferFormat(format)

    return (
        <>
            <div
                className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
                onClick={(event) => { if (event.target === event.currentTarget) onClose?.() }}
            >
                <div
                    className={`flex w-full flex-col overflow-hidden rounded-xl border shadow-2xl ${panelBg} ${isExport
                        ? 'h-[86vh] max-w-6xl'
                        : 'max-h-[80vh] max-w-2xl'}`}
                    role="dialog"
                    aria-modal="true"
                    aria-label={isExport ? 'Export notes' : 'Import notes'}
                >
                    <div className={`flex flex-none items-center gap-4 border-b px-5 py-3 ${borderClass}`}>
                        <h2 className={`text-base font-semibold ${textPrimary}`}>{isExport ? 'Export notes' : 'Import notes'}</h2>
                        <div className="flex-1" />
                        <button
                            type="button"
                            className={`inline-flex h-7 w-7 items-center justify-center rounded border-0 bg-transparent ${textSecondary} hover:opacity-100 opacity-70`}
                            onClick={() => onClose?.()}
                            aria-label="Close"
                        >
                            <CloseGlyph />
                        </button>
                    </div>

                    {isExport ? (
                        <div className="flex min-h-0 flex-1">
                            {/* left: filters + tree */}
                            <div className={`flex min-w-0 flex-1 flex-col border-r ${borderClass}`}>
                                <div className={`flex-none space-y-2 border-b px-4 py-3 ${borderClass}`}>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <div className="relative max-w-xs flex-1">
                                            <input
                                                className={`${inputClass} ${query ? 'pr-8' : ''}`}
                                                placeholder="Search notes, tasks, genes, ids or tags…"
                                                value={query}
                                                onChange={(event) => setQuery(event.target.value)}
                                            />
                                            {query ? (
                                                <button
                                                    type="button"
                                                    className={`absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border-0 p-0 ${isLight ? 'bg-gray-200 text-gray-600 hover:bg-gray-300' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'}`}
                                                    onClick={() => setQuery('')}
                                                    aria-label="Clear search"
                                                    title="Clear search"
                                                >
                                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                                                        <path d="M18 6 6 18M6 6l12 12" />
                                                    </svg>
                                                </button>
                                            ) : null}
                                        </div>
                                        <div className={`inline-flex overflow-hidden rounded border ${borderClass}`}>
                                            {TRANSFER_NOTE_SETS.map((option) => {
                                                const locked = option.requiresSelection && selectedIds.size === 0
                                                return (
                                                    <button
                                                        key={option.id}
                                                        type="button"
                                                        className={`${segment(noteSet === option.id)} ${locked ? 'cursor-default opacity-40' : ''}`}
                                                        onClick={() => setNoteSet(option.id)}
                                                        disabled={locked}
                                                        title={locked ? 'Select something first' : ''}
                                                    >
                                                        {option.label}
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    </div>

                                    {tagCatalogue.length > 0 ? (
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            {tagCatalogue.slice(0, 12).map((tag) => (
                                                <button
                                                    key={tag.key}
                                                    type="button"
                                                    className={`rounded-full border px-2 py-0.5 text-[11px] ${selectedTags.includes(tag.label)
                                                        ? 'border-[#0077cc] bg-[#0077cc] text-white'
                                                        : `${borderClass} ${textSecondary}`}`}
                                                    onClick={() => toggleTagFilter(tag.label)}
                                                >
                                                    {tag.label} <span className="opacity-60">{tag.totalCount}</span>
                                                </button>
                                            ))}
                                            {/* Rendered either way and only hidden, so the row keeps its
                                                height and the tree below it does not jump when a second
                                                tag brings the match toggle in. */}
                                            <div
                                                className={`inline-flex overflow-hidden rounded border ${borderClass} ${selectedTags.length > 1 ? '' : 'invisible'}`}
                                                aria-hidden={selectedTags.length > 1 ? undefined : true}
                                            >
                                                <button type="button" tabIndex={selectedTags.length > 1 ? 0 : -1} className={segment(tagMatchMode === 'all')} onClick={() => handleTagMatchMode('all')}>Match all</button>
                                                <button type="button" tabIndex={selectedTags.length > 1 ? 0 : -1} className={segment(tagMatchMode === 'any')} onClick={() => handleTagMatchMode('any')}>Match any</button>
                                            </div>
                                            {selectedTags.length > 0 ? (
                                                <button type="button" className={`text-[11px] underline ${textSecondary}`} onClick={() => applyTagFilter([])}>
                                                    Clear tags
                                                </button>
                                            ) : null}
                                        </div>
                                    ) : null}

                                    <div className="flex items-center gap-3">
                                        <button type="button" className={`text-xs underline ${textSecondary}`} onClick={handleSelectAllVisible}>
                                            Select all shown
                                        </button>
                                        <button type="button" className={`text-xs underline ${textSecondary}`} onClick={() => setSelectedIds(new Set())}>
                                            Clear selection
                                        </button>
                                    </div>
                                </div>

                                <div className="min-h-0 flex-1 overflow-y-auto themed-scrollbar">
                                    <NotesTransferTree
                                        tree={tree}
                                        states={states}
                                        expanded={expanded}
                                        onToggleExpanded={handleToggleExpanded}
                                        onToggleSelected={handleToggleSelected}
                                        onPreview={setPreviewNote}
                                        previewNoteId={previewNote?.id || ''}
                                        theme={theme}
                                        emptyMessage="Nothing matches these filters"
                                    />
                                </div>
                            </div>

                            {/* right: the note itself, for when a preview is not enough */}
                            <div className="flex w-[380px] flex-none flex-col">
                                <div className="min-h-0 flex-1 overflow-y-auto themed-scrollbar px-4 py-3">
                                    {previewNote ? (
                                        <div className="space-y-2">
                                            <div className={`text-sm font-semibold ${textPrimary}`}>{noteDisplayTitle(previewNote)}</div>
                                            <div className={`text-[11px] ${textSecondary}`}>
                                                {previewNote.target?.label || previewNote.target?.id}
                                                {previewNote.archived ? ' · archived' : ''}
                                                {' · edited '}{noteTimestampLabel(previewNote.updatedAt)}
                                            </div>
                                            {(previewNote.tags || []).length > 0 ? (
                                                <div className="flex flex-wrap gap-1">
                                                    {previewNote.tags.map((tag) => (
                                                        <span key={tag} className={`rounded-full border px-2 py-0.5 text-[11px] ${borderClass} ${textSecondary}`}>{tag}</span>
                                                    ))}
                                                </div>
                                            ) : null}
                                            <div className={`whitespace-pre-wrap rounded border p-2 text-sm ${borderClass} ${subtleBg} ${textPrimary}`}>
                                                {previewNote.body || <span className={textSecondary}>This note has no body text.</span>}
                                            </div>
                                        </div>
                                    ) : (
                                        <p className={`pt-8 text-center text-sm ${textSecondary}`}>
                                            Select a note in the tree to read it in full.
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="min-h-0 flex-1 overflow-y-auto themed-scrollbar px-5 py-4">
                            <div className="space-y-4">
                                <div className="space-y-1">
                                    <label className={`text-xs font-medium ${textSecondary}`}>File to import</label>
                                    <div className="flex gap-2">
                                        <input
                                            className={inputClass}
                                            placeholder="Choose a .json, .csv or .tsv file"
                                            value={importPath}
                                            onChange={(event) => { setImportPath(event.target.value); setScan(null) }}
                                        />
                                        <button type="button" className={ghostButton} onClick={() => setShowFileBrowser(true)}>Browse…</button>
                                        <button
                                            type="button"
                                            className={primaryButton}
                                            onClick={() => runScan(importPath)}
                                            disabled={!importPath.trim() || scanning}
                                        >
                                            {scanning ? 'Scanning…' : 'Scan'}
                                        </button>
                                    </div>
                                    <p className={`text-[11px] ${textSecondary}`}>
                                        Nothing is changed until you scan the file and choose what to do with it.
                                    </p>
                                </div>

                                {messageBox(importMessage)}

                                {scanSummary ? (
                                    <div className={`space-y-3 rounded border p-3 ${borderClass} ${subtleBg}`}>
                                        <div className={`text-sm font-medium ${textPrimary}`}>
                                            {scanSummary.filename} · {scanSummary.format.toUpperCase()} · {scanSummary.total} row{scanSummary.total === 1 ? '' : 's'}
                                        </div>

                                        {scanSummary.documentErrors.length > 0 ? (
                                            <div className={`rounded border px-3 py-2 text-xs ${isLight ? 'border-red-300 bg-red-50 text-red-800' : 'border-red-700 bg-red-950/40 text-red-300'}`}>
                                                {scanSummary.documentErrors.map((error) => <div key={error}>{error}</div>)}
                                            </div>
                                        ) : (
                                            <div className={`grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4 ${textSecondary}`}>
                                                <div><span className={textPrimary}>{scanSummary.newCount}</span> new</div>
                                                <div><span className={textPrimary}>{scanSummary.identicalCount}</span> already identical</div>
                                                <div><span className={textPrimary}>{scanSummary.differsCount}</span> differ</div>
                                                <div><span className={textPrimary}>{scanSummary.invalidCount}</span> cannot be read</div>
                                                <div><span className={textPrimary}>{scanSummary.todoCount}</span> tasks</div>
                                                <div><span className={textPrimary}>{scanSummary.noteCount}</span> notes</div>
                                                <div><span className={textPrimary}>{scanSummary.archivedCount}</span> archived</div>
                                                <div><span className={textPrimary}>{scanSummary.nearDuplicateCount}</span> possible duplicates</div>
                                            </div>
                                        )}

                                        {scanSummary.nearDuplicateCount > 0 ? (
                                            <p className={`text-[11px] ${textSecondary}`}>
                                                Some notes look like ones you already have but carry a different id, so they
                                                will be imported as separate notes rather than merged.
                                            </p>
                                        ) : null}

                                        {(scanSummary.invalidCount > 0 || scanSummary.warningCount > 0) ? (
                                            <div className={`max-h-40 overflow-y-auto themed-scrollbar rounded border ${borderClass}`}>
                                                <table className="w-full text-left text-[11px]">
                                                    <tbody>
                                                        {(scan.rows || [])
                                                            .filter((row) => row.status === 'invalid' || (row.warnings || []).length > 0)
                                                            .slice(0, 50)
                                                            .map((row) => (
                                                                <tr key={row.line} className={`border-b last:border-0 ${borderClass}`}>
                                                                    <td className={`w-14 px-2 py-1 align-top ${textSecondary}`}>Row {row.line}</td>
                                                                    <td className={`px-2 py-1 align-top ${textPrimary}`}>
                                                                        {row.title || row.target_label || row.target_id || '—'}
                                                                    </td>
                                                                    <td className="px-2 py-1 align-top">
                                                                        {(row.errors || []).map((error) => (
                                                                            <div key={error} className={isLight ? 'text-red-700' : 'text-red-400'}>{error}</div>
                                                                        ))}
                                                                        {(row.warnings || []).map((warning) => (
                                                                            <div key={warning} className={isLight ? 'text-amber-700' : 'text-amber-400'}>{warning}</div>
                                                                        ))}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        ) : null}

                                        {!scanSummary.blocked ? (
                                            <div className="space-y-2">
                                                <div className={`text-xs font-medium ${textPrimary}`}>When a note is in both places</div>
                                                {MERGE_STRATEGIES.map((option) => (
                                                    <label key={option.id} className="flex cursor-pointer items-start gap-2">
                                                        <input
                                                            type="radio"
                                                            name="merge-strategy"
                                                            className={`mt-0.5 ${isLight ? 'accent-[#0099ff]' : 'accent-sky-400'}`}
                                                            checked={strategy === option.id}
                                                            onChange={() => { setStrategy(option.id); setConfirmingDestructive(false) }}
                                                        />
                                                        <span className="min-w-0">
                                                            <span className={`text-xs ${option.destructive ? (isLight ? 'text-red-700' : 'text-red-400') : textPrimary}`}>
                                                                {option.label}
                                                            </span>
                                                            <span className={`block text-[11px] ${textSecondary}`}>{option.help}</span>
                                                        </span>
                                                    </label>
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    )}

                    {/* footer */}
                    <div className={`flex-none border-t px-5 py-3 ${borderClass}`}>
                        {isExport ? (
                            <div className="space-y-2">
                                {messageBox(exportMessage)}
                                {overwritePrompt ? (
                                    <div className={`flex flex-wrap items-center gap-2 rounded border px-3 py-2 text-xs ${isLight ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-amber-700 bg-amber-950/30 text-amber-300'}`}>
                                        <span className="flex-1">A file of that name is already there.</span>
                                        <button type="button" className={ghostButton} onClick={() => runExport('overwrite')} disabled={exporting}>Replace it</button>
                                        <button type="button" className={ghostButton} onClick={() => setOverwritePrompt(false)}>Cancel</button>
                                    </div>
                                ) : null}
                                <div className="flex flex-wrap items-end gap-3">
                                    <div className="min-w-[150px]">
                                        <label className={`block text-[11px] ${textSecondary}`}>Format</label>
                                        <div className={`mt-1 inline-flex overflow-hidden rounded border ${borderClass}`}>
                                            {TRANSFER_FORMATS.map((option) => (
                                                <button key={option.id} type="button" className={segment(format === option.id)} onClick={() => setFormat(option.id)}>
                                                    {option.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="min-w-[180px] flex-1">
                                        <label className={`block text-[11px] ${textSecondary}`}>File name</label>
                                        <input className={`mt-1 ${inputClass}`} value={filename} onChange={(event) => setFilename(event.target.value)} />
                                    </div>
                                    <div className="min-w-[220px] flex-[2]">
                                        <label className={`block text-[11px] ${textSecondary}`}>Folder</label>
                                        <div className="mt-1 flex gap-2">
                                            <input className={inputClass} value={directory} onChange={(event) => setDirectory(event.target.value)} />
                                            <button type="button" className={ghostButton} onClick={() => setShowDirectoryBrowser(true)}>Browse…</button>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        className={primaryButton}
                                        onClick={() => runExport('create')}
                                        disabled={exporting || selectedIds.size === 0 || !filename.trim() || !directory.trim()}
                                    >
                                        {exporting ? 'Exporting…' : `Export ${summary.selectedCount || ''}`.trim()}
                                    </button>
                                </div>
                                <div className={`flex flex-wrap items-center gap-x-4 text-[11px] ${textSecondary}`}>
                                    <span>
                                        {summary.selectedCount} selected
                                        {summary.todoCount ? ` · ${summary.todoCount} task${summary.todoCount === 1 ? '' : 's'}` : ''}
                                        {summary.noteCount ? ` · ${summary.noteCount} note${summary.noteCount === 1 ? '' : 's'} across ${summary.genomeCount} genome${summary.genomeCount === 1 ? '' : 's'}` : ''}
                                        {summary.archivedCount ? ` · ${summary.archivedCount} archived` : ''}
                                    </span>
                                    {summary.hiddenSelectedCount > 0 ? (
                                        <span className={isLight ? 'text-amber-700' : 'text-amber-400'}>
                                            {summary.hiddenSelectedCount} selected note{summary.hiddenSelectedCount === 1 ? ' is' : 's are'} hidden by the filters and will still be exported —{' '}
                                            <button type="button" className="underline hover:no-underline" onClick={clearFilters}>
                                                clear the filters
                                            </button>{' '}
                                            to see {summary.hiddenSelectedCount === 1 ? 'it' : 'them'}.
                                        </span>
                                    ) : null}
                                    {chosenFormat && !chosenFormat.lossless ? <span>{SPREADSHEET_CAVEAT}</span> : null}
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-wrap items-center gap-3">
                                <span className={`flex-1 text-[11px] ${textSecondary}`}>
                                    {!scanSummary
                                        ? 'Scan a file to see what it holds before importing it.'
                                        : scanSummary.blocked
                                            ? 'Nothing in this file can be imported.'
                                            : strategyMeta?.destructive && wouldDelete > 0
                                                ? `This will delete ${wouldDelete} stored note${wouldDelete === 1 ? '' : 's'}. A backup is written first.`
                                                : `${scanSummary.applicable} note${scanSummary.applicable === 1 ? '' : 's'} ready to import.`}
                                </span>
                                {confirmingDestructive ? (
                                    <>
                                        <button type="button" className={ghostButton} onClick={() => setConfirmingDestructive(false)}>Cancel</button>
                                        <button type="button" className={dangerButton} onClick={runApply} disabled={applying}>
                                            {applying ? 'Importing…' : `Yes, delete and replace`}
                                        </button>
                                    </>
                                ) : (
                                    <button
                                        type="button"
                                        className={strategyMeta?.destructive ? dangerButton : primaryButton}
                                        onClick={() => {
                                            if (strategyMeta?.destructive) setConfirmingDestructive(true)
                                            else runApply()
                                        }}
                                        disabled={applying || !scan?.digest || Boolean(scanSummary?.blocked)}
                                    >
                                        {applying ? 'Importing…' : 'Import'}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <FileBrowserModal
                isOpen={showDirectoryBrowser}
                onClose={() => setShowDirectoryBrowser(false)}
                onSelect={(path) => { setDirectory(path); setShowDirectoryBrowser(false) }}
                initialPath={String(outputDir || '').trim() || '.'}
                mode="directory"
                theme={theme}
            />
            <FileBrowserModal
                isOpen={showFileBrowser}
                onClose={() => setShowFileBrowser(false)}
                onSelect={(path) => {
                    setShowFileBrowser(false)
                    setImportPath(path)
                    runScan(path)
                }}
                initialPath={String(outputDir || '').trim() || '.'}
                mode="file"
                extensions={IMPORT_EXTENSIONS}
                theme={theme}
            />
        </>
    )
}
