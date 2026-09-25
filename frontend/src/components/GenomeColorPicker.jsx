// Choosing the colour a genome is drawn in.
//
// The swatch in the Genome Selector's action column opens this; so does the
// header control, with every selected genome as its subject. The preview above
// the palette is the point of the dialog — a colour is picked for how a gene
// track will look in it, not for how the disc looks.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
    DEFAULT_GENOME_COLOR,
    genomeColorPalette,
    normalizeGenomeDefaultColor,
    sanitizeHexColor,
} from '../genomeColorSchemes'
import { previewGeneLayout, previewRegionLabel } from '../utils/genomeColorPreview'

/** A miniature gene track drawn in one colour.
 *
 *  Exported because the configuration view shows the same picture for the
 *  default colour, and two drawings of "what this colour looks like" that drift
 *  apart would be worse than none. */
export function GenomeColorPreview({ color, isLight = false, height = 132, label = '' }) {
    const layout = useMemo(() => previewGeneLayout({ width: 320, height }), [height])
    const swatch = sanitizeHexColor(color, DEFAULT_GENOME_COLOR)
    const gridColor = isLight ? '#d8dee7' : '#3a4557'
    const textColor = isLight ? '#64748b' : '#9aa5b5'
    return (
        <div
            data-tour-id="genome-color-preview"
            className={`rounded-xl border overflow-hidden ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-[#1E2938]'}`}
        >
            <svg
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                className="block w-full"
                role="img"
                aria-label={`Gene track preview in ${swatch}`}
            >
                {/* The ruler: the line the two strands are stacked around. */}
                <line
                    x1={layout.ruler.left}
                    x2={layout.ruler.right}
                    y1={layout.ruler.y}
                    y2={layout.ruler.y}
                    stroke={gridColor}
                    strokeWidth="1"
                />
                {layout.ruler.ticks.map((tick) => (
                    <line
                        key={tick.coordinate}
                        x1={tick.x}
                        x2={tick.x}
                        y1={layout.ruler.y - 3}
                        y2={layout.ruler.y + 3}
                        stroke={gridColor}
                        strokeWidth="1"
                    />
                ))}
                {layout.genes.map((gene) => (
                    <g key={gene.id}>
                        {/* Intron line first, so the exon blocks sit on top of it. */}
                        <line
                            x1={gene.x}
                            x2={gene.x + gene.width}
                            y1={gene.centerY}
                            y2={gene.centerY}
                            stroke={swatch}
                            strokeWidth="1.25"
                            opacity="0.85"
                        />
                        {gene.exons.map((exon, index) => (
                            <rect
                                key={`${gene.id}-${index}`}
                                x={exon.x}
                                y={gene.y}
                                width={exon.width}
                                height={gene.exonHeight}
                                rx="1.5"
                                fill={swatch}
                            />
                        ))}
                        <text
                            x={gene.x}
                            y={gene.labelY}
                            fontSize="7"
                            fill={textColor}
                            style={{ fontFamily: 'inherit' }}
                        >
                            {gene.name}
                        </text>
                    </g>
                ))}
            </svg>
            <div
                className={`px-3 py-1.5 text-[10px] font-mono border-t ${isLight ? 'border-gray-100 text-gray-500' : 'border-gray-700/60 text-gray-400'}`}
            >
                {label || previewRegionLabel(layout.region)}
            </div>
        </div>
    )
}

/** The mixed-colour marker: a conic sweep through the built-in palette.
 *
 *  Used on the header control when the selected genomes disagree, so "these are
 *  not all one colour" is legible without opening anything. */
export function MixedColorSwatch({ size = 18, className = '', title = '' }) {
    return (
        <span
            className={`inline-block rounded-md border border-white/60 shadow-sm ${className}`}
            style={{
                width: size,
                height: size,
                background: 'conic-gradient(#ef4444, #f59e0b, #84cc16, #00b692, #0ea5e9, #3366cc, #8b5cf6, #ec4899, #ef4444)',
            }}
            title={title}
        />
    )
}

/** One colour as the app shows it: a small rounded square, like the Genome Selector's
 *  row swatch. Anything that displays a chosen colour uses this, so they all match. */
export function ColorSwatch({ color, size = 18, className = '', title = '' }) {
    // The Selector's 18px swatch has a 6px radius. A fixed rounded-md would turn a small
    // swatch into a circle, so the radius keeps that proportion instead.
    const radius = Math.max(2, Math.round(size * (size >= 16 ? 1 / 3 : 1 / 4)))
    return (
        <span
            className={`inline-block shrink-0 border border-white/60 shadow-sm ${className}`}
            style={{ width: size, height: size, borderRadius: radius, backgroundColor: color }}
            title={title}
        />
    )
}

