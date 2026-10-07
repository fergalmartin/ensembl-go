import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveBrowserGene } from '../src/utils/browserGeneNavigation.js'

const genomeKey = 'ensembl::Target_species::ASM::dataset::ensembl/2026_06'
const gene = { id: 'TARGET:1', name: 'Hit symbol' }
const resolved = { id: gene.id, name: 'Annotation symbol', chrom: 'chr2', start: 1200, end: 2800, strand: '-' }
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status })

test('resolves the stable ID in the exact selected dataset, retaining annotation coordinates', async () => {
    const signal = new AbortController().signal
    const result = await resolveBrowserGene({ apiBase: 'http://example.test', genomeKey, gene, signal,
        fetchImpl: async (input, options) => {
            const url = new URL(input)
            assert.equal(url.pathname, '/api/resolve_id')
            assert.equal(url.searchParams.get('genome'), genomeKey)
            assert.equal(url.searchParams.get('query'), gene.id)
            assert.equal(options.signal, signal)
            return reply({ gene: resolved })
        },
    })
    assert.deepEqual(result, resolved)
})

test('missing IDs and partial name matches cannot focus an unrelated gene', async () => {
    for (const value of [null, { ...resolved, id: 'other-gene' }]) {
        await assert.rejects(resolveBrowserGene({ apiBase: '', genomeKey, gene,
            fetchImpl: async () => reply({ gene: value }),
        }), /not found/)
    }
})

test('invalid annotation coordinates never become a browser navigation', async () => {
    for (const patch of [{ chrom: '' }, { start: null }, { end: null }, { start: 'unknown' }]) {
        await assert.rejects(resolveBrowserGene({ apiBase: '', genomeKey, gene,
            fetchImpl: async () => reply({ gene: { ...resolved, ...patch } }),
        }), /not found/)
    }
})

test('HTTP failures and cancellation propagate to the request owner', async () => {
    await assert.rejects(resolveBrowserGene({ apiBase: '', genomeKey, gene,
        fetchImpl: async () => reply({}, 404),
    }), /404/)
    await assert.rejects(resolveBrowserGene({ apiBase: '', genomeKey, gene,
        fetchImpl: async () => { throw new DOMException('Cancelled', 'AbortError') },
    }), { name: 'AbortError' })
})

test('a building annotation index is retried until the gene resolves', async () => {
    let requests = 0
    const result = await resolveBrowserGene({ apiBase: '', genomeKey, gene,
        fetchImpl: async () => ++requests === 1 ? reply({}, 425) : reply({ gene: resolved }),
    })
    assert.equal(requests, 2)
    assert.deepEqual(result, resolved)
})

test('leaving while the index builds cancels retries', async () => {
    const controller = new AbortController()
    let requests = 0
    const pending = resolveBrowserGene({ apiBase: '', genomeKey, gene, signal: controller.signal,
        fetchImpl: async () => {
            requests++
            setTimeout(() => controller.abort(), 10)
            return reply({}, 425)
        },
    })
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(requests, 1)
})
