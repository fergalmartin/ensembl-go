// The sequence view as rich text.
//
// RTF because it is the one coloured format every word processor opens without
// argument -- Word, Pages, LibreOffice, TextEdit -- and because a reader taking
// a coloured exon into a manuscript or a slide wants to keep editing it, not
// paste a picture of it.
//
// What makes a base look the way it does on screen is a fill behind it and an
// ink on it, so that is what this writes: `\chshdng0\chcbpatN` for the cell and
// `\cfN` for the letter. Character shading rather than a table, because sixty
// cells a row over thousands of rows is a table no word processor will lay out
// in reasonable time -- and a run of same-coloured bases collapses to one
// control sequence followed by its letters, which is what keeps the file to a
// size a document can hold.
//
// Everything arrives already decided, as the row model `sequenceViewExport`
// builds from the view's own painter. Nothing here chooses a colour.

/** RTF's own escapes, plus the non-ASCII characters a marker can carry. */
function escapeRtf(text) {
    let out = ''
    for (const character of String(text || '')) {
        if (character === '\\' || character === '{' || character === '}') {
            out += `\\${character}`
            continue
        }
        // RTF has a control symbol of its own for a non-breaking space, and it
        // is worth using over the general Unicode escape: `\\~` is understood
        // by everything, is two bytes rather than seven, and -- being a control
        // *symbol* -- does not swallow the space after it the way a control
        // word does. The gutters are made of these, so it is most of what a
        // padded coordinate costs.
        if (character === '\u00a0') {
            out += '\\~'
            continue
        }
        const code = character.codePointAt(0)
        if (code < 128) {
            out += character
            continue
        }
        // Signed 16-bit, which is what \\u takes, with a plain-ASCII stand-in
        // after it for readers that cannot show the real character.
        const signed = code > 32767 ? code - 65536 : code
        out += `\\u${signed}?`
    }
    return out
}

