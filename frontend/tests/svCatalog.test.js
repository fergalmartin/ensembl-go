import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAvailableSvAlignmentRows,
  catalogGenomeMatchesSpecies,
  findSvAlignment,
  getOutgoingSvAlignments,
  resolveCatalogGenomeForSpecies,
} from '../src/utils/svCatalog.js'

const grch38Species = {
  key: 'ensembl::Homo_sapiens::GCA_000001405.29',
  provider: 'ensembl',
  species_key: 'homo_sapiens',
  assembly: 'GCA_000001405.29',
  assembly_name: 'GRCh38.p14',
  equivalent_accessions: ['GCF_000001405.40'],
}

const hg00438Species = {
  key: 'ensembl::Homo_sapiens::GCA_018472595.2',
  provider: 'ensembl',
  species_key: 'homo_sapiens',
  assembly: 'GCA_018472595.2',
  assembly_name: 'HG00438_pat_hprc_f2',
}

const hg00733Species = {
  key: 'ensembl::Homo_sapiens::GCA_018506975.3',
  provider: 'ensembl',
  species_key: 'homo_sapiens',
  assembly: 'GCA_018506975.3',
  assembly_name: 'HG00733_mat_hprc_f2',
}

const chm13Species = {
  key: 'ensembl::Homo_sapiens::GCA_009914755.4',
  provider: 'ensembl',
  species_key: 'Homo_sapiens',
  assembly: 'GCA_009914755.4',
  assembly_name: 'T2T-CHM13v2.0',
  display_name: 'Human',
  common_name: 'Human',
}

const catalog = {
  genomes: [
    {
      id: 'grch38',
      assembly: 'GCA_000001405.29',
      assembly_name: 'GRCh38.p14',
      aliases: ['GRCh38', 'GCF_000001405.40'],
    },
    {
      id: 'hg00438',
      assembly: 'GCA_018472595.2',
      assembly_name: 'HG00438_pat_hprc_f2',
      aliases: ['HG00438'],
    },
    {
      id: 'hg00733',
      assembly: 'GCA_018506975.2',
      assembly_name: 'HG00733_mat_hprc_f2',
      aliases: ['HG00733', 'GCA_018506975.3'],
    },
  ],
  alignments: [
    {
      id: 'grch38_hg00438',
      supported: true,
      reference_genome: {
        assembly: 'GCA_000001405.29',
        assembly_name: 'GRCh38.p14',
        aliases: ['GRCh38'],
      },
      target_genome: {
        assembly: 'GCA_018472595.2',
        assembly_name: 'HG00438_pat_hprc_f2',
        aliases: ['HG00438'],
      },
    },
    {
      id: 'grch38_hg00733',
      supported: true,
      reference_genome: {
        assembly: 'GCA_000001405.29',
        assembly_name: 'GRCh38.p14',
        aliases: ['GRCh38'],
      },
      target_genome: {
        assembly: 'GCA_018506975.2',
        assembly_name: 'HG00733_mat_hprc_f2',
        aliases: ['HG00733', 'GCA_018506975.3'],
      },
    },
  ],
}

test('catalog genome matching accepts equivalent accessions', () => {
  assert.equal(catalogGenomeMatchesSpecies(catalog.genomes[0], grch38Species), true)
  assert.equal(resolveCatalogGenomeForSpecies(catalog, hg00733Species)?.id, 'hg00733')
})

test('catalog genome matching ignores weak species-only human matches', () => {
  assert.equal(catalogGenomeMatchesSpecies(catalog.genomes[0], chm13Species), false)
  assert.equal(catalogGenomeMatchesSpecies(catalog.genomes[1], grch38Species), false)
})

test('alignment lookup is directed from anchor to target', () => {
  assert.equal(findSvAlignment(catalog, grch38Species, hg00438Species)?.id, 'grch38_hg00438')
  assert.equal(findSvAlignment(catalog, hg00438Species, grch38Species), null)
})

test('outgoing alignments filter by selected anchor', () => {
  assert.deepEqual(
    getOutgoingSvAlignments(catalog, grch38Species).map((alignment) => alignment.id),
    ['grch38_hg00438', 'grch38_hg00733'],
  )
  assert.deepEqual(getOutgoingSvAlignments(catalog, hg00438Species), [])
})

test('available alignment rows report active, inactive, and use actions', () => {
  const rows = buildAvailableSvAlignmentRows(catalog, [grch38Species], [hg00438Species])
  const hg00438Row = rows.find((row) => row.id === 'grch38_hg00438')
  const hg00733Row = rows.find((row) => row.id === 'grch38_hg00733')

  assert.equal(hg00438Row.status, 'usable')
  assert.equal(hg00438Row.reference.isActive, true)
  assert.equal(hg00438Row.target.isSelected, true)
  assert.equal(hg00438Row.canUse, true)

  assert.equal(hg00733Row.status, 'unavailable')
  assert.equal(hg00733Row.target.isLocal, false)
  assert.equal(hg00733Row.canUse, false)
})

test('available alignment rows expose downloadable genomes and missing-file diagnostics', () => {
  const downloadableCatalog = {
    alignments: [
      {
        id: 'grch38_downloadable',
        supported: true,
        reference_genome: catalog.alignments[0].reference_genome,
        target_genome: {
          id: 'downloadable-target',
          assembly: 'GCA_999999999.1',
          assembly_name: 'DownloadableTarget',
          downloadable: true,
        },
        reference_regions: [{ id: '1' }, { id: '2' }],
      },
      {
        id: 'missing_alignment',
        supported: false,
        missing_files: ['BigChain: /missing.chain'],
        reference_genome: catalog.alignments[0].reference_genome,
        target_genome: catalog.alignments[0].target_genome,
      },
    ],
  }

  const rows = buildAvailableSvAlignmentRows(downloadableCatalog, [grch38Species], [hg00438Species])
  const downloadable = rows.find((row) => row.id === 'grch38_downloadable')
  const missing = rows.find((row) => row.id === 'missing_alignment')

  assert.equal(downloadable.status, 'downloadable')
  assert.equal(downloadable.regionCount, 2)
  assert.equal(downloadable.canDownloadTarget, true)
  assert.equal(downloadable.canUse, false)

  assert.equal(missing.status, 'missing_files')
  assert.deepEqual(missing.missingFiles, ['BigChain: /missing.chain'])
  assert.equal(missing.canUse, false)
})
