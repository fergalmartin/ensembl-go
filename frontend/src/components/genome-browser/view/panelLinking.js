// Linking the Genome Browser's panels: propagating one panel's position to the
// others (with the off-screen hold), and linking by gene or by region.
import { samePanelPosition } from './browserViewModel.js'
import { hasFiniteGeneCoords } from '../../../app/geneFocus.js'
import { browserViewportControls, describeBrowserViewport } from '../../../utils/browserTutorialControls.js'
import { linkedGeneFraming } from '../../../utils/linkedGeneFraming.js'
import { geneFivePrime } from './browserViewModel.js'
import { API_BASE } from '../../../backendRuntime.js'
import { chromosomeTokensForRegion, clampWindowToRegion, resolveRegionByChromTokens } from './browserViewModel.js'

export function flushLinkedPanelPositions(ctx, panelKey, chrom, start, end, targetTrack, anchorRatio = null) {
    const {
        firstPanel,
        isOverlayActive,
        linkModelRef,
        linkedSet,
        lockPanRef,
        lockZoomRef,
        onRefViewportChange,
        panelActualPositionsRef,
        panels,
        setPanelPositions,
        syncSourcePanelKeyRef,
    } = ctx
        if (firstPanel && panelKey === firstPanel.key && onRefViewportChange) {
            onRefViewportChange({ chrom, start, end, targetTrack: targetTrack || null })
        }
        // Keep the ref up-to-date with the source panel's actual position.
        panelActualPositionsRef.current[panelKey] = { chrom, start, end }
        syncSourcePanelKeyRef.current = panelKey
        if (!(lockPanRef.current || lockZoomRef.current || isOverlayActive)) return

        let recipients = []
        if (linkedSet.size >= 2) {
            recipients = panels
                .map((panel) => panel.key)
                .filter((key) => key !== panelKey && linkedSet.has(key))
        } else if (panels.length >= 2) {
            recipients = panels
                .map((panel) => panel.key)
                .filter((key) => key !== panelKey)
        }
        if (recipients.length === 0) return

        const model = linkModelRef.current
        const sourceDelta = model?.deltas?.[panelKey]?.delta
        const canApplyOffsets = Number.isFinite(sourceDelta) && recipients.every((key) => Number.isFinite(model?.deltas?.[key]?.delta))
        const canApplyRegionChroms = model?.type === 'region' && recipients.every((key) => String(model?.chroms?.[key] || '').trim())
        const isZoom = Number.isFinite(anchorRatio)
        const newSpan = Number(end) - Number(start)

        setPanelPositions((prev) => {
            const next = { ...prev }
            let changed = false
            const getRecipientChrom = (key) => (
                panelActualPositionsRef.current[key]?.chrom
                || prev[key]?.chrom
                || chrom
            )
            if (canApplyOffsets) {
                // Gene-link delta model: offset each recipient by its genomic delta.
                // Include anchorRatio so lockZoom applies the position directly instead
                // of falling back to the keep-own-center logic.
                const anchorStart = Number(start) - Number(sourceDelta)
                const anchorEnd = Number(end) - Number(sourceDelta)
                for (const key of recipients) {
                    const info = model.deltas[key]
                    const delta = Number(info.delta)
                    const nextPosition = {
                        chrom: info.chrom || chrom,
                        start: anchorStart + delta,
                        end: anchorEnd + delta,
                        targetTrack,
                        anchorRatio: isZoom ? anchorRatio : undefined,
                    }
                    if (!samePanelPosition(prev[key], nextPosition)) {
                        next[key] = nextPosition
                        changed = true
                    }
                }
            } else if (canApplyRegionChroms) {
                for (const key of recipients) {
                    const nextPosition = {
                        chrom: model.chroms[key] || chrom,
                        start,
                        end,
                        targetTrack,
                        anchorRatio: isZoom ? anchorRatio : undefined,
                    }
                    if (!samePanelPosition(prev[key], nextPosition)) {
                        next[key] = nextPosition
                        changed = true
                    }
                }
            } else if (isZoom && lockZoomRef.current && !lockPanRef.current) {
                // lockZoom zoom event without a delta model: apply the same screen-ratio
                // anchor to each recipient so they zoom in place at the same visual column.
                // Use panelActualPositionsRef so we always have the real current position,
                // not the stale panelPositions state value (which gets overwritten by pan
                // broadcasts and would otherwise cause a jump on the next zoom event).
                for (const key of recipients) {
                    const actualPos = panelActualPositionsRef.current[key]
                    const prevPos = actualPos || prev[key]
                    if (prevPos && Number.isFinite(prevPos.start) && Number.isFinite(prevPos.end)) {
                        const prevSpan = Number(prevPos.end) - Number(prevPos.start)
                        const anchor = Number(prevPos.start) + anchorRatio * prevSpan
                        const nextStart = anchor - anchorRatio * newSpan
                        const nextEnd = anchor + (1 - anchorRatio) * newSpan
                        // Update the ref so subsequent events also use the right position.
                        panelActualPositionsRef.current[key] = { chrom: prevPos.chrom || getRecipientChrom(key), start: nextStart, end: nextEnd }
                        const nextPosition = {
                            chrom: prevPos.chrom || getRecipientChrom(key),
                            start: nextStart,
                            end: nextEnd,
                            targetTrack,
                            anchorRatio,
                        }
                        if (!samePanelPosition(prev[key], nextPosition)) {
                            next[key] = nextPosition
                            changed = true
                        }
                    } else {
                        const nextPosition = { chrom: getRecipientChrom(key), start, end, targetTrack, anchorRatio }
                        if (!samePanelPosition(prev[key], nextPosition)) {
                            next[key] = nextPosition
                            changed = true
                        }
                    }
                }
            } else {
                for (const key of recipients) {
                    const nextPosition = { chrom: getRecipientChrom(key), start, end, targetTrack }
                    if (!samePanelPosition(prev[key], nextPosition)) {
                        next[key] = nextPosition
                        changed = true
                    }
                }
            }
            return changed ? next : prev
        })
    }

