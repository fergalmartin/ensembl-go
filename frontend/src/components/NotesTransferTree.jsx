// The checkbox tree in the notes export dialog.
//
// Rendering only. Every decision about what a click means lives in
// utils/notesTransferModel.js, so this file has no selection logic to get wrong
// and the arithmetic stays testable without a renderer.

import { useEffect, useRef } from 'react'
import { TRANSFER_NODE_TYPES } from '../utils/notesTransferModel'
import { notePreview } from '../utils/geneNotes'

function Chevron({ open, size = 12 }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
        >
            <path d="M9 18l6-6-6-6" />
        </svg>
    )
}

/** A checkbox that can also sit half-filled — the only way to say "some of this". */
function TriStateCheckbox({ state, onChange, label, accentClass }) {
    const ref = useRef(null)
    useEffect(() => {
        if (ref.current) ref.current.indeterminate = state === 'partial'
    }, [state])
    return (
        <input
            ref={ref}
            type="checkbox"
            className={`h-4 w-4 flex-none cursor-pointer rounded ${accentClass}`}
            checked={state === 'all'}
            onChange={onChange}
            onClick={(event) => event.stopPropagation()}
            aria-label={label}
        />
    )
}

function countLabel(counts) {
    if (!counts) return ''
    if (counts.archived > 0 && counts.archived < counts.total) {
        return `${counts.total} (${counts.archived} archived)`
    }
    if (counts.archived > 0 && counts.archived === counts.total) {
        return `${counts.total} archived`
    }
    return String(counts.total)
}

function TransferNode({
    node,
    depth,
    states,
    expanded,
    onToggleExpanded,
    onToggleSelected,
    onPreview,
    previewNoteId,
    isLight,
}) {
    const isNote = node.type === TRANSFER_NODE_TYPES.NOTE
    const hasChildren = !isNote && node.children.length > 0
    const isOpen = expanded.has(node.id)
    const state = states.get(node.id) || 'none'

    const accentClass = isLight ? 'accent-[#0099ff]' : 'accent-sky-400'
    const textPrimary = isLight ? 'text-gray-900' : 'text-gray-100'
    const textSecondary = isLight ? 'text-gray-500' : 'text-gray-400'
    const rowHover = isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]'
    const selectedRow = isLight ? 'bg-blue-50' : 'bg-[#1e2a3d]'
    const isPreviewing = isNote && previewNoteId === node.noteId

    return (
        <div>
            <div
                className={`flex items-center gap-2 rounded px-2 py-1 ${rowHover} ${isPreviewing ? selectedRow : ''} ${isNote ? 'cursor-pointer' : ''}`}
                style={{ paddingLeft: `${8 + depth * 18}px` }}
                onClick={() => { if (isNote) onPreview?.(node.note) }}
            >
                {hasChildren ? (
                    <button
                        type="button"
                        className={`inline-flex h-5 w-5 flex-none items-center justify-center border-0 bg-transparent p-0 ${textSecondary} hover:opacity-100 opacity-70`}
                        onClick={(event) => { event.stopPropagation(); onToggleExpanded(node.id) }}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? `Collapse ${node.label}` : `Expand ${node.label}`}
                    >
                        <Chevron open={isOpen} />
                    </button>
                ) : (
                    <span className="h-5 w-5 flex-none" aria-hidden="true" />
                )}

                <TriStateCheckbox
                    state={state}
                    accentClass={accentClass}
                    label={`Select ${node.label}`}
                    onChange={() => onToggleSelected(node)}
                />

                <span className={`min-w-0 flex-1 truncate text-sm ${textPrimary} ${node.archived ? 'italic opacity-70' : ''}`}>
                    {node.label}
                    {node.sublabel ? (
                        <span className={`ml-2 text-[11px] ${textSecondary}`}>{node.sublabel}</span>
                    ) : null}
                    {isNote ? (
                        <span className={`ml-2 text-[11px] ${textSecondary}`}>{notePreview(node.note, { max: 60 })}</span>
                    ) : null}
                </span>

                {node.archived ? (
                    <span className={`flex-none text-[10px] uppercase tracking-wide ${textSecondary}`}>archived</span>
                ) : null}
                {!isNote ? (
                    <span className={`flex-none text-[11px] tabular-nums ${textSecondary}`}>
                        {countLabel(node.counts)}
                    </span>
                ) : null}
            </div>

            {hasChildren && isOpen ? (
                <div>
                    {node.children.map((child) => (
                        <TransferNode
                            key={child.id}
                            node={child}
                            depth={depth + 1}
                            states={states}
                            expanded={expanded}
                            onToggleExpanded={onToggleExpanded}
                            onToggleSelected={onToggleSelected}
                            onPreview={onPreview}
                            previewNoteId={previewNoteId}
                            isLight={isLight}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    )
}

export default function NotesTransferTree({
    tree,
    states,
    expanded,
    onToggleExpanded,
    onToggleSelected,
    onPreview,
    previewNoteId = '',
    theme = 'dark',
    emptyMessage = 'Nothing matches these filters',
}) {
    const isLight = theme === 'light'
    const groups = tree?.root?.children || []

    if (groups.length === 0) {
        return (
            <div className={`px-3 py-8 text-center text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                {emptyMessage}
            </div>
        )
    }

    return (
        <div className="py-1">
            {groups.map((group) => (
                <TransferNode
                    key={group.id}
                    node={group}
                    depth={0}
                    states={states}
                    expanded={expanded}
                    onToggleExpanded={onToggleExpanded}
                    onToggleSelected={onToggleSelected}
                    onPreview={onPreview}
                    previewNoteId={previewNoteId}
                    isLight={isLight}
                />
            ))}
        </div>
    )
}
