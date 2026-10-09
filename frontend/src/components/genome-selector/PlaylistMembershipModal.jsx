import { useEffect, useMemo, useState } from 'react'
import { genomeKeysMatch } from '../../utils/genomeIdentity.js'
import { formatPlaylistGenomeLabel, itemKey } from './genomeSelectorModel.js'

export function PlaylistMembershipModal({ isOpen, theme, genomes, addOnly = false, preset = null, playlists, onClose, onSave }) {
    const isLight = theme === 'light'
    const targetGenomes = useMemo(
        () => (Array.isArray(genomes) ? genomes : []).filter(Boolean),
        [genomes]
    )
    const genome = targetGenomes[0] || null
    const genomeKey = itemKey(genome)
    const [selectedIds, setSelectedIds] = useState(new Set())
    const [newPlaylistName, setNewPlaylistName] = useState('')
    const [newPlaylistDescription, setNewPlaylistDescription] = useState('')
    const editablePlaylists = useMemo(
        () => (Array.isArray(playlists) ? playlists : []).filter((playlist) => !playlist.system),
        [playlists]
    )

    useEffect(() => {
        if (!isOpen || !genomeKey) return
        const nextSelected = new Set(
            addOnly
                ? []
                : editablePlaylists
                    .filter((playlist) => playlist.genomes.some((member) => genomeKeysMatch(member, genomeKey)))
                    .map((playlist) => playlist.id)
        )
        setSelectedIds(nextSelected)
        // A tutorial step that expects the form already filled in says so; see the dialog
        // arrival in docs/TUTORIALS.md. It fills what is empty rather than replacing what
        // is there: a reader who wrote their own description keeps it when the next step
        // re-establishes the dialog. Everywhere else this is the ordinary empty form.
        setNewPlaylistName((current) => (preset ? (String(current || '').trim() ? current : String(preset.name || '')) : ''))
        setNewPlaylistDescription((current) => (preset ? (String(current || '').trim() ? current : String(preset.description || '')) : ''))
    }, [isOpen, genomeKey, addOnly, editablePlaylists, preset])

    if (!isOpen || !genome) return null

    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div
                data-tour-id="playlist-membership-dialog"
                className={`w-full max-w-xl rounded-xl border shadow-2xl ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}
            >
                <div className={`px-5 py-4 border-b flex items-center justify-between ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <div>
                        <h3 className={`text-base font-bold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                            {addOnly ? 'Add selected genomes to playlists' : 'Add to playlists'}
                        </h3>
                        <p className={`text-xs mt-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {addOnly
                                ? `${targetGenomes.length} selected genome${targetGenomes.length === 1 ? '' : 's'}`
                                : formatPlaylistGenomeLabel(genome)}
                        </p>
                    </div>
                    <button
                        data-tour-id="playlist-membership-close"
                        type="button"
                        onClick={onClose}
                        className={`p-2 rounded-lg transition-colors ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                    </button>
                </div>

                <div className="px-5 py-4 space-y-4">
                    <div>
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Existing playlists</div>
                        <div
                            data-tour-id="playlist-membership-existing"
                            className={`rounded-xl border max-h-52 overflow-y-auto ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-900/30'}`}
                        >
                            {editablePlaylists.length === 0 ? (
                                <div className={`px-4 py-4 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>No playlists yet.</div>
                            ) : editablePlaylists.map((playlist) => {
                                const checked = selectedIds.has(playlist.id)
                                return (
                                    <label
                                        key={playlist.id}
                                        className={`flex items-start gap-3 px-4 py-3 border-b last:border-b-0 cursor-pointer ${isLight ? 'border-gray-200 hover:bg-white' : 'border-gray-700 hover:bg-gray-800/70'}`}
                                    >
                                        <input
                                            data-tour-id={`playlist-membership-checkbox-${playlist.id}`}
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() => {
                                                setSelectedIds((prev) => {
                                                    const next = new Set(prev)
                                                    if (next.has(playlist.id)) next.delete(playlist.id)
                                                    else next.add(playlist.id)
                                                    return next
                                                })
                                            }}
                                            className="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                        />
                                        <div className="min-w-0">
                                            <div className={`text-sm font-semibold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>{playlist.name}</div>
                                            <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                {playlist.genomes.length} genome{playlist.genomes.length === 1 ? '' : 's'}
                                                {playlist.description ? ` • ${playlist.description}` : ''}
                                            </div>
                                        </div>
                                    </label>
                                )
                            })}
                        </div>
                    </div>

                    <div className={`rounded-xl border p-4 ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-900/30'}`}>
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-3 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Create new playlist</div>
                        <div className="space-y-3">
                            <input
                                data-tour-id="playlist-membership-new-name"
                                type="text"
                                value={newPlaylistName}
                                onChange={(event) => setNewPlaylistName(event.target.value)}
                                placeholder="Playlist name"
                                className={`w-full px-3 py-2 rounded-lg text-sm border ${isLight
                                    ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                                    : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
                                    }`}
                            />
                            <textarea
                                data-tour-id="playlist-membership-new-description"
                                value={newPlaylistDescription}
                                onChange={(event) => setNewPlaylistDescription(event.target.value)}
                                placeholder="Description (optional)"
                                rows={3}
                                className={`w-full px-3 py-2 rounded-lg text-sm border resize-none ${isLight
                                    ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                                    : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
                                    }`}
                            />
                        </div>
                    </div>
                </div>

                <div className={`px-5 py-4 border-t flex items-center justify-end gap-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <button
                        data-tour-id="playlist-membership-cancel"
                        type="button"
                        onClick={onClose}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold border ${isLight
                            ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                            : 'bg-gray-800 text-gray-200 border-gray-600 hover:bg-gray-700'
                            }`}
                    >
                        Cancel
                    </button>
                    <button
                        data-tour-id="playlist-membership-save"
                        type="button"
                        onClick={() => {
                            const didSave = onSave({
                                genome,
                                genomes: targetGenomes,
                                addOnly,
                                selectedPlaylistIds: Array.from(selectedIds),
                                newPlaylistName,
                                newPlaylistDescription,
                            })
                            if (didSave !== false) onClose()
                        }}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold ${isLight ? 'bg-[#0099ff] text-white hover:bg-[#0088ee]' : 'bg-blue-600 text-white hover:bg-blue-500'}`}
                    >
                        {addOnly ? 'Add genomes' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    )
}
