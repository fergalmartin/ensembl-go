import assert from 'node:assert/strict'
import test from 'node:test'

import { getGenomeKey, genomeKeysMatch } from '../src/utils/genomeIdentity.js'

test('getGenomeKey falls back to explicit catalog keys when canonical fields are absent', () => {
  const species = {
    key: 'ensembl::homo_sapiens::GCA_018472595.2',
    genome_key: 'ensembl::homo_sapiens::GCA_018472595.2',
    assembly_name: '',
  }

  assert.equal(getGenomeKey(species), 'ensembl::homo_sapiens::GCA_018472595.2')
  assert.equal(genomeKeysMatch(species, 'homo_sapiens::GCA_018472595.2'), true)
})
