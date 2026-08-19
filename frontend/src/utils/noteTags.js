export const MAX_NOTE_TAGS = 20
export const MAX_NOTE_TAG_CHARS = 50

const text = (value) => (typeof value === 'string' ? value : (value == null ? '' : String(value)))

export function normalizeTagText(value) {
    const source = text(value)
    const hasControlCharacter = [...source].some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
    })
    if (!source || source.includes(',') || hasControlCharacter) return ''
    const token = source.replace(/\s+/g, ' ').trim()
    if (!token || token.length > MAX_NOTE_TAG_CHARS) return ''
    return token
}

export function tagKey(value) {
    return normalizeTagText(value).toLowerCase()
}

export function normalizeNoteTags(value) {
    if (!Array.isArray(value)) return []
    const tags = []
    const seen = new Set()
    for (const raw of value) {
        const tag = normalizeTagText(raw)
        const key = tagKey(tag)
        if (!tag || !key || seen.has(key)) continue
        if (tags.length >= MAX_NOTE_TAGS) break
        seen.add(key)
        tags.push(tag)
    }
    return tags
}

export function sameTagList(left, right) {
    const a = normalizeNoteTags(left).map(tagKey)
    const b = normalizeNoteTags(right).map(tagKey)
    return a.length === b.length && a.every((key, index) => key === b[index])
}

function tagSortComparator(mode) {
    const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    if (mode === 'recent') {
        return (a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || byLabel(a, b)
    }
    if (mode === 'alphabetical') return byLabel
    return (a, b) => (b.totalCount - a.totalCount) || b.lastUsedAt.localeCompare(a.lastUsedAt) || byLabel(a, b)
}

export function buildTagCatalogue(notes) {
    const byKey = new Map()
    for (const note of (Array.isArray(notes) ? notes : [])) {
        const tags = normalizeNoteTags(note?.tags)
        if (tags.length === 0) continue
        const archived = Boolean(note?.archived)
        const stamp = text(note?.tagsUpdatedAt || note?.updatedAt || note?.createdAt)
        const isTodo = note?.target?.kind === 'todo'
        const contextKey = isTodo ? 'todo' : `genome:${text(note?.target?.genome_key).trim()}`
        for (const tag of tags) {
            const key = tagKey(tag)
            let summary = byKey.get(key)
            if (!summary) {
                summary = {
                    key,
                    label: tag,
                    totalCount: 0,
                    activeCount: 0,
                    archivedCount: 0,
                    lastUsedAt: '',
                    contexts: new Map(),
                    spellings: new Map(),
                }
                byKey.set(key, summary)
            }
            summary.totalCount += 1
            if (archived) summary.archivedCount += 1
            else summary.activeCount += 1
            if (stamp > summary.lastUsedAt) summary.lastUsedAt = stamp

            const spelling = summary.spellings.get(tag) || { label: tag, count: 0, lastUsedAt: '' }
            spelling.count += 1
            if (stamp > spelling.lastUsedAt) spelling.lastUsedAt = stamp
            summary.spellings.set(tag, spelling)

            const existingContext = summary.contexts.get(contextKey) || {
                key: contextKey,
                kind: isTodo ? 'todo' : 'genome',
                genomeKey: isTodo ? '' : text(note?.target?.genome_key).trim(),
                totalCount: 0,
                activeCount: 0,
                archivedCount: 0,
            }
            existingContext.totalCount += 1
            if (archived) existingContext.archivedCount += 1
            else existingContext.activeCount += 1
            summary.contexts.set(contextKey, existingContext)
        }
    }

    return [...byKey.values()].map((summary) => {
        const spelling = [...summary.spellings.values()].sort((a, b) => (
            (b.count - a.count)
            || b.lastUsedAt.localeCompare(a.lastUsedAt)
            || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
        ))[0]
        return {
            key: summary.key,
            label: spelling?.label || summary.label,
            totalCount: summary.totalCount,
            activeCount: summary.activeCount,
            archivedCount: summary.archivedCount,
            lastUsedAt: summary.lastUsedAt,
            contexts: [...summary.contexts.values()].sort((a, b) => (
                (a.kind === 'todo' ? -1 : 0) - (b.kind === 'todo' ? -1 : 0)
                || b.totalCount - a.totalCount
                || a.genomeKey.localeCompare(b.genomeKey)
            )),
        }
    })
}

export function sortTagCatalogue(catalogue, mode = 'popular') {
    return (Array.isArray(catalogue) ? catalogue.slice() : []).sort(tagSortComparator(mode))
}

export function suggestTags(catalogue, {
    query = '',
    sortMode = 'popular',
    selectedTags = [],
    limit = Infinity,
} = {}) {
    const needle = tagKey(query)
    const selected = new Set(normalizeNoteTags(selectedTags).map(tagKey))
    const candidates = (Array.isArray(catalogue) ? catalogue : []).filter((tag) => (
        !selected.has(tag.key) && (!needle || tag.key.includes(needle))
    ))
    const sorted = sortTagCatalogue(candidates, sortMode)
    if (needle) {
        sorted.sort((a, b) => {
            const prefixDelta = Number(!a.key.startsWith(needle)) - Number(!b.key.startsWith(needle))
            return prefixDelta || tagSortComparator(sortMode)(a, b)
        })
    }
    return sorted.slice(0, Math.max(0, Number(limit) || 0))
}

export function noteMatchesTags(note, selectedTags, matchMode = 'all') {
    const wanted = normalizeNoteTags(selectedTags).map(tagKey)
    if (wanted.length === 0) return true
    const present = new Set(normalizeNoteTags(note?.tags).map(tagKey))
    return matchMode === 'any'
        ? wanted.some((key) => present.has(key))
        : wanted.every((key) => present.has(key))
}

export function matchTaggedNotes(notes, { query = '', selectedTags = [], matchMode = 'all' } = {}) {
    const needle = text(query).trim().toLowerCase()
    return (Array.isArray(notes) ? notes : []).filter((note) => {
        if (!noteMatchesTags(note, selectedTags, matchMode)) return false
        if (!needle) return true
        const haystacks = [
            note?.target?.label,
            note?.target?.id,
            note?.title,
            note?.body,
            ...normalizeNoteTags(note?.tags),
        ]
        return haystacks.some((value) => text(value).toLowerCase().includes(needle))
    })
}
