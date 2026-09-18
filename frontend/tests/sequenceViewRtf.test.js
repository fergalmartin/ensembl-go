import test from 'node:test'
import assert from 'node:assert/strict'

import { colourTable, escapeRtf, rtfDocument, rtfWriter } from '../src/utils/sequenceViewRtf.js'
import { escapeHtml, htmlDocument, htmlWriter } from '../src/utils/sequenceViewHtml.js'

const cell = (ch, extra = {}) => ({ ch, gap: false, pending: false, bg: null, outline: null, fg: '#334155', ...extra })

const oneRow = {
    key: 'k',
    label: 'ENST1',
    detail: 'Transcript',
    chrom: '1',
    start: 1,
    end: 4,
    strand: '+',
    reverse: false,
    collapsed: false,
    hidden: 0,
    rows: [{
        index: 0,
        left: 1,
        right: 4,
        amino: '',
        cells: [
            cell('A', { bg: '#ff0000', fg: '#ffffff' }),
            cell('C', { bg: '#ff0000', fg: '#ffffff' }),
            cell('G', { bg: '#0000ff', fg: '#ffffff' }),
            cell('T'),
        ],
    }],
}

test('RTF escapes only what RTF cannot hold literally', () => {
    assert.equal(escapeRtf('A{B}C\\D'), 'A\\{B\\}C\\\\D')
    assert.equal(escapeRtf('ACGT'), 'ACGT')
    // Anything outside ASCII becomes a \\u escape with a plain stand-in after
    // it, which is what a reader on an old word processor sees.
    assert.equal(escapeRtf('·'), '\\u183?')
})

test('the colour table is written from one, since zero means the default', () => {
    const table = colourTable(['#ff0000', '#0000ff', '#ff0000'])
    assert.equal(table.at('#ff0000'), 1)
    assert.equal(table.at('#0000ff'), 2)
    // A colour nothing used is index zero, which RTF reads as "leave it alone".
    assert.equal(table.at('#123456'), 0)
    assert.equal(table.table, '{\\colortbl;\\red255\\green0\\blue0;\\red0\\green0\\blue255;}')
})

test('a colour that is not a hex triplet is left out rather than written wrong', () => {
    const table = colourTable(['not-a-colour', '', null, '#00ff00'])
    assert.equal(table.at('#00ff00'), 1)
    assert.equal(table.table, '{\\colortbl;\\red0\\green255\\blue0;}')
})

test('an RTF document opens, declares a monospace font and closes', () => {
    const text = rtfDocument([oneRow], { title: 'Test' })
    assert.ok(text.startsWith('{\\rtf1\\ansi'))
    assert.ok(text.trimEnd().endsWith('}'))
    assert.ok(text.includes('Courier New'))
    assert.ok(text.includes('\\colortbl;'))
    // Every brace that opens has to close, or nothing will open the file.
    const opens = (text.match(/(?<!\\)\{/g) || []).length
    const closes = (text.match(/(?<!\\)\}/g) || []).length
    assert.equal(opens, closes)
})

test('neighbouring bases of one colour are written as one run', () => {
    const text = rtfDocument([oneRow])
    // The two red bases share one control sequence and appear as "AC"; the blue
    // one starts a new run with a different fill. This is the whole reason a
    // megabase is writable at all.
    const red = text.match(/\\chcbpat(\d+)\\cb\1\\cf\d+ AC/)
    const blue = text.match(/\\chcbpat(\d+)\\cb\1\\cf\d+ G/)
    assert.ok(red, 'the two red bases are one run')
    assert.ok(blue, 'the blue base is its own run')
    assert.notEqual(red[1], blue[1])
    // The unmarked base carries an ink and no fill at all.
    assert.match(text, /\\cf\d+ T/)
})

test('the bases and the coordinates both reach the file', () => {
    const text = rtfDocument([oneRow], { gutters: true })
    assert.ok(text.includes('AC'))
    assert.ok(text.includes('1'))
    assert.ok(text.includes('4'))
    const without = rtfDocument([oneRow], { gutters: false })
    // Without gutters the row is the bases and nothing else, so the padded
    // coordinate column is gone.
    assert.ok(!without.includes('\\~\\~'))
})

