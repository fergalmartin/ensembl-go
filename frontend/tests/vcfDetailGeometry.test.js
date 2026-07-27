import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    localVcfType,
    getVcfAltAlleleCount,
    getVcfDetailVariantLayout,
    shouldRenderActiveAnchorBase,
} from '../src/utils/vcfDetailGeometry.js'

test('localVcfType prefers explicit backend type tokens', () => {
    assert.equal(localVcfType({ type: 'ins', ref: 'A', alt: 'A' }), 'ins')
    assert.equal(localVcfType({ type: 'del', ref: 'A', alt: 'A' }), 'del')
    assert.equal(localVcfType({ type: 'SNP', ref: 'AA', alt: 'A' }), 'snv')
    assert.equal(localVcfType({ type: 'other', ref: 'A', alt: 'A' }), 'indel')
})

test('localVcfType infers anchored insertion/deletion vs indel fallback', () => {
    assert.equal(localVcfType({ ref: 'A', alt: 'AT' }), 'ins')
    assert.equal(localVcfType({ ref: 'AT', alt: 'A' }), 'del')
    assert.equal(localVcfType({ ref: 'AT', alt: 'GC' }), 'indel')
})

test('allele bar count uses ALT allele cardinality (commas + 1)', () => {
    assert.equal(getVcfAltAlleleCount({ alt: 'A' }), 1)
    assert.equal(getVcfAltAlleleCount({ alt: 'A,AA,AAA' }), 3)
    assert.equal(getVcfAltAlleleCount({ alt: 'A,,AAA' }), 3)
    assert.equal(getVcfAltAlleleCount({ alt: '' }), 1)
})

test('INS layout anchors at POS and marker starts at anchor right edge', () => {
    const out = getVcfDetailVariantLayout({ pos: 100, ref: 'A', alt: 'A,AA' }, 'ins')
    assert.equal(out.anchorStart, 100)
    assert.equal(out.anchorEnd, 101)
    assert.equal(out.refStart, 100)
    assert.equal(out.refEnd, 101)
    assert.equal(out.markerXGenomic, 101)
    assert.equal(out.hasDelSpan, false)
})

test('DEL layout excludes anchor base from deleted block span', () => {
    const out = getVcfDetailVariantLayout({ pos: 250, ref: 'CTCTTT', alt: 'C' }, 'del')
    assert.equal(out.anchorStart, 250)
    assert.equal(out.anchorEnd, 251)
    assert.equal(out.refStart, 251)
    assert.equal(out.refEnd, 256)
    assert.equal(out.markerXGenomic, 251.5)
    assert.equal(out.hasDelSpan, true)
})

test('DEL layout falls back to anchor edge marker when no deleted span remains', () => {
    const out = getVcfDetailVariantLayout({ pos: 42, ref: 'A', alt: 'A', end: 42 }, 'del')
    assert.equal(out.refStart, 43)
    assert.equal(out.refEnd, 43)
    assert.equal(out.markerXGenomic, 43)
    assert.equal(out.hasDelSpan, false)
})

test('anchor base renders only for active INS/DEL variants', () => {
    assert.equal(shouldRenderActiveAnchorBase('ins', true), true)
    assert.equal(shouldRenderActiveAnchorBase('del', true), true)
    assert.equal(shouldRenderActiveAnchorBase('indel', true), false)
    assert.equal(shouldRenderActiveAnchorBase('ins', false), false)
})

test('anchor icon asset exists in frontend assets', () => {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const iconPath = path.resolve(__dirname, '../src/assets/icons/icon_anchor.svg')
    assert.equal(fs.existsSync(iconPath), true)
    const content = fs.readFileSync(iconPath, 'utf8')
    assert.equal(content.includes('<svg'), true)
})

