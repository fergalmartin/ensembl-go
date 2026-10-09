// The tile caches of a Genome Browser panel's custom tracks: pruning what belongs
// to removed tracks, and evicting old tiles when a cache grows too large.

export function pruneRemovedTrackCaches(ctx) {
    const {
        bigBedLayoutStateRef,
        bigBedLodStateRef,
        customTracks,
        setCustomTrackData,
        setCustomTrackLoading,
        spliceLodStateRef,
        trackChromScaleRef,
        trackFeatureCacheRef,
        trackTileCacheRef,
        vcfBlockTileCacheRef,
        vcfLevelStateRef,
        vcfTileCacheRef,
    } = ctx
        const keepIds = new Set(customTracks.map((track) => track.id))
        const visibleIds = new Set(customTracks.filter((track) => track.visible !== false).map((track) => track.id))

        for (const key of Array.from(trackTileCacheRef.current.keys())) {
            const trackId = key.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) trackTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(trackFeatureCacheRef.current.keys())) {
            const withoutPrefix = key
                .replace(/^sjblk:/, '')
                .replace(/^sj:/, '')
                .replace(/^bbblk:/, '')
                .replace(/^bbft:/, '')
            const trackId = withoutPrefix.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) trackFeatureCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfTileCacheRef.current.keys())) {
            const trackId = key.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) vcfTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfBlockTileCacheRef.current.keys())) {
            // keys are "vcfblk:${trackId}|..." or "adpdet:${trackId}|..."
            const withoutPrefix = key.replace(/^(vcfblk|adpdet):/, '')
            const trackId = withoutPrefix.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) vcfBlockTileCacheRef.current.delete(key)
        }
        for (const key of Object.keys(trackChromScaleRef.current)) {
            const trackId = key.split('|', 1)[0]
            if (!keepIds.has(trackId) || !visibleIds.has(trackId)) delete trackChromScaleRef.current[key]
        }
        for (const key of Object.keys(vcfLevelStateRef.current)) {
            if (!keepIds.has(key)) delete vcfLevelStateRef.current[key]
        }
        for (const key of Object.keys(spliceLodStateRef.current)) {
            if (!keepIds.has(key) || !visibleIds.has(key)) delete spliceLodStateRef.current[key]
        }
        for (const key of Object.keys(bigBedLodStateRef.current)) {
            if (!keepIds.has(key) || !visibleIds.has(key)) delete bigBedLodStateRef.current[key]
        }
        for (const key of Object.keys(bigBedLayoutStateRef.current)) {
            if (!keepIds.has(key) || !visibleIds.has(key)) delete bigBedLayoutStateRef.current[key]
        }

        setCustomTrackData((prev) => {
            const next = {}
            for (const [id, value] of Object.entries(prev)) {
                if (keepIds.has(id) && visibleIds.has(id)) next[id] = value
            }
            return next
        })
        setCustomTrackLoading((prev) => {
            const next = {}
            for (const [id, value] of Object.entries(prev)) {
                if (keepIds.has(id) && visibleIds.has(id)) next[id] = value
            }
            return next
        })
    }

export function evictOldTiles(ctx) {
    const {
        trackFeatureCacheRef,
        trackTileCacheRef,
        vcfBlockTileCacheRef,
        vcfTileCacheRef,
    } = ctx
        const MAX_TILES = 2000
        const cache = trackTileCacheRef.current
        if (cache.size > MAX_TILES * 1.3) {
            // Delete oldest 30% (Maps maintain insertion order)
            const toDelete = Math.floor(cache.size - MAX_TILES)
            let removed = 0
            for (const key of cache.keys()) {
                if (removed >= toDelete) break
                cache.delete(key)
                removed++
            }
        }

        const MAX_VCF_TILES = 2800
        const vcfCache = vcfTileCacheRef.current
        if (vcfCache.size > MAX_VCF_TILES * 1.25) {
            const toDelete = Math.floor(vcfCache.size - MAX_VCF_TILES)
            let removed = 0
            for (const key of vcfCache.keys()) {
                if (removed >= toDelete) break
                vcfCache.delete(key)
                removed++
            }
        }

        const MAX_FEATURE_TILES = 3000
        const featureCache = trackFeatureCacheRef.current
        if (featureCache.size > MAX_FEATURE_TILES * 1.25) {
            const toDelete = Math.floor(featureCache.size - MAX_FEATURE_TILES)
            let removed = 0
            for (const key of featureCache.keys()) {
                if (removed >= toDelete) break
                featureCache.delete(key)
                removed++
            }
        }

        const MAX_VCF_BLOCK_TILES = 2400
        const vcfBlockCache = vcfBlockTileCacheRef.current
        if (vcfBlockCache.size > MAX_VCF_BLOCK_TILES * 1.25) {
            const toDelete = Math.floor(vcfBlockCache.size - MAX_VCF_BLOCK_TILES)
            let removed = 0
            for (const key of vcfBlockCache.keys()) {
                if (removed >= toDelete) break
                vcfBlockCache.delete(key)
                removed++
            }
        }
    }
