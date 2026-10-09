// Gene tiles of a Genome Browser panel: preloading a chromosome's genes when it is
// small enough, and collecting cached genes in a range.
import { API_BASE } from '../../backendRuntime.js'
import { buildGeneIntervalIndex, sameGeneRange } from '../../utils/geneIntervalIndex.js'
import { collectGenesFromList, getChromGeneCacheKey } from './trackData.js'
import { TILE_SIZE, getTileKey, snapToTile } from './trackData.js'

export function preloadChromosomeGenes(ctx, chrom) {
    const {
        activeGeneRequestGenerationRef,
        chromGeneCacheRef,
        chromGeneGenerationRef,
        fetchingChromGenesRef,
        geneTilesBlockedRef,
        genome,
        genomicViewRangeRef,
        identityRequestControllersRef,
        isActive,
        selectedChromRef,
        setGenes,
        setHasInitialViewportData,
        tileCacheRef,
    } = ctx
        const chromName = String(chrom || '').trim()
        if (!isActive || !chromName) return null
        if (geneTilesBlockedRef.current) return null

        const cacheKey = getChromGeneCacheKey(genome, chromName)
        const cached = chromGeneCacheRef.current.get(cacheKey)
        if (Array.isArray(cached)) return cached
        if (fetchingChromGenesRef.current.has(cacheKey)) return null

        const generation = chromGeneGenerationRef.current
        const requestGeneration = activeGeneRequestGenerationRef.current
        const requestToken = Symbol(cacheKey)
        const controller = new AbortController()
        identityRequestControllersRef.current.add(controller)
        fetchingChromGenesRef.current.set(cacheKey, requestToken)
        const params = new URLSearchParams({
            genome,
            chrom: chromName,
        })

        fetch(`${API_BASE}/api/browse/genes?${params.toString()}`, { signal: controller.signal })
            .then((response) => response.ok ? response.json() : null)
            .then((data) => {
                if (!Array.isArray(data)) return
                if (generation !== chromGeneGenerationRef.current) return
                if (requestGeneration !== activeGeneRequestGenerationRef.current) return
                buildGeneIntervalIndex(data)
                chromGeneCacheRef.current.set(cacheKey, data)
                const tilePrefix = `${chromName}:`
                for (const tileKey of tileCacheRef.current.keys()) {
                    if (tileKey.startsWith(tilePrefix)) tileCacheRef.current.delete(tileKey)
                }
                if (getChromGeneCacheKey(genome, selectedChromRef.current) !== cacheKey) return
                const range = genomicViewRangeRef.current || {}
                const visible = collectGenesFromList(data, range.start, range.end)
                setGenes((prev) => sameGeneRange(prev, visible) ? prev : visible)
                setHasInitialViewportData(true)
            })
            .catch((e) => {
                if (e?.name !== 'AbortError') {
                    console.warn(`[GenomeBrowser:${genome}] Failed to preload genes for ${chromName}`, e)
                }
            })
            .finally(() => {
                identityRequestControllersRef.current.delete(controller)
                if (fetchingChromGenesRef.current.get(cacheKey) === requestToken) {
                    fetchingChromGenesRef.current.delete(cacheKey)
                }
            })

        return null
    }

export function collectCachedGenes(ctx, chrom, start, end, tilePad = 1) {
    const {
        chromGeneCacheRef,
        genome,
        tileCacheRef,
    } = ctx
        if (!chrom) {
            return { genes: [], coverage: 0, expectedTiles: 0, fetchedTiles: 0 }
        }
        const chromGenes = chromGeneCacheRef.current.get(getChromGeneCacheKey(genome, chrom))
        if (Array.isArray(chromGenes)) {
            return {
                genes: collectGenesFromList(chromGenes, start, end),
                coverage: 1,
                expectedTiles: 1,
                fetchedTiles: 1,
                source: 'chrom',
            }
        }

        const cache = tileCacheRef.current
        const rangeStart = Math.max(0, Math.floor(start))
        const rangeEnd = Math.max(rangeStart + 1, Math.ceil(end))
        const coreFirstTile = snapToTile(rangeStart)
        const coreLastTile = snapToTile(Math.max(rangeStart, rangeEnd - 1))
        let expectedTiles = 0
        let fetchedTiles = 0
        for (let t = coreFirstTile; t <= coreLastTile; t += TILE_SIZE) {
            expectedTiles += 1
            if (cache.has(getTileKey(chrom, t))) fetchedTiles += 1
        }

        const firstTile = snapToTile(Math.max(0, rangeStart - tilePad * TILE_SIZE))
        const lastTile = snapToTile(rangeEnd + tilePad * TILE_SIZE)
        const collected = []
        const seen = new Set()
        for (let t = firstTile; t <= lastTile; t += TILE_SIZE) {
            const key = getTileKey(chrom, t)
            const tileGenes = cache.get(key)
            if (!tileGenes) continue
            for (const g of tileGenes) {
                if (!seen.has(g.id) && g.end >= rangeStart && g.start <= rangeEnd) {
                    seen.add(g.id)
                    collected.push(g)
                }
            }
        }

        return {
            genes: collected,
            coverage: expectedTiles > 0 ? (fetchedTiles / expectedTiles) : 1,
            expectedTiles,
            fetchedTiles,
            source: 'tiles',
        }
    }
