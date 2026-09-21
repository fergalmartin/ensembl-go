// Reading the sequence as text, for readers who would rather have the browser's
// own cursor than the view's.
//
// The interactive display is sixty elements a row carrying a colour, an outline,
// a rule, a mask and a hover target apiece. That is what a per-base view costs,
// and it is what buys clicking a base to ask about it. It also means the
// sequence is not *text*: a drag draws the view's own selection rather than the
// browser's, `Ctrl-C` has nothing selected to copy, and `Ctrl-F` finds nothing
// because no run of bases exists as a string in the document.
//
// The plain displays give that back. The rows are the same rows -- same
// document, same layout, same collapse, same reading direction -- written into
// one `<pre>` as lines, so everything the browser does with text works on them
// and nothing new has to be invented for selecting, copying or finding.
//
// Two of them, because a reader wanting text wants one of two different things:
//
//   * **Plain text** is the view written out: coordinates down both margins,
//     markers where sequence is collapsed. What you see is what you copy.
//   * **Plain FASTA** is what you paste into something else: a header line and
//     bases, nothing in the margins and no markers among the letters.
//
// Colouring survives both, as the letters' own ink rather than as a fill behind
// them -- a background per base would be the interactive view again, in a mode
// whose whole point is that it is not that.

import { CLASS_GAP, CLASS_NONE } from './sequenceViewPalette.js'
import { FIND_NONE } from './sequenceViewPaint.js'
import { BASES_PER_ROW } from './sequenceViewRows.js'

/** The view as it has always been: a cell per base, and a question behind each. */
export const DISPLAY_RICH = 'rich'

/** The rows as text, coordinates and all. */
export const DISPLAY_TEXT = 'text'

/** The bases as text, under a FASTA header. */
export const DISPLAY_FASTA = 'fasta'

export const DISPLAY_MODES = Object.freeze([
    {
        id: DISPLAY_RICH,
        label: 'Interactive',
        short: 'Interactive',
        hint: 'A cell per base: click one to ask about it, drag the Select tool '
            + 'across a stretch, and see the protein, the marks and the highlights.',
    },
    {
        id: DISPLAY_TEXT,
        label: 'Plain text',
        short: 'Plain text',
        hint: 'The rows as text, coordinates down both margins. Select with the '
            + 'browser’s own cursor, copy with Ctrl-C, find with Ctrl-F.',
    },
    {
        id: DISPLAY_FASTA,
        label: 'Plain FASTA',
        short: 'FASTA',
        hint: 'A header line and sixty bases a row, with nothing in the margins — '
            + 'ready to paste into anything that reads FASTA.',
    },
])

export function isDisplayMode(id) {
    return DISPLAY_MODES.some((mode) => mode.id === id)
}

export function displayMode(id) {
    return DISPLAY_MODES.find((mode) => mode.id === id) || DISPLAY_MODES[0]
}

export function displayModeLabel(id) {
    return displayMode(id).label
}

/** Whether a display is one of the two written as text. */
export function isPlainDisplay(id) {
    return id === DISPLAY_TEXT || id === DISPLAY_FASTA
}

/** Whether a display prints coordinates beside the bases. */
export function displayHasGutters(id) {
    return id === DISPLAY_TEXT
}

/**
 * Whether a display drops the markers standing in for collapsed sequence.
 *
 * FASTA is a format, and a run of dashes among the letters is not sequence. A
 * collapsed row therefore comes out short in that display, which is the honest
 * shape: the bases either side of a collapse really are not adjacent, and a row
 * padded back to sixty would say they were. Plain text keeps its markers,
 * because it is the view written down and the view draws them.
 */
export function displayDropsGaps(id) {
    return id === DISPLAY_FASTA
}

/**
 * Wide enough for the longest coordinate a gutter has to print.
 *
 * Nine figures with thousands separators -- `999,999,999` -- which is every
 * chromosome anyone reads here. Fixed rather than measured per screen, because
 * the column has to stand still while the reader scrolls: a gutter that grew a
 * character at a coordinate boundary would shift every base on the row.
 */
export const GUTTER_CHARS = 11

/**
 * A coordinate as it is printed in a margin, or blank space where there is none.
 *
 * Nothing is not zero: `Number(null)` is 0 and so is `Number('')`, and either
 * would print a row of the first chromosome's first base against sequence that
 * has no coordinate at all.
 */
export function gutterText(coord, width = GUTTER_CHARS) {
    const size = Math.max(0, Math.floor(Number(width) || 0))
    const value = coord === null || coord === undefined || coord === '' ? NaN : Number(coord)
    const text = Number.isFinite(value) ? value.toLocaleString('en-US') : ''
    return text.length >= size ? text : text.padStart(size, ' ')
}

