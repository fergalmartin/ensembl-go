import { API_BASE } from '../../backendRuntime.js'
import { groupTypeCounts } from '../../utils/trackGroups.js'
import { groupLayoutLabel } from './trackManagerModel.js'
import { GroupLayoutIcon, TypeBadge } from './trackManagerParts'

// A group in the Track Manager: what it holds at a glance; the dialog has the rest.
export function TrackGroupCard({ group, tracksById, isLight, onEdit, onDelete }) {
    const typeCounts = groupTypeCounts(group, tracksById)
    const names = group.members.map((m) => tracksById.get(String(m.track_id))?.label).filter(Boolean)
    const customCount = group.members.filter((m) => m.settings).length
    const handleDelete = async () => {
        if (!window.confirm(`Delete the group "${group.label}"?\n(Its tracks stay registered.)`)) return
        try {
            const res = await fetch(`${API_BASE}/api/track-groups/${group.id}`, { method: 'DELETE' })
            if (res.ok || res.status === 404) onDelete(group.id)
        } catch {
            // ignore
        }
    }
    const mutedCls = isLight ? 'text-gray-500' : 'text-gray-400'
    return (
        <div
            data-tour-id={`track-manager-group-${group.id}`}
            // By name, for the reason a track card is anchored by label: the id is minted
            // when the group is made and a tutorial cannot know it.
            data-tutorial-group-label={group.label}
            className={`h-full rounded-xl border p-4 ${isLight ? 'bg-indigo-50/40 border-indigo-200' : 'bg-indigo-950/20 border-indigo-800/60'}`}
        >
            <div className="flex items-start gap-3">
                <span className={`mt-0.5 shrink-0 rounded-md p-1 ${isLight ? 'bg-indigo-100 text-indigo-700' : 'bg-indigo-900/60 text-indigo-300'}`}>
                    <GroupLayoutIcon />
                </span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${isLight ? 'bg-indigo-100 text-indigo-700' : 'bg-indigo-900/60 text-indigo-300'}`}>Group</span>
                        <span className={`text-sm font-semibold truncate ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{group.label}</span>
                    </div>
                    <p className={`text-xs mt-1 ${mutedCls}`}>
                        {group.members.length} track{group.members.length === 1 ? '' : 's'} · {groupLayoutLabel(group.layout)}
                        {customCount > 0 ? ` · ${customCount} with custom settings` : ''}
                    </p>
                    {typeCounts.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                            {typeCounts.map(({ type, count }) => (
                                <span key={type} className="inline-flex items-center gap-1">
                                    <TypeBadge type={type} small />
                                    <span className={`text-xs ${mutedCls}`}>×{count}</span>
                                </span>
                            ))}
                        </div>
                    )}
                    <p className={`text-xs mt-1.5 truncate ${mutedCls}`} title={names.join(', ')}>
                        {names.length
                            ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`
                            : 'No tracks yet'}
                    </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    <button
                        type="button"
                        onClick={() => onEdit(group)}
                        className={`p-1.5 rounded-lg text-xs ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                        title="Edit group"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        onClick={handleDelete}
                        className={`p-1.5 rounded-lg text-xs ${isLight ? 'text-red-400 hover:bg-red-50' : 'text-red-500 hover:bg-red-900/30'}`}
                        title="Delete group (its tracks stay registered)"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    )
}
