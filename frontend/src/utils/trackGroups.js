// Track groups: a named, ordered set of one genome's registered tracks. The registry keeps
// them beside the tracks; these are the parts of handling them that need no React.

import { trackAssemblyKey } from './genomeIdentity.js'

/**
 * `list` with the item at `from` moved so it lands before the item that was at `to`
 * (`to === list.length` puts it last). Indices are into the list as it was, which is what
 * a drop between two rows gives.
 */
export function moveItem(list, from, to) {
    const items = Array.isArray(list) ? list.slice() : []
    if (from < 0 || from >= items.length) return items
    const target = Math.max(0, Math.min(items.length, to))
    if (target === from || target === from + 1) return items
    const [moved] = items.splice(from, 1)
    items.splice(target > from ? target - 1 : target, 0, moved)
    return items
}

/** The assembly every one of these tracks belongs to, or null when they span several or have none. */
export function sharedAssembly(tracks) {
    const keys = new Set((Array.isArray(tracks) ? tracks : []).map((t) => trackAssemblyKey(t?.genome_key)))
    if (keys.size !== 1) return null
    const [only] = keys
    return only || null
}

/** The groups for the same assembly as `genomeKey`, however either was chosen. */
export function groupsForAssembly(groups, genomeKey) {
    const assembly = trackAssemblyKey(genomeKey)
    return (Array.isArray(groups) ? groups : []).filter((g) => trackAssemblyKey(g?.genome_key) === assembly)
}

/** The groups a track is a member of. */
export function groupsContainingTrack(groups, trackId) {
    const id = String(trackId || '')
    return (Array.isArray(groups) ? groups : []).filter((g) =>
        (g?.members || []).some((m) => String(m?.track_id || '') === id))
}

/**
 * What a group holds, by type, in the order the types first appear:
 * [{ type: 'bigwig', count: 3 }, { type: 'bed', count: 1 }]. Members whose track is gone
 * are not counted.
 */
export function groupTypeCounts(group, tracksById) {
    const counts = new Map()
    for (const member of group?.members || []) {
        const track = tracksById?.get?.(String(member?.track_id || ''))
        if (!track) continue
        const type = track.type || 'unknown'
        counts.set(type, (counts.get(type) || 0) + 1)
    }
    return [...counts.entries()].map(([type, count]) => ({ type, count }))
}

/** Members with `trackIds` added at the end, in the order given, skipping any already there. */
export function appendMembers(members, trackIds) {
    const out = Array.isArray(members) ? members.slice() : []
    const present = new Set(out.map((m) => String(m.trackId)))
    for (const id of Array.isArray(trackIds) ? trackIds : []) {
        const key = String(id)
        if (present.has(key)) continue
        present.add(key)
        out.push({ trackId: key, custom: null })
    }
    return out
}

// ── In the Genome Browser ─────────────────────────────────────────────────────

/** A joined group's single row in a panel's track order. Custom tracks are `ct_…`. */
export const GROUP_ROW_PREFIX = 'cg_'
export const groupRowIdFor = (groupId) => `${GROUP_ROW_PREFIX}${groupId}`
export const isGroupRowId = (id) => typeof id === 'string' && id.startsWith(GROUP_ROW_PREFIX)

/**
 * `order` with `rowIds` brought together, in the order given, where the first of them
 * already is. Ids not in `order` are left out; the rest of `order` is untouched. How a
 * group switched back on gathers its tracks after some were dragged elsewhere or removed.
 */
export function gatherRows(order, rowIds) {
    const list = Array.isArray(order) ? order : []
    const present = new Set(list)
    const wanted = (Array.isArray(rowIds) ? rowIds : []).filter((id) => present.has(id))
    if (wanted.length < 2) return list.slice()
    const wantedSet = new Set(wanted)
    const at = list.findIndex((id) => wantedSet.has(id))
    const rest = list.filter((id) => !wantedSet.has(id))
    const insertAt = list.slice(0, at).filter((id) => !wantedSet.has(id)).length
    return [...rest.slice(0, insertAt), ...wanted, ...rest.slice(insertAt)]
}

/** A member as the browser shows it: the registered track with the group's own settings over it. */
export function effectiveMemberTrack(track, member) {
    if (!track) return null
    return member?.settings ? { ...track, ...member.settings } : track
}