/**
 * One row's characters, grouped into the fewest runs that can be drawn.
 *
 * A run is a stretch of neighbouring cells that will be drawn the same way,
 * which is what a span has to be drawn for. Sixty spans a row is what the
 * interactive display costs and what this one exists not to cost: a screen of
 * intronic sequence is one run, and even busy sequence is a handful.
 *
 * Two things decide how a cell is drawn and either can break a run: the
 * annotation class it wears, and whether one of the reader's Find patterns
 * matched it. Both, rather than whichever is in play -- a row with a match on
 * it must not lose its annotation colours everywhere else, and a match must not
 * be cut in half because the annotation changed underneath it.
 *
 * With `colour` off the class stops breaking runs, so a row with no matches on
 * it is one run. With `dropGaps` on the marker cells are left out before the
 * grouping, so the sequence either side of a collapse is one run rather than
 * two with nothing between.
 */
export function plainRuns(sequence, classes = '', {
    colour = true,
    dropGaps = false,
    finds = '',
} = {}) {
    const text = String(sequence ?? '')
    const codes = String(classes ?? '')
    const found = String(finds ?? '')
    if (!text) return []

    const runs = []
    let open = null
    for (let i = 0; i < text.length; i += 1) {
        const code = codes[i] || CLASS_NONE
        if (dropGaps && code === CLASS_GAP) continue
        // Uncoloured, every cell wears the same class, so only a match can
        // break a run -- without the grouping having to be told twice.
        const key = colour ? code : CLASS_NONE
        const lane = found ? (found[i] || FIND_NONE) : FIND_NONE
        if (open && open.code === key && open.lane === lane) open.text += text[i]
        else {
            open = { code: key, lane, text: text[i] }
            runs.push(open)
        }
    }
    return runs
}

/** The characters of a row as they will appear, which is what a copy will give. */
export function plainRowText(sequence, classes = '', { dropGaps = false } = {}) {
    return plainRuns(sequence, classes, { colour: false, dropGaps })
        .map((run) => run.text)
        .join('')
}

/**
 * A whole line of the plain display, gutters and all.
 *
 * The one place the line is written down, so that what is drawn and what is
 * copied cannot come apart: the component renders these very strings, split
 * into runs only where a colour changes.
 */
export function plainLineText(row, { display = DISPLAY_TEXT, gutter = GUTTER_CHARS } = {}) {
    const bases = plainRowText(row?.sequence, row?.classes, { dropGaps: displayDropsGaps(display) })
    if (!displayHasGutters(display)) return bases
    const left = gutterText(row?.firstCoord, gutter)
    const right = gutterText(row?.lastCoord, gutter)
    return `${left}  ${bases}  ${right}`
}

/**
 * How wide a line of a plain display is, in characters.
 *
 * The line is a fixed number of characters rather than a fixed number of pixels,
 * which is the difference between this display and the interactive one: there a
 * cell is stretched to whatever width makes sixty of them fill the panel, here a
 * character is a character and the line is as wide as the font draws it. Sizing
 * is done in `ch` units for the same reason -- one `ch` is the advance of a
 * digit in whatever font actually rendered, so the block is exactly as wide as
 * its own text even if the webfont never arrived.
 */
export function plainLineChars(display) {
    // Both margins, and the two spaces that hold each of them off the bases.
    return BASES_PER_ROW + (displayHasGutters(display) ? (GUTTER_CHARS + 2) * 2 : 0)
}

// A monospace advance, as a share of the type size. Every font in the mono stack
// -- IBM Plex Mono, Liberation Mono, Courier -- draws at 0.6em, and this is only
// ever used to *choose* a size: the width itself is set in `ch`, which is
// measured rather than assumed.
export const PLAIN_CHAR_RATIO = 0.6

// A line of text is read at a reading size. The interactive display stretches
// its cells to fill the panel because each one is a target to be clicked; there
// is nothing to click here, and sequence set in twenty-two point would be a
// wallchart. The floor is the same one the cells have, for the same reason: a
// panel too narrow for legible type is better overflowed than made unreadable.
export const PLAIN_FONT_MIN = 9
export const PLAIN_FONT_MAX = 15

/**
 * How wide a plain block comes out, in pixels.
 *
 * For the boxes around the text rather than for the text itself, which is sized
 * in `ch` and so is exact whatever font arrived. These have to be a number --
 * the scroller's spacer and slab are positioned in pixels, and a slab wider than
 * its contents is a horizontal scrollbar under sequence that fits. A few pixels
 * either way only moves the block within a box it is centred in anyway.
 */
export function plainBlockWidth(chars, fontSize) {
    const count = Math.max(0, Math.floor(Number(chars) || 0))
    const size = Math.max(0, Number(fontSize) || 0)
    return Math.ceil(count * PLAIN_CHAR_RATIO * size)
}

/** What size to set a plain display's text at, in the width available to it. */
export function plainFontSize(available, chars) {
    const width = Math.max(0, Number(available) || 0)
    const count = Math.max(1, Math.floor(Number(chars) || 0))
    const fitted = Math.floor(width / (count * PLAIN_CHAR_RATIO))
    return Math.min(PLAIN_FONT_MAX, Math.max(PLAIN_FONT_MIN, fitted))
}

