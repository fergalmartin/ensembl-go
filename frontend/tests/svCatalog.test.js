import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAvailableSvAlignmentRows,
  buildSvGenomeOptions,
  buildSvPairIndex,
  catalogGenomeMatchesSpecies,
  findSvAlignment,
  formatSvGenomeOptionLabel,
  getOutgoingSvAlignments,
  getSvAlignmentsForPair,
  resolveCatalogGenomeForSpecies,
  speciesGenomeKey,
} from '../src/utils/svCatalog.js'

const grch38Species = {
  key: 'ensembl::Homo_sapiens::GCA_000001405.29',
  provider: 'ensembl',
  species_key: 'homo_sapiens',
  assembly: 'GCA_000001405.29',
  assembly_name: 'GRCh38.p14',
  display_name: 'Human',
  common_name: 'Human',
  scientific_name: 'Homo sapiens',
  aliases: ['Human', 'Homo sapiens'],
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
      display_name: 'Human',
      common_name: 'Human',
      scientific_name: 'Homo sapiens',
      aliases: ['GRCh38', 'GCF_000001405.40', 'Human', 'Homo sapiens'],
    },
    {
      id: 'hg00438',
      assembly: 'GCA_018472595.2',
      assembly_name: 'HG00438_pat_hprc_f2',
      display_name: 'Human',
      common_name: 'Human',
      scientific_name: 'Homo sapiens',
      aliases: ['HG00438', 'Human', 'Homo sapiens'],
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
        display_name: 'Human',
        common_name: 'Human',
        scientific_name: 'Homo sapiens',
        aliases: ['GRCh38', 'Human', 'Homo sapiens'],
      },
      target_genome: {
        assembly: 'GCA_018472595.2',
        assembly_name: 'HG00438_pat_hprc_f2',
        display_name: 'Human',
        common_name: 'Human',
        scientific_name: 'Homo sapiens',
        aliases: ['HG00438', 'Human', 'Homo sapiens'],
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

// --- Multiple alignments per genome pair ---------------------------------

const reverseAlignment = {
  id: 'hg00438_grch38',
  label: 'HG00438.pat to GRCh38',
  supported: true,
  pair_id: 'gca00000140529__gca0184725952',
  reference_genome: catalog.alignments[0].target_genome,
  target_genome: catalog.alignments[0].reference_genome,
}

const altAlignment = {
  id: 'grch38_hg00438_alt',
  label: 'GRCh38 to HG00438.pat (minimap2)',
  supported: true,
  pair_id: 'gca00000140529__gca0184725952',
  reference_genome: catalog.alignments[0].reference_genome,
  target_genome: catalog.alignments[0].target_genome,
}

const multiCatalog = {
  ...catalog,
  alignments: [
    { ...catalog.alignments[0], pair_id: 'gca00000140529__gca0184725952' },
    reverseAlignment,
    altAlignment,
    catalog.alignments[1],
  ],
}

test('a genome pair can hold several alignments in one direction', () => {
  assert.deepEqual(
    getSvAlignmentsForPair(multiCatalog, grch38Species, hg00438Species).map((a) => a.id),
    ['grch38_hg00438', 'grch38_hg00438_alt'],
  )
})

test('the reverse direction is a separate alignment, not the same one', () => {
  assert.deepEqual(
    getSvAlignmentsForPair(multiCatalog, hg00438Species, grch38Species).map((a) => a.id),
    ['hg00438_grch38'],
  )
})

test('findSvAlignment can be pointed at a specific alignment of a pair', () => {
  assert.equal(
    findSvAlignment(multiCatalog, grch38Species, hg00438Species)?.id,
    'grch38_hg00438',
  )
  assert.equal(
    findSvAlignment(multiCatalog, grch38Species, hg00438Species, {
      preferredAlignmentId: 'grch38_hg00438_alt',
    })?.id,
    'grch38_hg00438_alt',
  )
})

test('a preferred alignment from another pair is ignored rather than obeyed', () => {
  assert.equal(
    findSvAlignment(multiCatalog, grch38Species, hg00438Species, {
      preferredAlignmentId: 'grch38_hg00733',
    })?.id,
    'grch38_hg00438',
  )
})

test('the pair index groups both directions under one entry', () => {
  const pairs = buildSvPairIndex(multiCatalog)
  assert.equal(pairs.length, 2)
  const humanPair = pairs.find((pair) => pair.alignments.length === 3)
  assert.deepEqual(
    humanPair.alignments.map((a) => a.id),
    ['grch38_hg00438', 'hg00438_grch38', 'grch38_hg00438_alt'],
  )
  assert.equal(humanPair.genomes.length, 2)
})

test('the pair index groups records that carry no pair_id', () => {
  const pairs = buildSvPairIndex({
    alignments: [
      { id: 'a', reference_genome: { assembly: 'GCA_1' }, target_genome: { assembly: 'GCA_2' } },
      { id: 'b', reference_genome: { assembly: 'GCA_2' }, target_genome: { assembly: 'GCA_1' } },
    ],
  })
  assert.equal(pairs.length, 1)
  assert.deepEqual(pairs[0].alignments.map((a) => a.id), ['a', 'b'])
})

// --- Genome dropdown availability ----------------------------------------

const localOnlyGenome = {
  id: 'hg00733',
  assembly: 'GCA_018506975.2',
  assembly_name: 'HG00733_mat_hprc_f2',
  local: true,
  aliases: ['HG00733'],
}

const absentGenome = {
  id: 'chm13',
  assembly: 'GCA_009914755.4',
  assembly_name: 'T2T-CHM13v2.0',
  local: false,
  aliases: ['CHM13'],
}

test('a genome already in the top bar is offered as selected', () => {
  const options = buildSvGenomeOptions(
    [catalog.genomes[0]],
    [grch38Species],
    new Set([speciesGenomeKey(grch38Species)]),
    new Set([speciesGenomeKey(grch38Species)]),
  )
  assert.equal(options[0].state, 'selected')
  assert.equal(options[0].disabled, false)
  assert.equal(options[0].isActive, true)
  assert.equal(formatSvGenomeOptionLabel(options[0]), options[0].label)
})

test('a downloaded genome missing from the top bar is offered as add', () => {
  const options = buildSvGenomeOptions([localOnlyGenome], [], new Set(), new Set())
  assert.equal(options[0].state, 'add')
  assert.equal(options[0].disabled, false)
  assert.match(formatSvGenomeOptionLabel(options[0]), /\(add\)$/)
})

test('a genome with no local data is listed but cannot be picked', () => {
  const options = buildSvGenomeOptions([absentGenome], [], new Set(), new Set())
  assert.equal(options[0].state, 'missing')
  assert.equal(options[0].disabled, true)
  assert.match(formatSvGenomeOptionLabel(options[0]), /\(missing\)$/)
})

test('a genome that could be downloaded says so rather than just missing', () => {
  const options = buildSvGenomeOptions(
    [{ ...absentGenome, downloadable: true }],
    [],
    new Set(),
    new Set(),
  )
  assert.equal(options[0].disabled, true)
  assert.match(formatSvGenomeOptionLabel(options[0]), /\(not downloaded\)$/)
})

test('genome options are ordered selected, then addable, then unusable', () => {
  const options = buildSvGenomeOptions(
    [absentGenome, localOnlyGenome, catalog.genomes[0]],
    [grch38Species],
    new Set([speciesGenomeKey(grch38Species)]),
    new Set(),
  )
  assert.deepEqual(options.map((option) => option.state), ['selected', 'add', 'missing'])
})

test('a genome resolved through local_species counts as addable', () => {
  const options = buildSvGenomeOptions(
    [{ id: 'hg00438', assembly: 'GCA_018472595.2', local_species: hg00438Species }],
    [],
    new Set(),
    new Set(),
  )
  assert.equal(options[0].state, 'add')
  assert.equal(options[0].species, hg00438Species)
})

test('the same genome appearing twice in the catalog yields one option', () => {
  const options = buildSvGenomeOptions([localOnlyGenome, localOnlyGenome], [], new Set(), new Set())
  assert.equal(options.length, 1)
})

test('an unusable alignment is flagged separately from an unusable genome', () => {
  const options = buildSvGenomeOptions([localOnlyGenome], [], new Set(), new Set())
  assert.match(
    formatSvGenomeOptionLabel({ ...options[0], supported: false }),
    /\(add, missing files\)$/,
  )
})
