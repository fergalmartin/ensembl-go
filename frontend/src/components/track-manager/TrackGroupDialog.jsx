import { useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../../backendRuntime.js'
import { rangeBetween } from '../../utils/fileSelection.js'
import { trackAssemblyKey } from '../../utils/genomeIdentity.js'
import { applySettingsChange } from '../../utils/trackBatch.js'
import { appendMembers, groupsForAssembly, moveItem } from '../../utils/trackGroups.js'
import { GROUP_LAYOUTS, TYPE_COLORS, basenameFromPath, customZoneProblem, fallbackGenomeLabel, findGenomeOption, memberSettings, memberSettingsFields, normalizeBigWigDisplayMode, settingsFromTrack, typeHasSettings, typeLabelOf } from './trackManagerModel.js'
import { TypeBadge } from './trackManagerParts'
import { TypeSettingsEditor } from './trackSettingsEditors'

/**
 * Creating or editing a group. `group` is the saved group when editing; otherwise the
 * group starts from `initialTrackIds` for `genomeKey`. `addTrackIds` are appended to an
 * existing group when it is opened from "Add to group", so the user sees where they land
 * and can reorder before saving.
 */
export function TrackGroupDialog({
    isLight,
    group = null,
    genomeKey = '',
    initialTrackIds = [],
    addTrackIds = [],
    // A tutorial can open a new group part-filled.
    initialLabel = '',
    initialLayout = 'separate',
    tracks,
    groups = [],
    genomeOptions,
    onClose,
    onSaved,
    onDeleted,
}) {
    const isEdit = Boolean(group)
    const tracksById = useMemo(() => new Map(tracks.map((t) => [String(t.id), t])), [tracks])
    const groupGenomeKey = group?.genome_key || genomeKey || ''
    const genomeTracks = useMemo(
        () => tracks.filter((t) => trackAssemblyKey(t.genome_key) === trackAssemblyKey(groupGenomeKey)),
        [tracks, groupGenomeKey]
    )
    const genomeLabel = findGenomeOption(genomeOptions, groupGenomeKey)?.label
        || genomeTracks.find((t) => t.genome_label)?.genome_label
        || fallbackGenomeLabel(groupGenomeKey)

    const [initialMembers] = useState(() => {
        const saved = (group?.members || [])
            .filter((m) => tracksById.has(String(m.track_id)))
            .map((m) => {
                const track = tracksById.get(String(m.track_id))
                return {
                    trackId: String(m.track_id),
                    custom: m.settings ? settingsFromTrack({ ...track, ...m.settings }) : null,
                }
            })
        return appendMembers(saved, [...initialTrackIds, ...addTrackIds].filter((id) => tracksById.has(String(id))))
    })
    const [label, setLabel] = useState(group?.label || initialLabel || '')
    const [layout, setLayout] = useState(group?.layout || initialLayout || 'separate')
    const [members, setMembers] = useState(initialMembers)
    // Opened to add tracks to an existing group: those are what the user came to look at.
    const [selectedIds, setSelectedIds] = useState(() => {
        const added = addTrackIds.map(String).filter((id) => initialMembers.some((m) => m.trackId === id))
        if (added.length) return added
        return initialMembers.length ? [initialMembers[0].trackId] : []
    })
    const anchorRef = useRef(selectedIds[0] || null)
    const [adding, setAdding] = useState(false)
    const [addPick, setAddPick] = useState([])
    const [dragFrom, setDragFrom] = useState(-1)
    const [dropAt, setDropAt] = useState(-1)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')
    const nameRef = useRef(null)

    useEffect(() => {
        if (!isEdit) nameRef.current?.focus()
    }, [isEdit])

    const memberIds = useMemo(() => new Set(members.map((m) => m.trackId)), [members])
    const available = useMemo(
        () => genomeTracks.filter((t) => !memberIds.has(String(t.id))),
        [genomeTracks, memberIds]
    )
    const sameName = useMemo(() => {
        const wanted = label.trim().toLowerCase()
        if (!wanted) return false
        return groupsForAssembly(groups, groupGenomeKey)
            .some((g) => g.id !== group?.id && String(g.label || '').trim().toLowerCase() === wanted)
    }, [groups, groupGenomeKey, group?.id, label])

    const problems = useMemo(() => {
        const out = []
        if (!label.trim()) out.push('Give the group a name.')
        for (const member of members) {
            const track = tracksById.get(member.trackId)
            if (!member.custom || track?.type !== 'bigwig') continue
            const zones = customZoneProblem(
                member.custom.bigWigSettings,
                normalizeBigWigDisplayMode(member.custom.displayMode, member.custom.bigWigDataType || member.custom.bigWigSettings?.data_type),
            )
            if (zones) out.push(`${track.label}: ${zones}`)
        }
        return out
    }, [label, members, tracksById])

    const handleRowClick = (trackId, event) => {
        const order = members.map((m) => m.trackId)
        if (event.shiftKey && anchorRef.current && order.includes(anchorRef.current)) {
            setSelectedIds(rangeBetween(order, anchorRef.current, trackId))
            return
        }
        anchorRef.current = trackId
        if (event.metaKey || event.ctrlKey) {
            setSelectedIds((prev) => (prev.includes(trackId) ? prev.filter((id) => id !== trackId) : [...prev, trackId]))
            return
        }
        setSelectedIds([trackId])
    }

    const removeMember = (trackId) => {
        setMembers((prev) => prev.filter((m) => m.trackId !== trackId))
        setSelectedIds((prev) => prev.filter((id) => id !== trackId))
    }

    const moveMember = (from, to) => setMembers((prev) => moveItem(prev, from, to))

    const handleRowKeyDown = (index, event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
        event.preventDefault()
        if (event.key === 'ArrowUp' && index > 0) moveMember(index, index - 1)
        if (event.key === 'ArrowDown' && index < members.length - 1) moveMember(index, index + 2)
    }

    const endDrag = () => {
        setDragFrom(-1)
        setDropAt(-1)
    }

    const addPicked = () => {
        const ordered = available.map((t) => String(t.id)).filter((id) => addPick.includes(id))
        setMembers((prev) => appendMembers(prev, ordered))
        setSelectedIds(ordered.length ? ordered : selectedIds)
        setAddPick([])
        setAdding(false)
    }

    const handleSave = async () => {
        if (problems.length || saving) return
        setSaving(true)
        setError('')
        const body = {
            label: label.trim(),
            layout,
            members: members.map((m) => {
                const track = tracksById.get(m.trackId)
                return { track_id: m.trackId, settings: m.custom ? memberSettingsFields(track?.type, m.custom) : null }
            }),
        }
        if (!isEdit) body.genome_key = groupGenomeKey
        try {
            const res = await fetch(
                isEdit ? `${API_BASE}/api/track-groups/${group.id}` : `${API_BASE}/api/track-groups`,
                { method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
            )
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data?.detail || `Could not save the group (${res.status})`)
            onSaved(data)
        } catch (e) {
            setError(e.message || 'Could not save the group')
            setSaving(false)
        }
    }

    const handleDeleteGroup = async () => {
        if (!window.confirm(`Delete the group "${group.label}"?\n(Its tracks stay registered.)`)) return
        try {
            const res = await fetch(`${API_BASE}/api/track-groups/${group.id}`, { method: 'DELETE' })
            if (!res.ok && res.status !== 404) throw new Error(`Could not delete the group (${res.status})`)
            onDeleted(group.id)
        } catch (e) {
            setError(e.message || 'Could not delete the group')
        }
    }

    const inputCls = `w-full px-3 py-2 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40 focus:border-blue-500'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40 focus:border-blue-500'}`
    const labelCls = `block text-xs font-medium mb-1.5 ${isLight ? 'text-gray-700' : 'text-gray-300'}`
    const mutedCls = isLight ? 'text-gray-500' : 'text-gray-400'
    const panelCls = `rounded-xl border p-4 ${isLight ? 'border-gray-200 bg-gray-50/60' : 'border-gray-700 bg-gray-800/30'}`

    const selectedMembers = members.filter((m) => selectedIds.includes(m.trackId))
    const selectedTypes = [...new Set(selectedMembers.map((m) => tracksById.get(m.trackId)?.type))]
    // The group's tracks by type, in the order the types first appear: what "select all of
    // a type" offers, as the bulk dialog's type rows do.
    const membersByType = (() => {
        const byType = new Map()
        for (const m of members) {
            const type = tracksById.get(m.trackId)?.type || ''
            if (!byType.has(type)) byType.set(type, [])
            byType.get(type).push(m.trackId)
        }
        return [...byType.entries()].map(([type, ids]) => ({ type, ids }))
    })()
    const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id))
    const selectType = (ids) => {
        setSelectedIds(ids)
        anchorRef.current = ids[0] || null
    }

    const editor = (() => {
        if (!selectedMembers.length) {
            return <p className={`text-sm ${mutedCls}`}>Select a track on the left to change how it shows in this group.</p>
        }
        if (selectedTypes.length > 1) {
            return (
                <p className={`text-sm ${mutedCls}`}>
                    These tracks are of different types. Select tracks of one type to change their settings together.
                </p>
            )
        }
        const type = selectedTypes[0]
        const first = selectedMembers[0]
        const firstTrack = tracksById.get(first.trackId)
        const many = selectedMembers.length > 1
        const allOwn = selectedMembers.every((m) => !m.custom)
        const someOwn = !allOwn && selectedMembers.some((m) => !m.custom)
        const wholeType = many && sameIds(selectedIds, membersByType.find((entry) => entry.type === type)?.ids || [])
        // Shown as the first one's, as bulk editing shows them; say so when they differ.
        const differ = many && new Set(selectedMembers.map((m) => JSON.stringify(memberSettings(m, tracksById.get(m.trackId))))).size > 1
        const makeAllMatch = () => {
            const settings = memberSettings(first, firstTrack)
            setMembers((prev) => prev.map((m) => (
                selectedIds.includes(m.trackId) ? { ...m, custom: JSON.parse(JSON.stringify(settings)) } : m
            )))
        }
        const setUseTrackSettings = (useTrack) => setMembers((prev) => prev.map((m) => {
            if (!selectedIds.includes(m.trackId)) return m
            if (useTrack) return { ...m, custom: null }
            return m.custom ? m : { ...m, custom: settingsFromTrack(tracksById.get(m.trackId)) }
        }))
        return (
            <div className="space-y-4">
                <div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <TypeBadge type={type} small />
                        <h3 className={`text-sm font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                            {!many
                                ? firstTrack?.label
                                : wholeType
                                    ? `All ${typeLabelOf(type)} tracks · ${selectedMembers.length}`
                                    : `${selectedMembers.length} ${typeLabelOf(type)} tracks`}
                        </h3>
                    </div>
                    {!many ? (
                        <p className={`text-xs mt-1 font-mono truncate ${mutedCls}`} title={firstTrack?.path}>
                            {basenameFromPath(firstTrack?.path || '')}
                        </p>
                    ) : (
                        <p className={`text-xs mt-1 ${mutedCls}`}>
                            Settings here apply to every one of these in this group. Select a single track on the left to change just that one.
                        </p>
                    )}
                </div>
                {!typeHasSettings(type) ? (
                    <p className={`text-sm ${mutedCls}`}>Tracks of this type have no settings to change.</p>
                ) : (
                    <div className={panelCls}>
                        <label className={`flex items-center gap-2 text-sm ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                            <input
                                type="checkbox"
                                data-tour-id="track-group-use-track-settings"
                                checked={allOwn}
                                ref={(el) => { if (el) el.indeterminate = someOwn }}
                                onChange={(e) => setUseTrackSettings(e.target.checked)}
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            {many ? 'Use each track’s own settings' : 'Use the track’s own settings'}
                        </label>
                        <p className={`text-xs mt-1.5 ${mutedCls}`}>
                            {allOwn
                                ? 'Changes made to the track itself show here too. Untick to give this group custom settings for it.'
                                : 'Custom settings for this group only. The track itself keeps its own; tick the box above to go back to them.'}
                        </p>
                        {!allOwn && differ && (
                            <div className={`mt-3 flex flex-wrap items-center gap-2 text-xs ${isLight ? 'text-amber-700' : 'text-amber-300'}`}>
                                <span>
                                    These tracks differ in some settings; this shows the first one&apos;s. A change here is made on every one, and whatever you leave alone stays as each has it.
                                </span>
                                <button
                                    type="button"
                                    data-tour-id="track-group-match-all"
                                    onClick={makeAllMatch}
                                    className={`px-2 py-1 rounded-md border font-medium ${isLight ? 'border-amber-300 text-amber-800 hover:bg-amber-50' : 'border-amber-700 text-amber-200 hover:bg-amber-900/30'}`}
                                >
                                    Make them all match this
                                </button>
                            </div>
                        )}
                        {!allOwn && (
                            <div className="mt-4">
                                <TypeSettingsEditor
                                    type={type}
                                    value={memberSettings(first, firstTrack)}
                                    onChange={(next) => {
                                        const before = memberSettings(first, firstTrack)
                                        // Several at once: only what changed reaches each, as when
                                        // editing tracks together.
                                        setMembers((prev) => prev.map((m) => {
                                            if (!selectedIds.includes(m.trackId)) return m
                                            if (m.trackId === first.trackId) return { ...m, custom: next }
                                            const base = memberSettings(m, tracksById.get(m.trackId))
                                            return { ...m, custom: applySettingsChange(before, next, base) }
                                        }))
                                    }}
                                    isLight={isLight}
                                    labelCls={labelCls}
                                    inputCls={inputCls}
                                    trackLabel={many ? '' : firstTrack?.label}
                                    allowAutomatic={false}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>
        )
    })()

    return (
        <div data-wheel-isolated="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div
                data-tour-id="track-group-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="track-group-dialog-title"
                className={`w-full max-w-5xl h-[min(88vh,780px)] rounded-2xl shadow-2xl border flex flex-col ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900 border-gray-700'}`}
            >
                <div className={`px-6 py-4 border-b flex items-center justify-between flex-none ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                    <div>
                        <h2 id="track-group-dialog-title" className={`text-base font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                            {isEdit ? 'Edit track group' : 'New track group'}
                        </h2>
                        <p className={`text-xs mt-0.5 ${mutedCls}`}>
                            {genomeLabel} · {members.length} track{members.length === 1 ? '' : 's'}
                        </p>
                    </div>
                    <button type="button" aria-label="Close" onClick={onClose} className={`p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 ${mutedCls}`}>✕</button>
                </div>

                <div className={`px-6 py-4 border-b flex-none grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                    <div>
                        <label htmlFor="track-group-name" className={labelCls}>Group name</label>
                        <input
                            id="track-group-name"
                            ref={nameRef}
                            data-tour-id="track-group-name"
                            type="text"
                            value={label}
                            maxLength={120}
                            placeholder="e.g. Lung ATAC"
                            onChange={(e) => setLabel(e.target.value)}
                            className={inputCls}
                        />
                        {sameName && (
                            <p className={`text-xs mt-1 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                                Another group for this genome already has this name.
                            </p>
                        )}
                    </div>
                    <div>
                        <span className={labelCls}>Show in the Genome Browser as</span>
                        <div data-tour-id="track-group-layout" className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Show in the Genome Browser as">
                            {GROUP_LAYOUTS.map((option) => {
                                const active = layout === option.id
                                return (
                                    <button
                                        key={option.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={active}
                                        data-tour-id={option.id === 'joined' ? 'track-group-layout-joined' : 'track-group-layout-separate'}
                                        onClick={() => setLayout(option.id)}
                                        className={`text-left rounded-lg border px-3 py-2 transition-colors ${active
                                            ? (isLight ? 'border-blue-500 bg-blue-50' : 'border-blue-500 bg-blue-900/30')
                                            : (isLight ? 'border-gray-200 hover:border-blue-300' : 'border-gray-700 hover:border-blue-700')}`}
                                    >
                                        <span className={`block text-sm font-medium ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{option.label}</span>
                                        <span className={`block text-xs mt-0.5 ${mutedCls}`}>{option.hint}</span>
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                </div>

                <div className="flex-1 min-h-0 grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                    <div className={`min-h-0 flex flex-col border-r ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                        <div className="px-4 pt-3 pb-2 flex-none">
                            <div className={`text-xs font-semibold uppercase tracking-wide ${mutedCls}`}>Tracks, in browser order</div>
                            <p className={`text-[11px] mt-0.5 ${mutedCls}`}>Drag to reorder (or Alt+↑/↓). Shift- or Cmd/Ctrl-click to select several.</p>
                            {members.length > 1 && (
                                <div className="mt-2 flex flex-wrap items-center gap-1.5" data-tour-id="track-group-select-type">
                                    <span className={`text-[11px] ${mutedCls}`}>Select all:</span>
                                    {membersByType.map(({ type, ids }) => {
                                        const active = sameIds(selectedIds, ids)
                                        return (
                                            <button
                                                key={type || 'unknown'}
                                                type="button"
                                                aria-pressed={active}
                                                onClick={() => selectType(ids)}
                                                title={`Select every ${typeLabelOf(type)} track in the group, to set them together`}
                                                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors ${active
                                                    ? (isLight ? 'border-blue-400 bg-blue-50 text-blue-800' : 'border-blue-500 bg-blue-900/40 text-blue-100')
                                                    : (isLight ? 'border-gray-200 text-gray-700 hover:border-blue-300' : 'border-gray-700 text-gray-300 hover:border-blue-600')}`}
                                            >
                                                <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: TYPE_COLORS[type] || '#94a3b8' }} />
                                                {typeLabelOf(type)} · {ids.length}
                                            </button>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                        <ol data-tour-id="track-group-members" className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-1">
                            {members.length === 0 && (
                                <li className={`text-sm px-2 py-3 ${mutedCls}`}>No tracks yet. Add some below.</li>
                            )}
                            {members.map((member, index) => {
                                const track = tracksById.get(member.trackId)
                                const selected = selectedIds.includes(member.trackId)
                                const lineBefore = dropAt === index && dragFrom !== -1 && dropAt !== dragFrom && dropAt !== dragFrom + 1
                                const lineAfter = index === members.length - 1 && dropAt === members.length && dragFrom !== -1 && dragFrom !== members.length - 1
                                return (
                                    <li
                                        key={member.trackId}
                                        data-tour-id={`track-group-member-${member.trackId}`}
                                        draggable
                                        tabIndex={0}
                                        aria-selected={selected}
                                        onDragStart={(e) => {
                                            e.dataTransfer.effectAllowed = 'move'
                                            e.dataTransfer.setData('text/plain', member.trackId)
                                            setDragFrom(index)
                                        }}
                                        onDragOver={(e) => {
                                            if (dragFrom === -1) return
                                            e.preventDefault()
                                            const rect = e.currentTarget.getBoundingClientRect()
                                            setDropAt(e.clientY < rect.top + rect.height / 2 ? index : index + 1)
                                        }}
                                        onDrop={(e) => {
                                            e.preventDefault()
                                            if (dragFrom !== -1 && dropAt !== -1) moveMember(dragFrom, dropAt)
                                            endDrag()
                                        }}
                                        onDragEnd={endDrag}
                                        onClick={(e) => handleRowClick(member.trackId, e)}
                                        onKeyDown={(e) => handleRowKeyDown(index, e)}
                                        className={`group/member flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 ${selected
                                            ? (isLight ? 'bg-blue-50' : 'bg-blue-900/30')
                                            : (isLight ? 'hover:bg-gray-100' : 'hover:bg-gray-800')} ${dragFrom === index ? 'opacity-50' : ''} ${lineBefore ? 'shadow-[inset_0_2px_0_0_#3b82f6]' : ''} ${lineAfter ? 'shadow-[inset_0_-2px_0_0_#3b82f6]' : ''}`}
                                    >
                                        <span aria-hidden="true" className={`cursor-grab text-xs leading-none ${mutedCls}`} title="Drag to reorder">⋮⋮</span>
                                        <span className={`w-5 text-right text-[11px] tabular-nums ${mutedCls}`}>{index + 1}</span>
                                        <TypeBadge type={track?.type} small />
                                        <span className="flex-1 min-w-0">
                                            <span className={`block text-sm truncate ${isLight ? 'text-gray-800' : 'text-gray-200'}`}>{track?.label}</span>
                                            {member.custom && (
                                                <span className={`text-[10px] px-1 rounded ${isLight ? 'bg-gray-200 text-gray-600' : 'bg-gray-700 text-gray-300'}`}>custom settings</span>
                                            )}
                                        </span>
                                        <button
                                            type="button"
                                            aria-label={`Remove ${track?.label} from the group`}
                                            title="Remove from the group"
                                            onClick={(e) => { e.stopPropagation(); removeMember(member.trackId) }}
                                            className={`shrink-0 p-1 rounded text-xs opacity-60 group-hover/member:opacity-100 focus:opacity-100 ${isLight ? 'hover:bg-gray-200' : 'hover:bg-gray-700'} ${mutedCls}`}
                                        >
                                            ✕
                                        </button>
                                    </li>
                                )
                            })}
                        </ol>
                        <div className={`flex-none border-t px-3 py-2 ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                            {adding ? (
                                <div className="space-y-2">
                                    <div className="max-h-44 overflow-y-auto space-y-0.5">
                                        {available.map((t) => {
                                            const id = String(t.id)
                                            const picked = addPick.includes(id)
                                            return (
                                                <label key={id} className={`flex items-center gap-2 rounded px-2 py-1 text-sm cursor-pointer ${isLight ? 'hover:bg-gray-100 text-gray-800' : 'hover:bg-gray-800 text-gray-200'}`}>
                                                    <input
                                                        type="checkbox"
                                                        checked={picked}
                                                        onChange={() => setAddPick((prev) => (picked ? prev.filter((x) => x !== id) : [...prev, id]))}
                                                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                                    />
                                                    <TypeBadge type={t.type} small />
                                                    <span className="truncate">{t.label}</span>
                                                </label>
                                            )
                                        })}
                                    </div>
                                    <div className="flex items-center justify-end gap-2">
                                        <button type="button" onClick={() => { setAdding(false); setAddPick([]) }} className={`px-3 py-1.5 rounded-lg text-xs ${isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-800'}`}>
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            data-tour-id="track-group-add-picked"
                                            disabled={!addPick.length}
                                            onClick={addPicked}
                                            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40"
                                        >
                                            Add {addPick.length || ''} track{addPick.length === 1 ? '' : 's'}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    data-tour-id="track-group-add-tracks"
                                    disabled={!available.length}
                                    onClick={() => setAdding(true)}
                                    title={available.length ? '' : 'Every track for this genome is already in the group'}
                                    className="w-full py-1.5 rounded-lg border border-dashed border-blue-400/50 text-xs text-blue-500 hover:bg-blue-500/5 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    + Add tracks{available.length ? ` (${available.length} more for this genome)` : ''}
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="min-h-0 overflow-y-auto px-6 py-4">{editor}</div>
                </div>

                {(error || problems.length > 0) && (
                    <div className={`px-6 py-2 border-t text-xs flex-none ${isLight ? 'border-gray-100' : 'border-gray-700'}`}>
                        {error && <div className={isLight ? 'text-red-700' : 'text-red-300'}>{error}</div>}
                        {!error && <div className={isLight ? 'text-amber-700' : 'text-amber-300'}>{problems[0]}{problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}</div>}
                    </div>
                )}
                <div className={`px-6 py-4 border-t flex items-center justify-between gap-3 flex-none ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700 bg-gray-900/50'}`}>
                    <div>
                        {isEdit && (
                            <button
                                type="button"
                                data-tour-id="track-group-delete"
                                onClick={handleDeleteGroup}
                                className={`px-3 py-2 rounded-lg text-sm ${isLight ? 'text-red-600 hover:bg-red-50' : 'text-red-400 hover:bg-red-900/30'}`}
                            >
                                Delete group
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className={`px-4 py-2 rounded-lg text-sm font-medium border ${isLight ? 'border-gray-300 text-gray-700 hover:bg-gray-100' : 'border-gray-600 text-gray-300 hover:bg-gray-800'}`}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            data-tour-id="track-group-save"
                            onClick={handleSave}
                            disabled={saving || problems.length > 0}
                            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {saving ? 'Saving…' : isEdit ? 'Save group' : 'Create group'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