// What the sequence is written on, and how far from it a letter has to be.
//
// The palette is a set of *backgrounds*, chosen to be told apart behind a letter
// of the opposite weight. The intron's slate and the repeat's are both nearly
// the colour of a dark page: as a fill with a white letter on it that is a
// perfectly good colour, and as the letter itself it is sequence nobody can
// read. So a palette colour is only used as ink where it clears the contrast a
// letter needs against the page, and is walked towards white or black until it
// does. The hue survives, which is the point -- a coding base is the same blue
// it is in the interactive display and in the legend under both.
//
// The ratio is the one WCAG asks of body text, measured properly: the naive
// luminance the palette flips its letter colour on is a weighted average of the
// raw channels, which is close enough for choosing between black and white on a
// known fill and not close enough to decide whether a colour can be read.
export const PLAIN_PAGE_DARK = '#111827'
export const PLAIN_PAGE_LIGHT = '#ffffff'
export const PLAIN_INK_CONTRAST = 4.5
const INK_STEP = 0.04

function channelLuminance(value) {
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** A colour's relative luminance, as the contrast standard defines it. */
export function relativeLuminance(hex) {
    const parts = channels(hex)
    if (!parts) return null
    const [r, g, b] = parts.map((part) => channelLuminance(part / 255))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** How far apart two colours are to read, from 1 (the same) to 21 (black on white). */
export function contrastRatio(a, b) {
    const first = relativeLuminance(a)
    const second = relativeLuminance(b)
    if (first === null || second === null) return null
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function channels(hex) {
    const value = String(hex || '').trim().replace('#', '')
    if (!/^[0-9a-fA-F]{6}$/.test(value)) return null
    return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
    ]
}

function toHex(parts) {
    return `#${parts.map((part) => Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, '0')).join('')}`
}

/** A colour moved `amount` of the way towards another. */
export function mixHex(hex, towards, amount) {
    const from = channels(hex)
    const to = channels(towards)
    if (!from || !to) return null
    const at = Math.min(1, Math.max(0, Number(amount) || 0))
    return toHex(from.map((part, i) => part + (to[i] - part) * at))
}

/**
 * A palette colour as ink a reader can actually read on this theme.
 *
 * Returns the colour itself where it already clears the threshold, so most of
 * the palette -- the exon blue, the UTR violet, the splice orange -- is printed
 * exactly as it is drawn elsewhere.
 */
export function plainInk(hex, isLight = false) {
    const colour = channels(hex) ? `#${String(hex).replace('#', '').toLowerCase()}` : null
    if (!colour) return null
    const page = isLight ? PLAIN_PAGE_LIGHT : PLAIN_PAGE_DARK
    const towards = isLight ? '#000000' : '#ffffff'
    const clears = (value) => (contrastRatio(value, page) ?? 0) >= PLAIN_INK_CONTRAST
    if (clears(colour)) return colour
    // In small steps, so a colour that needs a little help is given a little
    // rather than being thrown all the way to the end of the scale.
    for (let amount = INK_STEP; amount < 1; amount += INK_STEP) {
        const mixed = mixHex(colour, towards, amount)
        if (mixed && clears(mixed)) return mixed
    }
    return towards
}

/**
 * The line a FASTA record is headed by.
 *
 * One writer for the whole app: the download's files, the FASTA display and
 * anything else that has to name a stretch of sequence say it in the same words,
 * because a reader who copies from the screen and downloads the same region
 * should not get two different headers for one thing.
 */
export function fastaHeaderLine({
    name = '',
    chrom = '',
    start = null,
    end = null,
    strand = '+',
    hidden = 0,
} = {}) {
    const label = String(name || chrom || '').trim()
    const sign = strand === '-' ? '(-)' : '(+)'
    const from = Number(start)
    const to = Number(end)
    const where = Number.isFinite(from) && Number.isFinite(to)
        ? ` ${chrom}:${from}-${to}${sign}`
        : ''
    const spliced = Number(hidden) > 0 ? ` spliced -${Math.round(Number(hidden))}bp` : ''
    return `>${label}${where}${spliced}`
}

/**
 * The header line for one of the document's records, in the plain displays.
 *
 * The chromosome comes from the view rather than from the layout: a layout's
 * region is a pair of coordinates, and which chromosome they are on is the same
 * answer for every record on the screen.
 *
 * The range is the layout's rather than the record's, because the layout is what
 * is drawn -- a record read with flanking sequence around it covers more than
 * the feature it is named for, and the header names what is under it.
 */
export function sectionHeaderLine(section, chrom = '', unnamed = '') {
    const record = section?.record || null
    const region = section?.layout?.region || null
    const where = record?.chrom || chrom
    return fastaHeaderLine({
        // A plain region is a document of one record with no name of its own.
        // What the reader is looking at still has one -- the gene or transcript
        // they came here by -- and it is the name the same stretch is downloaded
        // under, so the header says it rather than falling straight through to
        // the chromosome.
        name: record?.label || unnamed || where,
        chrom: where,
        start: region?.start ?? record?.start,
        end: region?.end ?? record?.end,
        strand: record?.strand || '+',
        hidden: section?.layout?.hidden || 0,
    })
}
