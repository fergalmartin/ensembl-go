import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { resolveSvFeatureTrackGenomeIds, resolveSvFeatureWindowChrom } from '../src/utils/svFeatureTrackIdentity.js'

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('SV feature tracks use release-specific genome IDs for both haplotypes', () => {
  const ids = resolveSvFeatureTrackGenomeIds({
    referenceSpecies: {
      selection_key: 'ensembl::Homo_sapiens::GCA_000001405.29::dataset::ensembl/2025_12',
    },
    topSpecies: {
      selection_key: 'ensembl::Homo_sapiens::GCA_018472595.2::dataset::ensembl/2024_10',
    },
    bottomSpecies: {
      selection_key: 'ensembl::Homo_sapiens::GCA_018506975.2::dataset::ensembl/2025_08',
    },
  })

  assert.deepEqual(ids, {
    reference: 'ensembl::Homo_sapiens::GCA_000001405.29::dataset::ensembl/2025_12',
    top: 'ensembl::Homo_sapiens::GCA_018472595.2::dataset::ensembl/2024_10',
    bottom: 'ensembl::Homo_sapiens::GCA_018506975.2::dataset::ensembl/2025_08',
  })
  assert.notEqual(ids.top, 'target')
  assert.notEqual(ids.bottom, 'target')
})

test('legacy aliases remain compatibility fallbacks only when species are absent', () => {
  assert.deepEqual(resolveSvFeatureTrackGenomeIds(), {
    reference: 'reference',
    top: 'target',
    bottom: '',
  })
})

test('GF, GR, and SL are wired to the same resolved genome for every SV band', async () => {
  const view = await source('src/components/StructuralVariationView.jsx')

  assert.match(view, /resolveSvFeatureTrackGenomeIds\(\{[\s\S]*?referenceSpecies: refSpecies,[\s\S]*?topSpecies: tgtSpecies/)
  assert.match(view, /sequenceGenomeId=\{targetBrowseGenomeId\}/)
  assert.match(view, /sequenceGenomeId=\{topBrowseGenomeId\}/)
  assert.match(view, /sequenceGenomeId=\{bottomBrowseGenomeId\}/)
  assert.equal([...view.matchAll(/sequenceGenomeId=\{referenceBrowseGenomeId\}/g)].length, 2)
  assert.doesNotMatch(view, /sequenceGenomeId="(?:reference|target)"/)
})

test('canonical feature loading retains data and retries transient failures', async () => {
  const view = await source('src/components/StructuralVariationView.jsx')

  assert.equal([...view.matchAll(/const featureTrackRetryRef = useRef/g)].length, 2)
  assert.ok([...view.matchAll(/retryState\.timer = setTimeout/g)].length >= 2)
  assert.match(view, /featureTrackAbortRef\.current\[genomeKey\] = abortController\n\s*setFeatureTrackLoading/)
  assert.match(view, /featureTrackAbortRef\.current\[slotKey\] = abortController\n\s*setFeatureTrackLoading/)
})

test('a chrom-less ribbon viewport cannot mask either haplotype feature window', async () => {
  const view = await source('src/components/StructuralVariationView.jsx')

  assert.equal(resolveSvFeatureWindowChrom('11', { chrom: '' }, null), '11')
  assert.equal(resolveSvFeatureWindowChrom('', { chrom: '' }, { chrom: 'chr11' }), 'chr11')

  assert.match(view, /const resolvedTopChrom = useMemo/)
  assert.match(view, /const resolvedBottomChrom = useMemo/)
  assert.match(view, /const baseTopWindow = normalizedViewTopWindow \|\| normalizedAutoTopWindow \|\| normalizedFallbackTopWindow/)
  assert.match(view, /const baseBottomWindow = normalizedViewBottomWindow \|\| normalizedAutoBottomWindow \|\| normalizedFallbackBottomWindow/)
  assert.match(view, /prev && !prev\.chrom \? \{ \.\.\.prev, chrom: resolvedBottomChrom \} : prev/)
})
