import { useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import { genomeColorPalette } from '../../genomeColorSchemes.js'
import GenomeColorPicker, { ColorSwatch } from '../GenomeColorPicker'
import { TrackColorPaletteContext } from './trackColorContext.js'

/** A small picture of a track drawn in one colour, for the picker's preview. */
export function TrackColorPreview({ color, kind = 'intervals', isLight }) {
    const bg = isLight ? '#ffffff' : '#1E2938'
    const axis = isLight ? '#d8dee7' : '#3a4557'
    let body
    if (kind === 'signal') {
        const ys = [30, 26, 12, 20, 34, 8, 16, 28, 22, 6, 18, 30, 24, 14, 32, 26, 10, 22, 30, 20]
        const step = 320 / (ys.length - 1)
        const line = ys.map((y, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y + 10}`).join(' ')
        body = <path d={`${line} L320,50 L0,50 Z`} fill={color} opacity="0.85" />
    } else if (kind === 'variants') {
        body = [18, 46, 60, 104, 150, 158, 212, 250, 284].map((x, i) => (
            <g key={x}>
                <line x1={x} x2={x} y1={46} y2={18 + (i % 3) * 7} stroke={color} strokeWidth="1.5" />
                <circle cx={x} cy={16 + (i % 3) * 7} r="3" fill={color} />
            </g>
        ))
    } else {
        body = [[10, 26], [52, 12], [80, 40], [150, 18], [180, 8], [214, 52], [290, 20]].map(([x, w]) => (
            <rect key={x} x={x} y={22} width={w} height={12} rx="1.5" fill={color} opacity="0.9" />
        ))
    }
    return (
        <div className={`rounded-xl border overflow-hidden ${isLight ? 'border-gray-200' : 'border-gray-700'}`} style={{ background: bg }}>
            <svg viewBox="0 0 320 56" className="block w-full" role="img" aria-label={`Track preview in ${color}`}>
                <line x1="0" x2="320" y1="50.5" y2="50.5" stroke={axis} strokeWidth="1" />
                {body}
            </svg>
        </div>
    )
}

/** A track colour: the app's rounded swatch, which opens the shared colour picker.
 *
 *  `automatic` is for a colour whose default is "whatever the file says" (BED itemRgb):
 *  then an empty value means automatic, and choosing the default colour returns to it. */
export function TrackColorField({
    label,
    color,
    defaultColor,
    onChange,
    isLight,
    previewKind = 'intervals',
    pickerTitle = 'Track colour',
    pickerSubtitle = '',
    automatic = false,
    compact = false,
}) {
    const palette = useContext(TrackColorPaletteContext)
    const [open, setOpen] = useState(false)
    const isAutomatic = automatic && !color
    const shown = color || defaultColor
    // Too narrow for the marker in the compact grid; the zones have "Reset to defaults".
    const isDefault = !automatic && !compact && shown === defaultColor
    return (
        <div className={compact ? 'flex items-center gap-2' : ''}>
            {label ? (
                <span className={compact
                    ? `text-xs w-12 shrink-0 ${isLight ? 'text-gray-700' : 'text-gray-300'}`
                    : `block text-xs font-medium mb-1 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}
                >
                    {label}
                </span>
            ) : null}
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={`inline-flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors ${isLight ? 'hover:bg-blue-50' : 'hover:bg-blue-900/20'}`}
                title={`${pickerTitle}: ${isAutomatic ? 'automatic' : shown}`}
                aria-label={`Choose ${pickerTitle.toLowerCase()}`}
            >
                <ColorSwatch color={shown} />
                <span className={`text-xs font-mono ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
                    {isAutomatic ? 'Automatic' : shown}
                    {isDefault ? <span className={isLight ? 'text-gray-400' : 'text-gray-500'}> · default</span> : null}
                </span>
            </button>
            {open && typeof document !== 'undefined' ? createPortal(
                <GenomeColorPicker
                    isOpen
                    theme={isLight ? 'light' : 'dark'}
                    title={pickerTitle}
                    subtitle={pickerSubtitle}
                    palette={palette || genomeColorPalette(null)}
                    currentColor={shown}
                    defaultColor={defaultColor}
                    defaultLabel={automatic ? 'Automatic' : 'Use default'}
                    paletteHint={automatic
                        ? 'Automatic uses the colours written in the file where it has them, and this default where it does not.'
                        : 'Choose from the palette, or mix a custom colour.'}
                    renderPreview={(c) => <TrackColorPreview color={c} kind={previewKind} isLight={isLight} />}
                    onApply={(next) => onChange(automatic && next === defaultColor ? '' : next)}
                    onClose={() => setOpen(false)}
                />,
                document.body,
            ) : null}
        </div>
    )
}
