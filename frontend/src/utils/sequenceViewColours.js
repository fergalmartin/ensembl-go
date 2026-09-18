// What colour each kind of annotation is drawn in, and the reader's changes to
// it.
//
// `sequenceViewPalette.js` says what the app paints by default and why, and it
// stays the source of those defaults; this is the layer over it that a reader
// can move. The two are kept apart because the defaults carry arguments -- why
// intergenic cannot borrow the intron's colour, why genic cannot borrow the
// exon blue -- and an override is just a preference.
//
// Grouped the way the view is read rather than by class code, because the class
// codes are an implementation detail of a row's 60-character class string and
// nobody picking a colour is thinking in them:
//
//   - a location and a gene are the same vocabulary at two scales, so they
//     share one list
//   - a transcript, an exon and an intron are the same vocabulary as each other,
//     so they share the other
//   - two kinds appear in both, and are listed once in their own group rather
//     than twice with the same value, which reads as a bug the moment a reader
//     changes one and watches the other move
//
// A reader's choice is stored against the *item* -- "CDS", "splice site" -- and
// resolved to class codes here. That is what lets one choice drive the two
// shades a CDS alternates between, and what keeps a stored preference readable
// when the codes behind an item change.

import { sanitizeHexColor } from '../genomeColorSchemes.js'
import { CDS_STRIPE_COLORS, hexLuminance, TEXT_FLIP_LUMINANCE } from './featureColors.js'
import { CLASS_CODES, CLASS_STYLE, OVERLAP_LINE, classStyle } from './sequenceViewPalette.js'

/** The extra lightness the odd codon's shade carries over the even one.
 *
 * The CDS alternates between two shades so that the reading frame is visible
 * without counting, and a reader choosing "CDS" is choosing one colour -- so the
 * second is derived rather than asked for. Deriving it also means the stripe
 * survives any colour, including one too light for a fixed pale partner. */
const CDS_TINT = 0.55

function channels(hex) {
    const clean = sanitizeHexColor(hex, '#000000').slice(1)
    return [0, 2, 4].map((at) => parseInt(clean.slice(at, at + 2), 16))
}

/** The ring on the base a box is open about, per theme.
 *
 * High contrast against the page rather than a hue of its own: it has to read
 * over a filled cell, an outlined one and a bare one, and it means "this one",
 * not another kind of annotation. That is why its default is a behaviour --
 * `auto`, resolved against the theme -- and not a colour. A reader who picks one
 * is trading that property for a colour of their own, which is their call.
 */
export const RING_THEME = Object.freeze({ light: '#0f172a', dark: '#f8fafc' })

/** The value a themed item holds while it is still following the theme. */
export const FOLLOW_THEME = 'auto'

/** A colour as the three channels a CSS `rgb()` with a variable alpha needs.
 *
 * The selection's wash and outline are drawn at alphas held in custom
 * properties, so neither can be a hex. */
export function rgbTriplet(hex) {
    return channels(hex).join(' ')
}

