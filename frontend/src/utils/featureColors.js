// The app's feature palette, in one place.
//
// Lifted out of FeatureLegend.jsx so that plain modules — and the node --test
// suite, which cannot parse JSX — can read it without pulling in a React
// component. FeatureLegend re-exports it, so every existing importer is
// unaffected.
//
// Several keys share a colour on purpose: donor and acceptor are both "splice
// site" to a reader, and a merged UTR reads better than two near-identical
// purples. The aliases are kept because different parts of the backend name the
// same thing differently.

export const FEATURE_COLORS = {
    genomic: { bg: '#60a5fa', label: 'Genomic' },
    exon: { bg: '#60a5fa', label: 'Exon' },
    cds: { bg: '#60a5fa', label: 'CDS' },
    utr: { bg: '#c4b5fd', label: 'UTR' },          // Merged 5'/3' UTR
    utr5: { bg: '#c4b5fd', label: 'UTR' },         // Keep for backward compat
    utr3: { bg: '#c4b5fd', label: 'UTR' },         // Keep for backward compat
    intron: { bg: '#4a5568', label: 'Intronic' },
    // Shares the intron's colour because the alignment views draw both as
    // "not in an exon" and nothing there tells them apart. Its label was
    // "Intronic", which is simply wrong: intergenic is outside every gene and
    // intronic is inside one. The sequence view needs the distinction and
    // carries its own colour for it -- see utils/sequenceViewPalette.js.
    intergenic: { bg: '#4a5568', label: 'Intergenic' },
    splice: { bg: '#ed8936', label: 'Splice site' },  // Merged donor/acceptor
    splice_site: { bg: '#ed8936', label: 'Splice site' },  // Alias for projection
    donor: { bg: '#ed8936', label: 'Splice site' },   // Keep for backward compat
    acceptor: { bg: '#ed8936', label: 'Splice site' },
    start_codon: { bg: '#0d9488', label: 'Start (ATG)' },
    stop_codon: { bg: '#c026d3', label: 'Stop' },
}

// The two shades a CDS alternates between, one per codon, so that reading frame
// is visible without counting. Index by codon parity.
export const CDS_STRIPE_COLORS = ['#60a5fa', '#bfdbfe']

// Unique legend items for display (removes duplicates)
export const LEGEND_ITEMS = [
    { key: 'genomic', bg: '#60a5fa', outlineOnly: true, label: 'Genomic' },
    { key: 'exon', bg: '#60a5fa', label: 'Exon' },
    { key: 'cds', bg: '#60a5fa', gradient: 'linear-gradient(90deg, #60a5fa 50%, #bfdbfe 50%)', label: 'CDS' },
    { key: 'utr', bg: '#c4b5fd', label: 'UTR' },
    { key: 'intron', bg: '#4a5568', label: 'Intronic' },
    { key: 'splice', bg: '#ed8936', label: 'Splice site' },
    { key: 'start_codon', bg: '#0d9488', label: 'Start (ATG)' },
    { key: 'stop_codon', bg: '#c026d3', label: 'Stop' },
]

/**
 * Relative luminance, for deciding whether a base's letter is dark or light.
 *
 * The threshold matters more than it looks: #60a5fa, the commonest background
 * in this palette, sits at 0.614, so a threshold either side of that flips the
 * letter colour on most of the screen. 0.64 puts white on it, which is what the
 * Feature Explorer has always drawn.
 */
export function hexLuminance(hex) {
    const value = String(hex || '').replace('#', '')
    if (value.length !== 6) return 0
    const r = parseInt(value.slice(0, 2), 16) / 255
    const g = parseInt(value.slice(2, 4), 16) / 255
    const b = parseInt(value.slice(4, 6), 16) / 255
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export const TEXT_FLIP_LUMINANCE = 0.64