export function applyLinkedGeneViewToPanels(ctx, genesByPanelKey, options = {}) {
    const {
        clearPendingLinkApply,
        linkApplyTimerRef,
        linkModelRef,
        lockPanRef,
        lockZoomRef,
        panels,
        setLinkedPanelKeys,
        setLockPan,
        setLockZoom,
        setNavigateGenes,
        setPanelPositions,
    } = ctx
        const validPanels = panels.filter((panel) => hasFiniteGeneCoords(genesByPanelKey?.[panel.key]))
        if (validPanels.length < 2) return false

        const validKeys = validPanels.map((panel) => panel.key)
        const requestedAnchorKey = String(options.anchorKey || '').trim()
        const anchorKey = validKeys.includes(requestedAnchorKey) ? requestedAnchorKey : validKeys[0]
        const anchorGene = genesByPanelKey[anchorKey]

        const anchorFivePrime = geneFivePrime(anchorGene)
        if (!Number.isFinite(anchorFivePrime)) return false
        const { ratio: fivePrimeRatio, span } = linkedGeneFraming(validPanels.map((panel) => ({
            gene: genesByPanelKey[panel.key],
            bounds: describeBrowserViewport(panel.key)?.bounds,
            frameRange: browserViewportControls(panel.key)?.frameFocusedRange,
        })), anchorGene?.strand)

        const deltas = {}
        const nextNavigate = {}
        const nextPositions = {}
        for (const panel of validPanels) {
            const gene = genesByPanelKey[panel.key]
            const fivePrime = geneFivePrime(gene)
            if (!Number.isFinite(fivePrime)) continue
            const windowStart = fivePrime - (fivePrimeRatio * span)
            const windowEnd = windowStart + span
            deltas[panel.key] = {
                delta: fivePrime - anchorFivePrime,
                chrom: gene.chrom,
            }
            nextNavigate[panel.key] = {
                ...gene,
                windowStart,
                windowEnd,
                centerVertically: true,
            }
            nextPositions[panel.key] = {
                chrom: gene.chrom,
                // Navigation already accounts for the drawer. The linked position
                // must use the same framing or enabling Pan/Zoom undoes that work.
                ...(browserViewportControls(panel.key)?.frameFocusedRange?.(windowStart, windowEnd)
                    || { start: windowStart, end: windowEnd }),
            }
        }

        if (Object.keys(deltas).length < 2) return false

        if (lockPanRef.current) setLockPan(false)
        if (lockZoomRef.current) setLockZoom(false)
        clearPendingLinkApply()

        setPanelPositions((prev) => {
            const next = { ...prev }
            for (const key of validKeys) {
                delete next[key]
            }
            return next
        })
        setNavigateGenes((prev) => ({ ...prev, ...nextNavigate }))
        setLinkedPanelKeys(validKeys)
        linkModelRef.current = {
            type: 'gene',
            anchorKey,
            deltas,
        }

        linkApplyTimerRef.current = window.setTimeout(() => {
            linkApplyTimerRef.current = null
            setPanelPositions((prev) => ({ ...prev, ...nextPositions }))
            setLockPan(true)
            setLockZoom(true)
        }, 260)
        return true
    }

