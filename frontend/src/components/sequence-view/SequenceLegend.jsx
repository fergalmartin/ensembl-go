import { LEVEL_GROUPS } from '../../utils/sequenceViewPalette'
import { DEFAULT_PALETTE, groupColour, groupGradient } from '../../utils/sequenceViewColours'

/**
 * What the colours on screen mean, for the level being read.
 *
 * `coarse` is true where a region was too dense to read isoform by isoform. The
 * genic swatch belongs to that answer alone, so it appears only then: a legend
 * is a key to what is on screen, not a catalogue of what the view can draw.
 *
 * `only`, where it is given, is the same rule applied to a reading rather than a
 * level: a spliced sequence has no introns left to colour and a protein has no
 * nucleotide class at all, so the groups that cannot appear are not listed.
 * `null` is every group the level has, which is the genomic reading.
 */
export default function SequenceLegend({
    level, coarse = false, only = null, isLight, palette = DEFAULT_PALETTE,
}) {
    const allowed = only ? new Set(only) : null
    const groups = (LEVEL_GROUPS[level] || []).filter(
        (group) => (coarse || group.key !== 'genic') && (!allowed || allowed.has(group.key)),
    )
    const border = isLight ? 'border-gray-200' : 'border-gray-700'
    const text = isLight ? 'text-gray-600' : 'text-gray-400'
    if (groups.length === 0) return null

    return (
        <div className={`flex flex-wrap items-center gap-4 border-t px-4 py-2 ${border}`}>
            {groups.map((group) => (
                <span key={group.key} className="flex items-center gap-1.5">
                    <span className="h-3 w-3 rounded-sm" style={swatchStyle(group, palette)} />
                    <span className={`text-[11px] ${text}`}>{group.label}</span>
                </span>
            ))}
        </div>
    )
}

function swatchStyle(group, palette) {
    // Three kinds of mark, so three ways to draw the sample: a filled cell, an
    // outlined one, and a rule under the bases -- which is what an overlap is,
    // since it sits over whatever colour the base already has.
    const colour = groupColour(group, palette)
    if (group.underline) {
        return { background: 'transparent', borderBottom: `2px solid ${colour}` }
    }
    return {
        background: group.outlineOnly ? 'transparent' : (groupGradient(group, palette) || colour),
        border: `1px solid ${colour}`,
    }
}
