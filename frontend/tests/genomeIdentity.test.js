import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getGenomeKey,
  genomeKeysMatch,
  trackAssemblyKey,
} from '../src/utils/genomeIdentity.js'

test('getGenomeKey falls back to explicit catalog keys when canonical fields are absent', () => {
  const species = {
    key: 'ensembl::homo_sapiens::GCA_018472595.2',
    genome_key: 'ensembl::homo_sapiens::GCA_018472595.2',
    assembly_name: '',
  }

  assert.equal(getGenomeKey(species), 'ensembl::homo_sapiens::GCA_018472595.2')
  assert.equal(genomeKeysMatch(species, 'homo_sapiens::GCA_018472595.2'), true)
})

test('a track belongs to its assembly, whichever annotation release it was registered with', () => {
  const assembly = 'ensembl::Homo_sapiens::GCA_000001405.29'
  assert.equal(trackAssemblyKey(`${assembly}::dataset::ensembl/2025_12`), assembly)
  assert.equal(trackAssemblyKey(assembly), assembly)
  assert.equal(trackAssemblyKey(''), '')
  assert.equal(trackAssemblyKey(null), '')
  // Two releases of one assembly group together; another assembly does not join them.
  assert.equal(trackAssemblyKey(`${assembly}::dataset::ensembl/2025_12`), trackAssemblyKey(`${assembly}::dataset::ensembl/2024_03`))
  assert.notEqual(trackAssemblyKey(assembly), trackAssemblyKey('ensembl::Homo_sapiens::GCA_009914755.4::dataset::ensembl/2022_07'))
  // And a panel on another release of the same assembly still takes the track.
  const panel = { provider: 'ensembl', species_key: 'Homo_sapiens', assembly: 'GCA_000001405.29', dataset_release_key: 'ensembl/2024_03' }
  assert.equal(genomeKeysMatch(trackAssemblyKey(`${assembly}::dataset::ensembl/2025_12`), panel), true)
})
