import test from 'node:test'
import assert from 'node:assert/strict'

import {
    FIND_COLOURS,
    FIND_DEFAULT_COLOUR,
    FIND_LITERAL,
    FIND_REGEX,
    MAX_PATTERNS,
    activePatterns,
    compilePattern,
    findMatches,
    firstSpanAt,
    loadPatterns,
    matchLabel,
    movePattern,
    nearestMatch,
    newPattern,
    normalisePatterns,
    patternError,
    patternErrors,
    patternSearchKey,
    formatPatternRefs,
    parsePatternRefs,
    raiseSpan,
    resolvePatternSpans,
    resolveQuery,
    savePatterns,
    savedPatternFor,
    shortPattern,
    stepMatch,
} from '../src/utils/findPatterns.js'
import {
    loadMotifs,
    moveMotif,
    resolveMotifSpans,
    saveMotifs,
} from '../src/components/alignment-explorer/motifs.js'

const patterns = [
    { id: 'a', pattern: 'ATG', kind: FIND_LITERAL, enabled: true, colour: '#3366cc' },
    { id: 'b', pattern: 'TG.', kind: FIND_REGEX, enabled: true, colour: '#00b692' },
]

// ---- what a stored list is worth ----------------------------------------

test('a stored list is read field by field, against what this version knows', () => {
    const [only] = normalisePatterns([{ id: 'a' }])
    assert.equal(only.pattern, '')
    assert.equal(only.kind, FIND_LITERAL, 'an unknown kind is the safe one')
    assert.equal(only.enabled, true, 'a switch nobody stored is on')
    assert.ok(/^#[0-9a-f]{6}$/i.test(only.colour), 'and it is given a colour')
})

test('nonsense in the store is left out rather than drawn', () => {
    assert.deepEqual(normalisePatterns(null), [])
    assert.deepEqual(normalisePatterns('nope'), [])
    assert.deepEqual(normalisePatterns([null, 7, { pattern: 'ATG' }]), [], 'no id, no pattern')
    // Two rows claiming one id would both be edited by one keystroke.
    assert.equal(normalisePatterns([{ id: 'a' }, { id: 'a' }]).length, 1)
})

test('a list is bounded, so a corrupt store cannot hand the view a million', () => {
    const many = Array.from({ length: MAX_PATTERNS + 40 }, (_, i) => ({ id: `p${i}` }))
    assert.equal(normalisePatterns(many).length, MAX_PATTERNS)
})

test('the American spelling in an older store is still a colour', () => {
    // What every reader already has in their browser says `color`.
    const [only] = normalisePatterns([{ id: 'a', color: '#123456' }])
    assert.equal(only.colour, '#123456')
})

test('patterns round-trip, and unreadable storage is an empty list not a crash', () => {
    let held = null
    const storage = { getItem: () => held, setItem: (_, next) => { held = next } }
    assert.equal(savePatterns('k', patterns, storage), true)
    assert.deepEqual(loadPatterns('k', storage), patterns)
    held = '{bad'
    assert.deepEqual(loadPatterns('k', storage), [])
})

test('a store that throws on the accessor is survivable', () => {
    const angry = { getItem() { throw new Error('private window') }, setItem() { throw new Error('nope') } }
    assert.deepEqual(loadPatterns('k', angry), [])
    assert.equal(savePatterns('k', patterns, angry), false)
})

// ---- the order, and what it is for --------------------------------------

test('the top pattern wins a base two of them cover', () => {
    const spans = { a: [[2, 5]], b: [[0, 4], [4, 8]] }
    assert.deepEqual(resolvePatternSpans(patterns, spans), [
        [0, 2, '#00b692'], [2, 5, '#3366cc'], [5, 8, '#00b692'],
    ])
})

test('reordering changes who wins, and switching one off reveals the other', () => {
    const spans = { a: [[2, 5]], b: [[0, 4], [4, 8]] }
    assert.deepEqual(resolvePatternSpans(movePattern(patterns, 'a', 'b'), spans), [[0, 8, '#00b692']])
    assert.deepEqual(
        resolvePatternSpans([{ ...patterns[0], enabled: false }, patterns[1]], spans),
        [[0, 8, '#00b692']],
    )
    assert.deepEqual(patterns.map((item) => item.id), ['a', 'b'], 'and none of it mutated the list')
})

test('two runs of one colour meeting at a point are one run', () => {
    // Without the join, a pattern interrupted by a lower one it entirely covers
    // comes back in three pieces and draws as three.
    assert.deepEqual(
        resolvePatternSpans(patterns, { a: [[0, 4], [4, 9]] }),
        [[0, 9, '#3366cc']],
    )
})

test('moving a pattern nowhere leaves the list exactly as it was', () => {
    assert.equal(movePattern(patterns, 'a', 'a'), patterns)
    assert.equal(movePattern(patterns, 'a', 'nope'), patterns)
})

test('a search is identified by what was searched for, not by how it looks', () => {
    // Recolouring and reordering must not throw away matches still correct.
    assert.equal(
        patternSearchKey(patterns),
        patternSearchKey([...patterns].reverse().map((item) => ({ ...item, colour: '#ffffff' }))),
    )
    assert.notEqual(
        patternSearchKey(patterns),
        patternSearchKey([{ ...patterns[0], enabled: false }, patterns[1]]),
    )
    assert.equal(patternSearchKey([{ ...patterns[0], pattern: '' }]), '[]')
})

test('only a switched-on pattern with something in it is searched for', () => {
    assert.deepEqual(activePatterns([
        patterns[0],
        { ...patterns[1], enabled: false },
        { id: 'c', pattern: '', kind: FIND_LITERAL, enabled: true, colour: '#fff' },
    ]).map((item) => item.id), ['a'])
})

test('a new pattern takes a colour none of the others is wearing', () => {
    const palette = ['#111111', '#222222']
    const made = newPattern([{ ...patterns[0], colour: '#111111' }], palette)
    assert.equal(made.colour, '#222222')
    assert.equal(made.pattern, '')
    assert.equal(made.enabled, true)
})

// ---- what a pattern means -------------------------------------------------

test('a literal is matched character for character, syntax and all', () => {
    // `.` and `[` are IUPAC characters as well as regex ones, and a reader who
    // chose String has said which they meant.
    assert.deepEqual(findMatches('A.GATG', 'A.G', FIND_LITERAL), [[0, 3]])
    assert.deepEqual(findMatches('A.GATG', 'A.G', FIND_REGEX), [[0, 3], [3, 6]])
})

test('case is not part of the question', () => {
    // Soft-masked repeats are written in lower case.
    assert.deepEqual(findMatches('atgATG', 'ATG', FIND_LITERAL), [[0, 3], [3, 6]])
})

test('matches do not overlap each other', () => {
    assert.deepEqual(findMatches('AAAA', 'AA', FIND_LITERAL), [[0, 2], [2, 4]])
})

test('a pattern that can match nothing terminates and highlights nothing', () => {
    assert.deepEqual(findMatches('CCAACC', 'A*', FIND_REGEX), [[2, 4]])
    assert.deepEqual(findMatches('CCC', 'A*', FIND_REGEX), [])
})

test('offsets can be counted from somewhere other than zero', () => {
    assert.deepEqual(findMatches('CCATG', 'ATG', FIND_LITERAL, { offset: 1000 }), [[1002, 1005]])
})

test('a broken regular expression is a message, not an exception', () => {
    assert.equal(patternError('ATG', FIND_LITERAL), '')
    assert.equal(patternError('ATG[', FIND_LITERAL), '', 'a literal cannot be broken')
    assert.ok(patternError('ATG[', FIND_REGEX), 'but a regex can')
    assert.equal(patternError('', FIND_REGEX), '', 'and an empty box is not an error')
    assert.equal(compilePattern('ATG[', FIND_REGEX), null)
    assert.deepEqual(Object.keys(patternErrors([
        patterns[0], { id: 'bad', pattern: '(', kind: FIND_REGEX, enabled: true, colour: '#fff' },
    ])), ['bad'])
})

// ---- naming the saved patterns from the simple box ------------------------

test('a list of places is read, in the order it was written', () => {
    assert.deepEqual(parsePatternRefs('[P1,P2,P3]'), [1, 2, 3])
    assert.deepEqual(parsePatternRefs('[P3,P1]'), [3, 1], 'order is the whole point')
    assert.deepEqual(parsePatternRefs('[ p2 , P1 ]'), [2, 1], 'spacing and case are forgiven')
    assert.deepEqual(parsePatternRefs('[P2]'), [2])
})

test('anything that is not that notation is something to look for', () => {
    // These are all sequence or regex a reader might genuinely type.
    for (const text of ['', 'ATG', '[ACGT]', '[ACGT]{3}', 'P1', '[P1', 'P1,P2', '[]', '[PX]']) {
        assert.equal(parsePatternRefs(text), null, `${text} is not a reference list`)
    }
})

test('the notation is written the way a reader counts', () => {
    assert.equal(formatPatternRefs([1, 2, 3]), '[P1,P2,P3]')
    assert.equal(formatPatternRefs([2]), '[P2]')
    assert.equal(formatPatternRefs([]), '', 'nothing chosen is not an empty bracket')
    assert.equal(formatPatternRefs([0, -1, 2]), '[P2]', 'and there is no pattern zero')
})

test('what is written and what is read are the same thing', () => {
    for (const places of [[1], [1, 2], [3, 1, 2]]) {
        assert.deepEqual(parsePatternRefs(formatPatternRefs(places)), places)
    }
})

test('a reference list resolves to those patterns, in that order', () => {
    const resolved = resolveQuery('[P2,P1]', { patterns })
    assert.deepEqual(resolved.map((item) => item.id), ['b', 'a'])
    assert.ok(resolved.every((item) => item.enabled), 'named is asked for, switch or no switch')
})

test('a reference to a pattern that is no longer there is skipped, not refused', () => {
    // A reader pruning the list should not find every search they saved broken.
    assert.deepEqual(resolveQuery('[P1,P9]', { patterns }).map((item) => item.id), ['a'])
    assert.deepEqual(resolveQuery('[P9]', { patterns }), [])
    assert.deepEqual(resolveQuery('[P1,P1]', { patterns }).length, 1, 'and named twice is once')
})

test('a switched-off pattern is still searched for when it is named', () => {
    const off = [{ ...patterns[0], enabled: false }, patterns[1]]
    assert.deepEqual(resolveQuery('[P1]', { patterns: off }).map((item) => item.id), ['a'])
})

test('anything else in the box is one pattern, read as the switch says', () => {
    const [literal] = resolveQuery('ATGGC', { kind: FIND_LITERAL, patterns: [] })
    assert.equal(literal.pattern, 'ATGGC')
    assert.equal(literal.kind, FIND_LITERAL)
    const [regex] = resolveQuery('AT[GC]', { kind: FIND_REGEX, patterns: [] })
    assert.equal(regex.kind, FIND_REGEX)
    assert.deepEqual(resolveQuery('   ', { patterns }), [], 'an empty box asks for nothing')
})

test('typing what is already saved looks the same as picking it', () => {
    const [found] = resolveQuery('ATG', { kind: FIND_LITERAL, patterns })
    assert.equal(found.id, 'a')
    assert.equal(found.colour, '#3366cc', 'the saved colour, not a fresh one')
    // And what is not saved takes the colour it was offered.
    const [fresh] = resolveQuery('GGGG', { kind: FIND_LITERAL, patterns, colour: '#abcdef' })
    assert.equal(fresh.colour, '#abcdef')
})

test('the box knows whether what is in it is one of the saved patterns', () => {
    assert.equal(savedPatternFor('ATG', FIND_LITERAL, patterns)?.id, 'a')
    assert.equal(savedPatternFor('ATG', FIND_REGEX, patterns), null, 'read a different way')
    assert.equal(savedPatternFor('GGGG', FIND_LITERAL, patterns), null)
    assert.equal(savedPatternFor('[P1]', FIND_LITERAL, patterns), null, 'a list is not a pattern')
})

// ---- raising the one in hand ----------------------------------------------

test('the raised span wins whatever the priority put there', () => {
    const spans = [[0, 20, '#a']]
    assert.deepEqual(raiseSpan(spans, [5, 9, '#b']), [
        [0, 4, '#a'], [5, 9, '#b'], [10, 20, '#a'],
    ])
})

test('raising over the start or the end of a span trims it rather than splitting', () => {
    assert.deepEqual(raiseSpan([[0, 20, '#a']], [0, 9, '#b']), [[0, 9, '#b'], [10, 20, '#a']])
    assert.deepEqual(raiseSpan([[0, 20, '#a']], [10, 20, '#b']), [[0, 9, '#a'], [10, 20, '#b']])
})

test('a span the raised one covers entirely disappears under it', () => {
    assert.deepEqual(raiseSpan([[5, 9, '#a']], [0, 20, '#b']), [[0, 20, '#b']])
    assert.deepEqual(raiseSpan([[5, 9, '#a'], [11, 14, '#c']], [0, 20, '#b']), [[0, 20, '#b']])
})

test('spans the raised one does not touch are left exactly as they were', () => {
    const spans = [[0, 4, '#a'], [30, 40, '#c']]
    assert.deepEqual(raiseSpan(spans, [10, 20, '#b']), [
        [0, 4, '#a'], [10, 20, '#b'], [30, 40, '#c'],
    ])
})

test('the result is still sorted and disjoint, which is what the drawing needs', () => {
    const spans = [[0, 9, '#a'], [10, 19, '#c'], [20, 29, '#a']]
    const out = raiseSpan(spans, [5, 24, '#b'])
    for (let i = 1; i < out.length; i += 1) {
        assert.ok(out[i][0] > out[i - 1][1], `span ${i} starts after the one before it ends`)
    }
})

test('raising nothing changes nothing', () => {
    const spans = [[0, 9, '#a']]
    assert.equal(raiseSpan(spans, null), spans)
    assert.equal(raiseSpan(spans, [9, 0, '#b']), spans, 'and an inverted span is nothing')
})

// ---- the colours a find is drawn in ---------------------------------------

test('a find is not drawn in any colour this view uses for annotation', () => {
    // The blue it used to default to is a hair from the blue an exon is filled
    // with, so a match inside an exon was a blue mark on a blue block.
    const annotation = [
        '#60a5fa', '#c4b5fd', '#4a5568', '#ed8936', '#0d9488',
        '#c026d3', '#f472b6', '#f59e0b', '#7f9cc0', '#64748b',
    ]
    for (const colour of FIND_COLOURS) {
        assert.ok(!annotation.includes(colour), `${colour} is the annotation's`)
    }
    assert.equal(FIND_DEFAULT_COLOUR, FIND_COLOURS[0])
})

test('a pattern with no colour of its own takes the find default', () => {
    const [only] = resolveQuery('ATG', { patterns: [] })
    assert.equal(only.colour, FIND_DEFAULT_COLOUR)
    assert.equal(newPattern([]).colour, FIND_DEFAULT_COLOUR)
})

// ---- where a search starts ------------------------------------------------

test('a search starts at the match nearest where the reader is looking', () => {
    const matches = [[100, 105, 'a'], [5000, 5005, 'a'], [9000, 9005, 'a']]
    assert.equal(nearestMatch(matches, 4800), 1)
    assert.equal(nearestMatch(matches, 120), 0)
    assert.equal(nearestMatch(matches, 8000), 2)
})

test('a coordinate inside a match is that match, whatever else is near', () => {
    const matches = [[100, 200, 'a'], [201, 202, 'a']]
    assert.equal(nearestMatch(matches, 199), 0)
    assert.equal(nearestMatch(matches, 201), 1)
})

test('a coordinate past either end lands on the match at that end', () => {
    const matches = [[100, 105, 'a'], [9000, 9005, 'a']]
    assert.equal(nearestMatch(matches, 1), 0)
    assert.equal(nearestMatch(matches, 99_999), 1)
})

test('the first of two equally near matches wins, which is the earlier one', () => {
    // Reading order put the higher-priority match first where two share a
    // start, so a tie goes to the one the reader can see.
    const matches = [[100, 105, 'a'], [100, 110, 'b']]
    assert.equal(nearestMatch(matches, 100), 0)
})

test('nothing to start from starts at the beginning, and nothing at all is nowhere', () => {
    assert.equal(nearestMatch([[7, 9, 'a']], null), 0, 'an unmeasured viewport')
    assert.equal(nearestMatch([], 500), -1)
    assert.equal(nearestMatch(null, 500), -1)
})

// ---- stepping through them ------------------------------------------------

test('stepping wraps at both ends, the way a find box does', () => {
    assert.equal(stepMatch(0, 3, 1), 1)
    assert.equal(stepMatch(2, 3, 1), 0, 'past the last is the first')
    assert.equal(stepMatch(0, 3, -1), 2, 'before the first is the last')
})

test('nowhere to go is told apart from at the beginning', () => {
    assert.equal(stepMatch(-1, 0, 1), -1, 'no matches at all')
    assert.equal(stepMatch(-1, 3, 1), 0, 'not started yet: forward is the first')
    assert.equal(stepMatch(-1, 3, -1), 2, 'and back is the last')
})

test('a long pattern is shortened for a control that must not change width', () => {
    assert.equal(shortPattern('ATG'), 'ATG', 'a short one is untouched')
    assert.equal(shortPattern('ATGGCCTA'), 'ATGGCCTA', 'and so is one exactly at the limit')
    assert.equal(shortPattern('ATG[ACGT]{3}TTGCA'), 'ATG[ACGT…')
    assert.equal(shortPattern(''), '')
    assert.equal(shortPattern(null), '')
    // Whatever the limit, the result never runs past it by more than the mark
    // that says it was cut.
    for (const max of [1, 4, 12]) {
        assert.ok(shortPattern('A'.repeat(500), max).length <= max + 1, `at ${max}`)
    }
})

test('the label says what a find box says', () => {
    assert.equal(matchLabel(-1, 0), 'No matches', 'rather than 0 of 0')
    assert.equal(matchLabel(-1, 1), '1 match')
    assert.equal(matchLabel(-1, 148), '148 matches')
    assert.equal(matchLabel(2, 148), '3 of 148', 'counted from one, as a reader counts')
    assert.equal(matchLabel(2, 148, { truncated: true }), '3 of 148+')
})

test('a span is found by binary search wherever it is in the list', () => {
    const spans = [[0, 5, '#a'], [10, 20, '#b'], [30, 40, '#c']]
    assert.equal(firstSpanAt(spans, 0), 0)
    assert.equal(firstSpanAt(spans, 12), 1)
    assert.equal(firstSpanAt(spans, 100), 3, 'past the end is past the end')
})

// ---- the two views share one model ----------------------------------------

test('the explorer and the sequence view resolve overlaps identically', () => {
    // The explorer spells the field `color`; the model spells it `colour`. What
    // they may not differ on is which pattern wins.
    const spans = { a: [[2, 5]], b: [[0, 4], [4, 8]] }
    const asExplorer = patterns.map(({ colour, ...rest }) => ({ ...rest, color: colour }))
    assert.deepEqual(resolveMotifSpans(asExplorer, spans), resolvePatternSpans(patterns, spans))
})

test('an explorer list stored before the rename still loads', () => {
    let held = JSON.stringify([
        { id: 'a', pattern: 'ATG', kind: 'literal', enabled: true, color: '#3366cc' },
    ])
    const storage = { getItem: () => held, setItem: (_, next) => { held = next } }
    const [only] = loadMotifs(storage)
    assert.equal(only.pattern, 'ATG')
    assert.equal(only.color, '#3366cc', 'and comes back spelt the way that view spells it')
    assert.equal(saveMotifs([only], storage), true)
    assert.equal(loadMotifs(storage)[0].color, '#3366cc', 'round trip')
})

test('the explorer still reorders through the shared model', () => {
    const asExplorer = patterns.map(({ colour, ...rest }) => ({ ...rest, color: colour }))
    assert.deepEqual(moveMotif(asExplorer, 'a', 'b').map((item) => item.id), ['b', 'a'])
})
