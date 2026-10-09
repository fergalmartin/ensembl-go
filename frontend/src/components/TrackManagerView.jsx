/**
 * TrackManagerView — register, browse, and manage custom data tracks.
 * Tracks are persisted to disk via the backend's /api/tracks endpoints.
 */
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react'
import { genomeColorPalette } from '../genomeColorSchemes'
import { groupsContainingTrack, groupsForAssembly, sharedAssembly } from '../utils/trackGroups'
import useTutorial from '../hooks/useTutorial'

import { API_BASE } from '../backendRuntime'
import { genomeKeysMatch, getGenomeKey, normalizeGenomeProvider, trackAssemblyKey } from '../utils/genomeIdentity'
import {
  HUB_TRACK_ROW_HEIGHT,
  TRACK_TYPES,
  buildGenomeDisplayLabel,
  buildHubDiscoveryCacheKey,
  buildHubDiscoverySignature,
  fallbackGenomeLabel,
  findGenomeOption,
  hubTrackTypeLabel,
  normalizeHubDataUrl,
  normalizeHubTrackType,
  readHubDiscoveryCache,
  titleCaseGenomeToken,
  writeHubDiscoveryCache,
} from './track-manager/trackManagerModel.js'
import {
  TrackColorPaletteContext,
} from './track-manager/trackColorContext.js'
import {
  EmptyState,
  GroupLayoutIcon,
  IconUpDown,
  TypeBadge,
} from './track-manager/trackManagerParts.jsx'
import {
  RegistrationWizard,
} from './track-manager/RegistrationWizard.jsx'
import {
  TrackGroupDialog,
} from './track-manager/TrackGroupDialog.jsx'
import {
  TrackGroupCard,
} from './track-manager/TrackGroupCard.jsx'
import {
  TrackCard,
} from './track-manager/TrackCard.jsx'
import {
  HubTrackRows,
} from './track-manager/HubTrackRows.jsx'

// ── Main View ─────────────────────────────────────────────────────────────────

