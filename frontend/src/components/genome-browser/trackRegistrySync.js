// Keeping a Genome Browser panel's custom tracks in step with the Track Manager's
// registry, so settings and render modes edited there take effect here.
import { effectiveMemberTrack, groupRowIdFor } from '../../utils/trackGroups.js'
import { isIntervalTrackType } from './browserConstants.js'
import {
    normalizeBedSettings,
    normalizeBigWigDisplayMode,
    normalizeBigWigSettings,
    normalizeSpliceTrackSettings,
    normalizeVcfDisplayMode,
    normalizeVcfSettings,
} from './trackSettings.js'

export function syncTracksWithRegistry(ctx) {
    const {
        availableGroups,
        availableTracks,
        bedDensityScaleRef,
        customTracks,
        pendingGroupOrderRef,
        setCustomTrackData,
        setCustomTrackLoading,
        setCustomTracks,
        trackChromScaleRef,
        trackFeatureCacheRef,
        trackFeatureFetchSetRef,
        trackTileCacheRef,
        trackTileFetchSetRef,
        vcfBlockTileCacheRef,
        vcfBlockTileFetchSetRef,
        vcfTileCacheRef,
        vcfTileFetchSetRef,
    } = ctx
        if (!Array.isArray(availableTracks) || availableTracks.length === 0 || !Array.isArray(customTracks) || customTracks.length === 0) return
        const byRegistryId = new Map()
        const byPath = new Map()
        for (const registered of availableTracks) {
            if (!registered) continue
            if (registered.id !== undefined && registered.id !== null) {
                byRegistryId.set(String(registered.id), registered)
            }
            if (registered.path) byPath.set(String(registered.path), registered)
        }
        const groupsById = new Map((Array.isArray(availableGroups) ? availableGroups : []).map((g) => [String(g.id), g]))

        const fullRefreshIds = new Set()
        let localChanged = false
        const nextCustomTracks = customTracks.map((track) => {
            const registryId = track?.registryTrackId ? String(track.registryTrackId) : ''
            let registered = null
            if (registryId && byRegistryId.has(registryId)) {
                registered = byRegistryId.get(registryId)
            } else if (track?.path && byPath.has(String(track.path))) {
                registered = byPath.get(String(track.path))
            }
            if (!registered) return track

            // One of a group's tracks shows with the group's own settings for it, and follows
            // the group's name and layout. A group that is gone leaves a plain custom track.
            let groupInfo = track.group
            let joinedRowId = track.joinedRowId
            if (track.group) {
                const group = groupsById.get(String(track.group.id))
                if (!group) {
                    groupInfo = undefined
                    joinedRowId = undefined
                } else {
                    const memberIndex = (group.members || []).findIndex((m) => String(m.track_id) === String(registered.id))
                    if (memberIndex >= 0) registered = effectiveMemberTrack(registered, group.members[memberIndex])
                    groupInfo = {
                        id: group.id,
                        label: group.label,
                        layout: group.layout,
                        index: memberIndex >= 0 ? memberIndex : track.group.index,
                    }
                    joinedRowId = group.layout === 'joined' ? groupRowIdFor(group.id) : undefined
                }
                if (joinedRowId !== track.joinedRowId || groupInfo?.index !== track.group.index) {
                    if (groupInfo) pendingGroupOrderRef.current.add(groupInfo.id)
                }
            }

            const registeredType = registered.type || track.type || 'bigwig'
            const synced = {
                ...track,
                group: groupInfo,
                joinedRowId,
                registryTrackId: registered.id,
                type: registeredType,
                label: registered.label || track.label,
                path: registered.path || track.path,
            }

            if (registeredType === 'bigwig') {
                const mergedSettings = normalizeBigWigSettings(
                    registered.bigwig_settings,
                    track?.bigwigSettings || track?.bigwig_settings,
                )
                synced.bigwigSettings = mergedSettings
                synced.renderMode = normalizeBigWigDisplayMode(registered.display_mode, mergedSettings.data_type)
            } else if (registeredType === 'vcf') {
                synced.vcfSettings = normalizeVcfSettings(
                    registered.vcf_settings,
                    track?.vcfSettings || track?.vcf_settings,
                )
                synced.renderMode = normalizeVcfDisplayMode(registered.display_mode)
            } else if (registeredType === 'splice_junctions') {
                synced.spliceSettings = normalizeSpliceTrackSettings(registered.splice_settings)
                synced.renderMode = 'arcs'
            } else if (registered.display_mode) {
                synced.renderMode = registered.display_mode
            }
            if (isIntervalTrackType(registeredType)) {
                synced.bedSettings = normalizeBedSettings(registered.bed_settings)
            }

            const prevBigwig = track?.bigwigSettings || track?.bigwig_settings
            const nextBigwig = synced?.bigwigSettings || synced?.bigwig_settings
            const settingsChanged = JSON.stringify(prevBigwig || null) !== JSON.stringify(nextBigwig || null)
            const vcfSettingsChanged = JSON.stringify(track?.vcfSettings || track?.vcf_settings || null) !== JSON.stringify(synced?.vcfSettings || synced?.vcf_settings || null)
            const spliceChanged = JSON.stringify(track?.spliceSettings || track?.splice_settings || null) !== JSON.stringify(synced?.spliceSettings || synced?.splice_settings || null)
            const bedSettingsChanged = JSON.stringify(track?.bedSettings || null) !== JSON.stringify(synced?.bedSettings || null)
            const requiresFullRefresh = (
                String(synced.path || '') !== String(track.path || '')
                || String(synced.renderMode || '') !== String(track.renderMode || '')
                || String(synced.type || '') !== String(track.type || '')
            )
            if (requiresFullRefresh && track?.id) {
                fullRefreshIds.add(String(track.id))
            }
            if (
                synced.renderMode !== track.renderMode
                || synced.label !== track.label
                || synced.type !== track.type
                || synced.path !== track.path
                || String(synced.registryTrackId || '') !== String(track.registryTrackId || '')
                || JSON.stringify(synced.group || null) !== JSON.stringify(track.group || null)
                || synced.joinedRowId !== track.joinedRowId
                || settingsChanged
                || vcfSettingsChanged
                || spliceChanged
                || bedSettingsChanged
            ) {
                localChanged = true
            }
            return synced
        })

        if (localChanged) {
            setCustomTracks(nextCustomTracks)
        }
        if (!localChanged || fullRefreshIds.size === 0) return

        const shouldDropTrack = (rawKey) => {
            const normalized = String(rawKey || '').replace(/^(sjblk:|sj:|vcfblk:|adpdet:|bbblk:|bbft:|bddn:)/, '')
            const trackId = normalized.split('|', 1)[0]
            return fullRefreshIds.has(trackId)
        }

        for (const key of Array.from(trackTileCacheRef.current.keys())) {
            if (shouldDropTrack(key)) trackTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(trackFeatureCacheRef.current.keys())) {
            if (shouldDropTrack(key)) trackFeatureCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfTileCacheRef.current.keys())) {
            if (shouldDropTrack(key)) vcfTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(vcfBlockTileCacheRef.current.keys())) {
            if (shouldDropTrack(key)) vcfBlockTileCacheRef.current.delete(key)
        }
        for (const key of Array.from(trackTileFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) trackTileFetchSetRef.current.delete(key)
        }
        for (const key of Array.from(trackFeatureFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) trackFeatureFetchSetRef.current.delete(key)
        }
        for (const key of Array.from(vcfTileFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) vcfTileFetchSetRef.current.delete(key)
        }
        for (const key of Array.from(vcfBlockTileFetchSetRef.current.values())) {
            if (shouldDropTrack(key)) vcfBlockTileFetchSetRef.current.delete(key)
        }
        for (const key of Object.keys(trackChromScaleRef.current)) {
            const trackId = String(key).split('|', 1)[0]
            if (fullRefreshIds.has(trackId)) delete trackChromScaleRef.current[key]
        }
        for (const key of Object.keys(bedDensityScaleRef.current)) {
            const trackId = String(key).split('|', 1)[0]
            if (fullRefreshIds.has(trackId)) delete bedDensityScaleRef.current[key]
        }

        setCustomTrackData((prev) => {
            const next = { ...prev }
            for (const trackId of fullRefreshIds) delete next[trackId]
            return next
        })
        setCustomTrackLoading((prev) => {
            const next = { ...prev }
            for (const trackId of fullRefreshIds) next[trackId] = true
            return next
        })
    }
