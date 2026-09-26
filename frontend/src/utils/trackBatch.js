// Registering several track files at once: grouping them by type, and naming a group
// from one pattern — a prefix, the file's own name, and a number counted from wherever
// the last batch left off (lung 1-5 now, lung 6-10 next time).

export const DEFAULT_BATCH_NAMING = Object.freeze({
    prefix: '',
    useFileName: true,
    numbered: false,
    startIndex: 1,
    startIndexEdited: false,
})

/**
 * Files grouped by track type, in `typeOrder`, each group's files in the order given.
 * Files with no type yet come last, as `type: ''`.
 */
export function groupFilesByType(files, typeOrder = []) {
    const byType = new Map()
    for (const file of Array.isArray(files) ? files : []) {
        const type = String(file?.type || '')
        if (!byType.has(type)) byType.set(type, [])
        byType.get(type).push(file)
    }
    const rank = (type) => {
        if (!type) return Number.MAX_SAFE_INTEGER
        const i = typeOrder.indexOf(type)
        return i < 0 ? typeOrder.length : i
    }
    return [...byType.entries()]
        .sort((a, b) => rank(a[0]) - rank(b[0]))
        .map(([type, groupFiles]) => ({ type, files: groupFiles }))
}

/** One name from a group's pattern: prefix, file name and number, whichever are on. */
export function batchLabel(naming, stem, index) {
    const n = { ...DEFAULT_BATCH_NAMING, ...(naming || {}) }
    const start = Number.isFinite(Number(n.startIndex)) ? Math.trunc(Number(n.startIndex)) : 1
    const parts = [
        String(n.prefix || '').trim(),
        n.useFileName ? String(stem || '').trim() : '',
        n.numbered ? String(start + index) : '',
    ].filter(Boolean)
    // With everything switched off there is still something to call the track.
    return parts.length ? parts.join(' ') : String(stem || '').trim()
}

/**
 * The number to start from so a new batch carries on from tracks already named with the
 * same prefix: the highest "<prefix> N" plus one, or 1 when there are none.
 */
export function suggestStartIndex(existingLabels, prefix) {
    const p = String(prefix || '').trim().toLowerCase()
    if (!p) return 1
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^${escaped}\\s+(?:.*\\s)?(\\d+)$`)
    let highest = 0
    for (const label of Array.isArray(existingLabels) ? existingLabels : []) {
        const match = String(label || '').trim().toLowerCase().match(pattern)
        if (match) highest = Math.max(highest, Number.parseInt(match[1], 10))
    }
    return highest + 1
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * What changed between two versions of a group's settings, applied to one track's own:
 * only the fields that changed, one level into nested settings, so a track keeps
 * everything else it had. Editing tracks together is "change the display mode on all of
 * these", not "make these all identical".
 */
export function applySettingsChange(before, after, target) {
    const out = { ...target }
    for (const key of Object.keys(after || {})) {
        if (JSON.stringify(before?.[key]) === JSON.stringify(after[key])) continue
        if (isPlainObject(after[key]) && isPlainObject(before?.[key]) && isPlainObject(target?.[key])) {
            const inner = { ...target[key] }
            for (const innerKey of Object.keys(after[key])) {
                if (JSON.stringify(before[key][innerKey]) !== JSON.stringify(after[key][innerKey])) inner[innerKey] = after[key][innerKey]
            }
            out[key] = inner
        } else {
            out[key] = after[key]
        }
    }
    return out
}
