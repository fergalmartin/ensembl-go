// The Genome Browser's location box: resolving what was typed (a gene, an
// identifier, a region or chr:start-end) and moving the panel there.
import { trackAchievement } from '../../achievements/tracker.js'
import { API_BASE } from '../../backendRuntime.js'
import { checkRangeAgainstBounds, parseLocationQuery } from '../../utils/locationQuery.js'
import { LHS_WIDTH } from './browserConstants.js'
import { FOCUS_RANGE_FILL_FRACTION, frameRangeWithRightInset } from './genomeBrowserViewportLayout.js'

export async function runBrowserSearch(ctx) {
    const {
        emitTutorialSignal,
        fetchingTilesRef,
        focusDrawerInsetOnFocus,
        focusLocation,
        frameFocusRange,
        genes,
        genome,
        genomePillLabel,
        isFlipped,
        onManualNavigate,
        onPositionChange,
        pendingVerticalCenterGeneIdRef,
        regions,
        searchInput,
        selectedChrom,
        setChromLength,
        setGenes,
        setSearchInput,
        setSelectedChrom,
        setSelectedGene,
        setViewEnd,
        setViewStart,
        showSearchFeedback,
        tileCacheRef,
        viewWidthRef,
    } = ctx
        const rawQuery = searchInput.trim()
        if (!rawQuery) return
        showSearchFeedback(null)
        const genomeName = String(genomePillLabel || '').trim() || 'this genome'

        const resolveRegionChrom = (rawChrom) => {
            const token = String(rawChrom || '').trim()
            if (!token) return { region: null, ambiguous: false }
            const canonical = token.toLowerCase()
            const stripChr = canonical.startsWith('chr') ? canonical.slice(3) : canonical
            const addChr = canonical.startsWith('chr') ? canonical : `chr${canonical}`
            const tokenVariants = (value) => {
                const text = String(value || '').trim().toLowerCase()
                if (!text) return new Set()
                const out = new Set([text])
                if (text.startsWith('chr') && text.length > 3) out.add(text.slice(3))
                else out.add(`chr${text}`)
                if (['m', 'mt', 'chrm', 'chrmt'].includes(text)) {
                    out.add('m')
                    out.add('mt')
                    out.add('chrm')
                    out.add('chrmt')
                }
                return out
            }
            const queryTokens = tokenVariants(token)
            const intersectsTokenSet = (left, right) => {
                for (const value of left) {
                    if (right.has(value)) return true
                }
                return false
            }

            // Exact first
            let region = regions.find((r) => r.chrom === token)
            if (region) return { region, ambiguous: false }

            // Case-insensitive, plus chr/no-chr aliases
            region = regions.find((r) => {
                const rc = String(r.chrom || '').toLowerCase()
                if (rc === canonical) return true
                if (rc === stripChr) return true
                if (rc === addChr) return true
                const rcStrip = rc.startsWith('chr') ? rc.slice(3) : rc
                return rcStrip === stripChr
            })
            if (region) return { region, ambiguous: false }

            // Assembly-report synonyms returned by the backend.
            const synonymCandidates = regions.filter((r) => {
                const regionTokens = tokenVariants(r.chrom)
                if (intersectsTokenSet(queryTokens, regionTokens)) return true
                const synonyms = Array.isArray(r.synonyms) ? r.synonyms : []
                return synonyms.some((synonym) => intersectsTokenSet(queryTokens, tokenVariants(synonym)))
            })
            if (synonymCandidates.length === 1) {
                return { region: synonymCandidates[0], ambiguous: false }
            }
            if (synonymCandidates.length > 1) {
                return { region: null, ambiguous: true }
            }

            // Mitochondrial aliases
            if (['m', 'mt', 'chrm', 'chrmt'].includes(canonical)) {
                region = regions.find((r) => {
                    const rc = String(r.chrom || '').toLowerCase()
                    const rcStrip = rc.startsWith('chr') ? rc.slice(3) : rc
                    return rc === 'mt' || rc === 'm' || rc === 'chrm' || rc === 'chrmt' || rcStrip === 'mt' || rcStrip === 'm'
                }) || null
                return { region, ambiguous: false }
            }

            return { region: null, ambiguous: false }
        }

        // The backend's name for a sequence, or null when it has none: echoing the typed
        // name back on failure is what let an unknown sequence be "loaded".
        const resolveChromViaBackend = async (chrom, hintStart) => {
            const requested = String(chrom || '').trim()
            if (!requested) return null
            const numericHint = Number(hintStart)
            const probeStart = Number.isFinite(numericHint)
                ? Math.max(0, Math.floor(numericHint) - 1)
                : 0
            const probeEnd = probeStart + 1
            try {
                const res = await fetch(
                    `${API_BASE}/api/browse/sequence?genome=${genome}&chrom=${encodeURIComponent(requested)}&start=${probeStart}&end=${probeEnd}`
                )
                if (!res.ok) return null
                const data = await res.json()
                const resolved = String(data?.chrom || '').trim()
                return resolved || null
            } catch {
                return null
            }
        }

        // The sequence a typed name refers to: the panel's own list first, then the
        // backend's aliases. { region, chrom, ambiguous }; chrom is null when neither knows it.
        const resolveQueryChrom = async (chrom, hintStart) => {
            const { region, ambiguous } = resolveRegionChrom(chrom)
            if (region) return { region, chrom: String(region.chrom), ambiguous: false }
            if (ambiguous) return { region: null, chrom: null, ambiguous: true }
            const backendChrom = await resolveChromViaBackend(chrom, hintStart)
            if (!backendChrom) return { region: null, chrom: null, ambiguous: false }
            const known = regions.find((r) => String(r.chrom || '').trim() === backendChrom) || null
            return { region: known, chrom: backendChrom, ambiguous: false }
        }
        const regionBounds = (region) => {
            const min = Math.max(1, Math.floor(Number(region?.browsable_start) || 1))
            const max = Math.max(min + 1, Math.floor(Number(region?.browsable_end) || Number(region?.end) || min + 1))
            return { min, max }
        }

        const buildIdentifierWindow = (region, maxSpan = 1_000_000) => {
            if (!region?.chrom) return null
            const length = Math.floor(Number(region.end) || 0)
            if (length <= 0) return null
            if (length <= maxSpan) {
                return { chrom: region.chrom, start: 1, end: Math.max(2, length) }
            }
            const span = Math.min(maxSpan, length)
            const center = Math.max(1 + span / 2, Math.min(length - span / 2, length / 3))
            const start = Math.max(1, Math.round(center - span / 2))
            const end = Math.min(length, start + span)
            return { chrom: region.chrom, start, end: Math.max(start + 1, end) }
        }

        const jumpToRange = async (chrom, rawStart, rawEnd, geneForSelection = null) => {
            const { region: initialRegion, ambiguous } = resolveRegionChrom(chrom)
            let region = initialRegion
            let resolvedChrom = String(initialRegion?.chrom || chrom || '').trim()
            let start = Number(rawStart)
            let end = Number(rawEnd)
            if (!Number.isFinite(start) || !Number.isFinite(end)) return false
            if (end <= start) end = start + 1

            // Jumping to a gene also focuses it, which slides the drawer over
            // this panel's right edge — aim for the middle of what stays visible.
            if (geneForSelection) {
                const framedJump = frameRangeWithRightInset({
                    start,
                    end,
                    trackWidthPx: Math.max(1, viewWidthRef.current - LHS_WIDTH),
                    rightInsetPx: focusDrawerInsetOnFocus,
                    flipped: isFlipped,
                })
                if (framedJump) {
                    start = framedJump.start
                    end = framedJump.end
                }
            }

            if (!region && resolvedChrom) {
                const backendResolvedChrom = await resolveChromViaBackend(resolvedChrom, start)
                if (!backendResolvedChrom) return false
                resolvedChrom = backendResolvedChrom
                region = regions.find((r) => String(r.chrom || '').trim() === resolvedChrom) || null
            }
            if (!resolvedChrom) return false

            if (region) {
                // Region starts should always be 1-based chromosome coordinates.
                // Do not clamp to first-gene position from metadata payloads.
                //
                // Unless the genome declares a narrower window worth looking at, which the
                // tutorial's chromosome-1 slice does. Panning and zooming already respect
                // it through clampView; without it here too, a typed region or a pick from
                // the region list could still strand the user in the padding, which is the
                // one thing the declaration exists to prevent.
                const minBound = Math.max(1, Math.floor(Number(region.browsable_start) || 1))
                const maxBound = Math.max(
                    minBound + 1,
                    Math.floor(Number(region.browsable_end) || region.end || minBound + 1)
                )
                const span = Math.max(1, end - start)
                if (start < minBound) {
                    start = minBound
                    end = Math.min(maxBound, start + span)
                }
                if (end > maxBound) {
                    end = maxBound
                    start = Math.max(minBound, end - span)
                }
                setChromLength(maxBound)
            } else if (ambiguous) {
                // Ambiguous alias and no backend resolution: avoid arbitrary region switching.
                return false
            }

            if (resolvedChrom !== selectedChrom) {
                setSelectedChrom(resolvedChrom)
                setGenes([])
                tileCacheRef.current.clear()
                fetchingTilesRef.current.clear()
            }

            setViewStart(start)
            setViewEnd(end)
            if (onPositionChange) {
                onPositionChange(resolvedChrom, start, end)
            }
            pendingVerticalCenterGeneIdRef.current = geneForSelection?.id || null
            setSelectedGene(geneForSelection)
            setSearchInput('')
            if (onManualNavigate) onManualNavigate()
            // The chromosome as this panel knows it, so a caller that focuses what
            // it jumped to records the resolved name rather than what was typed.
            return resolvedChrom
        }

        const coordQuery = rawQuery.replace(/[–—]/g, '-')
        const parsed = parseLocationQuery(rawQuery)
        if (parsed.kind === 'malformed') {
            showSearchFeedback('error', parsed.message)
            return
        }

        // Coordinates: chr:start-end, or chr:position.
        if (parsed.kind === 'range' || parsed.kind === 'position') {
            const chrom = parsed.chrom
            const target = await resolveQueryChrom(chrom, parsed.kind === 'range' ? parsed.start : parsed.position)
            if (target.ambiguous) {
                showSearchFeedback('error', `"${chrom}" matches more than one sequence in ${genomeName}. Use the sequence's full name.`)
                return
            }
            if (!target.chrom) {
                showSearchFeedback('error', `There is no sequence called "${chrom}" in ${genomeName}.`)
                return
            }
            let start = parsed.kind === 'range' ? parsed.start : parsed.position
            let end = parsed.kind === 'range' ? parsed.end : parsed.position
            const notes = []
            if (parsed.swapped) notes.push('The start and end were the wrong way round.')
            // A range that runs off either end shows what there is; one wholly off it
            // shows the nearest end. Either way the reader is told, rather than left to
            // notice that the view is not what they typed.
            if (target.region) {
                const checked = checkRangeAgainstBounds({ start, end }, { ...regionBounds(target.region), chrom: target.chrom })
                start = checked.start
                end = checked.end
                if (checked.warning) notes.push(checked.warning)
            }
            // A single position is centred in a short window rather than focused: a focus
            // is at least two bases wide, which would misstate what was asked for.
            const isPosition = parsed.kind === 'position'
            // A range is framed like a focused gene rather than filling the view edge to
            // edge: padded so the boundary lines are visible, and shifted clear of the
            // drawer that focusing the location is about to slide over this panel.
            const requestedSpan = Math.max(1, end - start)
            const flank = Math.max(1, (requestedSpan / FOCUS_RANGE_FILL_FRACTION - requestedSpan) / 2)
            const framedRegion = isPosition
                ? { start: start - 50, end: start + 50 }
                : frameFocusRange(start - flank, end + flank, { gainingFocus: true })
            const resolvedChrom = await jumpToRange(target.chrom, framedRegion.start, framedRegion.end, null)
            if (!resolvedChrom) {
                showSearchFeedback('error', `Could not show ${chrom}:${start.toLocaleString('en-US')}-${end.toLocaleString('en-US')} in ${genomeName}.`)
                return
            }
            if (!isPosition) focusLocation({ chrom: resolvedChrom, start, end })
            if (notes.length) showSearchFeedback('warning', notes.join(' '))
            // A tutorial step about the search box cannot wait for the box to hold what
            // was typed — jumpToRange empties it — so it waits for this instead. Emitted
            // whether the user typed it or the tutorial did, which is what lets someone
            // who types it themselves move straight on. Only for a location that exists.
            emitTutorialSignal('browser.regionSearched', { chrom, start, end })
            return
        }

        // Region identifier format: chr / CM accession / assembly-report synonym
        const identifierQuery = coordQuery.trim()
        if (identifierQuery && !/[:\s-]/.test(identifierQuery)) {
            const { region, ambiguous } = resolveRegionChrom(identifierQuery)
            if (region) {
                const window = buildIdentifierWindow(region)
                if (window) {
                    await jumpToRange(window.chrom, window.start, window.end, null)
                    return
                }
            }
            if (ambiguous) {
                showSearchFeedback('error', `"${identifierQuery}" matches more than one sequence in ${genomeName}. Use the sequence's full name.`)
                return
            }
        }

        let searchUnavailable = false
        try {
            const res = await fetch(
                `${API_BASE}/api/resolve_id?genome=${genome}&query=${encodeURIComponent(rawQuery)}`
            )
            if (res.ok) {
                const data = await res.json()
                const gene = data?.gene || null
                if (gene?.chrom) {
                    let focusStart = gene.start
                    let focusEnd = gene.end
                    if (data?.resolved_type === 'transcript' && data?.selected_transcript_id && Array.isArray(data?.transcripts)) {
                        const tx = data.transcripts.find((t) => t.id === data.selected_transcript_id)
                        if (tx && Number.isFinite(tx.start) && Number.isFinite(tx.end)) {
                            focusStart = tx.start
                            focusEnd = tx.end
                        }
                    }

                    const span = Math.max(1, focusEnd - focusStart)
                    const padding = Math.max(100, span * 0.5)
                    if (!await jumpToRange(gene.chrom, focusStart - padding, focusEnd + padding, gene)) {
                        showSearchFeedback('error', `Found "${rawQuery}" on ${gene.chrom}, but that sequence is not available in ${genomeName}.`)
                        return
                    }
                    trackAchievement('browser.idSearch')
                    trackAchievement('browser.geneFocus')
                    return
                }
            }
        } catch (e) {
            console.error('Search resolve failed:', e)
            searchUnavailable = true
        }

        // Fallback to currently cached genes if API resolve is unavailable.
        const query = rawQuery.toLowerCase()
        const match = genes.find((g) =>
            (g.name && g.name.toLowerCase().includes(query)) || g.id.toLowerCase().includes(query)
        )
        if (match) {
            const padding = Math.max(100, (match.end - match.start) * 0.5)
            await jumpToRange(match.chrom, match.start - padding, match.end + padding, match)
            trackAchievement('browser.idSearch')
            trackAchievement('browser.geneFocus')
            return
        }

        showSearchFeedback('error', searchUnavailable
            ? `Could not search ${genomeName} for "${rawQuery}": the search service did not respond.`
            : `No gene, transcript or sequence called "${rawQuery}" was found in ${genomeName}.`)
    }