export default function TrackManagerView({
    theme = 'dark',
    config,
    inactiveSpecies = [],
    // A tutorial's `trackRegistry` arrival, reconciled below, and the way back: the
    // arrival waits on what this reports rather than assuming registration is instant.
    tutorialTrackRequest = null,
    onTutorialTracksRegistered = null,
}) {
    const isLight = theme === 'light'
    // Registering a track and saving a group are what their tutorial steps wait for: the
    // press alone would move on while the file is still being checked, and the next step's
    // arrival would register it a second time.
    const { emitSignal: emitTutorialSignal } = useTutorial()
    const [tracks, setTracks] = useState([])
    const [groups, setGroups] = useState([])
    // The group dialog: { group } to edit one, with `addTrackIds` when opened from "Add to
    // group"; { genomeKey, trackIds } to start a new one.
    const [groupDialog, setGroupDialog] = useState(null)
    const [groupMenuOpen, setGroupMenuOpen] = useState(false)
    const groupMenuRef = useRef(null)
    const [loading, setLoading] = useState(true)
    const [showWizard, setShowWizard] = useState(false)
    // Tracks ticked for editing together, and the tracks the edit dialog is open on.
    const [selectedTrackIds, setSelectedTrackIds] = useState(() => new Set())
    const [editingTracks, setEditingTracks] = useState(null)
    const toggleTrackSelected = useCallback((id) => {
        setSelectedTrackIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }, [])
    // What the wizard should open showing, when a tutorial puts it in a particular state.
    const [wizardSeed, setWizardSeed] = useState(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [filterType, setFilterType] = useState('')
    const [filterGenome, setFilterGenome] = useState('')
    const [hubTracksByGenome, setHubTracksByGenome] = useState({})
    const [hubLoading, setHubLoading] = useState(false)
    const [hubError, setHubError] = useState('')
    const [hubSelectedRows, setHubSelectedRows] = useState({})
    const [hubSearchByGenome, setHubSearchByGenome] = useState({})
    const [hubFilterByGenome, setHubFilterByGenome] = useState({})
    const [hubExpandedByGroup, setHubExpandedByGroup] = useState({})
    const [hubImportTasks, setHubImportTasks] = useState([])
    const [hubImporting, setHubImporting] = useState(false)
    const seenCompletedHubTaskIdsRef = useRef(new Set())
    const hubDiscoverySignatureRef = useRef('')

    // Build genome options from all species in the top bar (active + inactive in browser view)
    const genomeOptions = useMemo(() => {
        const all = [...(config?.active_species || []), ...(inactiveSpecies || [])]
        const seen = new Set()
        return all
            .filter(s => {
                const key = getGenomeKey(s)
                if (seen.has(key)) return false
                seen.add(key)
                return true
            })
            .map(s => {
                const key = getGenomeKey(s)
                const name = s.display_name || s.common_name || s.scientific_name || titleCaseGenomeToken(s.species_key) || key
                const assembly = s.assembly_name || s.assembly || ''
                const accession = s.assembly || s.gca || ''
                return {
                    key,
                    label: buildGenomeDisplayLabel({
                        name,
                        assemblyName: assembly,
                        accession,
                        fallback: key,
                    }),
                }
            })
    }, [config?.active_species, inactiveSpecies])

    const selectedGenomesForHub = useMemo(() => {
        const all = [...(config?.active_species || []), ...(inactiveSpecies || [])]
        const seen = new Set()
        const rows = []
        for (const species of all) {
            const speciesKey = String(species?.species_key || '').trim()
            const assembly = String(species?.assembly || '').trim()
            const genomeKey = getGenomeKey(species)
            if (!speciesKey || !assembly || seen.has(genomeKey)) continue
            seen.add(genomeKey)
            rows.push({
                genome_key: genomeKey,
                species_key: speciesKey,
                scientific_name: String(species?.scientific_name || '').trim(),
                common_name: String(species?.common_name || '').trim(),
                assembly,
                assembly_name: String(species?.assembly_name || species?.assembly || '').trim(),
                provider: normalizeGenomeProvider(species),
            })
        }
        return rows
    }, [config?.active_species, inactiveSpecies])
    const hubDiscoveryCacheKey = useMemo(
        () => buildHubDiscoveryCacheKey(selectedGenomesForHub),
        [selectedGenomesForHub]
    )

    const loadTracks = useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/tracks`)
            if (res.ok) {
                const data = await res.json()
                const loaded = { tracks: data.tracks || [], groups: Array.isArray(data.groups) ? data.groups : [] }
                setTracks(loaded.tracks)
                setGroups(loaded.groups)
                return loaded
            }
        } catch (e) {
            console.warn('Failed to load tracks:', e)
        } finally {
            setLoading(false)
        }
        return { tracks: [], groups: [] }
    }, [])

    useEffect(() => { loadTracks() }, [loadTracks])

    /* Report what is registered, so a tutorial's arrival can wait for the work rather than
     * assume it. Registering validates the file and may build a tabix index, which is real
     * work; a card describing a track in the list was otherwise ringing a card that did
     * not exist yet. */
    useEffect(() => {
        onTutorialTracksRegistered?.(tracks.map((track) => String(track?.label || '')))
    }, [tracks, onTutorialTracksRegistered])

    /* A tutorial's `trackRegistry` arrival, reconciled against this view.
     *
     * Set, never toggled: an arrival runs on every entry to a step, so walking back into
     * the step that registers the first track has to find exactly one track registered,
     * not a second copy of it.
     *
     * Registering is done here rather than in the runtime because this is where the work
     * lives, and because the registry the tutorial writes to is chosen by the backend
     * (`main._tracks_config`) rather than by the caller — so there is no second path that
     * could write somewhere else. */
    useEffect(() => {
        const request = tutorialTrackRequest
        if (!request) return
        let cancelled = false

        const run = async () => {
            // The registry itself is the runtime's job, not this view's. It has to be,
            // because a genome-browser step declares registered tracks with no Track
            // Manager mounted — and when both reconciled, each read the same empty registry
            // and posted the same three tracks, so the list showed six.
            //
            // So this only catches up with what the runtime has done.
            const loaded = await loadTracks()
            if (cancelled) return

            // The group section: which cards are ticked, and whether the "Add to group" menu
            // or the new-group dialog is up. Tracks are named by key and found by their file.
            const idFor = (key) => loaded.tracks.find((track) => request.files?.[key] && String(track.path || '') === request.files[key])?.id
            setSelectedTrackIds(new Set((request.selected || []).map(idFor).filter(Boolean)))
            setGroupMenuOpen(request.groupMenu === 'open')
            const dialog = request.groupDialog
            setGroupDialog(dialog?.state === 'open' ? {
                genomeKey: request.genomeKey || '',
                trackIds: (dialog.members || []).map(idFor).filter(Boolean),
                initialLabel: dialog.name || '',
                initialLayout: dialog.layout || 'separate',
                seededAt: request.requestedAt,
            } : null)

            // Then the wizard itself, which is what most of the steps are about.
            setShowWizard(request.wizard !== 'closed')
            setWizardSeed(request.wizard === 'closed' ? null : {
                step: request.wizard === 'details' ? 2 : 1,
                filePath: request.file || '',
                label: request.fields?.label || '',
                dataType: request.dataType || '',
                displayMode: request.displayMode || '',
                genomeKey: request.genome === 'slice' ? (request.genomeKey || '') : '',
                browserOpen: request.browser?.state === 'open',
                browserDirectory: request.browser?.directory || '',
                seededAt: request.requestedAt,
            })
        }

        run()
        return () => { cancelled = true }
    }, [tutorialTrackRequest, loadTracks])

    const loadHubTracks = useCallback(async (options = {}) => {
        const refresh = options?.refresh === true
        const silent = options?.silent === true
        if (!selectedGenomesForHub.length) {
            setHubTracksByGenome({})
            hubDiscoverySignatureRef.current = ''
            setHubError('')
            setHubLoading(false)
            return
        }
        if (!silent) {
            setHubLoading(true)
            setHubError('')
        }
        try {
            const res = await fetch(`${API_BASE}/api/tracks/trackhub/discover`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    genomes: selectedGenomesForHub,
                    refresh: refresh === true,
                }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
            const byGenome = {}
            for (const item of (data?.genomes || [])) {
                byGenome[item.genome_key] = item
            }
            const nextSignature = buildHubDiscoverySignature(byGenome)
            const prevSignature = String(hubDiscoverySignatureRef.current || '')
            const changed = !prevSignature || prevSignature !== nextSignature
            if (changed) {
                setHubTracksByGenome(byGenome)
                hubDiscoverySignatureRef.current = nextSignature
            }
            setHubError('')
            writeHubDiscoveryCache(hubDiscoveryCacheKey, byGenome, nextSignature)
        } catch (e) {
            if (!silent) setHubError(e.message || 'Failed to load Track Hub Registry tracks.')
        } finally {
            if (!silent) setHubLoading(false)
        }
    }, [selectedGenomesForHub, hubDiscoveryCacheKey])

    const loadHubImportTasks = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/tracks/trackhub/import_tasks`)
            const data = await res.json()
            if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)
            const nextTasks = Array.isArray(data?.tasks) ? data.tasks : []
            setHubImportTasks(nextTasks)
            const completedNow = nextTasks.filter((t) => t?.status === 'completed')
            let shouldReloadTracks = false
            for (const task of completedNow) {
                if (!seenCompletedHubTaskIdsRef.current.has(task.id)) {
                    seenCompletedHubTaskIdsRef.current.add(task.id)
                    shouldReloadTracks = true
                }
            }
            if (shouldReloadTracks) loadTracks()
        } catch {
            // keep silent in polling loop
        }
    }, [loadTracks])

    useEffect(() => {
        if (!selectedGenomesForHub.length) {
            setHubTracksByGenome({})
            hubDiscoverySignatureRef.current = ''
            setHubError('')
            setHubLoading(false)
            return
        }

        const cached = readHubDiscoveryCache(hubDiscoveryCacheKey, selectedGenomesForHub)
        const hasCached = !!(cached?.by_genome && Object.keys(cached.by_genome).length > 0)
        if (hasCached) {
            setHubTracksByGenome(cached.by_genome)
            hubDiscoverySignatureRef.current = String(cached.signature || buildHubDiscoverySignature(cached.by_genome))
            setHubError('')
            setHubLoading(false)
            // Always reconcile in the background so each session can start from cache
            // and then silently pick up any new registry entries.
            loadHubTracks({ refresh: false, silent: true })
            return
        }

        hubDiscoverySignatureRef.current = ''
        loadHubTracks({ refresh: false, silent: false })
    }, [selectedGenomesForHub, hubDiscoveryCacheKey, loadHubTracks])

    useEffect(() => {
        loadHubImportTasks()
        const timer = window.setInterval(() => {
            loadHubImportTasks()
        }, 2000)
        return () => window.clearInterval(timer)
    }, [loadHubImportTasks])

    const handleRegistered = (newTrack) => {
        setTracks(prev => [...prev, newTrack])
        emitTutorialSignal('tracks.registered', { label: String(newTrack?.label || '') })
    }

    const handleUpdate = (updated) => {
        setTracks(prev => prev.map(t => t.id === updated.id ? updated : t))
        // Moved to another genome: it leaves the groups of the one it left.
        const assembly = trackAssemblyKey(updated.genome_key)
        setGroups((prev) => prev.map((g) => (
            trackAssemblyKey(g.genome_key) === assembly || !g.members.some((m) => m.track_id === updated.id)
                ? g
                : { ...g, members: g.members.filter((m) => m.track_id !== updated.id) }
        )))
    }

    const handleGroupSaved = (saved) => {
        setGroups((prev) => (prev.some((g) => g.id === saved.id)
            ? prev.map((g) => (g.id === saved.id ? saved : g))
            : [...prev, saved]))
        setGroupDialog(null)
        emitTutorialSignal('tracks.groupSaved', { label: String(saved?.label || '') })
    }

    const handleGroupDeleted = (id) => {
        setGroups((prev) => prev.filter((g) => g.id !== id))
        setGroupDialog((prev) => (prev?.group?.id === id ? null : prev))
    }

    useEffect(() => {
        if (!groupMenuOpen) return undefined
        const handle = (e) => {
            if (groupMenuRef.current && !groupMenuRef.current.contains(e.target)) setGroupMenuOpen(false)
        }
        document.addEventListener('mousedown', handle)
        return () => document.removeEventListener('mousedown', handle)
    }, [groupMenuOpen])

    const handleDelete = (id) => {
        setTracks(prev => prev.filter(t => t.id !== id))
        setGroups((prev) => prev.map((g) => (g.members.some((m) => m.track_id === id)
            ? { ...g, members: g.members.filter((m) => m.track_id !== id) }
            : g)))
        setSelectedTrackIds((prev) => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
        })
    }

    const importedTrackKeys = useMemo(() => {
        const keys = new Set()
        for (const track of tracks) {
            if (String(track?.source || '').toLowerCase() !== 'trackhub') continue
            const genomeKey = String(track?.genome_key || '')
            const dataUrl = String(track?.source_meta?.data_url || '')
            const normalizedDataUrl = normalizeHubDataUrl(dataUrl)
            const importKey = String(track?.source_meta?.import_key || '')
            if (genomeKey && importKey) keys.add(`${genomeKey}|${importKey}`)
            if (genomeKey && dataUrl) keys.add(`${genomeKey}|${dataUrl}`)
            if (genomeKey && normalizedDataUrl) keys.add(`${genomeKey}|${normalizedDataUrl}`)
        }
        return keys
    }, [tracks])

    const importTaskByRowKey = useMemo(() => {
        const map = new Map()
        const sorted = [...hubImportTasks].sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')))
        for (const task of sorted) {
            const rowKey = `${task?.genome_key || ''}|${task?.import_key || ''}`
            if (!task?.genome_key || !task?.import_key || map.has(rowKey)) continue
            map.set(rowKey, task)
        }
        return map
    }, [hubImportTasks])

    const getHubRowState = useCallback((genomeKey, row) => {
        const rowKey = `${genomeKey}|${row?.import_key || ''}`
        const task = importTaskByRowKey.get(rowKey)
        const normalizedRowDataUrl = normalizeHubDataUrl(row?.data_url || '')
        const imported = importedTrackKeys.has(`${genomeKey}|${row?.import_key || ''}`)
            || importedTrackKeys.has(`${genomeKey}|${row?.data_url || ''}`)
            || importedTrackKeys.has(`${genomeKey}|${normalizedRowDataUrl}`)
        const status = imported
            ? 'Registered'
            : (task?.status === 'downloading'
                ? `Downloading ${Math.round((task?.progress || 0) * 100)}%`
                : task?.status === 'registering'
                    ? 'Registering'
                    : task?.status === 'failed'
                        ? 'Failed'
                        : task?.status === 'queued'
                            ? 'Queued'
                            : '')
        const canSelect = !imported && !['queued', 'downloading', 'registering'].includes(String(task?.status || ''))
        return { rowKey, task, imported, status, canSelect }
    }, [importTaskByRowKey, importedTrackKeys])

    const hubViewByGenome = useMemo(() => {
        const byGenome = {}
        for (const genome of selectedGenomesForHub) {
            const genomeKey = genome.genome_key
            const payload = hubTracksByGenome[genomeKey] || { tracks: [], error: '' }
            const allRows = Array.isArray(payload?.tracks) ? payload.tracks : []
            const hubFilter = String(hubFilterByGenome[genomeKey] || '').trim()
            const searchToken = String(hubSearchByGenome[genomeKey] || '').trim().toLowerCase()

            const hubNameSet = new Set()
            for (const row of allRows) {
                const hubName = String(row?.hub_name || 'Track Hub').trim() || 'Track Hub'
                hubNameSet.add(hubName)
            }
            const hubOptions = Array.from(hubNameSet).sort((a, b) => a.localeCompare(b))

            const filteredRows = allRows.filter((row) => {
                const hubName = String(row?.hub_name || 'Track Hub').trim() || 'Track Hub'
                if (hubFilter && hubName !== hubFilter) return false
                if (!searchToken) return true
                const haystack = [
                    hubName,
                    String(row?.track_name || ''),
                    String(row?.track_id || ''),
                    String(row?.description || ''),
                    String(row?.data_url || ''),
                ].join(' ').toLowerCase()
                return haystack.includes(searchToken)
            })

            const groupsMap = new Map()
            for (const row of filteredRows) {
                const hubName = String(row?.hub_name || 'Track Hub').trim() || 'Track Hub'
                const hubId = String(row?.hub_id || '').trim()
                const hubKey = `${genomeKey}|${hubName.toLowerCase()}|${hubId || '__'}`.toLowerCase()
                if (!groupsMap.has(hubKey)) {
                    groupsMap.set(hubKey, {
                        hub_key: hubKey,
                        hub_name: hubName,
                        hub_id: hubId,
                        tracks: [],
                        total_tracks: 0,
                        bigwig_count: 0,
                        bigbed_count: 0,
                    })
                }
                const group = groupsMap.get(hubKey)
                group.tracks.push(row)
                group.total_tracks += 1
                const trackType = normalizeHubTrackType(row)
                if (trackType === 'bigwig') group.bigwig_count += 1
                if (trackType === 'bigbed') group.bigbed_count += 1
            }

            const groups = Array.from(groupsMap.values())
            groups.sort((a, b) => {
                const nameCmp = String(a.hub_name || '').localeCompare(String(b.hub_name || ''))
                if (nameCmp !== 0) return nameCmp
                return String(a.hub_id || '').localeCompare(String(b.hub_id || ''))
            })
            for (const group of groups) {
                group.tracks.sort((a, b) => {
                    const typeOrder = { bigwig: 0, bigbed: 1, '': 9 }
                    const aType = normalizeHubTrackType(a)
                    const bType = normalizeHubTrackType(b)
                    const typeCmp = (typeOrder[aType] ?? 9) - (typeOrder[bType] ?? 9)
                    if (typeCmp !== 0) return typeCmp
                    const nameCmp = String(a?.track_name || '').localeCompare(String(b?.track_name || ''))
                    if (nameCmp !== 0) return nameCmp
                    return String(a?.data_url || '').localeCompare(String(b?.data_url || ''))
                })
            }

            byGenome[genomeKey] = {
                error: String(payload?.error || ''),
                allRows,
                filteredRows,
                hubOptions,
                groups,
            }
        }
        return byGenome
    }, [selectedGenomesForHub, hubTracksByGenome, hubFilterByGenome, hubSearchByGenome])

    const toggleHubSelection = useCallback((genomeKey, importKey, selected) => {
        const rowKey = `${genomeKey}|${importKey}`
        setHubSelectedRows((prev) => {
            const next = { ...prev }
            if (selected) next[rowKey] = true
            else delete next[rowKey]
            return next
        })
    }, [])

    const toggleHubGroupExpanded = useCallback((groupKey) => {
        setHubExpandedByGroup((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }))
    }, [])

    const updateHubSearch = useCallback((genomeKey, value) => {
        setHubSearchByGenome((prev) => ({ ...prev, [genomeKey]: value }))
    }, [])

    const updateHubFilter = useCallback((genomeKey, value) => {
        setHubFilterByGenome((prev) => ({ ...prev, [genomeKey]: value }))
    }, [])

    const handleSelectAllHubForGenome = useCallback((genomeKey, tracksForGenome, selected) => {
        setHubSelectedRows((prev) => {
            const next = { ...prev }
            for (const track of (tracksForGenome || [])) {
                const rowKey = `${genomeKey}|${track.import_key}`
                if (selected) next[rowKey] = true
                else delete next[rowKey]
            }
            return next
        })
    }, [])

    const handleImportSelectedHubTracks = useCallback(async () => {
        if (!config?.output_dir) return
        const selectedKeys = new Set(Object.keys(hubSelectedRows))
        if (selectedKeys.size === 0) return

        const genomeInfoByKey = new Map(selectedGenomesForHub.map((g) => [g.genome_key, g]))
        const items = []
        const importedRowKeys = []
        for (const [genomeKey, payload] of Object.entries(hubTracksByGenome || {})) {
            const genomeInfo = genomeInfoByKey.get(genomeKey)
            if (!genomeInfo) continue
            for (const track of (payload?.tracks || [])) {
                const rowKey = `${genomeKey}|${track.import_key}`
                if (!selectedKeys.has(rowKey)) continue
                const normalizedDataUrl = normalizeHubDataUrl(track.data_url)
                if (
                    importedTrackKeys.has(`${genomeKey}|${track.import_key}`)
                    || importedTrackKeys.has(`${genomeKey}|${track.data_url}`)
                    || importedTrackKeys.has(`${genomeKey}|${normalizedDataUrl}`)
                ) continue
                items.push({
                    genome_key: genomeKey,
                    species_key: genomeInfo.species_key,
                    assembly: genomeInfo.assembly,
                    label: track.track_name,
                    source_meta: {
                        hub_id: track.hub_id,
                        hub_name: track.hub_name,
                        track_id: track.track_id,
                        track_name: track.track_name,
                        assembly: track.assembly,
                        format: track.format,
                        data_url: normalizedDataUrl || track.data_url,
                        description: track.description,
                        import_key: track.import_key,
                    },
                })
                importedRowKeys.push(rowKey)
            }
        }
        if (items.length === 0) return

        setHubImporting(true)
        try {
            const res = await fetch(`${API_BASE}/api/tracks/trackhub/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    output_dir: config.output_dir,
                    items,
                }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`)

            setHubSelectedRows((prev) => {
                const next = { ...prev }
                for (const rowKey of importedRowKeys) {
                    delete next[rowKey]
                }
                return next
            })
            loadHubImportTasks()
        } catch (e) {
            setHubError(e.message || 'Failed to import Track Hub tracks.')
        } finally {
            setHubImporting(false)
        }
    }, [config?.output_dir, hubSelectedRows, selectedGenomesForHub, hubTracksByGenome, importedTrackKeys, loadHubImportTasks])

    // Derived: tracks grouped by genome
    const filteredTracks = useMemo(() => {
        return tracks.filter(t => {
            if (filterType && t.type !== filterType) return false
            if (filterGenome && !genomeKeysMatch(t.genome_key, filterGenome)) return false
            if (searchQuery) {
                const q = searchQuery.toLowerCase()
                return t.label?.toLowerCase().includes(q) || t.path?.toLowerCase().includes(q) || t.type?.includes(q)
            }
            return true
        })
    }, [tracks, filterType, filterGenome, searchQuery])

    // One section per assembly: tracks registered against different annotation releases
    // of the same assembly (the genome picker offers both) belong together.
    const tracksByGenome = useMemo(() => {
        const map = new Map()
        for (const t of filteredTracks) {
            const key = trackAssemblyKey(t.genome_key)
            if (!map.has(key)) map.set(key, [])
            map.get(key).push(t)
        }
        return map
    }, [filteredTracks])

    const tracksById = useMemo(() => new Map(tracks.map((t) => [String(t.id), t])), [tracks])

    // Groups shown under each genome. With a filter on, a group shows when its name
    // matches the search or it holds a track that does.
    const groupsByGenome = useMemo(() => {
        const filtering = Boolean(searchQuery || filterType || filterGenome)
        const shownIds = new Set(filteredTracks.map((t) => String(t.id)))
        const q = searchQuery.toLowerCase()
        const map = new Map()
        for (const g of groups) {
            if (filterGenome && !genomeKeysMatch(g.genome_key, filterGenome)) continue
            const visible = !filtering
                || (searchQuery && !filterType && g.label.toLowerCase().includes(q))
                || g.members.some((m) => shownIds.has(String(m.track_id)))
            if (!visible) continue
            const key = trackAssemblyKey(g.genome_key)
            if (!map.has(key)) map.set(key, [])
            map.get(key).push(g)
        }
        return map
    }, [groups, filteredTracks, searchQuery, filterType, filterGenome])

    const genomeSectionKeys = useMemo(
        () => [...new Set([...tracksByGenome.keys(), ...groupsByGenome.keys()])],
        [tracksByGenome, groupsByGenome]
    )

    const selectedTracks = useMemo(() => tracks.filter((t) => selectedTrackIds.has(t.id)), [tracks, selectedTrackIds])
    const selectionAssembly = useMemo(() => sharedAssembly(selectedTracks), [selectedTracks])
    const selectionGroups = useMemo(
        () => (selectionAssembly ? groupsForAssembly(groups, selectionAssembly) : []),
        [groups, selectionAssembly]
    )

    const allGenomes = useMemo(() => {
        const keys = new Set(tracks.map(t => trackAssemblyKey(t.genome_key)))
        return Array.from(keys).sort()
    }, [tracks])

    const browsePath = useMemo(() => {
        const outputDir = String(config?.output_dir || '').trim().replace(/\/+$/, '')
        if (outputDir) return `${outputDir}/local_data`
        return '.'
    }, [config])

    // Colour styles
    const bg = isLight ? 'bg-[#f8f9fa]' : 'bg-[#111827]'
    const contentBg = isLight ? 'bg-white' : 'bg-[#1a2232]'
    const borderColor = isLight ? 'border-gray-200' : 'border-gray-700'
    const textPrimary = isLight ? 'text-gray-900' : 'text-gray-100'
    const textSecondary = isLight ? 'text-gray-500' : 'text-gray-400'
    const inputCls = `px-3 py-1.5 rounded-lg text-sm border focus:outline-none focus:ring-2 ${isLight
        ? 'bg-white border-gray-300 text-gray-900 focus:ring-blue-500/40'
        : 'bg-gray-700 border-gray-600 text-gray-100 focus:ring-blue-500/40'}`
    const selectedHubCount = Object.keys(hubSelectedRows).length
    const genomeLabelByKey = useMemo(() => {
        const map = new Map()
        for (const g of selectedGenomesForHub) {
            const key = g.genome_key
            const option = findGenomeOption(genomeOptions, key)
            map.set(key, option?.label || fallbackGenomeLabel(key))
        }
        return map
    }, [selectedGenomesForHub, genomeOptions])

    const colorPalette = useMemo(() => genomeColorPalette(config), [config])

    return (
        <TrackColorPaletteContext.Provider value={colorPalette}>
        <div data-screenshot-capture="view" data-tour-id="track-manager-view" className={`h-full overflow-y-auto ${bg}`} style={{ minHeight: 0 }}>
            {/* ── Header ── */}
            <div data-tour-id="track-manager-header" className={`px-6 py-4 border-b ${borderColor} ${contentBg}`}>
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h1 className={`text-xl font-bold ${textPrimary}`}>Track Manager</h1>
                        <p className={`text-sm mt-0.5 ${textSecondary}`}>Register custom data tracks to display in the Genome Browser</p>
                    </div>
                    <button
                        data-tour-id="track-manager-add"
                        onClick={() => setShowWizard(true)}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow transition-colors"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                        Add Track
                    </button>
                </div>

                {/* ── Controls row: search + filters ── */}
                {tracks.length > 0 && (
                    <div data-tour-id="track-manager-filters" className="flex items-center gap-3 mt-4 flex-wrap">
                        <input
                            data-tour-id="track-manager-search"
                            type="text"
                            placeholder="Search tracks…"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className={`${inputCls} w-52`}
                        />
                        <select value={filterType} onChange={e => setFilterType(e.target.value)} className={inputCls}>
                            <option value="">All types</option>
                            {TRACK_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>
                        {allGenomes.length > 1 && (
                            <select value={filterGenome} onChange={e => setFilterGenome(e.target.value)} className={inputCls}>
                                <option value="">All genomes</option>
                                {allGenomes.map(g => {
                                    const track = tracks.find((item) => genomeKeysMatch(item.genome_key, g) && item.genome_label)
                                    const label = findGenomeOption(genomeOptions, g)?.label || track?.genome_label || fallbackGenomeLabel(g)
                                    return <option key={g} value={g}>{label}</option>
                                })}
                            </select>
                        )}
                        <span className={`text-xs ml-auto ${textSecondary}`}>{filteredTracks.length} track{filteredTracks.length !== 1 ? 's' : ''}</span>
                    </div>
                )}
            </div>

            {/* ── Track list ── */}
            <div data-tour-id="track-manager-list" className="px-6 py-5 space-y-6">
                {/* Edit several tracks at once: the same dialog as registering them. */}
                {selectedTrackIds.size > 0 && (
                    <div
                        data-tour-id="track-manager-selection"
                        className={`sticky top-0 z-10 flex items-center gap-3 rounded-xl border px-4 py-2.5 shadow-sm ${isLight ? 'bg-blue-50 border-blue-200' : 'bg-blue-950/60 border-blue-800 backdrop-blur'}`}
                    >
                        <span className={`text-sm font-medium ${isLight ? 'text-blue-900' : 'text-blue-100'}`}>
                            {selectedTrackIds.size} track{selectedTrackIds.size === 1 ? '' : 's'} selected
                        </span>
                        <button
                            type="button"
                            data-tour-id="track-manager-edit-selected"
                            onClick={() => setEditingTracks(tracks.filter((t) => selectedTrackIds.has(t.id)))}
                            className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700"
                        >
                            Edit {selectedTrackIds.size === 1 ? 'track' : `${selectedTrackIds.size} tracks`}
                        </button>
                        <div ref={groupMenuRef} className="relative">
                            <button
                                type="button"
                                data-tour-id="track-manager-add-to-group"
                                disabled={!selectionAssembly}
                                aria-haspopup="menu"
                                aria-expanded={groupMenuOpen}
                                onClick={() => setGroupMenuOpen((open) => !open)}
                                title={selectionAssembly
                                    ? 'Put the selected tracks in a track group'
                                    : selectedTracks.some((t) => !trackAssemblyKey(t.genome_key))
                                        ? 'A group belongs to a genome: give these tracks one first'
                                        : 'A group holds one genome\u2019s tracks: select tracks from one genome'}
                                className={`px-3 py-1.5 rounded-lg text-sm font-semibold border inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed ${isLight
                                    ? 'bg-white border-indigo-300 text-indigo-700 hover:bg-indigo-50'
                                    : 'bg-gray-900 border-indigo-700 text-indigo-200 hover:bg-indigo-950'}`}
                            >
                                <GroupLayoutIcon className="w-3.5 h-3.5" />
                                Add to group
                                <IconUpDown open={groupMenuOpen} size={10} />
                            </button>
                            {groupMenuOpen && selectionAssembly && (
                                <div
                                    role="menu"
                                    data-tour-id="track-manager-group-menu"
                                    className={`absolute left-0 top-full mt-1 z-20 min-w-[16rem] rounded-lg border shadow-lg py-1 ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}
                                >
                                    <button
                                        type="button"
                                        role="menuitem"
                                        data-tour-id="track-manager-new-group"
                                        onClick={() => {
                                            setGroupMenuOpen(false)
                                            setGroupDialog({ genomeKey: selectedTracks[0].genome_key, trackIds: selectedTracks.map((t) => String(t.id)) })
                                        }}
                                        className={`w-full text-left px-3 py-2 text-sm font-medium ${isLight ? 'text-blue-700 hover:bg-blue-50' : 'text-blue-300 hover:bg-blue-900/30'}`}
                                    >
                                        + New group…
                                    </button>
                                    {selectionGroups.length > 0 && (
                                        <div className={`px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide ${textSecondary}`}>Add to an existing group</div>
                                    )}
                                    {selectionGroups.map((g) => {
                                        const already = selectedTracks.filter((t) => g.members.some((m) => m.track_id === t.id)).length
                                        return (
                                            <button
                                                key={g.id}
                                                type="button"
                                                role="menuitem"
                                                onClick={() => {
                                                    setGroupMenuOpen(false)
                                                    setGroupDialog({ group: g, addTrackIds: selectedTracks.map((t) => String(t.id)) })
                                                }}
                                                className={`w-full text-left px-3 py-2 text-sm ${isLight ? 'text-gray-800 hover:bg-gray-100' : 'text-gray-200 hover:bg-gray-700'}`}
                                            >
                                                <span className="block truncate">{g.label}</span>
                                                <span className={`block text-xs ${textSecondary}`}>
                                                    {g.members.length} track{g.members.length === 1 ? '' : 's'}
                                                    {already ? ` · ${already === selectedTracks.length ? 'all' : already} already in it` : ''}
                                                </span>
                                            </button>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => setSelectedTrackIds(new Set())}
                            className={`ml-auto text-xs ${isLight ? 'text-blue-700 hover:underline' : 'text-blue-300 hover:underline'}`}
                        >
                            Clear selection
                        </button>
                    </div>
                )}
                {loading ? (
                    <div className="flex items-center justify-center h-40">
                        <div className={`w-6 h-6 border-2 border-t-transparent rounded-full animate-spin ${isLight ? 'border-blue-500' : 'border-blue-400'}`} />
                    </div>
                ) : tracks.length === 0 ? (
                    <EmptyState isLight={isLight} />
                ) : genomeSectionKeys.length === 0 ? (
                    <div className={`text-center py-12 ${textSecondary} text-sm`}>No tracks match your filters</div>
                ) : (
                    genomeSectionKeys.map((genomeKey) => {
                        const genomeTracks = tracksByGenome.get(genomeKey) || []
                        const genomeGroups = groupsByGenome.get(genomeKey) || []
                        const installed = findGenomeOption(genomeOptions, genomeKey)
                        const genomeLabel = installed?.label
                            || genomeTracks.find((track) => track.genome_label)?.genome_label
                            || fallbackGenomeLabel(genomeKey)
                        const groupIds = genomeTracks.map((t) => t.id)
                        const subheadCls = `text-[11px] font-semibold uppercase tracking-wide mb-2 ${textSecondary}`
                        const allSelected = groupIds.length > 0 && groupIds.every((id) => selectedTrackIds.has(id))
                        const someSelected = !allSelected && groupIds.some((id) => selectedTrackIds.has(id))
                        return (
                            <div key={genomeKey}>
                                <div className="flex items-center gap-2 mb-3">
                                    <input
                                        type="checkbox"
                                        checked={allSelected}
                                        ref={(el) => { if (el) el.indeterminate = someSelected }}
                                        onChange={(e) => setSelectedTrackIds((prev) => {
                                            const next = new Set(prev)
                                            for (const id of groupIds) {
                                                if (e.target.checked) next.add(id)
                                                else next.delete(id)
                                            }
                                            return next
                                        })}
                                        aria-label={`Select all ${genomeLabel} tracks`}
                                        data-tour-id="track-manager-select-genome"
                                        title="Select all tracks for this genome"
                                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                    />
                                    <h2 className={`text-xs font-semibold ${textSecondary}`}>{genomeLabel}</h2>
                                    {/* The link is kept when a genome is removed, so its tracks come
                                        back with it; say why they are not in the browser meanwhile. */}
                                    {genomeKey && !installed && (
                                        <span className={`text-[11px] ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                                            genome data not found in Genome Selector
                                        </span>
                                    )}
                                </div>
                                {genomeGroups.length > 0 && (
                                    <>
                                        <div className={subheadCls}>Groups</div>
                                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 items-stretch mb-4">
                                            {genomeGroups.map((g) => (
                                                <TrackGroupCard
                                                    key={g.id}
                                                    group={g}
                                                    tracksById={tracksById}
                                                    isLight={isLight}
                                                    onEdit={(group) => setGroupDialog({ group })}
                                                    onDelete={handleGroupDeleted}
                                                />
                                            ))}
                                        </div>
                                        {genomeTracks.length > 0 && <div className={subheadCls}>Tracks</div>}
                                    </>
                                )}
                                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 items-stretch auto-rows-fr">
                                    {genomeTracks.map(track => (
                                        <TrackCard
                                            key={track.id}
                                            track={track}
                                            isLight={isLight}
                                            genomeOptions={genomeOptions}
                                            onDelete={handleDelete}
                                            onEdit={(t) => setEditingTracks([t])}
                                            selected={selectedTrackIds.has(track.id)}
                                            onToggleSelected={toggleTrackSelected}
                                            groupNames={groupsContainingTrack(groups, track.id).map((g) => g.label)}
                                        />
                                    ))}
                                </div>
                            </div>
                        )
                    })
                )}

                {/* ── Track Hub Registry discovery/import ── */}
                <div data-tour-id="track-manager-hub" className={`rounded-xl border p-4 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/30'}`}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div>
                            <h3 className={`text-sm font-semibold ${textPrimary}`}>Track Hub Registry</h3>
                            <p className={`text-xs mt-0.5 ${textSecondary}`}>
                                Discover BigWig and BigBed tracks by selected genome and import as local tracks.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => loadHubTracks({ refresh: true, silent: false })}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${isLight ? 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50' : 'bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700'}`}
                            >
                                Refresh
                            </button>
                            <button
                                type="button"
                                onClick={handleImportSelectedHubTracks}
                                disabled={!config?.output_dir || selectedHubCount === 0 || hubImporting}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${(!config?.output_dir || selectedHubCount === 0 || hubImporting)
                                    ? (isLight ? 'bg-gray-100 text-gray-400' : 'bg-gray-800 text-gray-500')
                                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                                    }`}
                                title={!config?.output_dir ? 'Set output directory in Configuration first' : ''}
                            >
                                {hubImporting ? 'Importing…' : `Import selected${selectedHubCount > 0 ? ` (${selectedHubCount})` : ''}`}
                            </button>
                        </div>
                    </div>

                    {hubError && (
                        <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${isLight ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-red-900/20 text-red-300 border border-red-800/40'}`}>
                            {hubError}
                        </div>
                    )}

                    <div className="mt-3 space-y-4">
                        {selectedGenomesForHub.length === 0 ? (
                            <div className={`text-xs ${textSecondary}`}>No selected genomes available.</div>
                        ) : hubLoading ? (
                            <div className="flex items-center gap-2 text-xs">
                                <div className={`w-4 h-4 border-2 border-t-transparent rounded-full animate-spin ${isLight ? 'border-blue-500' : 'border-blue-400'}`} />
                                <span className={textSecondary}>Loading Track Hub Registry tracks…</span>
                            </div>
                        ) : (
                            selectedGenomesForHub.map((genome) => {
                                const genomeKey = genome.genome_key
                                const payload = hubViewByGenome[genomeKey] || { error: '', allRows: [], filteredRows: [], hubOptions: [], groups: [] }
                                const rows = payload.filteredRows || []
                                const groups = payload.groups || []
                                const selectable = rows.filter((row) => getHubRowState(genomeKey, row).canSelect)
                                const allSelected = selectable.length > 0 && selectable.every((row) => hubSelectedRows[`${genomeKey}|${row.import_key}`])
                                return (
                                    <div key={genomeKey} className={`rounded-lg border ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                                        <div className={`px-3 py-2 flex items-center justify-between ${isLight ? 'bg-gray-50' : 'bg-gray-800/40'}`}>
                                            <div>
                                                <div className={`text-xs font-semibold ${textPrimary}`}>{genomeLabelByKey.get(genomeKey) || genomeKey}</div>
                                                <div className={`text-[11px] ${textSecondary}`}>{rows.length} matching track{rows.length !== 1 ? 's' : ''} across {groups.length} hub{groups.length !== 1 ? 's' : ''}</div>
                                            </div>
                                        </div>
                                        <div className={`px-3 py-2 border-t flex items-center gap-2 flex-wrap ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/20'}`}>
                                            <input
                                                type="text"
                                                value={hubSearchByGenome[genomeKey] || ''}
                                                onChange={(e) => updateHubSearch(genomeKey, e.target.value)}
                                                placeholder="Search hub, URL, description, track..."
                                                className={`${inputCls} !text-xs !py-1.5 w-72 max-w-full`}
                                            />
                                            <select
                                                value={hubFilterByGenome[genomeKey] || ''}
                                                onChange={(e) => updateHubFilter(genomeKey, e.target.value)}
                                                className={`${inputCls} !text-xs !py-1.5`}
                                            >
                                                <option value="">All hubs</option>
                                                {(payload.hubOptions || []).map((hubName) => (
                                                    <option key={hubName} value={hubName}>{hubName}</option>
                                                ))}
                                            </select>
                                            <label className={`text-[11px] ml-auto flex items-center gap-1.5 ${textSecondary}`}>
                                                <input
                                                    type="checkbox"
                                                    checked={allSelected}
                                                    disabled={selectable.length === 0}
                                                    onChange={(e) => handleSelectAllHubForGenome(genomeKey, selectable, e.target.checked)}
                                                />
                                                Select all shown
                                            </label>
                                        </div>
                                        {payload.error && (
                                            <div className={`px-3 py-2 text-[11px] ${isLight ? 'text-amber-700 bg-amber-50 border-t border-amber-200' : 'text-amber-300 bg-amber-900/10 border-t border-amber-800/30'}`}>
                                                {payload.error}
                                            </div>
                                        )}
                                        {rows.length === 0 ? (
                                            <div className={`px-3 py-2 text-[11px] ${textSecondary}`}>
                                                {payload.allRows?.length ? 'No tracks match the current search/filter.' : 'No Track Hub records found for this genome.'}
                                            </div>
                                        ) : (
                                            <div className={`divide-y ${isLight ? 'divide-gray-200' : 'divide-gray-700'}`}>
                                                {groups.map((group) => {
                                                    const expanded = !!hubExpandedByGroup[group.hub_key]
                                                    const groupSelectedCount = group.tracks.filter((row) => hubSelectedRows[`${genomeKey}|${row.import_key}`]).length
                                                    return (
                                                        <div key={group.hub_key}>
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleHubGroupExpanded(group.hub_key)}
                                                                className={`w-full px-3 py-2 text-left flex items-center justify-between gap-3 ${isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-800/30'}`}
                                                            >
                                                                <div className="min-w-0 flex-1">
                                                                    <div className={`text-xs font-semibold truncate ${textPrimary}`}>{group.hub_name}</div>
                                                                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                                                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${isLight ? 'bg-gray-100 text-gray-600' : 'bg-gray-800 text-gray-300'}`}>
                                                                            {group.total_tracks} total
                                                                        </span>
                                                                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-400/40 text-blue-500 bg-blue-500/10">
                                                                            bigWig {group.bigwig_count}
                                                                        </span>
                                                                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-400/40 text-emerald-500 bg-emerald-500/10">
                                                                            bigBed {group.bigbed_count}
                                                                        </span>
                                                                        {groupSelectedCount > 0 && (
                                                                            <span className={`text-[10px] ${textSecondary}`}>{groupSelectedCount} selected</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <span className={`opacity-50 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                                                    <IconUpDown open={expanded} size={14} />
                                                                </span>
                                                            </button>
                                                            {expanded && (
                                                                <HubTrackRows
                                                                    rows={group.tracks}
                                                                    isLight={isLight}
                                                                    renderRow={(row, rowIndex) => {
                                                                        const { rowKey, task, status, canSelect } = getHubRowState(genomeKey, row)
                                                                        const rowTrackType = normalizeHubTrackType(row)
                                                                        const rowTypeLabel = hubTrackTypeLabel(rowTrackType, row)
                                                                        const isLast = rowIndex === group.tracks.length - 1
                                                                        const rowTypeBadgeClass = rowTrackType === 'bigbed'
                                                                            ? 'border-emerald-400/40 text-emerald-500 bg-emerald-500/10'
                                                                            : rowTrackType === 'bigwig'
                                                                                ? 'border-blue-400/40 text-blue-500 bg-blue-500/10'
                                                                                : (isLight ? 'border-gray-300 text-gray-600 bg-gray-100' : 'border-gray-600 text-gray-300 bg-gray-700/40')
                                                                        return (
                                                                            <div key={rowKey} className="relative px-3 py-2 flex items-stretch gap-2" style={{ minHeight: HUB_TRACK_ROW_HEIGHT }}>
                                                                                <div className="relative w-8 shrink-0 mr-0.5 flex items-center">
                                                                                    <div
                                                                                        className={`absolute left-4 top-0 ${isLast ? 'bottom-1/2' : 'bottom-0'} border-l-2 ${isLight ? 'border-gray-300' : 'border-gray-600'}`}
                                                                                    />
                                                                                    <div
                                                                                        className={`absolute left-4 w-4 border-b-2 ${isLight ? 'border-gray-300' : 'border-gray-600'}`}
                                                                                    />
                                                                                </div>
                                                                                <div className="min-w-0 flex-1 overflow-hidden">
                                                                                    <div className="flex items-center gap-2 flex-wrap">
                                                                                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${rowTypeBadgeClass}`}>
                                                                                            {rowTypeLabel}
                                                                                        </span>
                                                                                        <span className={`text-xs font-medium ${textPrimary}`}>{row.track_name || row.track_id}</span>
                                                                                        {status && (
                                                                                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${status === 'Failed'
                                                                                                ? (isLight ? 'bg-red-100 text-red-700' : 'bg-red-900/30 text-red-300')
                                                                                                : status === 'Registered'
                                                                                                    ? (isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-300')
                                                                                                    : (isLight ? 'bg-blue-100 text-blue-700' : 'bg-blue-900/30 text-blue-300')
                                                                                                }`}>
                                                                                                {status}
                                                                                            </span>
                                                                                        )}
                                                                                    </div>
                                                                                    <div className={`text-[11px] mt-0.5 font-mono truncate ${textSecondary}`}>{row.data_url}</div>
                                                                                    {row.description && (
                                                                                        <div className={`text-[11px] mt-0.5 truncate ${textSecondary}`}>{row.description}</div>
                                                                                    )}
                                                                                    {task?.status === 'failed' && task?.error && (
                                                                                        <div className={`text-[11px] mt-0.5 truncate ${isLight ? 'text-red-700' : 'text-red-300'}`}>{task.error}</div>
                                                                                    )}
                                                                                </div>
                                                                                <input
                                                                                    type="checkbox"
                                                                                    className="mt-0.5 ml-2 shrink-0"
                                                                                    checked={!!hubSelectedRows[rowKey]}
                                                                                    disabled={!canSelect}
                                                                                    onChange={(e) => toggleHubSelection(genomeKey, row.import_key, e.target.checked)}
                                                                                />
                                                                            </div>
                                                                        )
                                                                    }}
                                                                />
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )
                            })
                        )}
                    </div>
                </div>

                {/* ── Supported types info ── */}
                {tracks.length === 0 && (
                    <div className={`mt-6 rounded-xl border p-5 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-800/40'}`}>
                        <h3 className={`text-sm font-semibold mb-3 ${textPrimary}`}>Supported Track Types</h3>
                        <div className="grid gap-2 sm:grid-cols-2">
                            {TRACK_TYPES.map(t => (
                                <div key={t.id} className={`flex items-start gap-2.5 p-2.5 rounded-lg ${isLight ? 'bg-white border border-gray-100' : 'bg-gray-800 border border-gray-700/50'}`}>
                                    <TypeBadge type={t.id} small />
                                    <div className="min-w-0">
                                        <p className={`text-xs font-medium ${textPrimary}`}>{t.label}</p>
                                        <p className={`text-[11px] mt-0.5 ${textSecondary}`}>{t.desc}</p>
                                        <p className={`text-[10px] font-mono mt-0.5 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>{t.ext}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* ── Registration Wizard ── */}
            {editingTracks && editingTracks.length > 0 && (
                <RegistrationWizard
                    mode="edit"
                    editTracks={editingTracks}
                    isLight={isLight}
                    genomeOptions={genomeOptions}
                    onClose={() => setEditingTracks(null)}
                    onUpdated={handleUpdate}
                    onRegistered={() => {}}
                    initialBrowsePath={browsePath}
                    existingLabels={tracks.filter((t) => !editingTracks.some((e) => e.id === t.id)).map((t) => t.label)}
                />
            )}
            {groupDialog && (
                <TrackGroupDialog
                    key={`${groupDialog.group?.id || 'new'}:${groupDialog.seededAt || ''}`}
                    isLight={isLight}
                    group={groupDialog.group || null}
                    genomeKey={groupDialog.genomeKey || ''}
                    initialTrackIds={groupDialog.trackIds || []}
                    addTrackIds={groupDialog.addTrackIds || []}
                    initialLabel={groupDialog.initialLabel || ''}
                    initialLayout={groupDialog.initialLayout || 'separate'}
                    tracks={tracks}
                    groups={groups}
                    genomeOptions={genomeOptions}
                    onClose={() => setGroupDialog(null)}
                    onSaved={handleGroupSaved}
                    onDeleted={handleGroupDeleted}
                />
            )}
            {showWizard && (
                <RegistrationWizard
                    isLight={isLight}
                    genomeOptions={genomeOptions}
                    onClose={() => { setShowWizard(false); setWizardSeed(null) }}
                    onRegistered={handleRegistered}
                    trackGroups={groups}
                    onGroupSaved={handleGroupSaved}
                    initialBrowsePath={browsePath}
                    seed={wizardSeed}
                    existingLabels={tracks.map((t) => t.label)}
                />
            )}
        </div>
        </TrackColorPaletteContext.Provider>
    )
}
