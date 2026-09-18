// What each per-base class looks like, and which classes a focus level can show.
//
// A class is carried through the view as a single character, because a row's
// classes travel as a 60-character string beside its 60-character sequence.
// That makes a row's identity an O(1) string compare, which is what lets the
// scroller re-render one row instead of the whole slab.
//
// Colours come from utils/featureColors.js — the same palette the Alignment view
// and the Feature Explorer paint with — so a reader who has learned one view can
// read this one.

import { FEATURE_COLORS, CDS_STRIPE_COLORS } from './featureColors.js'

export const CLASS_NONE = '.'

// The cells of a collapsed stretch's marker. Not a class of base -- there is no
// base under it -- but it travels in the same 60-character string, so it needs a
// code of its own that nothing can mistake for annotation.
export const CLASS_GAP = '~'

export const CLASS_CODES = Object.freeze({
    // Location level
    genic: 'g',
    intergenic: 'n',
    // Gene level, where a base is described by every isoform at once
    coding: 'o',
    noncoding: 'x',
    utr: 'u',
    mixed: 'm',
    // Transcript and feature level
    cds: 'c',        // even codon
    cds1: 'C',       // odd codon — the alternating shade
    utr5: '5',
    utr3: '3',
    intron: 'i',
    donor: 'd',
    acceptor: 'a',
    start_codon: 'S',
    stop_codon: 'T',
    // Available at every level, off by default
    softmask: 'r',
})

// Filled or outlined is the first thing a reader sees, before any hue: a filled
// cell is the feature itself, an outlined one is sequence of that broad kind
// that is not the feature. That is what separates coding from non-coding, and
// genic from intergenic, and it is the same outline the Feature Explorer draws
// its read-only "Genomic" row with.
//
// Hue alone could not do it. Non-coding is exon, so it belongs in the exon blue;
// a lighter shade of the same blue beside a solid CDS is a difference nobody
// reliably sees. Intergenic had a worse version of the same problem -- it was
// borrowing the intron's exact colour from the shared palette, so the two read
// as one thing when they are opposites: intergenic is outside every gene,
// intronic is inside one.
const NONCODING_LINE = FEATURE_COLORS.exon.bg
const INTERGENIC_LINE = '#64748b'
// The rule drawn under bases more than one gene covers. Amber because it marks
// where the annotation itself is layered rather than what a base is, which is
// the same thing the gene-boundary marks say.
export const OVERLAP_LINE = '#f59e0b'
// "A gene is here, and its isoforms were not read" -- the coarse answer a region
// too dense to draw in detail falls back to. Once it shared the exon blue, on
// the grounds that genic is coding seen from further away. It cannot any more:
// a location is now drawn in the gene classes, so a tile that fell back can sit
// beside one that did not, and the two blues would say the same thing about
// bases that are not the same at all.
const GENIC_COARSE = '#7f9cc0'
// Not a feature at all but a disagreement -- between the isoforms of a gene, or
// between the genes lying on one base -- so it deliberately
// leaves the palette's blue/purple/slate vocabulary rather than looking like a
// weaker version of one of them.
const MIXED_BG = '#f472b6'
const SOFTMASK_BG = '#475569'

export const CLASS_STYLE = Object.freeze({
    [CLASS_CODES.genic]: { bg: GENIC_COARSE, label: 'Genic' },
    [CLASS_CODES.intergenic]: { bg: INTERGENIC_LINE, label: 'Intergenic', outline: true },

    [CLASS_CODES.coding]: { bg: FEATURE_COLORS.cds.bg, label: 'Coding' },
    [CLASS_CODES.noncoding]: { bg: NONCODING_LINE, label: 'Non-coding', outline: true },
    [CLASS_CODES.utr]: { bg: FEATURE_COLORS.utr.bg, label: 'UTR' },
    [CLASS_CODES.mixed]: { bg: MIXED_BG, label: 'Mixed' },

    [CLASS_CODES.cds]: { bg: CDS_STRIPE_COLORS[0], label: 'CDS' },
    [CLASS_CODES.cds1]: { bg: CDS_STRIPE_COLORS[1], label: 'CDS' },
    [CLASS_CODES.utr5]: { bg: FEATURE_COLORS.utr5.bg, label: "5' UTR" },
    [CLASS_CODES.utr3]: { bg: FEATURE_COLORS.utr3.bg, label: "3' UTR" },
    [CLASS_CODES.intron]: { bg: FEATURE_COLORS.intron.bg, label: 'Intronic' },
    [CLASS_CODES.donor]: { bg: FEATURE_COLORS.donor.bg, label: 'Splice donor' },
    [CLASS_CODES.acceptor]: { bg: FEATURE_COLORS.acceptor.bg, label: 'Splice acceptor' },
    [CLASS_CODES.start_codon]: { bg: FEATURE_COLORS.start_codon.bg, label: 'Start (ATG)' },
    [CLASS_CODES.stop_codon]: { bg: FEATURE_COLORS.stop_codon.bg, label: 'Stop' },

    [CLASS_CODES.softmask]: { bg: SOFTMASK_BG, label: 'Repeat (soft-masked)' },
})

/**
 * The classes a focus level can produce, grouped the way the reader toggles
 * them. One checkbox can cover several classes — nobody wants to turn off
 * donors and acceptors separately, or even shade of a CDS codon.
 */
