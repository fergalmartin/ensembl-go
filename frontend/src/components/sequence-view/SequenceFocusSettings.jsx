import { LEVEL_GROUPS } from '../../utils/sequenceViewPalette'
import { DEFAULT_PALETTE, groupColour, groupGradient } from '../../utils/sequenceViewColours'

/**
 * What the level being read highlights.
 *
 * Scoped to that level: a location is genic or intergenic, a gene is described
 * by all its isoforms at once, and a transcript by its own codons and splice
 * sites. Showing one list of every class there is would offer most readers
 * switches that do nothing at the level they are on.
 *
 * `level` is what is drawn, which is the records' level while a collection is
 * on screen -- tick genes off a location and the switches on offer are a gene's,
 * because that is what the rows are now showing.
 *
 * The flank used to live here as well, as one stepper setting both ends of
 * whatever was in focus. It is now the Feature menu's, where each kind of
 * feature carries its own 5' and 3' amounts; two controls for one setting can
 * disagree on screen, and this was the one that could say less.
 */
export default function SequenceFocusSettings({
    level,
    highlights,
    onHighlightsChange,
    isLight,
    palette = DEFAULT_PALETTE,
    onClose,
}) {
    const groups = LEVEL_GROUPS[level] || []
    const border = isLight ? 'border-gray-200' : 'border-gray-700'
    const heading = isLight ? 'text-gray-500' : 'text-gray-400'
    const text = isLight ? 'text-gray-700' : 'text-gray-300'
    const muted = isLight ? 'text-gray-500' : 'text-gray-400'
    const toggle = (key) => onHighlightsChange({ ...highlights, [key]: !highlights[key] })

    return (
        <div className="flex h-full flex-col">
            <div className={`flex items-center justify-between border-b px-4 py-3 ${border}`}>
                <h3 className={`text-xs font-semibold uppercase tracking-wide ${heading}`}>
                    Highlights
                </h3>
                <button
                    type="button"
                    onClick={onClose}
                    className={`text-xs ${muted} hover:underline`}
                >
                    Close
                </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-2">
                    {groups.map((group) => (
                        <label key={group.key} className="flex items-start gap-2.5">
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={Boolean(highlights?.[group.key])}
                                onChange={() => toggle(group.key)}
                            />
                            <span
                                className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm"
                                style={group.underline ? {
                                    background: 'transparent',
                                    borderBottom: `2px solid ${groupColour(group, palette)}`,
                                } : {
                                    background: group.outlineOnly
                                        ? 'transparent'
                                        : (groupGradient(group, palette) || groupColour(group, palette)),
                                    border: `1px solid ${groupColour(group, palette)}`,
                                }}
                            />
                            <span className="min-w-0">
                                <span className={`block text-sm ${text}`}>{group.label}</span>
                                {group.hint ? (
                                    <span className={`block text-[11px] ${muted}`}>{group.hint}</span>
                                ) : null}
                            </span>
                        </label>
                    ))}
                </div>
            </div>
        </div>
    )
}