function hexChannels(colour) {
    const clean = String(colour || '').replace('#', '')
    if (clean.length !== 6) return null
    const value = Number.parseInt(clean, 16)
    if (!Number.isFinite(value)) return null
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

/**
 * The colour table, and an index for every colour used.
 *
 * RTF numbers colours from one -- index zero means "whatever the reader's
 * default is" -- so the table is written out from index one and every lookup is
 * its position plus one.
 */
export function colourTable(colours) {
    const order = []
    const index = new Map()
    for (const colour of colours) {
        const channels = hexChannels(colour)
        if (!channels || index.has(colour)) continue
        order.push(channels)
        index.set(colour, order.length)
    }
    return {
        index,
        at: (colour) => index.get(colour) || 0,
        table: `{\\colortbl;${order.map(({ r, g, b }) => `\\red${r}\\green${g}\\blue${b};`).join('')}}`,
    }
}

/**
 * Every colour a set of documents actually uses.
 *
 * Only for the whole-document form below. A streamed export cannot see its own
 * cells before it writes its header, so it declares the palette in full
 * instead -- see `paletteColours`.
 */
function coloursOf(documents) {
    const out = new Set()
    for (const document_ of documents || []) {
        for (const row of document_.rows) {
            for (const cell of row.cells) {
                if (cell.bg) out.add(cell.bg)
                if (cell.fg) out.add(cell.fg)
                if (cell.underline) out.add(cell.underline)
                // An outline has no fill on screen, and no fill here either --
                // but the hue still has to say which class it is, so it becomes
                // the letter's ink rather than the cell's background.
                if (cell.outline) out.add(cell.outline)
            }
        }
    }
    return out
}

/** The control sequence a cell's appearance needs, or '' where it is plain. */
function cellStyle(cell, colours) {
    const fill = cell.bg ? `\\chshdng0\\chcbpat${colours.at(cell.bg)}\\cb${colours.at(cell.bg)}` : ''
    const ink = cell.outline || cell.fg
    // The overlap rule: a line under bases more than one gene covers, in its
    // own colour, over whatever the base is already wearing. `\\ulc` is Word's
    // underline colour; readers that do not know it still draw the underline.
    const rule = cell.underline ? `\\ul\\ulc${colours.at(cell.underline)}` : ''
    return `${fill}\\cf${colours.at(ink)}${rule}`
}

/**
 * A row of cells, with same-looking neighbours joined.
 *
 * The join is the whole reason this is usable: an intron is one control
 * sequence and a thousand letters rather than a thousand of each.
 *
 * Each run is a group of its own, `{...}`, so its colours are undone by the
 * closing brace rather than by being set back to something. The row used to end
 * with `\\chcbpat0\\cb0`, meaning "back to the default" -- but colour zero is
 * also how the colour table numbers its first entry, and macOS's own RTF engine
 * reads it the second way: everything after a run of coloured bases, including
 * the coordinate at the end of the line, came out on a black background. A
 * group has no such ambiguity, and costs two bytes a run.
 */
function writeCells(cells, colours) {
    let out = ''
    let open = null
    let run = ''
    const flush = () => {
        if (!run) return
        out += `{${open} ${escapeRtf(run)}}`
        run = ''
    }
    for (const cell of cells) {
        const style = cellStyle(cell, colours)
        if (style !== open) {
            flush()
            open = style
        }
        run += cell.ch === ' ' ? '\u00a0' : cell.ch
    }
    flush()
    return out
}

const GUTTER_PAD = 12
// The space between a coordinate and the first base of its row.
//
// Non-breaking, and written out rather than left to the padding, because RTF
// eats one space after every control word as its terminator -- and the run of
// cells begins with one. A plain space here is swallowed as the delimiter of
// `\\cf`, which is why the left-hand number sat flush against the sequence
// while the right-hand one, which no control word precedes, looked fine.
const GUTTER_GAP = '\u00a0\u00a0'

function gutter(value, align) {
    const text = value === null || value === undefined ? '' : String(value)
    // Padded with non-breaking spaces for the same reason, and so the column
    // still lines up in a reader that collapses runs of ordinary ones.
    return align === 'right'
        ? text.padStart(GUTTER_PAD, '\u00a0')
        : text.padEnd(GUTTER_PAD, '\u00a0')
}

/**
 * A streamed export.
 *
 * The header, then a record's heading, then its rows in as many batches as the
 * caller likes, then the tail. Nothing is held: the caller paints a block of
 * rows, hands them over, writes the piece it gets back and throws the rows
 * away, so the memory an export costs is one block rather than one file.
 *
 * `colours` is the whole palette rather than what the cells turned out to use,
 * because RTF's colour table lives in the header and a stream has not seen a
 * cell by then. A declared colour nothing uses costs seven bytes.
 *
 * `\fs` is in half-points, so a 16 is an 8pt monospace -- small enough that
 * sixty cells and two coordinate gutters fit the width of a portrait page,
 * which is the shape this is nearly always read in.
 */
export function rtfWriter({
    title = 'Sequence',
    subtitle = '',
    fontSize = 16,
    headings = true,
    gutters = true,
    colours = [],
} = {}) {
    const table = colourTable(colours)
    return {
        colours: table,
        head() {
            const parts = [
                '{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1',
                '{\\fonttbl{\\f0\\fmodern\\fcharset0 Courier New;}{\\f1\\fswiss\\fcharset0 Helvetica;}}',
                table.table,
                // Landscape would fit more, but a sequence is read down the page
                // and every reader who prints one expects portrait.
                '\\paperw11906\\paperh16838\\margl720\\margr720\\margt720\\margb720',
                `{\\f1\\fs24\\b ${escapeRtf(title)}\\b0\\par}`,
            ]
            if (subtitle) parts.push(`{\\f1\\fs18 ${escapeRtf(subtitle)}\\par}`)
            parts.push('\\par')
            return `${parts.join('\n')}\n`
        },
        recordHead(meta) {
            const parts = []
            if (headings) {
                parts.push(`{\\f1\\fs20\\b ${escapeRtf(meta.label || meta.chrom)}\\b0`)
                const detail = [
                    meta.detail,
                    `${meta.chrom}:${meta.start}-${meta.end}`,
                    meta.strand === '-' ? 'reverse strand' : 'forward strand',
                    meta.collapsed ? `${meta.hidden.toLocaleString()} bp collapsed` : '',
                ].filter(Boolean).join(' \u00b7 ')
                parts.push(`{\\fs16  ${escapeRtf(detail)}}\\par}`)
            }
            // Single-spaced, no first-line indent and no space between
            // paragraphs: a row is a line of a sequence, not a paragraph.
            parts.push(`{\\f0\\fs${fontSize}\\sl${Math.round(fontSize * 13)}\\slmult0`)
            return `${parts.join('\n')}\n`
        },
        rows(rows) {
            const parts = []
            for (const row of rows || []) {
                // The lane is indented by exactly the left gutter, so a letter
                // stands over the base whose codon it belongs to.
                if (row.amino && row.amino.trim()) {
                    const lane = gutters ? gutter('', 'right') + GUTTER_GAP : ''
                    parts.push(`${escapeRtf(lane)}${escapeRtf(row.amino.replace(/ /g, '\u00a0'))}\\line `)
                }
                const left = gutters ? escapeRtf(gutter(row.left, 'right') + GUTTER_GAP) : ''
                const right = gutters && row.right !== null
                    ? escapeRtf(GUTTER_GAP + String(row.right))
                    : ''
                parts.push(`${left}${writeCells(row.cells, table)}${right}\\line `)
            }
            return parts.length ? `${parts.join('\n')}\n` : ''
        },
        recordTail: () => '\\par}\n\\par\n',
        tail: () => '}',
    }
}

/**
 * The whole export in one string.
 *
 * The streamed writer above, driven to the end. Anything small enough to hold
 * is clearer this way, and it is what the tests read.
 */
export function rtfDocument(documents, options = {}) {
    const writer = rtfWriter({ ...options, colours: [...coloursOf(documents)] })
    const parts = [writer.head()]
    for (const document_ of documents || []) {
        parts.push(writer.recordHead(document_))
        parts.push(writer.rows(document_.rows))
        parts.push(writer.recordTail())
    }
    parts.push(writer.tail())
    return parts.join('')
}

export { escapeRtf }
