import assert from 'node:assert/strict'
import test from 'node:test'

import {
    noteBubbleGlyphMetrics,
    noteBubbleGlyphPaths,
    noteBubbleGlyphSvgMarkup,
} from '../src/utils/noteBubbleGlyph.js'

const numbersIn = (d) => (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)

// ---------------------------------------------------------------------------
// noteBubbleGlyphMetrics

test('the stroke is held to a legible weight as the bubble shrinks', () => {
    // The point of clamping: at the 14px the canvas overlay uses, a freely
    // scaling weight lands near 1px and the tail stops reading as a tail.
    assert.ok(noteBubbleGlyphMetrics(10).stroke >= 1.5)
    assert.ok(noteBubbleGlyphMetrics(14).stroke >= 1.5)
    assert.ok(noteBubbleGlyphMetrics(64).stroke <= 2.2)
})

test('metrics reject a nonsensical size', () => {
    for (const bad of [0, -4, Number.NaN, undefined, null, 'big']) {
        assert.equal(noteBubbleGlyphMetrics(bad), null)
    }
})

// ---------------------------------------------------------------------------
// noteBubbleGlyphPaths

test('the body is one closed path so a filled bubble reads as one silhouette', () => {
    const { body } = noteBubbleGlyphPaths(24)
    assert.ok(body.startsWith('M '))
    assert.ok(body.trimEnd().endsWith('Z'), 'body path is not closed')
    assert.equal((body.match(/M /g) || []).length, 1, 'body must be a single subpath')
})

test('the tail drops below the body', () => {
    const paths = noteBubbleGlyphPaths(24)
    const ys = numbersIn(paths.body)
    // The body bottom is at 17 in the 24-unit authoring box; the tail reaches 21.
    assert.ok(Math.max(...ys) > 17, 'tail does not extend past the body')
    assert.ok(Math.max(...ys) <= 24, 'tail overflows the box')
})

test('the two rules sit inside the body and the lower one is shorter', () => {
    const [first, second] = noteBubbleGlyphPaths(24).lines
    const [x0, y0, x1] = numbersIn(first)
    const [x2, y2, x3] = numbersIn(second)

    assert.ok(y0 < y2, 'rules are not stacked')
    assert.ok(y0 > 3 && y2 < 17, 'rules fall outside the body')
    assert.equal(x0, x2, 'rules are not left-aligned')
    assert.ok((x3 - x2) < (x1 - x0), 'the lower rule should be the shorter one')
})

test('every path scales with the box', () => {
    const small = numbersIn(noteBubbleGlyphPaths(14).body)
    const large = numbersIn(noteBubbleGlyphPaths(28).body)
    assert.equal(small.length, large.length)
    for (let i = 0; i < small.length; i += 1) {
        // Arc flags are literal 0/1 and do not scale.
        if (small[i] === 0 || small[i] === 1) continue
        assert.ok(large[i] > small[i], `coordinate ${i} did not grow`)
    }
})

test('paths pass a bad size through as null', () => {
    assert.equal(noteBubbleGlyphPaths(0), null)
    assert.equal(noteBubbleGlyphPaths(Number.NaN), null)
})

// ---------------------------------------------------------------------------
// noteBubbleGlyphSvgMarkup

test('the export markup draws the same three paths the component does', () => {
    const paths = noteBubbleGlyphPaths(16)
    const markup = noteBubbleGlyphSvgMarkup({ x: 40, y: 20, size: 16, color: '#3366cc' })

    assert.equal((markup.match(/<path /g) || []).length, 3)
    assert.ok(markup.includes(`d="${paths.body}"`), 'export body differs from the shared path data')
    for (const line of paths.lines) assert.ok(markup.includes(`d="${line}"`))
    assert.ok(markup.includes(`stroke-width="${paths.stroke}"`))
})

test('an outline bubble is not filled; a filled one knocks its rules out', () => {
    const outline = noteBubbleGlyphSvgMarkup({ x: 0, y: 0, size: 16, color: '#3366cc' })
    assert.ok(!outline.includes('fill="#3366cc"'), 'outline bubble should not be filled')
    assert.ok(outline.includes('stroke="#3366cc"'))

    const filled = noteBubbleGlyphSvgMarkup({ x: 0, y: 0, size: 16, color: '#3366cc', fill: true, knockout: '#ffffff' })
    assert.ok(filled.includes('fill="#3366cc"'), 'filled bubble should paint its body')
    assert.ok(filled.includes('stroke="#ffffff"'), 'rules should be knocked out of a filled body')
})

test('the export markup centres the bubble on the given point', () => {
    const markup = noteBubbleGlyphSvgMarkup({ x: 40, y: 20, size: 16, color: '#000' })
    assert.ok(markup.includes('translate(32 12)'), markup.slice(0, 80))
})

test('the export markup yields nothing for a bad size', () => {
    assert.equal(noteBubbleGlyphSvgMarkup({ x: 0, y: 0, size: 0, color: '#000' }), '')
})
