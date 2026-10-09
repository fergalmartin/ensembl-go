// The Genome Browser view's model: shared empty values (stable identities for the
// panels' memo), the far-panel hold interval, genome pill labels, chromosome-token
// matching between panels, and keeping a window inside a region. Pure functions.
import { speciesItemKey } from '../../../app/genomeLists.js'

/** Shared empties keep absent notes and track registries stable across frames. */
export const EMPTY_NOTE_COUNTS = Object.freeze({})

export const EMPTY_NOTE_LIST = Object.freeze([])

export const EMPTY_TRACK_LIST = Object.freeze([])

export const EMPTY_FAR_PANELS = new Set()

/** How often a linked panel parked off screen catches up with the pan. */
export const OFFSCREEN_LINK_INTERVAL_MS = 200

/**
 * Things a drag must not be stolen from: controls that expect a click, and text
 * a user may legitimately want to select.
 */
export const DRAG_SCROLL_EXCLUDED_SELECTOR = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    'label',
    'summary',
    'option',
    '[role="button"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="slider"]',
    '[contenteditable="true"]',
    '[data-no-drag-scroll="true"]',
].join(',')

export function dirnameFromPath(filepath) {
    if (!filepath || typeof filepath !== 'string') return ''
    const normalized = filepath.replace(/\/+$/, '')
    const idx = normalized.lastIndexOf('/')
    if (idx <= 0) return ''
    return normalized.slice(0, idx)
}

export function formatSpeciesForPill(species) {
    if (!species) return ''
    if (species.display_name) return species.display_name
    if (species.common_name) return species.common_name
    const name = species.scientific_name || ''
    if (!name) return ''
    const parts = name.split(' ')
    if (parts.length < 2) return name
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

export function buildGenomePillLabel(species) {
    if (!species) return ''
    const name = formatSpeciesForPill(species)
    const assembly = species?.assembly_name || species?.assembly || ''
    return assembly ? `${name} — ${assembly}` : name
}

// `findScrollHost`, `stickyControlsInset` and `panelAlignmentAnchor` are shared
// with the left-hand scroll rail, which has to put a genome's dot at exactly the
// scroll position this file's alignment scrolls to.

export function dedupeSpeciesList(speciesList) {
    const out = []
    const seen = new Set()
    for (const species of Array.isArray(speciesList) ? speciesList : []) {
        if (!species) continue
        const key = speciesItemKey(species)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(species)
    }
    return out
}

export function geneFivePrime(gene) {
    return gene?.strand === '+' ? Number(gene.start) : Number(gene.end)
}

export function sameArrayMembers(a, b) {
    if (a === b) return true
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false
    }
    return true
}

export function samePanelPosition(a, b) {
    if (a === b) return true
    if (!a || !b) return false
    return (
        String(a.chrom || '') === String(b.chrom || '') &&
        Number(a.start) === Number(b.start) &&
        Number(a.end) === Number(b.end) &&
        String(a.targetTrack || '') === String(b.targetTrack || '') &&
        Object.is(Number(a.anchorRatio), Number(b.anchorRatio))
    )
}

export function chromosomeTokenVariants(value) {
    const raw = String(value || '').trim()
    if (!raw) return new Set()
    const lower = raw.toLowerCase()
    const variants = new Set([lower])
    if (lower.startsWith('chr') && lower.length > 3) variants.add(lower.slice(3))
    else variants.add(`chr${lower}`)
    if (['m', 'mt', 'chrm', 'chrmt'].includes(lower)) {
        variants.add('m')
        variants.add('mt')
        variants.add('chrm')
        variants.add('chrmt')
    }
    return variants
}

export function chromosomeTokensForRegion(region, fallbackChrom = '') {
    const tokens = new Set()
    for (const value of [fallbackChrom, region?.chrom, ...(Array.isArray(region?.synonyms) ? region.synonyms : [])]) {
        for (const token of chromosomeTokenVariants(value)) tokens.add(token)
    }
    return tokens
}

export function regionMatchesTokens(region, tokens) {
    if (!region || !tokens?.size) return false
    for (const token of chromosomeTokensForRegion(region)) {
        if (tokens.has(token)) return true
    }
    return false
}

export function resolveRegionByChromTokens(regions, chromOrTokens) {
    const tokens = chromOrTokens instanceof Set ? chromOrTokens : chromosomeTokenVariants(chromOrTokens)
    if (!tokens.size || !Array.isArray(regions)) return null
    return regions.find((region) => regionMatchesTokens(region, tokens)) || null
}

export function clampWindowToRegion(chrom, start, end, region) {
    const requestedStart = Number(start)
    const requestedEnd = Number(end)
    if (!chrom || !Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedEnd <= requestedStart) {
        return null
    }
    const minStart = Math.max(1, Math.floor(Number(region?.start) || 1))
    const maxEnd = Math.max(minStart + 1, Math.floor(Number(region?.end || region?.length) || requestedEnd))
    const requestedSpan = requestedEnd - requestedStart
    const maxSpan = maxEnd - minStart
    if (requestedSpan >= maxSpan) {
        return { chrom, start: minStart, end: maxEnd }
    }
    const nextStart = Math.min(Math.max(requestedStart, minStart), maxEnd - requestedSpan)
    return { chrom, start: nextStart, end: nextStart + requestedSpan }
}
