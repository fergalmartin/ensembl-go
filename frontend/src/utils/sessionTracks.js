// Which custom tracks and track groups a Genome Browser panel has open, as saved between
// sessions, and how to put them back. Saved per genome as the panel's custom rows top to
// bottom; see the backend's /api/browser/session-tracks for the stored shape.

import { isGroupRowId } from './trackGroups.js'

/**
 * A panel's custom rows as session entries, in `trackOrder`. Tracks that are not from the
 * registry (opened straight from a file) have nothing to reopen them by and are left out.
 */
export function describeSessionTracks(customTracks, trackOrder) {
    const byId = new Map((Array.isArray(customTracks) ? customTracks : []).map((t) => [t.id, t]))
    const entries = []
    for (const rowId of Array.isArray(trackOrder) ? trackOrder : []) {
        if (isGroupRowId(rowId)) {
            const members = (customTracks || []).filter((t) => t.joinedRowId === rowId)
            if (!members.length || !members[0].group?.id) continue
            entries.push({ type: 'group', group_id: String(members[0].group.id), visible: members.some((t) => t.visible !== false) })
            continue
        }
        const track = byId.get(rowId)
        if (!track || !track.registryTrackId) continue
        const visible = track.visible !== false
        if (track.group?.id) {
            entries.push({ type: 'group_track', group_id: String(track.group.id), track_id: String(track.registryTrackId), visible })
        } else {
            entries.push({ type: 'track', track_id: String(track.registryTrackId), visible })
        }
    }
    return entries
}

/**
 * What to open for saved `entries`, in order, against what is registered now:
 *   { kind: 'track', track, visible }
 *   { kind: 'group_track', group, member, index, visible }  one of a group's tracks, own row
 *   { kind: 'group', group, visible }                       a joined group, all its tracks
 * A group is reopened as it is laid out now, which may not be how it was saved: a group
 * since made joined comes back as one row where its first track was; one since made
 * separate comes back as its tracks, in group order, where the row was. Anything no longer
 * registered, and any track no longer in its group, is skipped.
 */
export function planSessionRestore(entries, { tracksById, groupsById }) {
    const plan = []
    const placedGroups = new Set()
    const placedMembers = new Set()
    const trackOf = (id) => tracksById?.get?.(String(id)) || null
    const groupOf = (id) => groupsById?.get?.(String(id)) || null
    const memberSlot = (group, trackId) => (group.members || []).findIndex((m) => String(m.track_id) === String(trackId))

    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || typeof entry !== 'object') continue
        const visible = entry.visible !== false
        if (entry.type === 'track') {
            const track = trackOf(entry.track_id)
            if (track) plan.push({ kind: 'track', track, visible })
            continue
        }
        const group = groupOf(entry.group_id)
        if (!group) continue
        if (group.layout === 'joined') {
            if (placedGroups.has(group.id)) continue
            placedGroups.add(group.id)
            plan.push({ kind: 'group', group, visible })
            continue
        }
        const members = entry.type === 'group'
            ? (group.members || []).map((member, index) => ({ member, index }))
            : [{ member: group.members?.[memberSlot(group, entry.track_id)], index: memberSlot(group, entry.track_id) }]
        for (const { member, index } of members) {
            if (!member || index < 0 || !trackOf(member.track_id)) continue
            const key = `${group.id}|${member.track_id}`
            if (placedMembers.has(key)) continue
            placedMembers.add(key)
            plan.push({ kind: 'group_track', group, member, index, visible })
        }
    }
    return plan
}
