import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_GENOME_COLOR_PALETTE,
  DEFAULT_GENOME_COLOR,
  MAX_CUSTOM_GENOME_COLORS,
  assignGenomeColors,
  genomeColorConfigPatch,
  genomeColorKey,
  genomeColorPalette,
  genomeColorResolver,
  migrateLegacyGenomeColors,
  normalizeCustomGenomeColors,
  normalizeGenomeColorAssignments,
  normalizeGenomeDefaultColor,
  pruneGenomeColorAssignments,
  resolveGenomeColor,
  sanitizeHexColor,
  sharedGenomeColor,
  withCustomGenomeColor,
  withoutCustomGenomeColor,
} from '../src/genomeColorSchemes.js'

const human = { provider: 'ensembl', species_key: 'homo_sapiens', assembly: 'GCA_000001405.29' }
const mouse = { provider: 'ensembl', species_key: 'mus_musculus', assembly: 'GCA_000001635.9' }
const humanKey = genomeColorKey(human)
const mouseKey = genomeColorKey(mouse)

test('the built-in palette offers ten distinct colours, led by the default', () => {
  assert.equal(BUILTIN_GENOME_COLOR_PALETTE.length, 10)
  assert.equal(new Set(BUILTIN_GENOME_COLOR_PALETTE).size, 10)
  assert.equal(BUILTIN_GENOME_COLOR_PALETTE[0], DEFAULT_GENOME_COLOR)
  for (const color of BUILTIN_GENOME_COLOR_PALETTE) {
    assert.match(color, /^#[0-9a-f]{6}$/)
  }
})

test('sanitizeHexColor accepts long and short hex and rejects everything else', () => {
  assert.equal(sanitizeHexColor('#AABBCC'), '#aabbcc')
  assert.equal(sanitizeHexColor('  #f80  '), '#ff8800')
  assert.equal(sanitizeHexColor('rebeccapurple', ''), '')
  assert.equal(sanitizeHexColor(null), DEFAULT_GENOME_COLOR)
  assert.equal(normalizeGenomeDefaultColor('not a colour'), DEFAULT_GENOME_COLOR)
})

test('a genome with no colour of its own wears the configured default', () => {
  assert.equal(resolveGenomeColor({}, human), DEFAULT_GENOME_COLOR)
  assert.equal(resolveGenomeColor({ genome_default_color: '#123456' }, human), '#123456')
})

test('a colour is keyed on the assembly, so a dataset release does not change it', () => {
  const config = { genome_colors: { [humanKey]: '#f59e0b' } }
  assert.equal(resolveGenomeColor(config, human), '#f59e0b')
  assert.equal(resolveGenomeColor(config, { ...human, dataset_release: '110' }), '#f59e0b')
  assert.equal(resolveGenomeColor(config, mouse), DEFAULT_GENOME_COLOR)
})

test('a colour follows the genome rather than its position in the active set', () => {
  const config = { genome_colors: { [humanKey]: '#ec4899', [mouseKey]: '#84cc16' } }
  const resolve = genomeColorResolver(config)
  assert.deepEqual([human, mouse].map(resolve), ['#ec4899', '#84cc16'])
  assert.deepEqual([mouse, human].map(resolve), ['#84cc16', '#ec4899'])
})

test('a tutorial genome keeps the colour its script assigned', () => {
  const config = { genome_colors: { [humanKey]: '#ec4899' }, genome_default_color: '#111111' }
  assert.equal(resolveGenomeColor(config, { ...human, tutorial_color_index: 1 }), BUILTIN_GENOME_COLOR_PALETTE[1])
  assert.equal(genomeColorResolver(config)({ ...mouse, tutorial_color_index: 0 }), BUILTIN_GENOME_COLOR_PALETTE[0])
})

test('assigning the default colour clears the entry rather than storing it', () => {
  const assigned = assignGenomeColors({}, [human], '#f59e0b', '#3366cc')
  assert.deepEqual(assigned, { [humanKey]: '#f59e0b' })
  const cleared = assignGenomeColors(assigned, [human], '#3366cc', '#3366cc')
  assert.deepEqual(cleared, {})
})

test('a bulk assignment paints every genome it is given', () => {
  const assigned = assignGenomeColors({}, [human, mouse], '#0ea5e9')
  assert.deepEqual(assigned, { [humanKey]: '#0ea5e9', [mouseKey]: '#0ea5e9' })
})

test('sharedGenomeColor reports one colour only when the set agrees', () => {
  const config = { genome_colors: { [humanKey]: '#ec4899', [mouseKey]: '#ec4899' } }
  assert.equal(sharedGenomeColor(config, [human, mouse]), '#ec4899')
  assert.equal(sharedGenomeColor({ genome_colors: { [humanKey]: '#ec4899' } }, [human, mouse]), '')
  assert.equal(sharedGenomeColor(config, []), '')
})

test('the palette holds the built-ins plus the user\'s own, without duplicates', () => {
  const palette = genomeColorPalette({ genome_color_palette: ['#123456', '#3366cc', '#123456'] })
  assert.deepEqual(palette, [...BUILTIN_GENOME_COLOR_PALETTE, '#123456'])
  assert.deepEqual(normalizeCustomGenomeColors(['#00b692', 'nope', '#abc']), ['#aabbcc'])
})

test('a freshly mixed colour goes to the front of a full palette', () => {
  const full = Array.from({ length: MAX_CUSTOM_GENOME_COLORS }, (_, index) => (
    `#${String(index + 16).padStart(2, '0')}0000`
  ))
  const next = withCustomGenomeColor(full, '#ff00ff')
  assert.equal(next.length, MAX_CUSTOM_GENOME_COLORS)
  assert.equal(next[0], '#ff00ff')
  assert.equal(withCustomGenomeColor(['#123456'], '#3366cc').length, 1)
  assert.deepEqual(withoutCustomGenomeColor(['#123456', '#654321'], '#123456'), ['#654321'])
})

test('applying a colour assigns it and remembers a custom one', () => {
  const config = { genome_default_color: '#3366cc', genome_color_palette: [] }
  const patch = genomeColorConfigPatch(config, [human], '#abcdef')
  assert.deepEqual(patch.genome_colors, { [humanKey]: '#abcdef' })
  assert.deepEqual(patch.genome_color_palette, ['#abcdef'])
  // A built-in colour is already offered, so it does not join the custom row.
  assert.deepEqual(genomeColorConfigPatch(config, [human], '#f59e0b').genome_color_palette, [])
  assert.equal(genomeColorConfigPatch(config, [human], 'nonsense'), null)
})

test('assignments for genomes that are gone are dropped', () => {
  const assignments = { [humanKey]: '#ec4899', [mouseKey]: '#84cc16' }
  assert.deepEqual(pruneGenomeColorAssignments(assignments, [human]), { [humanKey]: '#ec4899' })
  assert.deepEqual(normalizeGenomeColorAssignments({ '': '#fff000', ok: 'bad' }), {})
})

test('the old positional list becomes a default colour and a palette', () => {
  const migrated = migrateLegacyGenomeColors({
    genome_browser_colors: ['#3366cc', '#00b692', '#f59e0b', '#ec4899', '#8b5cf6', '#123456'],
  })
  assert.equal(migrated.genome_default_color, '#3366cc')
  assert.deepEqual(migrated.genome_colors, {})
  // Only the colour that is not already built in survives as a custom one.
  assert.deepEqual(migrated.genome_color_palette, ['#123456'])
})

test('migration leaves a configuration that already knows its colours alone', () => {
  const migrated = migrateLegacyGenomeColors({
    genome_browser_colors: ['#000000', '#111111'],
    genome_default_color: '#8b5cf6',
    genome_colors: { [humanKey]: '#0ea5e9' },
    genome_color_palette: ['#654321'],
  })
  assert.deepEqual(migrated, {
    genome_default_color: '#8b5cf6',
    genome_colors: { [humanKey]: '#0ea5e9' },
    genome_color_palette: ['#654321'],
  })
})
