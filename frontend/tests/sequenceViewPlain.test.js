import test from 'node:test'
import assert from 'node:assert/strict'

import {
    DISPLAY_FASTA,
    DISPLAY_MODES,
    DISPLAY_RICH,
    DISPLAY_TEXT,
    GUTTER_CHARS,
    displayDropsGaps,
    displayHasGutters,
    displayModeLabel,
    fastaHeaderLine,
    gutterText,
    isDisplayMode,
    isPlainDisplay,
    mixHex,
    PLAIN_FONT_MAX,
    PLAIN_FONT_MIN,
    plainBlockWidth,
    plainFontSize,
    plainInk,
    plainLineChars,
    plainLineText,
    plainRowText,
    plainRuns,
    PLAIN_INK_CONTRAST,
    PLAIN_PAGE_DARK,
    PLAIN_PAGE_LIGHT,
    contrastRatio,
    relativeLuminance,
    sectionHeaderLine,
} from '../src/utils/sequenceViewPlain.js'
import { CLASS_CODES, CLASS_GAP, CLASS_NONE } from '../src/utils/sequenceViewPalette.js'
import { documentHeader } from '../src/utils/sequenceViewExport.js'

// ---- which display is which ---------------------------------------------

test('the interactive display is the first of them, and the default', () => {
    assert.equal(DISPLAY_MODES[0].id, DISPLAY_RICH)
    assert.equal(displayModeLabel(DISPLAY_RICH), 'Interactive')
})

test('anything that is not one of the three is not a display', () => {
    assert.ok(isDisplayMode(DISPLAY_TEXT))
    assert.ok(!isDisplayMode('plaintext'))
    assert.ok(!isDisplayMode(''))
    // An unknown id reads as the default rather than as nothing at all, so a
    // setting stored by an older version cannot leave the view blank.
    assert.equal(displayModeLabel('nonsense'), 'Interactive')
})

test('the two written as text are the plain ones', () => {
    assert.ok(isPlainDisplay(DISPLAY_TEXT))
    assert.ok(isPlainDisplay(DISPLAY_FASTA))
    assert.ok(!isPlainDisplay(DISPLAY_RICH))
})

test('only plain text prints coordinates, and only FASTA drops the markers', () => {
    assert.ok(displayHasGutters(DISPLAY_TEXT))
    assert.ok(!displayHasGutters(DISPLAY_FASTA))
    assert.ok(displayDropsGaps(DISPLAY_FASTA))
    assert.ok(!displayDropsGaps(DISPLAY_TEXT))
})

// ---- the margins ---------------------------------------------------------

test('a coordinate is printed to a fixed width, so the column stands still', () => {
    assert.equal(gutterText(1).length, GUTTER_CHARS)
    assert.equal(gutterText(119_632_279).length, GUTTER_CHARS)
    assert.equal(gutterText(119_632_279).trim(), '119,632,279')
    assert.equal(gutterText(1).trim(), '1')
})

test('a row with no coordinate leaves the column empty rather than narrow', () => {
    assert.equal(gutterText(null).length, GUTTER_CHARS)
    assert.equal(gutterText(null).trim(), '')
})

// ---- grouping a row into runs -------------------------------------------

test('neighbouring bases of one class are drawn as one run', () => {
    assert.deepEqual(plainRuns('AAACCC', 'iiiooo').map(({ code, text }) => ({ code, text })), [
        { code: 'i', text: 'AAA' },
        { code: 'o', text: 'CCC' },
    ])
})

test('a row of one class is one run, however long', () => {
    const runs = plainRuns('A'.repeat(60), 'i'.repeat(60))
    assert.equal(runs.length, 1)
    assert.equal(runs[0].text.length, 60)
})

test('uncoloured, a whole row is one run carrying no class', () => {
    const runs = plainRuns('AAACCC', 'iiiooo', { colour: false })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].code, CLASS_NONE)
    assert.equal(runs[0].text, 'AAACCC')
})

