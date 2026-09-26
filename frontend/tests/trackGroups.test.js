import assert from 'node:assert/strict'
import test from 'node:test'

import {
    appendMembers,
    effectiveMemberTrack,
    gatherRows,
    groupRowIdFor,
    isGroupRowId,
    groupTypeCounts,
    groupsContainingTrack,
    groupsForAssembly,
    moveItem,
    sharedAssembly,
} from '../src/utils/trackGroups.js'

const HUMAN = 'ensembl::Homo_sapiens::GCA_000001405.29'
const PIG = 'ensembl::Sus_scrofa::GCA_000003025.6'

test('moveItem drops a row before the row it was dropped on', () => {
    const list = ['a', 'b', 'c', 'd']
    assert.deepEqual(moveItem(list, 0, 2), ['b', 'a', 'c', 'd'])
    assert.deepEqual(moveItem(list, 3, 0), ['d', 'a', 'b', 'c'])
    assert.deepEqual(moveItem(list, 1, 4), ['a', 'c', 'd', 'b'])
    // Dropping a row next to itself leaves the order alone.
    assert.deepEqual(moveItem(list, 1, 1), list)
    assert.deepEqual(moveItem(list, 1, 2), list)
    assert.deepEqual(moveItem(list, 9, 0), list)
})

test('sharedAssembly treats a dataset suffix as the same genome', () => {
    assert.equal(sharedAssembly([{ genome_key: HUMAN }, { genome_key: `${HUMAN}::dataset::ensembl/2025_12` }]), HUMAN)
    assert.equal(sharedAssembly([{ genome_key: HUMAN }, { genome_key: PIG }]), null)
    assert.equal(sharedAssembly([{ genome_key: '' }]), null)
    assert.equal(sharedAssembly([]), null)
})

test('groups are found by assembly and by member', () => {
    const groups = [
        { id: 'g1', genome_key: HUMAN, members: [{ track_id: 't1' }, { track_id: 't2' }] },
        { id: 'g2', genome_key: `${HUMAN}::dataset::ensembl/2025_12`, members: [{ track_id: 't2' }] },
        { id: 'g3', genome_key: PIG, members: [] },
    ]
    assert.deepEqual(groupsForAssembly(groups, HUMAN).map((g) => g.id), ['g1', 'g2'])
    assert.deepEqual(groupsContainingTrack(groups, 't2').map((g) => g.id), ['g1', 'g2'])
    assert.deepEqual(groupsContainingTrack(groups, 't9'), [])
})

test('groupTypeCounts counts members by type in order of appearance', () => {
    const tracksById = new Map([
        ['a', { type: 'bigwig' }], ['b', { type: 'bed' }], ['c', { type: 'bigwig' }],
    ])
    const group = { members: [{ track_id: 'a' }, { track_id: 'b' }, { track_id: 'gone' }, { track_id: 'c' }] }
    assert.deepEqual(groupTypeCounts(group, tracksById), [{ type: 'bigwig', count: 2 }, { type: 'bed', count: 1 }])
})

test('appendMembers adds new tracks at the end without repeats', () => {
    const members = [{ trackId: 'a', custom: { x: 1 } }]
    assert.deepEqual(appendMembers(members, ['b', 'a', 'c', 'b']), [
        { trackId: 'a', custom: { x: 1 } }, { trackId: 'b', custom: null }, { trackId: 'c', custom: null },
    ])
})

test('gatherRows brings a group together where its first track is', () => {
    const order = ['forward', 'ct_a', 'ct_x', 'ct_c', 'ct_b', 'reverse']
    assert.deepEqual(gatherRows(order, ['ct_a', 'ct_b', 'ct_c']), ['forward', 'ct_a', 'ct_b', 'ct_c', 'ct_x', 'reverse'])
    // The first of them decides where, even when it is not the group's first.
    assert.deepEqual(gatherRows(['ct_x', 'ct_c', 'ct_y', 'ct_a'], ['ct_a', 'ct_c']), ['ct_x', 'ct_a', 'ct_c', 'ct_y'])
    // Missing ids are skipped; a single one moves nothing.
    assert.deepEqual(gatherRows(order, ['ct_zz', 'ct_b']), order)
})

test('group rows and effective member settings', () => {
    assert.equal(groupRowIdFor('grp_1'), 'cg_grp_1')
    assert.equal(isGroupRowId('cg_grp_1'), true)
    assert.equal(isGroupRowId('ct_1'), false)
    const track = { id: 't', display_mode: 'signal_plot', label: 'T' }
    assert.equal(effectiveMemberTrack(track, { settings: null }), track)
    assert.deepEqual(effectiveMemberTrack(track, { settings: { display_mode: 'zoned_heatmap' } }), { id: 't', display_mode: 'zoned_heatmap', label: 'T' })
})
