import { normalizeNoteTags, tagKey } from '../../utils/noteTags.js'

export function TagChip({ label, isLight, onRemove = null, compact = false, muted = false }) {
    return (
        <span
            className={`inline-flex max-w-full items-center rounded-full border font-medium leading-none ${compact ? 'h-[18px] px-1.5 text-[9px]' : 'h-6 px-2 text-[11px]'} ${muted ? 'opacity-60' : ''} ${isLight ? 'border-slate-300 bg-slate-100 text-slate-700' : 'border-slate-600 bg-slate-800 text-slate-200'}`}
            title={label}
        >
            <span className="truncate">{label}</span>
            {onRemove && (
                <button
                    type="button"
                    onClick={() => onRemove(label)}
                    className="ml-1 flex-none opacity-50 hover:opacity-100"
                    title={`Remove ${label}`}
                    aria-label={`Remove ${label}`}
                >
                    ×
                </button>
            )}
        </span>
    )
}

export function PreviewTagChips({ tags, isLight, archived = false }) {
    const normalized = normalizeNoteTags(tags)
    if (normalized.length === 0) {
        return (
            <span className={`mt-1 flex h-[18px] items-center text-[9px] italic ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
                No tags added
            </span>
        )
    }
    const visible = normalized.slice(0, 3)
    return (
        <span className="mt-1 flex h-[18px] min-w-0 items-center gap-1 overflow-hidden" aria-label={`Tags: ${normalized.join(', ')}`}>
            {visible.map((tag) => <TagChip key={tagKey(tag)} label={tag} isLight={isLight} compact muted={archived} />)}
            {normalized.length > visible.length && (
                <span className={`flex-none text-[9px] ${isLight ? 'text-slate-500' : 'text-slate-400'}`}>+{normalized.length - visible.length}</span>
            )}
        </span>
    )
}
