import { IconUpDown } from './downloadIcons'

// ---------------------------------------------------------------------------
// Collapsible panel header (shared between both panels)
// ---------------------------------------------------------------------------
export function PanelHeader({ title, count, countLabel, collapsed, onToggle, isLight, actions }) {
    const canToggle = typeof onToggle === 'function'
    return (
        <div
            className={`px-4 py-2.5 flex items-center justify-between select-none shrink-0 ${canToggle ? 'cursor-pointer' : ''} ${isLight ? (canToggle ? 'bg-gray-50 hover:bg-gray-100' : 'bg-gray-50') : (canToggle ? 'bg-gray-750 hover:bg-gray-700' : 'bg-gray-750')}`}
            onClick={onToggle}
        >
            <div className="flex items-center gap-2.5">
                <span className={`text-xs font-bold uppercase tracking-widest ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                    {title}
                </span>
                {count !== undefined && (
                    <span className={`text-xs tabular-nums px-2 py-0.5 rounded-full font-medium ${isLight ? 'bg-gray-200 text-gray-600' : 'bg-gray-700 text-gray-300'}`}>
                        {countLabel ?? count}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                {actions}
                {canToggle && (
                    <span className={isLight ? 'text-gray-400' : 'text-gray-500'} onClick={onToggle}>
                        <IconUpDown open={!collapsed} size={14} />
                    </span>
                )}
            </div>
        </div>
    )
}