test('a coordinate is separated from its bases at both ends', () => {
    const text = rtfDocument([oneRow], { gutters: true })
    // RTF eats one space after a control word as its terminator, and the run of
    // cells opens with one -- so an ordinary space here is swallowed and the
    // number ends up flush against the sequence. Both gaps are non-breaking for
    // that reason, and the test is here because the bug is invisible in source.
    // `\\~` is RTF's own non-breaking space, which is what the gaps are made of.
    assert.match(text, /1\\~\\~\{\\chshdng/, 'a gap after the left-hand coordinate')
    assert.match(text, /\\~\\~4\\line/, 'a gap before the right-hand one')
    // The bug was a coordinate with nothing at all between it and the cells.
    assert.ok(!/[0-9]\{?\\chshdng0\\chcbpat[1-9]/.test(text), 'no coordinate touches a cell run')
})

test('HTML separates its coordinates the same way', () => {
    const text = htmlDocument([oneRow], { gutters: true })
    assert.match(text, /<\/span>\u00a0\u00a0/, 'a gap after the left-hand coordinate')
    assert.match(text, /\u00a0\u00a0<span class="gutter">4<\/span>/)
})

test('the streamed writer and the whole-document form produce the same file', () => {
    for (const [writerOf, documentOf] of [[rtfWriter, rtfDocument], [htmlWriter, htmlDocument]]) {
        const documents = [oneRow, { ...oneRow, label: 'Second', start: 9, end: 12 }]
        const options = { title: 'Test', subtitle: 'Sub', headings: true, gutters: true }
        const colours = new Set()
        for (const d of documents) for (const r of d.rows) for (const c of r.cells) {
            for (const colour of [c.bg, c.fg, c.outline]) if (colour) colours.add(colour)
        }
        const writer = writerOf({ ...options, colours: [...colours] })
        // Driven a record at a time, and a record two rows at a time, which is
        // what the runner does over a chromosome.
        let streamed = writer.head()
        for (const document_ of documents) {
            streamed += writer.recordHead(document_)
            for (let at = 0; at < document_.rows.length; at += 2) {
                streamed += writer.rows(document_.rows.slice(at, at + 2))
            }
            streamed += writer.recordTail()
        }
        streamed += writer.tail()
        assert.equal(streamed, documentOf(documents, options))
    }
})

test('a heading per record can be turned off', () => {
    assert.ok(rtfDocument([oneRow], { headings: true }).includes('ENST1'))
    assert.ok(!rtfDocument([oneRow], { headings: false }).includes('ENST1'))
})

test('a spliced record says how much it left out', () => {
    const text = rtfDocument([{ ...oneRow, collapsed: true, hidden: 1234 }])
    assert.match(text, /1,234 bp collapsed/)
})

test('the protein lane is written above its bases when a row carries one', () => {
    const text = rtfDocument([{ ...oneRow, rows: [{ ...oneRow.rows[0], amino: ' M  ' }] }])
    assert.ok(text.includes('M'))
})

test('HTML escapes the four characters that would otherwise close a tag', () => {
    assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
})

test('an HTML export is one standalone page with its styles inside it', () => {
    const text = htmlDocument([oneRow], { title: 'Test' })
    assert.ok(text.startsWith('<!doctype html>'))
    assert.ok(text.includes('<style>'))
    // Nothing fetched: a page that linked a stylesheet would lose its colours
    // the moment it was mailed to someone.
    assert.ok(!text.includes('<link'))
    assert.ok(!text.includes('src='))
    assert.ok(text.trimEnd().endsWith('</html>'))
})

test('HTML carries the same runs, as one span apiece', () => {
    const text = htmlDocument([oneRow])
    assert.ok(text.includes('background:#ff0000'))
    assert.ok(text.includes('background:#0000ff'))
    assert.match(text, /<span style="background:#ff0000;color:#ffffff">AC<\/span>/)
    // A bare base wears nothing at all rather than an empty span.
    assert.match(text, />T</)
})

test('an outlined class is a rule over and under, not a fill, in both formats', () => {
    const outlined = {
        ...oneRow,
        rows: [{ ...oneRow.rows[0], cells: [cell('A', { outline: '#64748b' })] }],
    }
    const html = htmlDocument([outlined])
    assert.ok(!html.includes('background:#64748b'))
    assert.ok(html.includes('box-shadow:inset 0 1px 0 0 #64748b'))
    // RTF has no outline, so the hue moves to the ink rather than being lost --
    // and the cell takes no fill, which `\\chcbpat0` is the reset for.
    const rtf = rtfDocument([outlined])
    assert.ok(!/\\chcbpat[1-9]/.test(rtf), 'nothing is filled')
    const ink = rtf.match(/\\cf(\d+) A/)
    assert.ok(ink, 'the base is inked')
    assert.match(rtf, new RegExp(`\\{\\\\colortbl;(?:[^}]*;)?\\\\red100\\\\green116\\\\blue139;`))
})

test('a run of colour is a group, so nothing leaks past it', () => {
    const text = rtfDocument([oneRow])
    // Undone by its closing brace rather than by being set back to colour zero.
    // Colour zero also numbers the first entry of the table, and macOS reads it
    // that way: the old reset painted the rest of every line black.
    assert.ok(!text.includes('\\chcbpat0'), 'nothing resets to colour zero')
    assert.ok(!text.includes('\\cb0'), 'nor to its Word spelling')
    assert.match(text, /\{\\chshdng0\\chcbpat\d+\\cb\d+\\cf\d+ AC\}/)
    // A group opens for every run and closes again, header and body alike.
    const opens = (text.match(/(?<!\\)\{/g) || []).length
    const closes = (text.match(/(?<!\\)\}/g) || []).length
    assert.equal(opens, closes)
})

test('the overlap rule is an underline in both formats, over what is already there', () => {
    const ruled = {
        ...oneRow,
        rows: [{
            ...oneRow.rows[0],
            cells: [
                cell('A', { bg: '#ff0000', fg: '#ffffff', underline: '#f59e0b' }),
                cell('C'),
            ],
        }],
    }
    const rtf = rtfDocument([ruled])
    // Underlined and filled at once: a base two genes share is still whatever
    // kind of base it was.
    assert.match(rtf, /\\chcbpat\d+\\cb\d+\\cf\d+\\ul\\ulc\d+ A/)
    assert.ok(rtf.includes('\\red245\\green158\\blue11'), 'the rule has a colour of its own')
    // The base beside it carries neither.
    assert.ok(!/\\ul\\ulc\d+ C/.test(rtf))

    const html = htmlDocument([ruled])
    assert.match(html, /box-shadow:inset 0 -2px 0 0 #f59e0b/)
    assert.match(html, /background:#ff0000/)
})

test('both formats survive a document with no rows at all', () => {
    const empty = { ...oneRow, rows: [] }
    assert.ok(rtfDocument([empty]).startsWith('{\\rtf1'))
    assert.ok(htmlDocument([empty]).includes('</html>'))
    assert.ok(rtfDocument([]).startsWith('{\\rtf1'))
    assert.ok(htmlDocument([]).includes('</html>'))
})
