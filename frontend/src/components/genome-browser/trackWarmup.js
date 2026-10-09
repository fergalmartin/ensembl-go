// Warming a panel's VCF overview tiles for the whole chromosome, so zooming out
// on a variant track shows its density without waiting.
import { API_BASE } from '../../backendRuntime.js'
import { VCF_BLOCK_LEVELS, buildVcfOverviewWarmupKey, buildVcfOverviewWarmupTiles } from '../../utils/vcfTileStrategy.js'
import { getFetchErrorMessage, isTransientFetchErrorMessage } from './trackData.js'
import { isVcfAdaptiveLikeMode, normalizeVcfDisplayMode } from './trackSettings.js'

export function warmVcfOverviewTiles(ctx) {
    const {
        chromLength,
        customTracks,
        genome,
        isActive,
        makeVcfBlockTileKey,
        selectedChrom,
        setCustomTrackData,
        setCustomTrackFetchRevision,
        setCustomTrackLoading,
        vcfBlockTileCacheRef,
        vcfBlockTileFetchSetRef,
        vcfOverviewWarmupActiveRef,
        vcfOverviewWarmupDoneRef,
    } = ctx
        if (!isActive || !selectedChrom || !Number(chromLength || 0)) return
        const l0 = VCF_BLOCK_LEVELS[0]
        const chromEnd = Number(chromLength || 0)
        const vcfTracks = customTracks.filter((track) => (
            track?.path
            && track.visible
            && (track.type || 'bigwig') === 'vcf'
            && isVcfAdaptiveLikeMode(normalizeVcfDisplayMode(track.renderMode))
        ))
        if (vcfTracks.length === 0) return

        let cancelled = false
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        const hasForegroundVcfFetch = () => {
            for (const key of vcfBlockTileFetchSetRef.current.values()) {
                const token = String(key || '')
                if (token.startsWith('adpdet:')) return true
                if (token.startsWith('vcfblk:') && !token.includes('|L0|')) return true
            }
            return false
        }

        const warmTrack = async (track) => {
            const warmupKey = buildVcfOverviewWarmupKey({
                trackId: track.id,
                path: track.path,
                chrom: selectedChrom,
                chromLength: chromEnd,
                level: l0,
            })
            if (vcfOverviewWarmupDoneRef.current.has(warmupKey)) return
            if (vcfOverviewWarmupActiveRef.current.has(warmupKey)) return
            vcfOverviewWarmupActiveRef.current.add(warmupKey)
            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: true }))

            try {
                const tiles = buildVcfOverviewWarmupTiles({ chromLength: chromEnd, level: l0 })
                    .map((tileSpec) => {
                        const tileStart = tileSpec.tileStart
                        const tileEnd = tileSpec.tileEnd
                        const key = makeVcfBlockTileKey(track.id, selectedChrom, l0.id, tileStart, tileEnd)
                        return { ...tileSpec, key }
                    })
                    .filter((tile) => !vcfBlockTileCacheRef.current.has(tile.key))

                if (tiles.length === 0) {
                    vcfOverviewWarmupDoneRef.current.add(warmupKey)
                    return
                }

                for (const tile of tiles) {
                    if (cancelled) return
                    while (!cancelled && hasForegroundVcfFetch()) {
                        await delay(80)
                    }
                    if (cancelled) return
                    if (vcfBlockTileCacheRef.current.has(tile.key)) continue
                    if (vcfBlockTileFetchSetRef.current.has(tile.key)) continue

                    vcfBlockTileFetchSetRef.current.add(tile.key)
                    try {
                        const response = await fetch(`${API_BASE}/api/browse/vcf/block_tiles`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                path: track.path,
                                chrom: selectedChrom,
                                genome,
                                coverage_threshold: 0.25,
                                tiles: [{
                                    start: tile.start,
                                    end: tile.end,
                                    level_id: tile.level_id,
                                    block_bp: tile.block_bp,
                                    window_bp: tile.window_bp,
                                }],
                            }),
                        })
                        const payload = response.ok
                            ? await response.json()
                            : await response.json().then((e) => { throw new Error(e?.detail || `HTTP ${response.status}`) })
                        const returnedChrom = payload?.chrom || selectedChrom
                        const returned = Array.isArray(payload?.tiles) ? payload.tiles : []
                        for (const returnedTile of returned) {
                            const tStart = Math.max(0, Math.floor(Number(returnedTile.start) || 0))
                            const tEnd = Math.max(tStart + 1, Math.ceil(Number(returnedTile.end) || 1))
                            const levelId = String(returnedTile.level_id || l0.id)
                            const selectedKey = makeVcfBlockTileKey(track.id, selectedChrom, levelId, tStart, tEnd)
                            vcfBlockTileCacheRef.current.set(selectedKey, returnedTile)
                            if (returnedChrom !== selectedChrom) {
                                const resolvedKey = makeVcfBlockTileKey(track.id, returnedChrom, levelId, tStart, tEnd)
                                vcfBlockTileCacheRef.current.set(resolvedKey, returnedTile)
                            }
                        }
                        setCustomTrackFetchRevision((v) => v + 1)
                    } catch (e) {
                        const errorMessage = getFetchErrorMessage(e)
                        if (!isTransientFetchErrorMessage(errorMessage)) {
                            setCustomTrackData((prev) => ({
                                ...prev,
                                [track.id]: { ...(prev[track.id] || {}), has_data: false, error: errorMessage },
                            }))
                            setCustomTrackLoading((prev) => ({ ...prev, [track.id]: false }))
                            return
                        }
                    } finally {
                        vcfBlockTileFetchSetRef.current.delete(tile.key)
                    }
                    await delay(20)
                }

                vcfOverviewWarmupDoneRef.current.add(warmupKey)
                setCustomTrackFetchRevision((v) => v + 1)
            } finally {
                vcfOverviewWarmupActiveRef.current.delete(warmupKey)
            }
        }

        for (const track of vcfTracks) {
            warmTrack(track)
        }

        return () => {
            cancelled = true
        }
    }