/** A colour mixed towards white (positive) or black (negative). */
export function shade(hex, amount) {
    const towards = amount >= 0 ? 255 : 0
    const mix = Math.min(1, Math.abs(Number(amount) || 0))
    const parts = channels(hex).map((value) => Math.round(value + (towards - value) * mix))
    return `#${parts.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The second shade of a CDS, given the first.
 *
 * The shipped pair is returned unchanged for the shipped colour, so switching
 * this on changes nothing about how the app looks by default -- a derived
 * partner that happened to differ from `CDS_STRIPE_COLORS[1]` would repaint
 * every coding base for no reason anybody asked for.
 *
 * Otherwise paler, which is the established look, unless the colour is already
 * so pale that a paler partner would be indistinguishable from it -- the one
 * thing the stripe exists to avoid.
 */
export function codonPartner(hex) {
    const clean = sanitizeHexColor(hex, CDS_STRIPE_COLORS[0])
    if (clean.toLowerCase() === CDS_STRIPE_COLORS[0].toLowerCase()) return CDS_STRIPE_COLORS[1]
    const [red, green, blue] = channels(clean)
    const light = (red * 0.299 + green * 0.587 + blue * 0.114) / 255
    return shade(clean, light > 0.75 ? -CDS_TINT * 0.6 : CDS_TINT)
}

/**
 * The ink a letter takes on a filled cell.
 *
 * Shared between the row on screen and anything exporting what that row looks
 * like: a base drawn in white on screen and in black in the file would be the
 * same annotation saying two different things about how readable it is. Cached,
 * because a row asks this per cell and the answers are drawn from a palette of
 * about fifteen colours.
 */
const TEXT_ON = new Map()
export function textOnColour(background) {
    if (!TEXT_ON.has(background)) {
        TEXT_ON.set(background, hexLuminance(background) > TEXT_FLIP_LUMINANCE ? '#0f172a' : '#ffffff')
    }
    return TEXT_ON.get(background)
}

/** Every colour a reader can change, in the order the menu lists them. */
export const COLOUR_SECTIONS = Object.freeze([
    {
        key: 'region',
        label: 'Region and gene',
        hint: 'A location is drawn in the classes a gene is, so the two share one set.',
        items: [
            { key: 'coding', label: 'Coding', codes: [CLASS_CODES.coding] },
            { key: 'utr', label: 'UTR', codes: [CLASS_CODES.utr] },
            { key: 'mixed', label: 'Mixed', codes: [CLASS_CODES.mixed], hint: 'Genes or isoforms disagree here.' },
            { key: 'intergenic', label: 'Intergenic', codes: [CLASS_CODES.intergenic], kind: 'outline' },
            { key: 'genic', label: 'Genic', codes: [CLASS_CODES.genic], hint: 'Too many genes to read every isoform.' },
            {
                key: 'overlap',
                label: 'Overlapping genes',
                // Not a class: a base under two genes is still coding or still
                // intronic. It is a rule under the row, over whatever the base
                // already wears.
                codes: [],
                kind: 'underline',
                hint: 'A rule under bases more than one gene covers.',
            },
        ],
    },
    {
        key: 'transcript',
        label: 'Transcript, exon and intron',
        hint: 'An exon or an intron is its transcript windowed, so all three read the same.',
        items: [
            { key: 'cds', label: 'CDS', codes: [CLASS_CODES.cds, CLASS_CODES.cds1], striped: true, hint: 'Alternating by codon, so the frame is visible.' },
            { key: 'utr5', label: "5′ UTR", codes: [CLASS_CODES.utr5] },
            { key: 'utr3', label: "3′ UTR", codes: [CLASS_CODES.utr3] },
            { key: 'splice', label: 'Splice site', codes: [CLASS_CODES.donor, CLASS_CODES.acceptor] },
            { key: 'start_codon', label: 'Start (ATG)', codes: [CLASS_CODES.start_codon] },
            { key: 'stop_codon', label: 'Stop', codes: [CLASS_CODES.stop_codon] },
            { key: 'softmask', label: 'Repeats', codes: [CLASS_CODES.softmask] },
        ],
    },
    {
        key: 'highlight',
        label: 'Highlighting',
        hint: 'Marks about what the reader is doing, rather than about the sequence.',
        items: [
            {
                key: 'selection',
                label: 'Selection',
                codes: [],
                kind: 'selection',
                defaultColour: '#f2c766',
                hint: 'The bases a drag has picked out.',
            },
            {
                key: 'base',
                label: 'Base',
                codes: [],
                kind: 'ring',
                themed: RING_THEME,
                defaultColour: FOLLOW_THEME,
                hint: 'The one base a box is open about.',
            },
        ],
    },
    {
        key: 'shared',
        label: 'Both',
        hint: 'Drawn the same at every level, so there is one colour for each.',
        items: [
            { key: 'noncoding', label: 'Non-coding', codes: [CLASS_CODES.noncoding], kind: 'outline' },
            { key: 'intron', label: 'Intronic', codes: [CLASS_CODES.intron] },
        ],
    },
])

export const COLOUR_ITEMS = Object.freeze(
    COLOUR_SECTIONS.flatMap((section) => section.items.map((item) => ({ ...item, section: section.key }))),
)

/** What the app paints without being asked, read out of the palette itself so
 * the two can never disagree about what "default" means. */
export const DEFAULT_COLOURS = Object.freeze(Object.fromEntries(
    COLOUR_ITEMS.map((item) => [
        item.key,
        // A class's default is the palette's own, so the two cannot drift. A
        // mark that is not a class -- the overlap rule, the selection, the ring
        // on a base -- carries its own, because there is no class to read it
        // from.
        item.defaultColour || (item.key === 'overlap'
            ? OVERLAP_LINE
            : (classStyle(item.codes[0])?.bg || OVERLAP_LINE)),
    ]),
))

// Every code an item covers, not just its first: a splice site is a donor and an
// acceptor, and colouring only one of them would be a menu that half works. The
// CDS's second shade is the one exception, and it is derived below rather than
// taking the item's colour outright.
const ITEM_OF_CODE = new Map()
for (const item of COLOUR_ITEMS) {
    for (const code of item.codes) ITEM_OF_CODE.set(code, item.key)
}

/** A stored set of colours, read against the defaults as they are now. */
export function normaliseColours(stored) {
    const out = {}
    for (const item of COLOUR_ITEMS) {
        const fallback = DEFAULT_COLOURS[item.key]
        const held = stored?.[item.key]
        if (typeof held !== 'string') { out[item.key] = fallback; continue }
        // A themed item may be following the theme instead of holding a colour,
        // and that is a value like any other -- it is what it ships as.
        out[item.key] = (item.themed && held === FOLLOW_THEME)
            ? FOLLOW_THEME
            : sanitizeHexColor(held, fallback)
    }
    return out
}

/** Whether anything has been moved off its default. */
export function coloursChanged(colours) {
    return COLOUR_ITEMS.some((item) => colours?.[item.key]
        && colours[item.key].toLowerCase() !== DEFAULT_COLOURS[item.key].toLowerCase())
}

/**
 * How every class is drawn, with the reader's colours in place.
 *
 * One object built per set of colours and handed down, rather than a function
 * every caller imports: a row is memoised on what it is given, so the palette
 * has to keep its identity while the colours do. The same reason the empty
 * overlap list is frozen.
 */
export function buildPalette(colours) {
    const chosen = normaliseColours(colours)
    const styles = {}
    for (const [code, base] of Object.entries(CLASS_STYLE)) {
        const key = ITEM_OF_CODE.get(code)
        styles[code] = key ? { ...base, bg: chosen[key] } : { ...base }
    }
    // The odd codon follows the even one, so a reader who picks a CDS colour
    // gets a stripe in it rather than their colour beside the old pale blue.
    if (styles[CLASS_CODES.cds1]) {
        styles[CLASS_CODES.cds1] = {
            ...styles[CLASS_CODES.cds1],
            bg: codonPartner(chosen.cds),
        }
    }
    const selectionRgb = rgbTriplet(chosen.selection)
    return {
        colours: chosen,
        overlap: chosen.overlap,
        style: (code) => styles[code] || null,
        /**
         * The wash over selected cells, and the line around the whole of them.
         *
         * Both are `rgb()` with a variable alpha rather than a hex: the weight
         * each is drawn at belongs to the view -- heavy enough to find, light
         * enough to read the bases through -- while the colour belongs to the
         * reader. The alphas are registered custom properties, set once in
         * index.css.
         *
         * One colour behind both. The pair that shipped differed by five units
         * of red and three of blue, which nothing can see and nothing explained.
         */
        selection: {
            edge: `rgb(${selectionRgb} / var(--sequence-select-edge-alpha, 1))`,
            wash: `rgb(${selectionRgb} / var(--sequence-select-alpha, 0.3))`,
            colour: chosen.selection,
        },
        /** The ring on the base a box is open about, resolved against the theme
         * while it is still following it. */
        ring: (isLight) => (chosen.base === FOLLOW_THEME
            ? RING_THEME[isLight ? 'light' : 'dark']
            : chosen.base),
        /** What an item looks like in a swatch: its colour, and the second shade
         * where there is one. */
        swatch: (key) => (key === 'cds'
            ? { bg: chosen.cds, second: codonPartner(chosen.cds) }
            : { bg: chosen[key] || DEFAULT_COLOURS[key] }),
    }
}

/** The palette as it ships, for anything drawing before a reader's choices are
 * known. */
export const DEFAULT_PALETTE = buildPalette(DEFAULT_COLOURS)

/**
 * Items in the same section wearing the same colour.
 *
 * Not forbidden -- it is the reader's screen -- but worth saying, because two
 * annotations drawn the same way cannot be told apart whatever the legend
 * claims. That rule is the palette's own, and a test holds the defaults to it.
 */
export function collisionsIn(sectionKey, colours) {
    const section = COLOUR_SECTIONS.find((item) => item.key === sectionKey)
    if (!section) return new Map()
    const look = (item) => `${item.kind || 'fill'}:${String(colours[item.key] || '').toLowerCase()}`
    const isDefault = (item) => String(colours[item.key] || '').toLowerCase()
        === DEFAULT_COLOURS[item.key].toLowerCase()
    const seen = new Map()
    const clashes = new Map()
    for (const item of section.items) {
        const key = look(item)
        const first = seen.get(key)
        // A pair that ships identical -- 5' and 3' UTR are one purple -- is not
        // news. It becomes worth saying once a reader has moved one of them,
        // because from then on it is their doing and probably not their intent.
        if (first && !(isDefault(item) && isDefault(first.item))) {
            clashes.set(item.key, first.item.label)
        } else if (!first) seen.set(key, { item })
    }
    return clashes
}

/**
 * The colour a highlight group is drawn in, through a palette.
 *
 * The groups belong to `sequenceViewPalette.js`, which is where what a level can
 * show is decided; their `swatch` is the shipped colour. This answers the same
 * question against a reader's palette, so the legend and the switches show what
 * is actually on screen rather than what shipped.
 */
export function groupColour(group, palette) {
    if (!group) return null
    // A group with no classes is not a colour of base: the overlap rule is the
    // only one, and it lives beside the classes rather than among them.
    if (!group.classes?.length) return palette.overlap
    return palette.style(group.classes[0])?.bg || group.swatch
}

/** The two-tone sample a striped group shows, or null where there is one tone. */
export function groupGradient(group, palette) {
    if (!group?.gradient) return null
    const first = palette.style(group.classes[0])?.bg
    const second = palette.style(group.classes[1])?.bg
    return first && second ? `linear-gradient(90deg, ${first} 50%, ${second} 50%)` : group.gradient
}
