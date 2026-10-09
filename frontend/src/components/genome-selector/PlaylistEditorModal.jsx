import { useEffect, useState } from 'react'
import { genomeKeysMatch } from '../../utils/genomeIdentity.js'
import { formatPlaylistGenomeLabel } from './genomeSelectorModel.js'

export function PlaylistEditorModal({ isOpen, theme, playlist, availableAssembliesByKey, onClose, onSave }) {
    const isLight = theme === 'light'
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [genomes, setGenomes] = useState([])

    useEffect(() => {
        if (!isOpen || !playlist) return
        setName(playlist.name || '')
        setDescription(playlist.description || '')
        setGenomes(Array.isArray(playlist.genomes) ? playlist.genomes : [])
    }, [isOpen, playlist])

    if (!isOpen || !playlist) return null

    return (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div className={`w-full max-w-2xl rounded-xl border shadow-2xl ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                <div className={`px-5 py-4 border-b flex items-center justify-between ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <div>
                        <h3 className={`text-base font-bold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Edit playlist</h3>
                        <p className={`text-xs mt-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{genomes.length} genome{genomes.length === 1 ? '' : 's'}</p>
                    </div>
                    <button
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
                    <div className="grid grid-cols-1 gap-3">
                        <input
                            type="text"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Playlist name"
                            className={`w-full px-3 py-2 rounded-lg text-sm border ${isLight
                                ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                                : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
                                }`}
                        />
                        <textarea
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            placeholder="Description (optional)"
                            rows={3}
                            className={`w-full px-3 py-2 rounded-lg text-sm border resize-none ${isLight
                                ? 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'
                                : 'bg-gray-900 border-gray-600 text-gray-100 placeholder-gray-500'
                                }`}
                        />
                    </div>

                    <div>
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Playlist genomes</div>
                        <div className={`rounded-xl border max-h-64 overflow-y-auto ${isLight ? 'border-gray-200 bg-gray-50/70' : 'border-gray-700 bg-gray-900/30'}`}>
                            {genomes.length === 0 ? (
                                <div className={`px-4 py-4 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>This playlist is empty.</div>
                            ) : genomes.map((genome) => {
                                const isMissing = !availableAssembliesByKey.has(genome.key)
                                const isActiveByDefault = Boolean(genome.active_by_default)
                                return (
                                    <div
                                        key={genome.key}
                                        className={`px-4 py-3 border-b last:border-b-0 flex items-center justify-between gap-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                                    >
                                        <div className="min-w-0">
                                            <div className={`text-sm font-semibold truncate ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>{formatPlaylistGenomeLabel(genome)}</div>
                                            <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                {genome.key}
                                                {isMissing ? ' • Missing locally' : ''}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                            <button
                                                type="button"
                                                aria-pressed={isActiveByDefault}
                                                title="Active by default when this playlist is selected"
                                                onClick={() => setGenomes((prev) => prev.map((member) => (
                                                    genomeKeysMatch(member, genome)
                                                        ? { ...member, active_by_default: !Boolean(member.active_by_default) }
                                                        : member
                                                )))}
                                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${isActiveByDefault
                                                    ? (isLight ? 'bg-[#0099ff] text-white hover:bg-[#0088ee]' : 'bg-blue-600 text-white hover:bg-blue-500')
                                                    : (isLight ? 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-50' : 'bg-gray-800 text-gray-300 border border-gray-600 hover:bg-gray-700')
                                                    }`}
                                            >
                                                Active
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setGenomes((prev) => prev.filter((member) => !genomeKeysMatch(member, genome)))}
                                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${isLight
                                                    ? 'bg-red-50 text-red-700 hover:bg-red-100'
                                                    : 'bg-red-900/30 text-red-300 hover:bg-red-900/50'
                                                    }`}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </div>

                <div className={`px-5 py-4 border-t flex items-center justify-end gap-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <button
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
                        type="button"
                        onClick={() => {
                            const didSave = onSave({
                                ...playlist,
                                name,
                                description,
                                genomes,
                            })
                            if (didSave !== false) onClose()
                        }}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold ${isLight ? 'bg-[#0099ff] text-white hover:bg-[#0088ee]' : 'bg-blue-600 text-white hover:bg-blue-500'}`}
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    )
}