test('FASTA drops the markers, and joins the sequence either side of them', () => {
    const sequence = `AAA${'-'.repeat(4)}CCC`
    const classes = `iii${CLASS_GAP.repeat(4)}iii`
    // Kept, the marker breaks the row into three runs; dropped, the intronic
    // sequence either side of it is one.
    assert.equal(plainRuns(sequence, classes).length, 3)
    const runs = plainRuns(sequence, classes, { dropGaps: true })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].text, 'AAACCC')
})

test('an empty row is no runs at all', () => {
    assert.deepEqual(plainRuns('', ''), [])
})

test('a cell with no class still lands in a run', () => {
    const runs = plainRuns('AC', '')
    assert.equal(runs.length, 1)
    assert.equal(runs[0].code, CLASS_NONE)
    assert.equal(runs[0].text, 'AC')
})

test('a match breaks a run, and so does the annotation under it', () => {
    // Both, rather than whichever is in play. A row with a match on it must
    // keep its annotation colours everywhere else, and a match must not be cut
    // in half because the class changed underneath it.
    const runs = plainRuns('AAACCC', 'iiiooo', { finds: '..11..' })
    assert.deepEqual(runs.map((run) => run.text), ['AA', 'A', 'C', 'CC'])
    assert.deepEqual(runs.map((run) => run.lane), ['.', '1', '1', '.'])
    assert.deepEqual(runs.map((run) => run.code), ['i', 'i', 'o', 'o'])
})

test('a match spanning two classes is one highlight, not two half-matches', () => {
    // The run is cut where the class changes, but both halves carry the same
    // lane -- so the component draws one continuous fill across them.
    const runs = plainRuns('AAAA', 'iioo', { finds: '1111' })
    assert.ok(runs.every((run) => run.lane === '1'))
})

test('uncoloured, a match is still the one thing that breaks a run', () => {
    const runs = plainRuns('AAACCC', 'iiiooo', { colour: false, finds: '..11..' })
    assert.deepEqual(runs.map((run) => run.text), ['AA', 'AC', 'CC'])
})

// ---- the line as it is copied -------------------------------------------

test('the text of a row is its characters, whatever the colouring', () => {
    assert.equal(plainRowText('AAACCC', 'iiiooo'), 'AAACCC')
    assert.equal(plainRowText('AAA--CCC', `iii${CLASS_GAP}${CLASS_GAP}iii`, { dropGaps: true }), 'AAACCC')
})

test('plain text prints the coordinates either side of the bases', () => {
    const line = plainLineText(
        { sequence: 'ACGT', classes: 'iiii', firstCoord: 1000, lastCoord: 1003 },
        { display: DISPLAY_TEXT },
    )
    assert.ok(line.includes('ACGT'))
    assert.ok(line.trimStart().startsWith('1,000'))
    assert.ok(line.trimEnd().endsWith('1,003'))
    // Both margins are the same width, so the bases start at the same column on
    // every row of the screen.
    assert.equal(line.indexOf('ACGT'), GUTTER_CHARS + 2)
})

test('FASTA prints the bases and nothing else', () => {
    const line = plainLineText(
        { sequence: 'ACGT', classes: 'iiii', firstCoord: 1000, lastCoord: 1003 },
        { display: DISPLAY_FASTA },
    )
    assert.equal(line, 'ACGT')
})

test('a collapsed row is short in FASTA rather than padded back to sixty', () => {
    const line = plainLineText(
        { sequence: 'AA----CC', classes: `ii${CLASS_GAP.repeat(4)}ii` },
        { display: DISPLAY_FASTA },
    )
    assert.equal(line, 'AACC')
})

// ---- how wide, and at what size ------------------------------------------

test('a plain text line is the bases and both margins; FASTA is the bases', () => {
    assert.equal(plainLineChars(DISPLAY_FASTA), 60)
    assert.equal(plainLineChars(DISPLAY_TEXT), 60 + (GUTTER_CHARS + 2) * 2)
    // What the line writer actually produces, so the width and the text cannot
    // come apart.
    const row = { sequence: 'A'.repeat(60), classes: 'i'.repeat(60), firstCoord: 1, lastCoord: 60 }
    assert.equal(plainLineText(row, { display: DISPLAY_TEXT }).length, plainLineChars(DISPLAY_TEXT))
    assert.equal(plainLineText(row, { display: DISPLAY_FASTA }).length, plainLineChars(DISPLAY_FASTA))
})