export async function linkPanelsByGene(ctx) {
    const {
        applyLinkedGeneView,
        externalFocusMap,
        hasPanels,
        linkModelRef,
        panels,
        selectedGenes,
        setLinkedPanelKeys,
        setLinkingGene,
        setSelectedGenes,
        tutorialEpochRef,
    } = ctx
        if (!hasPanels) return
        const selectedByPanel = {}
        for (const panel of panels) {
            const gene = hasFiniteGeneCoords(selectedGenes[panel.key])
                ? selectedGenes[panel.key]
                : externalFocusMap?.[panel.key]
            if (hasFiniteGeneCoords(gene)) {
                selectedByPanel[panel.key] = gene
            }
        }
        const selectedKeys = Object.keys(selectedByPanel)
        if (selectedKeys.length === 0) return

        const anchorKey = selectedKeys[0]
        const anchorGene = selectedByPanel[anchorKey]
        const queryToken = String(anchorGene?.name || anchorGene?.id || '').trim()
        const hasUnmatchedPanels = panels.some((panel) => !selectedByPanel[panel.key])
        if (!hasUnmatchedPanels || !queryToken) {
            if (selectedKeys.length >= 2) {
                setSelectedGenes((prev) => ({ ...prev, ...selectedByPanel }))
                applyLinkedGeneView(selectedByPanel, { anchorKey })
            }
            return
        }

        const requestEpoch = tutorialEpochRef.current
        setLinkingGene(true)
        try {
            const matched = { ...selectedByPanel }
            await Promise.all(panels.map(async (panel) => {
                if (matched[panel.key]) return
                try {
                    const res = await fetch(`${API_BASE}/api/browse/search_gene?genome=${encodeURIComponent(panel.genomeParam)}&query=${encodeURIComponent(queryToken)}`)
                    if (!res.ok) return
                    const gene = await res.json()
                    if (hasFiniteGeneCoords(gene)) {
                        matched[panel.key] = gene
                    }
                } catch {
                    // keep unmatched panels independent
                }
            }))

            if (requestEpoch !== tutorialEpochRef.current) return
            const matchedKeys = panels
                .map((panel) => panel.key)
                .filter((key) => hasFiniteGeneCoords(matched[key]))
            if (matchedKeys.length < 2) {
                setLinkedPanelKeys([])
                linkModelRef.current = null
                alert(`Gene "${queryToken}" was not found in at least two visible genomes.`)
                return
            }

            const effectiveAnchor = matched[anchorKey] ? anchorKey : matchedKeys[0]
            setSelectedGenes((prev) => ({ ...prev, ...matched }))
            applyLinkedGeneView(matched, { anchorKey: effectiveAnchor })
        } catch (e) {
            console.error('Failed to link gene:', e)
        } finally {
            setLinkingGene(false)
        }
    }

export async function linkPanelsByRegion(ctx) {
    const {
        clearPendingLinkApply,
        fetchRegionsForPanel,
        firstPanel,
        linkModelRef,
        linkingRegion,
        lockPanRef,
        lockZoomRef,
        panelActualPositionsRef,
        panelCount,
        panels,
        setLinkedPanelKeys,
        setLinkingRegion,
        setLockPan,
        setLockZoom,
        setPanelPositions,
        syncSourcePanelKeyRef,
        tutorialEpochRef,
    } = ctx
        if (panelCount < 2 || !firstPanel || linkingRegion) return
        const primaryPosition = panelActualPositionsRef.current[firstPanel.key]
        if (
            !primaryPosition?.chrom ||
            !Number.isFinite(Number(primaryPosition.start)) ||
            !Number.isFinite(Number(primaryPosition.end)) ||
            Number(primaryPosition.end) <= Number(primaryPosition.start)
        ) {
            return
        }

        const requestEpoch = tutorialEpochRef.current
        setLinkingRegion(true)
        try {
            const primaryRegions = await fetchRegionsForPanel(firstPanel)
            const primaryRegion = resolveRegionByChromTokens(primaryRegions, primaryPosition.chrom)
            const sourceTokens = chromosomeTokensForRegion(primaryRegion, primaryPosition.chrom)
            if (!sourceTokens.size) return

            const linkedKeys = [firstPanel.key]
            const chroms = { [firstPanel.key]: String(primaryPosition.chrom) }
            const nextPositions = {}

            for (const panel of panels) {
                if (panel.key === firstPanel.key) continue
                const regions = await fetchRegionsForPanel(panel)
                const region = resolveRegionByChromTokens(regions, sourceTokens)
                if (!region?.chrom) continue
                const window = clampWindowToRegion(
                    String(region.chrom),
                    Number(primaryPosition.start),
                    Number(primaryPosition.end),
                    region,
                )
                if (!window) continue
                linkedKeys.push(panel.key)
                chroms[panel.key] = window.chrom
                nextPositions[panel.key] = window
                panelActualPositionsRef.current[panel.key] = window
            }

            if (requestEpoch !== tutorialEpochRef.current || linkedKeys.length < 2) return

            if (lockPanRef.current) setLockPan(false)
            if (lockZoomRef.current) setLockZoom(false)
            clearPendingLinkApply()
            linkModelRef.current = {
                type: 'region',
                anchorKey: firstPanel.key,
                chroms,
            }
            syncSourcePanelKeyRef.current = firstPanel.key
            setLinkedPanelKeys(linkedKeys)
            setPanelPositions((prev) => ({ ...prev, ...nextPositions }))
            setLockPan(true)
            setLockZoom(true)
        } catch (error) {
            console.error('Failed to link region:', error)
        } finally {
            setLinkingRegion(false)
        }
    }
