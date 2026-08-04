import assert from 'node:assert/strict'
import test from 'node:test'

import { deregisterGenomesFromConfig, removalKeyCandidates } from '../src/utils/genomeDeregistration.js'

const genome = (overrides = {}) => ({
  species_key: 'Homo_sapiens',
  assembly: 'GCA_000001405.29',
  provider: 'ensembl',
  files: { fasta: '/data/human.fa', gff3: '/data/human.gff3' },
  ...overrides,
})

const baseConfig = (overrides = {}) => ({
  active_species: [genome()],
  manual_species: [],
  next_previous_session_genomes: [genome()],
  genome_analysis_reports: {
    'ensembl::Homo_sapiens::GCA_000001405.29': { fasta: { status: 'ok' }, gff3: { status: 'ok' } },
  },
  genome_file_overrides: {
    'ensembl::Homo_sapiens::GCA_000001405.29': { gff3: '/data/other.gff3' },
  },
  genome_playlists: [
    { id: 'p1', name: 'Mine', genomes: [genome(), genome({ species_key: 'Mus_musculus', assembly: 'GCA_000001635.9' })] },
  ],
  ref_fasta: '/data/human.fa',
  ref_gff: '/data/human.gff3',
  ref_index: '/data/human.gff3.index.db',
  homologies_file: '/data/human.homology.tsv.gz',
  ...overrides,
})

test('a removed genome leaves every list that referred to it', () => {
  const { config, changed } = deregisterGenomesFromConfig(baseConfig(), [genome()])

  assert.equal(changed, true)
  assert.deepEqual(config.active_species, [])
  assert.deepEqual(config.next_previous_session_genomes, [])
  assert.deepEqual(config.genome_analysis_reports, {})
  assert.deepEqual(config.genome_file_overrides, {})
  assert.ok(config.deregistered_genome_keys.some((key) => key.includes('Homo_sapiens')))
})

test('playlists lose the genome but are never themselves deleted', () => {
  // An emptied playlist is still the user's, and the backend restores the
  // previous list when an empty one arrives without an explicit clear.
  const config = baseConfig({
    genome_playlists: [{ id: 'p1', name: 'Only human', genomes: [genome()] }],
  })

  const result = deregisterGenomesFromConfig(config, [genome()])

  assert.equal(result.config.genome_playlists.length, 1)
  assert.equal(result.config.genome_playlists[0].name, 'Only human')
  assert.deepEqual(result.config.genome_playlists[0].genomes, [])
})

test('other playlist members are untouched', () => {
  const result = deregisterGenomesFromConfig(baseConfig(), [genome()])
  const members = result.config.genome_playlists[0].genomes
  assert.equal(members.length, 1)
  assert.equal(members[0].species_key, 'Mus_musculus')
})

test('ref pointers are cleared when the genome that owned them goes', () => {
  const result = deregisterGenomesFromConfig(baseConfig(), [genome()])

  assert.equal(result.config.ref_fasta, '')
  assert.equal(result.config.ref_gff, '')
  assert.equal(result.config.ref_index, '')
  assert.equal(result.config.homologies_file, '')
})

test('ref pointers belonging to a genome that stays are left alone', () => {
  const mouse = genome({ species_key: 'Mus_musculus', assembly: 'GCA_000001635.9', files: { fasta: '/data/mouse.fa', gff3: '/data/mouse.gff3' } })
  const config = baseConfig({ active_species: [genome(), mouse] })

  const result = deregisterGenomesFromConfig(config, [mouse])

  assert.equal(result.config.ref_gff, '/data/human.gff3')
  assert.equal(result.config.active_species.length, 1)
})

test('a manually added genome leaves manual_species', () => {
  const manual = genome({ species_key: 'My_species', assembly: 'asm1', provider: 'manual', is_manual: true })
  const config = baseConfig({ manual_species: [manual], active_species: [manual] })

  const result = deregisterGenomesFromConfig(config, [manual])

  assert.deepEqual(result.config.manual_species, [])
  assert.deepEqual(result.config.active_species, [])
})