const LEVEL_GROUP_TABLE = {
    // A location shows what a gene shows, so that reading a region and reading a
    // gene teach the same thing and moving between them changes the window
    // rather than the vocabulary. Genic is the coarse answer, kept for the
    // regions too dense to read isoform by isoform.
    location: [
        { key: 'coding', label: 'Coding', classes: [CLASS_CODES.coding], swatch: FEATURE_COLORS.cds.bg },
        { key: 'utr', label: 'UTR', classes: [CLASS_CODES.utr], swatch: FEATURE_COLORS.utr.bg },
        { key: 'noncoding', label: 'Non-coding', classes: [CLASS_CODES.noncoding], swatch: NONCODING_LINE, outlineOnly: true },
        { key: 'intron', label: 'Intronic', classes: [CLASS_CODES.intron], swatch: FEATURE_COLORS.intron.bg },
        {
            key: 'mixed',
            label: 'Mixed',
            classes: [CLASS_CODES.mixed],
            swatch: MIXED_BG,
            hint: 'Genes or isoforms that cover this base disagree about it.',
        },
        { key: 'intergenic', label: 'Intergenic', classes: [CLASS_CODES.intergenic], swatch: INTERGENIC_LINE, outlineOnly: true },
        {
            key: 'overlap',
            label: 'Overlapping genes',
            // Not a class of base: a base under two genes is still coding or
            // still intronic. It is a rule under the row, drawn over whatever
            // colour the base already has.
            classes: [],
            swatch: OVERLAP_LINE,
            underline: true,
            hint: 'More than one gene covers these bases.',
        },
        {
            key: 'genic',
            label: 'Genic',
            classes: [CLASS_CODES.genic],
            swatch: GENIC_COARSE,
            hint: 'Where there are too many genes to read every isoform.',
        },
    ],
    gene: [
        { key: 'coding', label: 'Coding', classes: [CLASS_CODES.coding], swatch: FEATURE_COLORS.cds.bg },
        { key: 'utr', label: 'UTR', classes: [CLASS_CODES.utr], swatch: FEATURE_COLORS.utr.bg },
        { key: 'noncoding', label: 'Non-coding', classes: [CLASS_CODES.noncoding], swatch: NONCODING_LINE, outlineOnly: true },
        { key: 'intron', label: 'Intronic', classes: [CLASS_CODES.intron], swatch: FEATURE_COLORS.intron.bg },
        {
            key: 'mixed',
            label: 'Mixed',
            classes: [CLASS_CODES.mixed],
            swatch: MIXED_BG,
            hint: 'Isoforms that cover this base disagree about it.',
        },
    ],
    transcript: [
        {
            key: 'cds',
            label: 'CDS',
            classes: [CLASS_CODES.cds, CLASS_CODES.cds1],
            swatch: CDS_STRIPE_COLORS[0],
            gradient: `linear-gradient(90deg, ${CDS_STRIPE_COLORS[0]} 50%, ${CDS_STRIPE_COLORS[1]} 50%)`,
        },
        { key: 'utr', label: 'UTR', classes: [CLASS_CODES.utr5, CLASS_CODES.utr3], swatch: FEATURE_COLORS.utr.bg },
        // An exon that is neither translated nor untranslated region: the whole
        // of a lncRNA, and the reason a non-coding transcript is not blank here.
        { key: 'noncoding', label: 'Non-coding', classes: [CLASS_CODES.noncoding], swatch: NONCODING_LINE, outlineOnly: true },
        { key: 'intron', label: 'Intronic', classes: [CLASS_CODES.intron], swatch: FEATURE_COLORS.intron.bg },
        { key: 'splice', label: 'Splice site', classes: [CLASS_CODES.donor, CLASS_CODES.acceptor], swatch: FEATURE_COLORS.splice.bg },
        { key: 'start_codon', label: 'Start (ATG)', classes: [CLASS_CODES.start_codon], swatch: FEATURE_COLORS.start_codon.bg },
        { key: 'stop_codon', label: 'Stop', classes: [CLASS_CODES.stop_codon], swatch: FEATURE_COLORS.stop_codon.bg },
        { key: 'softmask', label: 'Repeats', classes: [CLASS_CODES.softmask], swatch: SOFTMASK_BG },
    ],
}

// A focus on one exon or intron, and an ad-hoc selection, describe their bases
// exactly as a transcript does — only the window differs — so they share its
// toggles rather than owning a second, identical list.
LEVEL_GROUP_TABLE.feature = LEVEL_GROUP_TABLE.transcript
LEVEL_GROUP_TABLE.custom = LEVEL_GROUP_TABLE.transcript

export const LEVEL_GROUPS = Object.freeze(LEVEL_GROUP_TABLE)

export const LEVELS = Object.freeze(['location', 'gene', 'transcript', 'feature', 'custom'])

/** The default highlight switches for a level: everything but repeats. */
export function defaultHighlights(level) {
    const groups = LEVEL_GROUPS[level] || []
    const out = {}
    for (const group of groups) out[group.key] = group.key !== 'softmask'
    return out
}

/** Every class a level draws, keyed by code, for resolving a toggle to codes. */
export function classesForLevel(level) {
    const groups = LEVEL_GROUPS[level] || []
    const out = new Map()
    for (const group of groups) {
        for (const code of group.classes) out.set(code, group.key)
    }
    return out
}

export function classStyle(code) {
    return CLASS_STYLE[code] || null
}
