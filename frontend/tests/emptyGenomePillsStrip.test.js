import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const app = read('../src/App.jsx')
const pills = read('../src/components/SelectedSpeciesPillsBar.jsx')
const message = read('../src/components/NoGenomesPillsMessage.jsx')

// The components are .jsx, which node cannot import, so the constants are read out of
// the source the same way the tutorial suite reads the markup it guards.
const constantIn = (source, name) => {
  const match = source.match(new RegExp(`export const ${name} = ([^\\n]+)`))
  return match ? match[1].trim() : null
}

// ---------------------------------------------------------------------------
// The strip holds its place when it is empty
// ---------------------------------------------------------------------------

test('the strip is exactly as tall with no genomes as with some', () => {
  // The whole point of putting a message here rather than dropping the strip: the
  // header keeps one height, so nothing below it moves when a first genome arrives.
  assert.match(
    pills,
    /style=\{\{ minHeight: PILL_CONTENT_HEIGHT \}\}/,
    'the empty row does not hold the pills’ own height',
  )
})

test('the reserved row height is derived from the pills, not typed in twice', () => {
  // It used to be a bare 46 with the arithmetic only in a comment, so trimming the
  // row padding would have left the tutorial reserving a height nothing else used.
  const contentHeight = Number(constantIn(pills, 'PILL_CONTENT_HEIGHT'))
  assert.ok(Number.isFinite(contentHeight), 'PILL_CONTENT_HEIGHT is no longer a plain number')
  assert.equal(constantIn(pills, 'PILLS_ROW_HEIGHT'), 'PILL_CONTENT_HEIGHT + 4 + 2')
})

test('the row padding under the pills matches the height the constant claims', () => {
  // The badge already sits at the foot of each pill; a full `py-1` beneath it read as
  // a gap. If this padding changes, PILLS_ROW_HEIGHT above has to change with it.
  assert.match(pills, /px-1 pt-1 pb-0\.5 /)
})

// ---------------------------------------------------------------------------
// What it says, and where it sends you
// ---------------------------------------------------------------------------

test('the message names both routes to a genome and can open either', () => {
  assert.match(message, /No genomes selected\./)
  assert.match(message, /to fetch data and/)
  assert.match(message, /to add local genomes to the current session\./)
  assert.match(message, /buttonId="download"[\s\S]*?onOpenView\('download'\)/)
  assert.match(message, /buttonId="genome_selector"[\s\S]*?onOpenView\('genome_selector'\)/)
})

test('the inline button is the header button scaled, not a re-drawn one', () => {
  // Each icon is sized against the 44px header button it lives in, so shrinking the box
  // alone would leave the icon at the wrong weight inside it. Scaling the whole thing is
  // what keeps the proportions the reader recognises the button by.
  assert.match(message, /const INLINE_SCALE = INLINE_BUTTON_SIZE \/ HEADER_BUTTON_SIZE/)
  assert.match(message, /transform: `scale\(\$\{INLINE_SCALE\}\)`/)
  assert.match(message, /borderRadius: Math\.round\(8 \* INLINE_SCALE\)/)
})

test('the button carries only the icon; the name sits beside it', () => {
  const buttonMarkup = message.slice(message.indexOf('<button'), message.indexOf('</button>'))
  assert.match(buttonMarkup, /<AppButtonIcon buttonId=\{buttonId\} isLight=\{isLight\} \/>/)
  // `${label}` in the title and aria-label is fine — that names the button for a
  // reader who cannot see it. A bare `{label}` would be the name rendered inside it.
  assert.doesNotMatch(buttonMarkup, /(?<!\$)\{label\}/, 'the label is back inside the button')
  // The names are still there, as text in the sentence rather than as button contents.
  assert.match(message, /<span className="font-semibold">Download<\/span>/)
  assert.match(message, /<span className="font-semibold">Genome Selector<\/span>/)
})

test('the buttons go through the same handler as the header buttons', () => {
  // Not a second navigation path that could drift from the real one.
  assert.match(app, /onOpenView=\{handleTopBarButtonClick\}/)
})

// ---------------------------------------------------------------------------
// Tutorials keep the behaviour they had
// ---------------------------------------------------------------------------

test('a tutorial gets the blank reservation, never the message', () => {
  // A tutorial sandbox starts with no pills deliberately and adds its own; telling the
  // reader to go and download a genome is the opposite of what the step is teaching.
  assert.match(app, /const showNoGenomesMessage = topBarSpecies\.length === 0 && !tutorialConfig/)
  assert.match(app, /visibility: \(topBarSpecies\.length === 0 && !showNoGenomesMessage\) \? 'hidden' : undefined/)
})

test('the header keeps its full bottom padding when there is no strip under it', () => {
  // The trimmed padding is there to sit under the assembly badges. With the header
  // collapsed, or the strip gone, the button rows still want the room.
  assert.match(app, /pt-4 \$\{showsPillsStrip \? 'pb-2' : 'pb-4'\}/)
})