test('entries stored under a legacy key form are still matched', () => {
  const config = baseConfig({
    genome_analysis_reports: { 'Homo_sapiens::GCA_000001405.29': { fasta: { status: 'ok' } } },
    genome_file_overrides: { 'Homo_sapiens::GCA_000001405.29': { gff3: '/data/other.gff3' } },
  })

  const result = deregisterGenomesFromConfig(config, [genome()])

  assert.deepEqual(result.config.genome_analysis_reports, {})
  assert.deepEqual(result.config.genome_file_overrides, {})
})

test('the removed keys are reported so App can prune its own selection', () => {
  const result = deregisterGenomesFromConfig(baseConfig(), [genome()])

  assert.ok(result.removedKeys.includes('ensembl::Homo_sapiens::GCA_000001405.29'))
  assert.deepEqual(result.config.__removed_genome_keys, result.removedKeys)
})

test('removing a filesystem-discovered genome records it even if it is not selected', () => {
  const config = baseConfig()
  const result = deregisterGenomesFromConfig(config, [
    genome({ species_key: 'Danio_rerio', assembly: 'GCA_000002035.4', files: {} }),
  ])

  assert.equal(result.changed, true)
  assert.notEqual(result.config, config)
  assert.ok(result.config.deregistered_genome_keys.some((key) => key.includes('Danio_rerio')))
})

test('deregistering an already inactive downloaded genome still records it as hidden', () => {
  const config = baseConfig({
    active_species: [],
    next_previous_session_genomes: [],
    genome_analysis_reports: {},
    genome_file_overrides: {},
    genome_playlists: [],
    ref_fasta: '',
    ref_gff: '',
    ref_index: '',
    homologies_file: '',
  })

  const result = deregisterGenomesFromConfig(config, [genome()])

  assert.equal(result.changed, true)
  assert.ok(result.config.deregistered_genome_keys.length > 0)
})

test('an empty target list is a no-op', () => {
  const config = baseConfig()
  assert.equal(deregisterGenomesFromConfig(config, []).config, config)
})

test('a hidden playlist the caller cannot see is carried through untouched', () => {
  // The selector renders a config with the app's internal playlists filtered
  // out. Deregistering has to be computed against the whole config, or writing
  // the result back deletes the playlists that were merely not on screen.
  const config = baseConfig({
    genome_playlists: [
      { id: 'p1', name: 'Mine', genomes: [genome()] },
      { id: 'previous-session', name: 'Previous session', hidden: true, genomes: [genome()] },
    ],
  })

  const result = deregisterGenomesFromConfig(config, [genome()])

  assert.equal(result.config.genome_playlists.length, 2)
  const hidden = result.config.genome_playlists.find((playlist) => playlist.hidden)
  assert.ok(hidden, 'the hidden playlist was dropped')
  assert.deepEqual(hidden.genomes, [], 'the hidden playlist kept a genome that was removed')
})

test('deregistering twice keeps one hidden key rather than accumulating duplicates', () => {
  const first = deregisterGenomesFromConfig(baseConfig(), [genome()])
  const second = deregisterGenomesFromConfig(first.config, [genome()])

  assert.deepEqual(second.config.deregistered_genome_keys, first.config.deregistered_genome_keys)
  assert.equal(second.changed, false, 'a repeat removal reported a change with nothing left to change')
})

test('a genome removed while another is being kept does not take the other with it', () => {
  const mouse = genome({ species_key: 'Mus_musculus', assembly: 'GCA_000001635.9' })
  const config = baseConfig({ active_species: [genome(), mouse] })

  const result = deregisterGenomesFromConfig(config, [genome()])

  assert.equal(result.config.active_species.length, 1)
  assert.equal(result.config.active_species[0].species_key, 'Mus_musculus')
  assert.ok(
    !result.config.deregistered_genome_keys.some((key) => key.includes('Mus_musculus')),
    'the surviving genome was recorded as deregistered',
  )
})

test('key candidates cover the selection, assembly and legacy forms', () => {
  const keys = removalKeyCandidates([genome({ selection_key: 'ensembl::Homo_sapiens::GCA_000001405.29::dataset::ensembl/2025_12' })])
  assert.ok(keys.includes('ensembl::Homo_sapiens::GCA_000001405.29::dataset::ensembl/2025_12'))
  assert.ok(keys.includes('ensembl::Homo_sapiens::GCA_000001405.29'))
})
