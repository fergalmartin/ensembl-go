import { DrawerIconButton, VerticalChevronGlyph } from './focusDrawerChrome'
import { focusDrawerPalette } from './focusDrawerStyle'

// The sections of the Feature Explorer — Gene, Transcripts, Exons, Proteins, Structure,
// Export — laid out on the one surface they share rather than as a card each inside
// it: a title, a rule out to the collapse arrow, and a divider between one section and
// the next. The same chrome as the drawers elsewhere, so the view reads as one page.

/** Classes for a section's outer element: nothing but the divider above it. */
export function featureSectionClass(isLight) {
    return `feature-section border-t first:border-t-0 ${isLight ? 'border-gray-200' : 'border-gray-700'}`
}

/** A small control in the Feature Explorer's chrome: no box, just the glyph, tinted on hover. */
export function quietIconButtonClass(isLight, { active = false, disabled = false } = {}) {
    if (disabled) return `rounded flex items-center justify-center ${isLight ? 'text-gray-300' : 'text-gray-600'} cursor-not-allowed`
    if (active) return `rounded flex items-center justify-center transition-colors ${isLight ? 'bg-blue-50 text-[#0077cc]' : 'bg-[#2b3a55] text-sky-300'}`
    return `rounded flex items-center justify-center transition-colors ${isLight
        ? 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
        : 'text-gray-400 hover:text-gray-100 hover:bg-[#273449]'}`
}

/**
 * The heading row of a section. The whole row toggles it, as before; `actions` sit
 * between the rule and the arrow.
 */
export default function FeatureSectionHeader({ title, collapsed, onToggle, isLight, actions = null, expandTitle, collapseTitle }) {
    const palette = focusDrawerPalette(isLight)
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onToggle?.()}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onToggle?.()
                }
            }}
            className="px-4 pt-3 pb-2 flex items-center gap-3 cursor-pointer select-none"
        >
            <div className={`flex-none min-w-0 truncate text-sm font-semibold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>
                {title}
            </div>
            <div className="flex-1 h-px" style={{ backgroundColor: palette.divider }} />
            {actions ? (
                <div className="flex-none flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
                    {actions}
                </div>
            ) : null}
            <span onClick={(event) => event.stopPropagation()} className="flex-none">
                <DrawerIconButton
                    onClick={() => onToggle?.()}
                    title={collapsed ? expandTitle : collapseTitle}
                    accent={palette.accent}
                    rowHoverClass={palette.rowHoverClass}
                    expanded={!collapsed}
                    compact
                ><VerticalChevronGlyph pointsDown={collapsed} size={17} /></DrawerIconButton>
            </span>
        </div>
    )
}

/**
 * A heading inside a section — Exon detail, Coding exons, Variants — in the drawers'
 * small-capitals style, with its own arrow when it folds.
 */
export function FeatureSubHeading({ label, collapsed, onToggle, isLight, expandTitle, collapseTitle, children = null }) {
    const palette = focusDrawerPalette(isLight)
    const foldable = typeof onToggle === 'function'
    return (
        <div
            role={foldable ? 'button' : undefined}
            tabIndex={foldable ? 0 : undefined}
            onClick={foldable ? () => onToggle() : undefined}
            onKeyDown={foldable ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onToggle()
                }
            } : undefined}
            className={`flex items-center gap-2 py-1 ${foldable ? 'cursor-pointer select-none' : ''}`}
        >
            <h3 className={`flex-none text-[11px] font-semibold tracking-wide uppercase ${palette.subTextClass}`}>{label}</h3>
            <div className="flex-1 h-px" style={{ backgroundColor: palette.divider }} />
            {children}
            {foldable ? (
                <span onClick={(event) => event.stopPropagation()} className="flex-none">
                    <DrawerIconButton
                        onClick={() => onToggle()}
                        title={collapsed ? expandTitle : collapseTitle}
                        accent={palette.accent}
                        rowHoverClass={palette.rowHoverClass}
                        expanded={!collapsed}
                        compact
                    ><VerticalChevronGlyph pointsDown={collapsed} size={17} /></DrawerIconButton>
                </span>
            ) : null}
        </div>
    )
}
