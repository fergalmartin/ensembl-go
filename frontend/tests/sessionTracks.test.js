import assert from 'node:assert/strict'
import test from 'node:test'

import { describeSessionTracks, planSessionRestore } from '../src/utils/sessionTracks.js'

const customTracks = [
    { id: 'ct_1', registryTrackId: 'trk_a', visible: true },
    { id: 'ct_2', registryTrackId: 'trk_b', visible: false, group: { id: 'grp_s', index: 1 } },
    { id: 'ct_3', registryTrackId: 'trk_c', visible: true, group: { id: 'grp_j', index: 0 }, joinedRowId: 'cg_grp_j' },
    { id: 'ct_4', registryTrackId: 'trk_d', visible: true, group: { id: 'grp_j', index: 1 }, joinedRowId: 'cg_grp_j' },
    { id: 'ct_5', path: '/opened/from/a/file.bw', visible: true },
]

test('describeSessionTracks lists the custom rows top to bottom', () => {
    const order = ['forward', 'ct_2', 'cg_grp_j', 'ct_5', 'ct_1', 'reverse', 'sequence']
    assert.deepEqual(describeSessionTracks(customTracks, order), [
        { type: 'group_track', group_id: 'grp_s', track_id: 'trk_b', visible: false },
        { type: 'group', group_id: 'grp_j', visible: true },
        { type: 'track', track_id: 'trk_a', visible: true },
    ])
})

test('planSessionRestore reopens what is still registered, in order', () => {
    const tracksById = new Map(['trk_a', 'trk_b', 'trk_c', 'trk_d'].map((id) => [id, { id }]))
    const groupsById = new Map([
        ['grp_s', { id: 'grp_s', layout: 'separate', members: [{ track_id: 'trk_a' }, { track_id: 'trk_b' }] }],
        ['grp_j', { id: 'grp_j', layout: 'joined', members: [{ track_id: 'trk_c' }, { track_id: 'trk_d' }] }],
    ])
    const plan = planSessionRestore([
        { type: 'group_track', group_id: 'grp_s', track_id: 'trk_b', visible: false },
        { type: 'group', group_id: 'grp_j', visible: true },
        { type: 'track', track_id: 'trk_gone' },
        { type: 'group', group_id: 'grp_gone' },
        { type: 'track', track_id: 'trk_a' },
    ], { tracksById, groupsById })
    assert.deepEqual(plan.map((p) => [p.kind, p.track?.id || p.member?.track_id || p.group.id, p.visible, p.index]), [
        ['group_track', 'trk_b', false, 1],
        ['group', 'grp_j', true, undefined],
        ['track', 'trk_a', true, undefined],
    ])
})

test('a group comes back as it is laid out now', () => {
    const tracksById = new Map(['trk_c', 'trk_d', 'trk_e'].map((id) => [id, { id }]))
    // Saved joined, since made separate: its tracks in group order.
    const nowSeparate = new Map([['g', { id: 'g', layout: 'separate', members: [{ track_id: 'trk_d' }, { track_id: 'trk_c' }] }]])
    assert.deepEqual(
        planSessionRestore([{ type: 'group', group_id: 'g' }], { tracksById, groupsById: nowSeparate }).map((p) => p.member.track_id),
        ['trk_d', 'trk_c'],
    )
    // Saved separate, since made joined: one row, where its first track was.
    const nowJoined = new Map([['g', { id: 'g', layout: 'joined', members: [{ track_id: 'trk_c' }, { track_id: 'trk_d' }] }]])
    const plan = planSessionRestore([
        { type: 'group_track', group_id: 'g', track_id: 'trk_c' },
        { type: 'track', track_id: 'trk_e' },
        { type: 'group_track', group_id: 'g', track_id: 'trk_d' },
    ], { tracksById, groupsById: nowJoined })
    assert.deepEqual(plan.map((p) => p.kind), ['group', 'track'])
    // A track taken out of its group since is not reopened as part of it.
    const shrunk = new Map([['g', { id: 'g', layout: 'separate', members: [{ track_id: 'trk_c' }] }]])
    assert.deepEqual(planSessionRestore([{ type: 'group_track', group_id: 'g', track_id: 'trk_d' }], { tracksById, groupsById: shrunk }), [])
})