export default function GenomeColorPicker({
    isOpen,
    theme = 'dark',
    title = 'Genome colour',
    subtitle = '',
    palette,
    currentColor = '',
    defaultColor = DEFAULT_GENOME_COLOR,
    // What the colour is shown against. Defaults to the genome track it was
    // written for; anything else colouring something that is not a genome passes
    // its own, rather than previewing genes it does not have.
    renderPreview,
    paletteHint = 'A colour mixed here joins the palette when it is applied, ready for the next genome.',
    // What returning to the default means for the subject: "Automatic" for a track
    // whose default is whatever its file says.
    defaultLabel = 'Use default',
    onApply,
    onClose,
}) {
    const isLight = theme === 'light'
    const normalizedDefault = normalizeGenomeDefaultColor(defaultColor)
    // No current colour means the subject genomes disagree; the dialog opens on
    // the default rather than picking one of them arbitrarily.
    const opening = sanitizeHexColor(currentColor, normalizedDefault)
    const [selected, setSelected] = useState(opening)
    const [draftCustom, setDraftCustom] = useState(opening)
    const customInputRef = useRef(null)

    useEffect(() => {
        if (!isOpen) return
        setSelected(opening)
        setDraftCustom(opening)
    }, [isOpen, opening])

    const swatches = useMemo(
        () => (Array.isArray(palette) && palette.length ? palette : genomeColorPalette(null)),
        [palette]
    )

    if (!isOpen) return null

    const applySelected = () => {
        onApply?.(selected)
        onClose?.()
    }

    return (
        <div className="fixed inset-0 z-[230] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
            <div
                data-tour-id="genome-color-dialog"
                className={`w-full max-w-md rounded-xl border shadow-2xl ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}
            >
                <div className={`px-5 py-4 border-b flex items-start justify-between gap-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <div className="min-w-0">
                        <h3 className={`text-base font-bold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{title}</h3>
                        {subtitle ? (
                            <p className={`text-xs mt-1 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{subtitle}</p>
                        ) : null}
                    </div>
                    <button
                        data-tour-id="genome-color-close"
                        type="button"
                        onClick={onClose}
                        aria-label="Close the colour picker"
                        className={`p-2 rounded-lg transition-colors ${isLight ? 'text-gray-500 hover:bg-gray-100' : 'text-gray-400 hover:bg-gray-700'}`}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                    </button>
                </div>

                <div className="px-5 py-4 space-y-4">
                    {renderPreview ? renderPreview(selected) : <GenomeColorPreview color={selected} isLight={isLight} />}

                    <div>
                        <div className={`text-xs font-semibold uppercase tracking-wide mb-2 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Palette
                        </div>
                        <div data-tour-id="genome-color-palette" className="flex flex-wrap gap-2">
                            {swatches.map((swatch) => {
                                const isSelected = swatch === selected
                                return (
                                    <button
                                        key={swatch}
                                        data-tour-id={`genome-color-swatch-${swatch.slice(1)}`}
                                        type="button"
                                        onClick={() => {
                                            setSelected(swatch)
                                            setDraftCustom(swatch)
                                        }}
                                        aria-pressed={isSelected}
                                        title={swatch === normalizedDefault ? `${swatch} (default)` : swatch}
                                        className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-105 ${isSelected
                                            ? (isLight ? 'border-gray-900' : 'border-white')
                                            : (isLight ? 'border-white' : 'border-gray-800')
                                            }`}
                                        style={{ backgroundColor: swatch }}
                                    />
                                )
                            })}
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        {/* The native colour input is hidden behind a button: a bare
                            swatch input reads as another palette entry rather than as
                            the way to reach a colour that is not in the palette. */}
                        <input
                            ref={customInputRef}
                            type="color"
                            value={draftCustom}
                            onChange={(event) => {
                                const next = sanitizeHexColor(event.target.value, draftCustom)
                                setDraftCustom(next)
                                setSelected(next)
                            }}
                            className="sr-only"
                            tabIndex={-1}
                            aria-hidden="true"
                        />
                        <button
                            data-tour-id="genome-color-custom"
                            type="button"
                            onClick={() => customInputRef.current?.click()}
                            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${isLight
                                ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                                : 'bg-gray-800 text-gray-200 border-gray-600 hover:bg-gray-700'
                                }`}
                        >
                            <MixedColorSwatch size={16} />
                            Custom colour…
                        </button>
                        <span className={`text-xs font-mono ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {selected}
                            {selected === normalizedDefault ? ` · ${defaultLabel === 'Use default' ? 'default' : defaultLabel.toLowerCase()}` : ''}
                        </span>
                    </div>
                    <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        {paletteHint}
                    </p>
                </div>

                <div className={`px-5 py-4 border-t flex items-center justify-between gap-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <button
                        data-tour-id="genome-color-default"
                        type="button"
                        onClick={() => {
                            setSelected(normalizedDefault)
                            setDraftCustom(normalizedDefault)
                        }}
                        disabled={selected === normalizedDefault}
                        className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${selected === normalizedDefault
                            ? (isLight ? 'text-gray-300 cursor-not-allowed' : 'text-gray-600 cursor-not-allowed')
                            : (isLight ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-700')
                            }`}
                    >
                        {defaultLabel}
                    </button>
                    <div className="flex items-center gap-3">
                        <button
                            data-tour-id="genome-color-cancel"
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
                            data-tour-id="genome-color-apply"
                            type="button"
                            onClick={applySelected}
                            className={`px-4 py-2 rounded-lg text-sm font-semibold text-white ${isLight ? 'bg-[#0099ff] hover:bg-[#0088ee]' : 'bg-blue-600 hover:bg-blue-500'}`}
                        >
                            Apply
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
