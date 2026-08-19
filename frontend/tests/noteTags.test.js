import test from 'node:test'
import assert from 'node:assert/strict'

import {
    buildTagCatalogue,
    matchTaggedNotes,
    normalizeNoteTags,
    noteMatchesTags,
    sortTagCatalogue,
    suggestTags,
} from '../src/utils/noteTags.js'

const note = (id, tags, overrides = {}) => ({
    id,
    title: '',
    body: '',
    tags,
    tagsUpdatedAt: `2026-08-${id.padStart(2, '0')}T10:00:00Z`,
    archived: false,
    target: { kind: 'gene', genome_key: 'ensembl::human::GRCh38', id: `G${id}`, label: '' },
    ...overrides,
})

test('tags are trimmed and deduplicated case-insensitively', () => {
    assert.deepEqual(normalizeNoteTags([' Needs   review ', 'RNA-seq', 'needs review', 'bad,tag', '']), [
        'Needs review',
        'RNA-seq',
    ])
})

test('catalogue counts active, archived, todo and genome contexts', () => {
    const catalogue = buildTagCatalogue([
        note('01', ['Review']),
        note('02', ['review'], { archived: true }),
        note('03', ['Review'], { target: { kind: 'todo', genome_key: 'global::todos', id: 'tasks' } }),
        note('04', ['RNA-seq'], { target: { kind: 'gene', genome_key: 'ensembl::mouse::GRCm39', id: 'M1' } }),
    ])
    const review = catalogue.find((tag) => tag.key === 'review')
    assert.equal(review.label, 'Review')
    assert.deepEqual([review.totalCount, review.activeCount, review.archivedCount], [3, 2, 1])
    assert.equal(review.contexts.find((context) => context.kind === 'todo').totalCount, 1)
    assert.equal(review.contexts.find((context) => context.genomeKey.includes('human')).totalCount, 2)
})

test('catalogue supports popular, recent and alphabetical ordering', () => {
    const catalogue = buildTagCatalogue([
        note('01', ['Beta']),
        note('02', ['Beta']),
        note('09', ['Alpha']),
    ])
    assert.deepEqual(sortTagCatalogue(catalogue, 'popular').map((tag) => tag.label), ['Beta', 'Alpha'])
    assert.deepEqual(sortTagCatalogue(catalogue, 'recent').map((tag) => tag.label), ['Alpha', 'Beta'])
    assert.deepEqual(sortTagCatalogue(catalogue, 'alphabetical').map((tag) => tag.label), ['Alpha', 'Beta'])
})

test('suggestions exclude selected tags and rank prefixes before substrings', () => {
    const catalogue = buildTagCatalogue([
        note('01', ['Review']),
        note('02', ['Needs review']),
        note('03', ['Review']),
        note('04', ['RNA-seq']),
    ])
    assert.deepEqual(
        suggestTags(catalogue, { query: 'rev', selectedTags: ['RNA-seq'] }).map((tag) => tag.label),
        ['Review', 'Needs review'],
    )
})

test('tag matching supports all and any while text search spans tasks and tags', () => {
    const notes = [
        note('01', ['Review', 'RNA-seq'], { title: 'Inspect REG4' }),
        note('02', ['Review'], { body: 'coverage issue', target: { kind: 'todo', genome_key: 'global::todos', id: 'tasks' } }),
        note('03', ['RNA-seq'], { title: 'Other' }),
    ]
    assert.equal(noteMatchesTags(notes[0], ['review', 'rna-SEQ'], 'all'), true)
    assert.deepEqual(matchTaggedNotes(notes, { selectedTags: ['Review', 'RNA-seq'], matchMode: 'all' }).map((item) => item.id), ['01'])
    assert.deepEqual(matchTaggedNotes(notes, { selectedTags: ['Review', 'RNA-seq'], matchMode: 'any' }).map((item) => item.id), ['01', '02', '03'])
    assert.deepEqual(matchTaggedNotes(notes, { query: 'coverage' }).map((item) => item.id), ['02'])
    assert.deepEqual(matchTaggedNotes(notes, { query: 'rna-seq' }).map((item) => item.id), ['01', '03'])
})