test('the box around a plain block is as wide as the block', () => {
    // Sixty characters of monospace at fifteen point. The box is what the
    // scroller is given; a box wider than the text is a scrollbar under
    // sequence that fits.
    assert.equal(plainBlockWidth(60, 15), 540)
    assert.equal(plainBlockWidth(0, 15), 0)
    assert.equal(plainBlockWidth(60, 0), 0)
    // Bigger type and longer lines both make it wider.
    assert.ok(plainBlockWidth(86, 15) > plainBlockWidth(60, 15))
    assert.ok(plainBlockWidth(60, 15) > plainBlockWidth(60, 12))
    // A size chosen to fit the panel produces a block that fits the panel.
    for (const available of [400, 700, 1100, 1600]) {
        for (const chars of [60, 86]) {
            const width = plainBlockWidth(chars, plainFontSize(available, chars))
            assert.ok(width <= available || plainFontSize(available, chars) === PLAIN_FONT_MIN,
                `${chars} chars in ${available}px`)
        }
    }
})

test('the text is set to fit the panel, within reading sizes', () => {
    // A panel wide enough for type bigger than anyone reads sequence at stops
    // at the ceiling rather than becoming a wallchart.
    assert.equal(plainFontSize(4000, 60), PLAIN_FONT_MAX)
    // A panel too narrow for legible type overflows rather than going smaller
    // than the cells themselves are allowed to.
    assert.equal(plainFontSize(120, 86), PLAIN_FONT_MIN)
    // In between, bigger panels take bigger type.
    assert.ok(plainFontSize(700, 86) <= plainFontSize(900, 86))
    // Nonsense is a size, not a crash.
    assert.ok(plainFontSize(NaN, 86) >= PLAIN_FONT_MIN)
    assert.ok(plainFontSize(500, 0) >= PLAIN_FONT_MIN)
})

// ---- ink ----------------------------------------------------------------

test('contrast is measured the way the standard measures it', () => {
    // Black on white is the whole scale, and a colour against itself is none of
    // it. Guards the gamma step: a naive average of the raw channels gives 21
    // for the first and 1 for the second too, and quite different answers in
    // between -- which is exactly where every real decision here is made.
    assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 0.01)
    assert.ok(Math.abs(contrastRatio('#60a5fa', '#60a5fa') - 1) < 0.01)
    assert.equal(contrastRatio('nonsense', '#ffffff'), null)
    // The intron slate really is unreadable on the dark page, which is the
    // thing this whole mechanism exists for.
    assert.ok(contrastRatio('#4a5568', PLAIN_PAGE_DARK) < PLAIN_INK_CONTRAST)
})

test('a colour already readable on the page is printed exactly as it is', () => {
    // The exon blue: bright enough to read on a dark page untouched, so a
    // coding base is the same blue it is in the interactive display.
    const blue = '#60a5fa'
    assert.equal(plainInk(blue, false), blue)
    assert.ok(contrastRatio(blue, PLAIN_PAGE_DARK) >= PLAIN_INK_CONTRAST)
})

test('a colour too dark to read on a dark page is walked towards white', () => {
    const ink = plainInk('#4a5568', false)
    assert.notEqual(ink, '#4a5568')
    assert.ok(relativeLuminance(ink) > relativeLuminance('#4a5568'))
    // Far enough to be readable, and no further -- one step back would not be.
    assert.ok(contrastRatio(ink, PLAIN_PAGE_DARK) >= PLAIN_INK_CONTRAST)
})

test('a colour too pale to read on a light page is walked towards black', () => {
    const ink = plainInk('#c4b5fd', true)
    assert.ok(relativeLuminance(ink) < relativeLuminance('#c4b5fd'))
    assert.ok(contrastRatio(ink, PLAIN_PAGE_LIGHT) >= PLAIN_INK_CONTRAST)
})

test('every colour the palette can draw comes out readable on both themes', () => {
    // The point of the whole exercise: the palette is a set of backgrounds, and
    // a background printed as a letter is not necessarily a letter anyone can
    // read.
    const colours = [
        '#60a5fa', '#bfdbfe', '#c4b5fd', '#4a5568', '#ed8936', '#0d9488',
        '#c026d3', '#475569', '#7f9cc0', '#f472b6', '#64748b', '#000000', '#ffffff',
    ]
    for (const colour of colours) {
        assert.ok(
            contrastRatio(plainInk(colour, false), PLAIN_PAGE_DARK) >= PLAIN_INK_CONTRAST,
            `${colour} on the dark page`,
        )
        assert.ok(
            contrastRatio(plainInk(colour, true), PLAIN_PAGE_LIGHT) >= PLAIN_INK_CONTRAST,
            `${colour} on the light page`,
        )
    }
})

test('something that is not a colour is not ink', () => {
    assert.equal(plainInk('', false), null)
    assert.equal(plainInk(null, false), null)
    assert.equal(plainInk('rebeccapurple', false), null)
})

test('mixing is by the fraction given, and refuses what it cannot read', () => {
    assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff')
    assert.equal(mixHex('#000000', '#ffffff', 0), '#000000')
    assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080')
    assert.equal(mixHex('nonsense', '#ffffff', 0.5), null)
})

// ---- the header ----------------------------------------------------------

test('a header names the record, where it is and which way round it reads', () => {
    assert.equal(
        fastaHeaderLine({ name: 'PHGDH', chrom: '1', start: 100, end: 200, strand: '-' }),
        '>PHGDH 1:100-200(-)',
    )
})

test('a collapsed record says how much of it is not there', () => {
    assert.equal(
        fastaHeaderLine({ name: 'X', chrom: '1', start: 1, end: 9, strand: '+', hidden: 4000 }),
        '>X 1:1-9(+) spliced -4000bp',
    )
})

test('the screen and the download write the same header for the same record', () => {
    const document_ = {
        label: 'PHGDH', chrom: '1', start: 100, end: 200, strand: '-', collapsed: true, hidden: 40,
    }
    assert.equal(
        documentHeader(document_),
        fastaHeaderLine({
            name: 'PHGDH', chrom: '1', start: 100, end: 200, strand: '-', hidden: 40,
        }),
    )
})

test('an unnamed region is headed by where it is', () => {
    const section = { record: null, layout: { region: { start: 100, end: 200 } } }
    assert.equal(sectionHeaderLine(section, '1'), '>1 1:100-200(+)')
})

test('an unnamed region takes the name the reader came here by', () => {
    // A plain region drawn at a gene is that gene's sequence, and is downloaded
    // under that gene's name; the header on the screen says the same.
    const section = { record: null, layout: { region: { start: 100, end: 200 } } }
    assert.equal(sectionHeaderLine(section, '1', 'PHGDH'), '>PHGDH 1:100-200(+)')
})

test('a record keeps its own name whatever the focus is called', () => {
    const section = {
        record: { label: 'ENST00000641023', chrom: '1', strand: '+' },
        layout: { region: { start: 100, end: 200 } },
    }
    assert.equal(sectionHeaderLine(section, '1', 'PHGDH'), '>ENST00000641023 1:100-200(+)')
})

test('a record is headed at the extent actually drawn, not at its own ends', () => {
    // A gene read with flanking sequence covers more than the gene: the header
    // names what is under it.
    const section = {
        record: { label: 'PHGDH', chrom: '1', start: 500, end: 600, strand: '+' },
        layout: { region: { start: 400, end: 700 } },
    }
    assert.equal(sectionHeaderLine(section, '1'), '>PHGDH 1:400-700(+)')
})

test('the class codes a row carries are the ones the palette knows', () => {
    // Guards the run grouping against a class channel that has quietly changed
    // its alphabet underneath it.
    const runs = plainRuns('ACGT', `${CLASS_CODES.cds}${CLASS_CODES.cds}${CLASS_CODES.intron}${CLASS_CODES.intron}`)
    assert.deepEqual(runs.map((run) => run.code), [CLASS_CODES.cds, CLASS_CODES.intron])
})
