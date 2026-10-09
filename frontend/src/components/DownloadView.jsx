import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { API_BASE } from '../backendRuntime'
import useTutorial from '../hooks/useTutorial'
import { isDemoGenomeItem } from '../tutorials/demoGenome'
import { fetchDemoGenomeStatus, installDemoGenome } from '../tutorials/demoGenomeApi'
import ScreenshotExportModal from './ScreenshotExportModal'
import ScreenshotSelectionOverlay from './ScreenshotSelectionOverlay'
import {
    buildDefaultScreenshotName,
    buildDomNodeScreenshotSnapshot,
    measureScreenshotNode,
} from '../utils/screenshotExport'
import {
    getAssemblyAccession,
    getAssemblyGenomeKey,
    normalizeGenomeProvider,
    normalizeGenomeRecord,
    normalizeGenomeSourceDatabase,
} from '../utils/genomeIdentity'
import { datasetReleaseDownloadMetadata } from '../utils/downloadMetadata'
import {
    getDownloadTasksSnapshot,
    refreshDownloadTasks,
    subscribeDownloadTasks,
    useDownloadTasks,
} from '../utils/downloadTasksStore'
import ActiveDownloadsPanel from './ActiveDownloadsPanel'
import { fileTypeLabel } from '../utils/genomeFileTypes'
import { SELECTOR_REFRESH_EVENT, readPendingSelectorGenomeIds, writePendingSelectorGenomeIds } from '../app/appLayout.js'
import {
  DEFAULT_DOWNLOAD_FILE_TYPES,
  ENSEMBL_DOWNLOAD_FILE_TYPES,
  PAGE_SIZE,
  REFSEQ_DOWNLOAD_FILE_TYPES,
  REFSEQ_FEATURED_ACCESSIONS,
  REFSEQ_INVERTEBRATE_GROUPS,
  REFSEQ_MICROBE_GROUPS,
  VERTEBRATE_GROUPS,
  buildCatalogChangeMessage,
  chooseFilesForTypes,
  gcaPrefixedDownloadFilename,
  itemFromSpeciesAssembly,
  matchesModelOrganism,
  normalizeRemoteSpecies,
  pickPreferredTask,
} from './download/downloadModel.js'
import { IconSearch } from './download/downloadIcons.jsx'
import {
  GroupBrowser,
  RefSeqGroupBrowser,
} from './download/catalogBrowsers.jsx'
import {
  DownloadTypeToolbar,
} from './download/DownloadTypeToolbar.jsx'
import {
  SpeciesRow,
} from './download/SpeciesRow.jsx'
import {
  PanelHeader,
} from './download/PanelHeader.jsx'
import {
  LocalGenomesList,
} from './download/LocalGenomesList.jsx'

// ---------------------------------------------------------------------------
// Main DownloadView
// ---------------------------------------------------------------------------

// What the catalogue looked like the last time this view was open. The view is
// unmounted when the user switches away, so without this every visit started
// from an empty list and a spinner, and stayed there until the backend answered
// — which, with a long GFF3 analysis running, could be a very long time. The
// genomes were already fetched this session; showing them straight away and
// refreshing behind the list costs nothing and never leaves the page blank.
const sessionCatalogue = {
    groups: null,
    species: null,
    refSeqGroups: null,
    status: null,
    localAssemblies: null,
    ncbiBrowse: new Map(),
    ncbiSearch: new Map(),
}

export default function DownloadView({
    config,
    theme,
    screenshotMode = false,
    onScreenshotModeChange = null,
    onScreenshotAvailabilityChange = null,
    screenshotToggleButtonRef = null,
}) {
    const isLight = theme === 'light'
    const screenshotRootRef = useRef(null)
    const speciesListScrollRef = useRef(null)
    const [screenshotRootNode, setScreenshotRootNode] = useState(null)
    const [selectedScreenshotTarget, setSelectedScreenshotTarget] = useState(null)
    const setScreenshotRoot = useCallback((node) => {
        screenshotRootRef.current = node
        setScreenshotRootNode(node)
    }, [])

    const [groups, setGroups] = useState(() => sessionCatalogue.groups || [])
    const [allSpecies, setAllSpecies] = useState(() => sessionCatalogue.species || [])
    const [ncbiSpecies, setNcbiSpecies] = useState([])
    const [localAssemblies, setLocalAssemblies] = useState(() => sessionCatalogue.localAssemblies || [])
    // Only the first visit of a session has nothing to show.
    const [loading, setLoading] = useState(() => !sessionCatalogue.species)
    const [activeProvider, setActiveProvider] = useState('ensembl')
    const [ncbiLoading, setNcbiLoading] = useState(false)
    const [activeRefSeqGroup, setActiveRefSeqGroup] = useState('All genomes')
    const [activeRefSeqSubGroup, setActiveRefSeqSubGroup] = useState(null)
    const [refSeqGroups, setRefSeqGroups] = useState(() => sessionCatalogue.refSeqGroups || [])
    const [refSeqGroupsLoading, setRefSeqGroupsLoading] = useState(false)
    const [ncbiCurrentPageToken, setNcbiCurrentPageToken] = useState(null)
    const [ncbiNextPageToken, setNcbiNextPageToken] = useState(null)
    const [ncbiPageTokenHistory, setNcbiPageTokenHistory] = useState([])
    const [ncbiTotalCount, setNcbiTotalCount] = useState(null)
    const [activeGroup, setActiveGroup] = useState('All')
    const [activeSubGroup, setActiveSubGroup] = useState(null)
    const [search, setSearch] = useState('')
    const [page, setPage] = useState(1)
    const [expandedKey, setExpandedKey] = useState(null)
    const [activeDownloadTypes, setActiveDownloadTypes] = useState(() => new Set(DEFAULT_DOWNLOAD_FILE_TYPES))

    const [myList, setMyList] = useState([])
    const tasks = useDownloadTasks()
    const [downloading, setDownloading] = useState(false)
    const [deletingLocalGenomes, setDeletingLocalGenomes] = useState(false)
    const [statusMsg, setStatusMsg] = useState(null)
    const [catalogStatus, setCatalogStatus] = useState(() => sessionCatalogue.status)
	    const [refreshingCatalog, setRefreshingCatalog] = useState(false)
	    const seenFailedTaskIdsRef = useRef(new Set())
	    const seenWarningTaskIdsRef = useRef(new Set())
	    const seenCompletedTaskIdsRef = useRef(new Set())
	    const dismissedAutoManagedItemIdsRef = useRef(new Set())
	    const tasksRef = useRef([])
    const lastCatalogFingerprintRef = useRef('')
    // null until the first status reply, so a normal mount does not look like an arrival.
    const catalogueWasAvailableRef = useRef(null)
    const ncbiBrowseCacheRef = useRef(sessionCatalogue.ncbiBrowse)
    const ncbiSearchCacheRef = useRef(sessionCatalogue.ncbiSearch)

    // Panel collapse state
    const [speciesCollapsed, setSpeciesCollapsed] = useState(false)

    // ---------------------------------------------------------------------------
    // Data fetching
    // ---------------------------------------------------------------------------
    useEffect(() => {
        tasksRef.current = tasks
    }, [tasks])

    useEffect(() => {
        const allowed = new Set(activeProvider === 'ncbi' ? REFSEQ_DOWNLOAD_FILE_TYPES : ENSEMBL_DOWNLOAD_FILE_TYPES)
        setActiveDownloadTypes((prev) => {
            const next = new Set([...prev].filter((type) => allowed.has(type)))
            if (next.size === 0) DEFAULT_DOWNLOAD_FILE_TYPES.forEach((type) => allowed.has(type) && next.add(type))
            return next
        })
    }, [activeProvider])

    const fetchLocalAssemblies = useCallback(async () => {
        if (!config?.output_dir) {
            sessionCatalogue.localAssemblies = null
            setLocalAssemblies([])
            return
        }
        try {
            const res = await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(config.output_dir)}`)
            if (res.ok) {
                const data = await res.json()
                const assemblies = (Array.isArray(data) ? data : []).map((item) => normalizeGenomeRecord(item))
                sessionCatalogue.localAssemblies = assemblies
                setLocalAssemblies(assemblies)
                const localTypeByKey = new Map()
                for (const entry of assemblies) {
                    const key = getAssemblyGenomeKey(entry)
                    localTypeByKey.set(key, Array.isArray(entry.types) ? entry.types : [])
                }
                const latestByKey = new Map()
                for (const task of tasksRef.current) {
                    const key = getAssemblyGenomeKey(task)
                    const typeKey = task.file_type || `__task__${task.id}`
                    if (!latestByKey.has(key)) latestByKey.set(key, new Map())
                    const typeMap = latestByKey.get(key)
                    const existing = typeMap.get(typeKey)
                    typeMap.set(typeKey, existing ? (pickPreferredTask([existing, task]) || task) : task)
                }
                const inProgressStatuses = new Set(['pending', 'downloading'])
                // Keep My List local type cache in sync with disk state to avoid stale "downloaded" badges.
                setMyList((prev) => prev
                    .map((item) => {
                        const types = localTypeByKey.get(item.id)
                        if (!types) return { ...item, localTypes: [] }
                        return { ...item, localTypes: types }
                    })
                    .filter((item) => {
                        if (!item.autoManaged) return true
                        const latestTasks = Array.from((latestByKey.get(item.id) || new Map()).values())
                        const hasInProgress = latestTasks.some((task) => inProgressStatuses.has(task.status))
                        const hasFailed = latestTasks.some((task) => task.status === 'failed')
                        if (hasInProgress || hasFailed) return true
                        if (!Array.isArray(item.requestedTypes) || item.requestedTypes.length === 0) return true
                        const requiredTypes = item.requestedTypes
                        const localTypes = Array.isArray(item.localTypes) ? item.localTypes : (localTypeByKey.get(item.id) || [])
                        return !requiredTypes.every((type) => localTypes.includes(type))
                    }))
	            } else {
	                console.warn('Failed to refresh local assemblies:', res.statusText)
	            }
	        } catch (error) {
	            console.warn('Failed to refresh local assemblies:', error)
	        }
	    }, [config?.output_dir])

    // While a tutorial is running the demo genome joins the catalogue, so the tutorial
    // can teach this view for real — same search, same file-type chips, same download
    // button — without a network round trip or a gigabyte on disk.
    const { isRunning: tutorialRunning, emitSignal: emitTutorialSignal } = useTutorial()
    const [demoSpecies, setDemoSpecies] = useState(null)

    useEffect(() => {
        if (!tutorialRunning) {
            setDemoSpecies(null)
            return
        }
        let cancelled = false
        fetchDemoGenomeStatus(config?.output_dir || '')
            .then((status) => { if (!cancelled) setDemoSpecies(status?.species || null) })
            .catch(() => { if (!cancelled) setDemoSpecies(null) })
        return () => { cancelled = true }
    }, [config?.output_dir, tutorialRunning])

    // The demo genome is already on the machine, so installing it is instantaneous — which
    // teaches the wrong thing. Pacing it over a few seconds with real-looking progress is
    // the point of the step: this is what waiting for a download looks like.
    const DEMO_DOWNLOAD_MS = 5000
    const [demoProgress, setDemoProgress] = useState(null)

    const handleDemoGenomeInstall = useCallback(async () => {
        if (!config?.output_dir) {
            setStatusMsg({ text: 'Set an Output Directory in Configuration first.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
        // Deliberately not a status banner: that banner is in the flow above the species
        // table, so showing one shifts the whole list — including the button just clicked —
        // down by its height. The progress goes on the button's own icon instead, which is
        // where a real download shows it anyway.
        setDemoProgress(0)
        const started = Date.now()
        const ticker = setInterval(() => {
            setDemoProgress(Math.min(0.99, (Date.now() - started) / DEMO_DOWNLOAD_MS))
        }, 60)
        try {
            // Do the real work while the progress runs, then hold until the clock catches
            // up so the pacing is the same whether or not the disk was quick.
            const install = installDemoGenome(config.output_dir)
            await Promise.all([
                install,
                new Promise((resolve) => setTimeout(resolve, DEMO_DOWNLOAD_MS)),
            ])
            clearInterval(ticker)
            setDemoProgress(1)
            await fetchLocalAssemblies()
            // Cleared only once the listing has caught up, so the icon goes straight from
            // a full ring to the downloaded tick rather than flicking back in between.
            setDemoProgress(null)
            emitTutorialSignal('demoGenome.installed')
        } catch (error) {
            clearInterval(ticker)
            setDemoProgress(null)
            setStatusMsg({ text: `Could not install the demo genome: ${error?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        } finally {
            clearInterval(ticker)
        }
    }, [config?.output_dir, emitTutorialSignal, fetchLocalAssemblies])

    const fetchRemoteCatalogData = useCallback(async () => {
        const [gRes, sRes] = await Promise.all([
            fetch(`${API_BASE}/api/remote/groups?provider=ensembl`),
            fetch(`${API_BASE}/api/remote/species?provider=ensembl`),
        ])
        if (!gRes.ok || !sRes.ok) throw new Error('Failed to load remote catalogue')
        const fetchedGroups = await gRes.json()
        const fetchedSpecies = (await sRes.json()).map((item) => normalizeRemoteSpecies(item, 'ensembl'))

        let modelsCount = 0
        fetchedSpecies.forEach((s) => {
            const matchingAssemblies = s.assemblies?.filter((a) =>
                matchesModelOrganism(s.key, a)
            ) || []
            if (matchingAssemblies.length > 0) {
                modelsCount += matchingAssemblies.length
            }
        })

        const nextGroups = [
            { name: 'Models', count: modelsCount },
            ...fetchedGroups,
        ]
        sessionCatalogue.groups = nextGroups
        sessionCatalogue.species = fetchedSpecies
        setGroups(nextGroups)
        setAllSpecies(fetchedSpecies)
    }, [])

    const fetchNcbiSearchResults = useCallback(async (pageToken = null) => {
        const query = search.trim()
        if (activeProvider !== 'ncbi') return

        // A page already fetched this session is served from the cache below, so
        // only an actual round trip is worth a spinner.
        const willFetch = query
            ? !ncbiSearchCacheRef.current.has(`search:${query.toLowerCase()}`)
            : !ncbiBrowseCacheRef.current.has(`browse:${activeRefSeqGroup}:${pageToken || ''}`)
        setNcbiLoading(willFetch)
        try {
            if (!query) {
                const tokenParam = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''
                const cacheKey = `browse:${activeRefSeqGroup}:${pageToken || ''}`
                let data = ncbiBrowseCacheRef.current.get(cacheKey)
                if (!data) {
                    const res = await fetch(
                        `${API_BASE}/api/remote/ncbi/browse?group=${encodeURIComponent(activeRefSeqGroup)}&page_size=${PAGE_SIZE}${tokenParam}`
                    )
                    data = await res.json().catch(() => ({}))
                    if (!res.ok) throw new Error(data?.detail || 'Failed to load RefSeq group')
                    ncbiBrowseCacheRef.current.set(cacheKey, data)
                }
                const fetched = Array.isArray(data?.species) ? data.species.map((item) => normalizeRemoteSpecies(item, 'ncbi')) : []
                setNcbiSpecies(fetched)
                setNcbiCurrentPageToken(pageToken || null)
                setNcbiNextPageToken(data?.next_page_token || null)
                setNcbiTotalCount(typeof data?.total_count === 'number' ? data.total_count : null)
                return
            }

            const cacheKey = `search:${query.toLowerCase()}`
            let data = ncbiSearchCacheRef.current.get(cacheKey)
            if (!data) {
                const res = await fetch(
                    `${API_BASE}/api/remote/ncbi/search?query=${encodeURIComponent(query)}&assembly_source=refseq&page_size=${PAGE_SIZE}`
                )
                data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(data?.detail || 'Failed to search RefSeq genomes')
                ncbiSearchCacheRef.current.set(cacheKey, data)
            }
            setNcbiSpecies(Array.isArray(data?.species) ? data.species.map((item) => normalizeRemoteSpecies(item, 'ncbi')) : [])
            setNcbiCurrentPageToken(null)
            setNcbiNextPageToken(null)
            setNcbiPageTokenHistory([])
            setNcbiTotalCount(typeof data?.total_count === 'number' ? data.total_count : null)
        } catch (e) {
            setStatusMsg({ text: `RefSeq search failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        } finally {
            setNcbiLoading(false)
        }
    }, [activeProvider, activeRefSeqGroup, search])

    const fetchCatalogStatus = useCallback(async () => {
        const res = await fetch(`${API_BASE}/api/remote/catalog/status`)
        if (!res.ok) throw new Error('Failed to load catalogue status')
        const data = await res.json()
        sessionCatalogue.status = data
        setCatalogStatus(data)
        return data
    }, [])

    const fetchRefSeqGroups = useCallback(async () => {
        setRefSeqGroupsLoading(!sessionCatalogue.refSeqGroups)
        try {
            const res = await fetch(`${API_BASE}/api/remote/groups?provider=ncbi`)
            const data = await res.json().catch(() => ([]))
            sessionCatalogue.refSeqGroups = Array.isArray(data) ? data : []
            setRefSeqGroups(sessionCatalogue.refSeqGroups)
        } catch (error) {
            console.warn('Failed to refresh RefSeq groups:', error)
        } finally {
            setRefSeqGroupsLoading(false)
        }
    }, [])

    useEffect(() => {
        const init = async () => {
            // Revisiting the view refreshes behind whatever is already on screen;
            // only a first, empty mount is allowed to show the spinner.
            const hasCachedSpecies = !!sessionCatalogue.species
            if (!hasCachedSpecies) setLoading(true)
            try {
                const [status] = await Promise.all([
                    fetchCatalogStatus(),
                    fetchRemoteCatalogData(),
                ])
                lastCatalogFingerprintRef.current = String(status?.current_catalog_fingerprint || '')
            } catch (e) { console.error('Failed to load data', e) }
            finally { if (!hasCachedSpecies) setLoading(false) }
        }
        init()
    }, [fetchCatalogStatus, fetchRemoteCatalogData])

    useEffect(() => {
        fetchLocalAssemblies()
    }, [fetchLocalAssemblies])

    // Fetch RefSeq group counts when the RefSeq tab is activated (cached 1hr on backend)
    useEffect(() => {
        if (activeProvider !== 'ncbi') return
        fetchRefSeqGroups()
    }, [activeProvider, fetchRefSeqGroups])

    useEffect(() => {
        if (activeProvider !== 'ncbi') return undefined
        const timer = window.setTimeout(() => {
            fetchNcbiSearchResults()
        }, 200)
        return () => window.clearTimeout(timer)
    }, [activeProvider, fetchNcbiSearchResults, activeRefSeqGroup, search])

    useEffect(() => {
        let cancelled = false
        const pollCatalogStatus = async () => {
            try {
                const status = await fetchCatalogStatus()
                if (cancelled || !status) return
                const nextFingerprint = String(status.current_catalog_fingerprint || '')
                const previousFingerprint = String(lastCatalogFingerprintRef.current || '')
                const catalogueAvailable = Boolean(status.catalog_available)
                const fingerprintChanged = Boolean(
                    nextFingerprint && previousFingerprint && nextFingerprint !== previousFingerprint
                )
                // The very first catalogue to arrive has no earlier fingerprint to differ
                // from, so the comparison above cannot see it. Without this the view stays
                // empty until the user reloads.
                const catalogueJustArrived = catalogueWasAvailableRef.current === false && catalogueAvailable
                if (fingerprintChanged || catalogueJustArrived) {
                    await fetchRemoteCatalogData()
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
                    }
                }
                catalogueWasAvailableRef.current = catalogueAvailable
                if (nextFingerprint) {
                    lastCatalogFingerprintRef.current = nextFingerprint
                }
            } catch {
                // keep silent during catalogue polling
            }
        }
        pollCatalogStatus()
        const id = window.setInterval(pollCatalogStatus, 5000)
        return () => {
            cancelled = true
            window.clearInterval(id)
        }
    }, [fetchCatalogStatus, fetchRemoteCatalogData])

    useEffect(() => {
        const nextPendingIds = new Set(
            myList
                .filter((item) => item.autoManaged)
                .map((item) => String(item.id || '').trim())
                .filter(Boolean)
        )
        const previousPendingIds = readPendingSelectorGenomeIds()
        const removedIds = Array.from(previousPendingIds).filter((id) => !nextPendingIds.has(id))
        const changed = removedIds.length > 0 || previousPendingIds.size !== nextPendingIds.size
        if (!changed) return
        writePendingSelectorGenomeIds(nextPendingIds)
        if (removedIds.length > 0 && typeof window !== 'undefined') {
            window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
        }
    }, [myList])

    useEffect(() => {
        // Runs on every shared poll, not only when the list changes: rows below are
        // retired against local files that arrive independently of the tasks.
        const onTasks = () => {
            try {
                const newTasks = getDownloadTasksSnapshot()
                if (Array.isArray(newTasks)) {
                    const latestByKey = new Map()
                    for (const task of newTasks) {
                        const key = getAssemblyGenomeKey(task)
                        const typeKey = task.file_type || `__task__${task.id}`
                        if (!latestByKey.has(key)) latestByKey.set(key, new Map())
                        const typeMap = latestByKey.get(key)
                        const existing = typeMap.get(typeKey)
                        if (!existing) {
                            typeMap.set(typeKey, task)
                            continue
                        }
                        const next = pickPreferredTask([existing, task]) || task
                        typeMap.set(typeKey, next)
                    }

                    const latestTasksForKey = (key) => Array.from((latestByKey.get(key) || new Map()).values())
                    const inProgressStatuses = new Set(['pending', 'downloading'])
                    const inProgressKeys = new Set()
                    const failedKeys = new Set()
                    const newlyCompletedTasks = []

                    for (const [key, taskMap] of latestByKey.entries()) {
                        const latestTasks = Array.from(taskMap.values())
                        const hasInProgress = latestTasks.some((task) => inProgressStatuses.has(task.status))
                        const hasFailed = latestTasks.some((task) => task.status === 'failed')
                        const hasCompleted = latestTasks.some((task) => task.status === 'completed')
                        if (hasInProgress) inProgressKeys.add(key)
                        if (hasFailed) failedKeys.add(key)
                    }

                    for (const task of newTasks) {
                        if (task.status !== 'completed') continue
                        if (seenCompletedTaskIdsRef.current.has(task.id)) continue
                        seenCompletedTaskIdsRef.current.add(task.id)
                        newlyCompletedTasks.push(task)
                    }

                    const newFailedTasks = []
                    for (const task of newTasks) {
                        if (task.status !== 'failed') continue
                        if (seenFailedTaskIdsRef.current.has(task.id)) continue
                        seenFailedTaskIdsRef.current.add(task.id)
                        newFailedTasks.push(task)
                    }
                    if (newFailedTasks.length > 0) {
                        const first = newFailedTasks[0]
                        const label = first.file_type ? `${fileTypeLabel(first.file_type)} for ${first.assembly}` : first.filename
                        setStatusMsg({ text: `Download failed: ${label}`, isError: true })
                        setTimeout(() => setStatusMsg(null), 6000)
                    } else {
                        const newWarningTasks = []
                        for (const task of newTasks) {
                            if (task.status !== 'completed') continue
                            if (!String(task.warning || '').trim()) continue
                            if (seenWarningTaskIdsRef.current.has(task.id)) continue
                            seenWarningTaskIdsRef.current.add(task.id)
                            newWarningTasks.push(task)
                        }
                        if (newWarningTasks.length > 0) {
                            const first = newWarningTasks[0]
                            const fallbackLabel = first.file_type ? `${fileTypeLabel(first.file_type)} for ${first.assembly}` : first.filename
                            setStatusMsg({
                                text: String(first.warning || `Softmasked file unavailable; used unmasked fallback for ${fallbackLabel}.`),
                                isError: false,
                                isWarning: true,
                            })
                            setTimeout(() => setStatusMsg(null), 7000)
                        }
                    }

                    setMyList((prev) => {
                        let next = prev.slice()

                        const existingIds = new Set(next.map((i) => i.id))
	                        const dismissedIds = dismissedAutoManagedItemIdsRef.current
	                        const keysToSurface = new Set([...inProgressKeys, ...failedKeys].filter((key) => !dismissedIds.has(key)))
                        for (const key of keysToSurface) {
                            if (existingIds.has(key)) continue
                            const taskSeed = newTasks.find((task) => getAssemblyGenomeKey(task) === key)
                            const provider = normalizeGenomeProvider(taskSeed)
                            const speciesKey = taskSeed?.species_key || ''
                            const assembly = taskSeed?.assembly || ''
                            const speciesPool = provider === 'ncbi' ? ncbiSpecies : allSpecies
                            const species = speciesPool.find((s) => s.key === speciesKey)
                            const asm = species?.assemblies?.find((a) => getAssemblyAccession(a) === assembly)
                            const latest = latestTasksForKey(key)
                            const requestedTypes = [...new Set(latest.map((t) => t.file_type).filter(Boolean))]
                            next.push({
                                id: key,
                                provider,
                                source_database: asm?.source_database || normalizeGenomeSourceDatabase({ provider, assembly }),
                                species_key: speciesKey,
                                scientific_name: species?.scientific_name || speciesKey.replace(/_/g, ' '),
                                common_name: species?.common_name || '',
                                display_name: species?.display_name || '',
                                display_name_reason: species?.display_name_reason || '',
                                assembly,
                                gca: assembly,
                                assembly_name: asm?.name || assembly,
                                equivalent_accessions: asm?.equivalent_accessions || [],
                                autoManaged: true,
                                requestedTypes,
                                localTypes: undefined,
                            })
                        }

                        // Auto-managed entries disappear only once all requested local files are present.
                        next = next.filter((item) => {
                            if (!item.autoManaged) return true
                            const latest = latestTasksForKey(item.id)
                            const hasInProgress = latest.some((task) => inProgressStatuses.has(task.status))
                            const hasFailed = latest.some((task) => task.status === 'failed')
                            if (hasInProgress || hasFailed) return true
                            if (!Array.isArray(item.requestedTypes) || item.requestedTypes.length === 0) return true
                            const requiredTypes = item.requestedTypes
                            const localTypes = Array.isArray(item.localTypes) ? item.localTypes : []
                            const isComplete = requiredTypes.every((type) => localTypes.includes(type))
                            return !isComplete
                        })

                        return next
                    })

                    if (newlyCompletedTasks.length > 0) fetchLocalAssemblies()
                }
            } catch { /* ignore */ }
        }
        onTasks()
        return subscribeDownloadTasks(onTasks)
    }, [allSpecies, fetchLocalAssemblies, ncbiSpecies])

    const sidebarGroups = useMemo(() => {
        if (activeProvider !== 'ensembl') return []
        const baseGroups = groups.filter(g => g.name !== 'Local genomes')
        return [
            ...baseGroups,
            { name: 'Local genomes', count: localAssemblies.length, sub_groups: [] }
        ]
    }, [activeProvider, groups, localAssemblies.length])

    const buildRemoteFilesUrl = useCallback((item, requestedTypes = []) => {
        const params = new URLSearchParams({
            provider: normalizeGenomeProvider(item),
        })
        const normalizedTypes = (Array.isArray(requestedTypes) ? requestedTypes : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        if (normalizedTypes.length > 0) {
            params.set('file_types', normalizedTypes.join(','))
        }
        return `${API_BASE}/api/remote/files/${item.species_key}/${encodeURIComponent(getAssemblyAccession(item))}?${params.toString()}`
    }, [])

    const buildAvailabilityUrl = useCallback((item, includeDirectoryListing = false) => {
        const params = new URLSearchParams({
            provider: normalizeGenomeProvider(item),
        })
        if (includeDirectoryListing) params.set('include_directory_listing', 'true')
        return `${API_BASE}/api/remote/files/${item.species_key}/${encodeURIComponent(getAssemblyAccession(item))}/availability?${params.toString()}`
    }, [])

    const markItemsActive = useCallback((items, filesByItem) => {
        setMyList((prev) => {
            const byId = new Map(prev.map((item) => [item.id, item]))
            for (const item of items) {
                const fileTypes = [...new Set((filesByItem.get(item.id) || []).map((file) => file.type).filter(Boolean))]
                const existing = byId.get(item.id)
                byId.set(item.id, {
                    ...(existing || item),
                    ...item,
                    autoManaged: true,
                    localTypes: undefined,
                    requestedTypes: [
                        ...new Set([
                            ...(Array.isArray(existing?.requestedTypes) ? existing.requestedTypes : []),
                            ...fileTypes,
                        ]),
                    ],
                })
                dismissedAutoManagedItemIdsRef.current.delete(item.id)
            }
            return Array.from(byId.values())
        })
    }, [])

    const postDownloadFile = useCallback(async (item, file, { force = false } = {}) => {
        const res = await fetch(`${API_BASE}/api/remote/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: file.url,
                filename: file.filename,
                provider: normalizeGenomeProvider(item),
                species_key: item.species_key,
                assembly: getAssemblyAccession(item),
                file_type: file.type,
                output_dir: config.output_dir,
                scientific_name: item.scientific_name,
                common_name: item.common_name,
                display_name: item.display_name || '',
                display_name_reason: item.display_name_reason || '',
                assembly_name: item.assembly_name,
                source_database: item.source_database,
                equivalent_accessions: item.equivalent_accessions || [],
                taxid: Number(item.taxid) || 0,
                ...datasetReleaseDownloadMetadata(file),
                force,
            }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.detail || `Failed to start ${file.type || 'file'} download`)
        return data
    }, [config?.output_dir])

    const handleDownloadFiles = useCallback(async (item, files, { force = false } = {}) => {
        if (!config?.output_dir) {
            setStatusMsg({ text: 'Set an Output Directory in Configuration first.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
        const queuedFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.filename) : []
        if (queuedFiles.length === 0) {
            setStatusMsg({ text: 'No matching files are available for this genome.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
        setDownloading(true)
        let started = 0
        let alreadyLocal = 0
        let alreadyQueued = 0
        try {
            for (const file of queuedFiles) {
                const data = await postDownloadFile(item, file, { force })
                if (data?.status === 'started' || data?.status === 'pending' || data?.status === 'downloading') started++
                else if (data?.status === 'already_exists' || data?.status === 'completed') alreadyLocal++
                else alreadyQueued++
            }
            if (started > 0) markItemsActive([item], new Map([[item.id, queuedFiles]]))
            if (alreadyLocal > 0) fetchLocalAssemblies()
            const parts = []
            if (started > 0) parts.push(`Started ${started} file download${started !== 1 ? 's' : ''}`)
            if (alreadyQueued > 0) parts.push(`${alreadyQueued} already queued`)
            if (alreadyLocal > 0) parts.push(`${alreadyLocal} already present locally`)
            setStatusMsg({ text: `${parts.length ? parts.join(' • ') : 'No new downloads were needed'}.`, isError: false })
            setTimeout(() => setStatusMsg(null), 5000)
        } catch (e) {
            setStatusMsg({ text: `Download failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        } finally {
            setDownloading(false)
            void refreshDownloadTasks()
        }
    }, [config?.output_dir, fetchLocalAssemblies, markItemsActive, postDownloadFile])

    const handleCancelDownloadFiles = useCallback(async (item, files) => {
        const selectedFiles = Array.isArray(files) ? files : []
        const fileTypes = [...new Set(selectedFiles.map((file) => String(file?.type || '').trim()).filter(Boolean))]
        const filenames = [...new Set(selectedFiles.map((file) => gcaPrefixedDownloadFilename(file, item)).filter(Boolean))]
        if (fileTypes.length === 0 && filenames.length === 0) return
        try {
            const res = await fetch(`${API_BASE}/api/remote/download/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: normalizeGenomeProvider(item),
                    species_key: item.species_key,
                    assembly: getAssemblyAccession(item),
                    file_types: fileTypes,
                    filenames,
                }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data?.detail || 'Failed to cancel downloads')
            const cancelledIds = new Set(Array.isArray(data?.task_ids) ? data.task_ids : [])
            if (cancelledIds.size > 0) void refreshDownloadTasks()
            setStatusMsg({
                text: cancelledIds.size > 0
                    ? `Canceled ${cancelledIds.size} download${cancelledIds.size === 1 ? '' : 's'}.`
                    : 'No active downloads matched that selection.',
                isError: false,
            })
            setTimeout(() => setStatusMsg(null), 4000)
        } catch (e) {
            setStatusMsg({ text: `Cancel failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        }
    }, [])

    const handleRowDownload = useCallback(async (item, { force = false, selectedTypes = null } = {}) => {
        if (isDemoGenomeItem(item)) {
            await handleDemoGenomeInstall()
            return
        }
        const requestedTypes = Array.isArray(selectedTypes) ? selectedTypes : Array.from(activeDownloadTypes)
        if (requestedTypes.length === 0) {
            setStatusMsg({ text: 'Select at least one file type to download.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
        try {
            const res = await fetch(buildAvailabilityUrl(item, false))
            const availability = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(availability?.detail || 'Could not load available files')
            const files = chooseFilesForTypes(availability, requestedTypes)
            await handleDownloadFiles(item, files, { force })
        } catch (e) {
            setStatusMsg({ text: `Download failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        }
    }, [activeDownloadTypes, buildAvailabilityUrl, handleDemoGenomeInstall, handleDownloadFiles])

    const handleDownloadAllAssemblies = useCallback(async (species, options = {}) => {
        const assemblies = Array.isArray(species?.assemblies) ? species.assemblies : []
        for (const asm of assemblies) {
            const item = itemFromSpeciesAssembly(species, asm)
            const itemTypes = options?.selectedTypesByItem?.[item.id]
            if (Array.isArray(itemTypes) && itemTypes.length === 0) continue
            await handleRowDownload(item, { selectedTypes: itemTypes })
        }
    }, [handleRowDownload])

    const deleteLocalGenome = useCallback(async (item) => {
        if (!config?.output_dir || !item) return
        if (!item.download_managed) {
            setStatusMsg({ text: item.delete_blocked_reason || 'Custom genomes must be deleted manually', isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
            return
        }
        const res = await fetch(`${API_BASE}/api/remote/local-files`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                output_dir: config.output_dir,
                species_key: item.species_key,
                assembly: getAssemblyAccession(item),
                provider: normalizeGenomeProvider(item),
            }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data?.detail || 'Failed to remove downloaded files')
    }, [config?.output_dir])

    const handleDeleteLocalGenome = useCallback(async (item) => {
        setDeletingLocalGenomes(true)
        try {
            await deleteLocalGenome(item)
            await fetchLocalAssemblies()
            if (typeof window !== 'undefined') window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
            setStatusMsg({ text: 'Downloaded files removed.', isError: false })
            setTimeout(() => setStatusMsg(null), 3500)
        } catch (e) {
            setStatusMsg({ text: `Remove failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        } finally {
            setDeletingLocalGenomes(false)
        }
    }, [deleteLocalGenome, fetchLocalAssemblies])

    const handleDeleteLocalFile = useCallback(async (item, file, filePath) => {
        if (!config?.output_dir || !item || !filePath) return
        try {
            const res = await fetch(`${API_BASE}/api/remote/local-file`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    output_dir: config.output_dir,
                    species_key: item.species_key,
                    assembly: getAssemblyAccession(item),
                    provider: normalizeGenomeProvider(item),
                    file_path: filePath,
                }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data?.detail || 'Failed to delete file')
            await fetchLocalAssemblies()
            if (typeof window !== 'undefined') window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
            setStatusMsg({ text: `Deleted ${fileTypeLabel(file?.type)} file.`, isError: false })
            setTimeout(() => setStatusMsg(null), 3500)
        } catch (e) {
            setStatusMsg({ text: `Delete failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        }
    }, [config?.output_dir, fetchLocalAssemblies])

    const handleDeleteAllLocalGenomes = useCallback(async (itemsToDelete) => {
        const targets = (Array.isArray(itemsToDelete) ? itemsToDelete : []).filter((item) => item?.download_managed)
        if (targets.length === 0) return
        setDeletingLocalGenomes(true)
        try {
            for (const item of targets) {
                await deleteLocalGenome(item)
            }
            await fetchLocalAssemblies()
            if (typeof window !== 'undefined') window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
            setStatusMsg({ text: `Removed downloaded files for ${targets.length} genome${targets.length === 1 ? '' : 's'}.`, isError: false })
            setTimeout(() => setStatusMsg(null), 4000)
        } catch (e) {
            setStatusMsg({ text: `Remove all failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 6000)
        } finally {
            setDeletingLocalGenomes(false)
        }
    }, [deleteLocalGenome, fetchLocalAssemblies])

    // Fetch remote available types and local (already downloaded) types for each item
    useEffect(() => {
        myList.forEach(item => {
            // Check remote available types
            if (item.availableTypes === undefined) {
                setMyList(prev => prev.map(i => i.id === item.id ? { ...i, availableTypes: null } : i))
                fetch(buildRemoteFilesUrl(item))
                    .then(r => r.ok ? r.json() : [])
                    .then(files => {
                        const types = [...new Set(files.map(f => f.type))]
                        setMyList(prev => prev.map(i => i.id === item.id ? { ...i, availableTypes: types } : i))
                    })
                    .catch(() => setMyList(prev => prev.map(i => i.id === item.id ? { ...i, availableTypes: [] } : i)))
            }
            // Check local_data for already-downloaded files
            if (item.localTypes === undefined && config?.output_dir) {
                setMyList(prev => prev.map(i => i.id === item.id ? { ...i, localTypes: null } : i))
                fetch(`${API_BASE}/api/remote/local-files?output_dir=${encodeURIComponent(config.output_dir)}&species_key=${encodeURIComponent(item.species_key)}&assembly=${encodeURIComponent(getAssemblyAccession(item))}&provider=${encodeURIComponent(normalizeGenomeProvider(item))}`)
                    .then(r => r.ok ? r.json() : { types: [] })
                    .then(data => {
                        setMyList(prev => prev.map(i => i.id === item.id ? { ...i, localTypes: data.types || [] } : i))
                    })
                    .catch(() => setMyList(prev => prev.map(i => i.id === item.id ? { ...i, localTypes: [] } : i)))
            }
        })
    }, [buildRemoteFilesUrl, myList, config?.output_dir])

    const totalAssemblies = useMemo(() => {
        const speciesList = activeProvider === 'ncbi' ? ncbiSpecies : allSpecies
        return speciesList.reduce((sum, s) => sum + (s.assemblies?.length || 0), 0)
    }, [activeProvider, allSpecies, ncbiSpecies])

    // ---------------------------------------------------------------------------
    // Tasks keyed by provider-aware genome id for badge status
    // ---------------------------------------------------------------------------
    const tasksByItemKey = useMemo(() => {
        const map = {}
        tasks.forEach(task => {
            const key = getAssemblyGenomeKey(task)
            if (!map[key]) map[key] = []
            map[key].push(task)
        })
        return map
    }, [tasks])

    const localTypeByKey = useMemo(() => {
        const map = new Map()
        localAssemblies.forEach((item) => {
            map.set(getAssemblyGenomeKey(item), Array.isArray(item.types) ? item.types : [])
        })
        return map
    }, [localAssemblies])

    const localFileInfoByKey = useMemo(() => {
        const map = new Map()
        localAssemblies.forEach((item) => {
            map.set(getAssemblyGenomeKey(item), item)
        })
        return map
    }, [localAssemblies])

    const localSearchMatches = useCallback((item, query) => {
        if (!query) return true
        return [
            item?.scientific_name,
            item?.common_name,
            item?.species_key,
            item?.assembly_name,
            item?.source_database,
            getAssemblyAccession(item),
        ].some((value) => String(value || '').toLowerCase().includes(query))
    }, [])

    const filteredLocalAssemblies = useMemo(() => {
        const q = search.toLowerCase().trim()
        return localAssemblies.filter((item) => localSearchMatches(item, q))
    }, [localAssemblies, localSearchMatches, search])

    const filteredActiveLocalItems = useMemo(() => {
        const q = search.toLowerCase().trim()
        return myList
            .filter((item) => item.autoManaged)
            .filter((item) => localSearchMatches(item, q))
    }, [localSearchMatches, myList, search])

    // ---------------------------------------------------------------------------
    // Filtered / paginated species
    // ---------------------------------------------------------------------------
    const filteredSpecies = useMemo(() => {
        if (activeProvider === 'ncbi') {
            let list = ncbiSpecies

            if (activeRefSeqGroup === 'Featured') {
                list = list
                    .map((species) => {
                        const matchingAssemblies = (species.assemblies || []).filter((assembly) =>
                            REFSEQ_FEATURED_ACCESSIONS.has(getAssemblyAccession(assembly))
                        )
                        return matchingAssemblies.length > 0 ? { ...species, assemblies: matchingAssemblies } : null
                    })
                    .filter(Boolean)
            } else if (activeRefSeqGroup === 'Vertebrates') {
                list = list.filter((species) => VERTEBRATE_GROUPS.has(species.group))
            } else if (activeRefSeqGroup === 'Invertebrates') {
                list = list.filter((species) => REFSEQ_INVERTEBRATE_GROUPS.has(species.group))
            } else if (activeRefSeqGroup === 'Microbes') {
                list = list.filter((species) => REFSEQ_MICROBE_GROUPS.has(species.group))
            } else if (activeRefSeqGroup && activeRefSeqGroup !== 'All genomes') {
                list = list.filter((species) => species.group === activeRefSeqGroup)
            }

            if (search.trim()) {
                const q = search.toLowerCase().trim()
                list = list
                    .map((s) => {
                        const scientificMatch = s.scientific_name?.toLowerCase().includes(q)
                        const commonMatch = s.common_name?.toLowerCase().includes(q)
                        const sourceMatch = (s.assemblies || []).some((a) =>
                            String(a.source_database || '').toLowerCase().includes(q)
                        )
                        const matchingAssemblies = (s.assemblies || []).filter((a) =>
                            getAssemblyAccession(a).toLowerCase().includes(q)
                            || String(a.name || '').toLowerCase().includes(q)
                            || String(a.source_database || '').toLowerCase().includes(q)
                        )
                        if (scientificMatch || commonMatch || sourceMatch) return s
                        if (matchingAssemblies.length > 0) return { ...s, assemblies: matchingAssemblies }
                        return null
                    })
                    .filter(Boolean)
            }
            return list
        }
        let list = demoSpecies ? [demoSpecies, ...allSpecies] : allSpecies

        if (activeGroup === 'Models') {
            // Filter species to only those in the MODEL_ORGANISMS list
            list = list.map(s => {
                const matchingAssemblies = s.assemblies?.filter(a =>
                    matchesModelOrganism(s.key, a)
                )
                if (matchingAssemblies && matchingAssemblies.length > 0) {
                    return { ...s, assemblies: matchingAssemblies }
                }
                return null
            }).filter(Boolean)
        } else if (activeGroup === 'Projects') {
            const requestedProject = String(activeSubGroup || '').trim()
            list = list.map(s => {
                const matchingAssemblies = (s.assemblies || []).filter(a => {
                    const projects = Array.isArray(a.projects) ? a.projects : []
                    if (requestedProject) return projects.includes(requestedProject)
                    return projects.length > 0
                })
                if (matchingAssemblies.length > 0) {
                    return { ...s, assemblies: matchingAssemblies }
                }
                return null
            }).filter(Boolean)
        } else if (activeGroup === 'Local genomes') {
            const localAssemblySet = new Set(localAssemblies.map((a) => getAssemblyGenomeKey(a)))
            list = list.map(s => {
                const matchingAssemblies = s.assemblies?.filter(a =>
                    localAssemblySet.has(getAssemblyGenomeKey({ provider: s.provider, species_key: s.key, assembly: getAssemblyAccession(a) }))
                ) || []
                if (matchingAssemblies.length > 0) {
                    return { ...s, assemblies: matchingAssemblies }
                }
                return null
            }).filter(Boolean)
        } else if (activeGroup === 'Vertebrates') {
            list = list.filter(s => VERTEBRATE_GROUPS.has(s.group))
        } else if (activeGroup !== 'All') {
            list = list.filter(s => s.group === activeGroup)
        }

        if (activeSubGroup && activeGroup !== 'Projects') list = list.filter(s => s.sub_group === activeSubGroup)
        if (search.trim()) {
            const q = search.toLowerCase().trim()
            list = list
                .map((s) => {
                    const scientificMatch = s.scientific_name?.toLowerCase().includes(q)
                    const commonMatch = s.common_name?.toLowerCase().includes(q)
                    const sourceMatch = (s.assemblies || []).some((a) =>
                        String(a.source_database || '').toLowerCase().includes(q)
                    )
                    const matchingAssemblies = (s.assemblies || []).filter((a) =>
                        getAssemblyAccession(a).toLowerCase().includes(q)
                        || String(a.name || '').toLowerCase().includes(q)
                        || String(a.source_database || '').toLowerCase().includes(q)
                    )

                    // If query matches species/common name, keep all assemblies for that species.
                    if (scientificMatch || commonMatch || sourceMatch) return s
                    // If query matches only assembly fields, keep just matching assembly rows.
                    if (matchingAssemblies.length > 0) return { ...s, assemblies: matchingAssemblies }
                    return null
                })
                .filter(Boolean)
        }
        return list
    }, [activeProvider, allSpecies, demoSpecies, activeGroup, activeSubGroup, ncbiSpecies, search, localAssemblies, activeRefSeqGroup])

    const totalPages = Math.ceil(filteredSpecies.length / PAGE_SIZE)
    const pageSpecies = filteredSpecies.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    useEffect(() => { setPage(1) }, [activeGroup, activeProvider, activeSubGroup, activeRefSeqGroup, activeRefSeqSubGroup, search])

    useEffect(() => {
        const node = speciesListScrollRef.current
        if (!node) return undefined
        const resetScroll = () => {
            node.scrollTop = 0
        }
        resetScroll()
        const frame = window.requestAnimationFrame(resetScroll)
        return () => window.cancelAnimationFrame(frame)
    }, [activeProvider, activeGroup, activeSubGroup, activeRefSeqGroup, activeRefSeqSubGroup, search, page])

    // ---------------------------------------------------------------------------
    // My list management
    // ---------------------------------------------------------------------------
    const makeItemId = useCallback((provider, key, assembly) => (
        getAssemblyGenomeKey({ provider, species_key: key, assembly })
    ), [])
    const myListIds = useMemo(() => new Set(myList.map(i => i.id)), [myList])

	    const addToList = useCallback((species, asm) => {
	        const id = makeItemId(species.provider, species.key, getAssemblyAccession(asm))
	        if (myListIds.has(id)) return
	        dismissedAutoManagedItemIdsRef.current.delete(id)
	        setMyList(prev => [...prev, {
            id,
            provider: normalizeGenomeProvider(species),
            source_database: asm?.source_database || normalizeGenomeSourceDatabase({ provider: species.provider, assembly: getAssemblyAccession(asm) }),
            species_key: species.key,
            scientific_name: species.scientific_name,
            common_name: species.common_name,
            display_name: species.display_name || '',
            display_name_reason: species.display_name_reason || '',
            assembly: getAssemblyAccession(asm),
            gca: asm.gca || getAssemblyAccession(asm),
            assembly_name: asm.name,
            equivalent_accessions: asm?.equivalent_accessions || [],
            taxid: Number(species.taxid || species.species_taxonomy_id) || 0,
            requestedTypes: [],
        }])
    }, [myListIds, makeItemId])

	    const removeFromList = useCallback((id) => {
	        setMyList((prev) => {
	            const removed = prev.find((item) => item.id === id)
	            if (removed?.autoManaged) dismissedAutoManagedItemIdsRef.current.add(id)
	            return prev.filter((item) => item.id !== id)
	        })
	    }, [])

	    const clearList = () => {
	        setMyList((prev) => {
	            for (const item of prev) {
	                if (item?.autoManaged) dismissedAutoManagedItemIdsRef.current.add(item.id)
	            }
	            return []
	        })
	    }

    const handleRefreshCatalog = useCallback(async () => {
        setRefreshingCatalog(true)
        try {
            if (activeProvider === 'ncbi') {
                const res = await fetch(`${API_BASE}/api/remote/ncbi/refresh`, { method: 'POST' })
                const data = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(data?.detail || 'Failed to refresh RefSeq browse data')
                ncbiBrowseCacheRef.current = new Map()
                ncbiSearchCacheRef.current = new Map()
                await Promise.all([
                    fetchRefSeqGroups(),
                    fetchNcbiSearchResults(),
                ])
                setStatusMsg({ text: 'Refreshed RefSeq browse data.', isError: false })
                setTimeout(() => setStatusMsg(null), 4000)
                return
            }

            const res = await fetch(`${API_BASE}/api/remote/catalog/refresh`, { method: 'POST' })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data?.detail || 'Failed to refresh catalogue')
            setCatalogStatus(data)
            lastCatalogFingerprintRef.current = String(data?.current_catalog_fingerprint || lastCatalogFingerprintRef.current || '')
            await fetchRemoteCatalogData()
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
            }
            setStatusMsg({ text: 'Checked Ensembl FTP catalogue for updates.', isError: false })
            setTimeout(() => setStatusMsg(null), 4000)
        } catch (e) {
            setStatusMsg({ text: `Catalogue refresh failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        } finally {
            setRefreshingCatalog(false)
        }
    }, [activeProvider, fetchNcbiSearchResults, fetchRefSeqGroups, fetchRemoteCatalogData])

    const handleAcknowledgeCatalogChange = useCallback(async () => {
        const token = String(catalogStatus?.latest_change?.token || '')
        if (!token) return
        try {
            const res = await fetch(`${API_BASE}/api/remote/catalog/acknowledge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            })
            if (!res.ok) throw new Error('Failed to dismiss catalogue notice')
            const data = await res.json()
            setCatalogStatus(data)
        } catch {
            // keep silent for acknowledgement
        }
    }, [catalogStatus])

    // ---------------------------------------------------------------------------
    // Retry a single failed file type for a specific item
    // ---------------------------------------------------------------------------
	    const handleRetry = useCallback(async (item, fileType) => {
	        if (!config?.output_dir) {
	            setStatusMsg({ text: 'Set an Output Directory in Configuration first.', isError: true })
	            setTimeout(() => setStatusMsg(null), 4000)
	            return
	        }
	        dismissedAutoManagedItemIdsRef.current.delete(item.id)
	        try {
            const filesRes = await fetch(buildRemoteFilesUrl(item, [fileType]))
            if (!filesRes.ok) throw new Error('Could not fetch file list')
            const files = await filesRes.json()
            const file = files.find(f => f.type === fileType)
            if (!file) throw new Error(`No ${fileType} file found for this assembly`)
            const res = await fetch(`${API_BASE}/api/remote/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: file.url,
                    filename: file.filename,
                    provider: normalizeGenomeProvider(item),
                    species_key: item.species_key,
                    assembly: getAssemblyAccession(item),
                    file_type: file.type,
                    output_dir: config.output_dir,
                    scientific_name: item.scientific_name,
                    common_name: item.common_name,
                    display_name: item.display_name || '',
                    display_name_reason: item.display_name_reason || '',
                    assembly_name: item.assembly_name,
                    source_database: item.source_database,
                    equivalent_accessions: item.equivalent_accessions || [],
                    taxid: Number(item.taxid) || 0,
                    ...datasetReleaseDownloadMetadata(file, item),
                }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) {
                throw new Error(data?.detail || 'Failed to start retry')
            }
            if (data?.status === 'already_exists' || data?.status === 'completed') {
                fetchLocalAssemblies()
                setStatusMsg({ text: `${fileTypeLabel(fileType)} is already present locally for ${getAssemblyAccession(item)}.`, isError: false })
                setTimeout(() => setStatusMsg(null), 4000)
                return
            }
            setMyList((prev) => prev.map((entry) =>
                entry.id === item.id
                    ? {
                        ...entry,
                        autoManaged: true,
                        localTypes: undefined,
                        requestedTypes: [
                            ...new Set([
                                ...(Array.isArray(entry.requestedTypes) ? entry.requestedTypes : []),
                                fileType,
                            ]),
                        ],
                    }
                    : entry
            ))
            setStatusMsg({ text: `Retrying ${fileTypeLabel(fileType)} download for ${getAssemblyAccession(item)}…`, isError: false })
            void refreshDownloadTasks()
            setTimeout(() => setStatusMsg(null), 4000)
        } catch (e) {
            setStatusMsg({ text: `Retry failed: ${e?.message || 'Unknown error'}`, isError: true })
            setTimeout(() => setStatusMsg(null), 5000)
        }
    }, [buildRemoteFilesUrl, config?.output_dir, fetchLocalAssemblies])

    // ---------------------------------------------------------------------------
    // Download
    // ---------------------------------------------------------------------------
    const handleDownload = async (items, fileTypes) => {
        if (items.length === 1 && isDemoGenomeItem(items[0])) {
            await handleDemoGenomeInstall()
            return
        }
        if (!config?.output_dir) {
            setStatusMsg({ text: 'Set an Output Directory in Configuration first.', isError: true })
            setTimeout(() => setStatusMsg(null), 4000)
            return
        }
	        setDownloading(true)
	        let started = 0
	        let alreadyLocal = 0
	        let alreadyQueued = 0
	        const startedItemIds = new Set()
        const startedTypesByItem = new Map()
        const shouldAutoIncludeMetadata = fileTypes.includes('fasta') || fileTypes.includes('gff3')
        const effectiveTypes = shouldAutoIncludeMetadata
            ? [...new Set([...fileTypes, 'metadata'])]
            : [...fileTypes]
	        try {
	            for (const item of items) {
	                dismissedAutoManagedItemIdsRef.current.delete(item.id)
	            }
	            for (const item of items) {
                let startedForItem = false
                const filesRes = await fetch(buildRemoteFilesUrl(item, effectiveTypes))
                if (!filesRes.ok) continue
                const files = await filesRes.json()
                const queuedFiles = files.filter(f => effectiveTypes.includes(f.type))
                for (const file of queuedFiles) {
                    const res = await fetch(`${API_BASE}/api/remote/download`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            url: file.url,
                            filename: file.filename,
                            provider: normalizeGenomeProvider(item),
                            species_key: item.species_key,
                            assembly: getAssemblyAccession(item),
                            file_type: file.type,
                            output_dir: config.output_dir,
                            scientific_name: item.scientific_name,
                            common_name: item.common_name,
                            display_name: item.display_name || '',
                            display_name_reason: item.display_name_reason || '',
                            assembly_name: item.assembly_name,
                            source_database: item.source_database,
	                            equivalent_accessions: item.equivalent_accessions || [],
	                            taxid: Number(item.taxid) || 0,
                                ...datasetReleaseDownloadMetadata(file, item),
	                        }),
                    })
                    const data = await res.json().catch(() => ({}))
                    if (!res.ok) {
                        continue
                    }
                    if (data?.status === 'started' || data?.status === 'pending' || data?.status === 'downloading') {
                        started++
                        startedForItem = true
                        if (!startedTypesByItem.has(item.id)) startedTypesByItem.set(item.id, new Set())
                        startedTypesByItem.get(item.id).add(file.type)
                    } else if (data?.status === 'already_exists' || data?.status === 'completed') {
                        alreadyLocal++
                    } else {
                        alreadyQueued++
                    }
                }
                if (startedForItem) startedItemIds.add(item.id)
            }
            if (startedItemIds.size > 0) {
                setMyList((prev) => prev.map((item) =>
                    startedItemIds.has(item.id)
                        ? {
                            ...item,
                            autoManaged: true,
                            localTypes: undefined,
                            requestedTypes: [
                                ...new Set([
                                    ...(Array.isArray(item.requestedTypes) ? item.requestedTypes : []),
                                    ...Array.from(startedTypesByItem.get(item.id) || []),
                                ]),
                            ],
                        }
                        : item
                ))
            }
            if (alreadyLocal > 0) {
                fetchLocalAssemblies()
            }
            const statusParts = []
            if (started > 0) statusParts.push(`Started ${started} file download${started !== 1 ? 's' : ''}`)
            if (alreadyQueued > 0) statusParts.push(`${alreadyQueued} already queued`)
            if (alreadyLocal > 0) statusParts.push(`${alreadyLocal} already present locally`)
            setStatusMsg({
                text: `${statusParts.length > 0 ? statusParts.join(' • ') : 'No new downloads were needed'}.`,
                isError: false,
            })
        } catch (e) {
            setStatusMsg({ text: `Error: ${e.message}`, isError: true })
        } finally {
            setDownloading(false)
            void refreshDownloadTasks()
            setTimeout(() => setStatusMsg(null), 5000)
        }
    }

    // ---------------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------------
    const latestCatalogChange = catalogStatus?.latest_change || null
    const latestCatalogChangeMessage = buildCatalogChangeMessage(latestCatalogChange)
    const showCatalogChangeBanner = Boolean(
        latestCatalogChange
        && latestCatalogChange.seen === false
        && latestCatalogChangeMessage
    )
    const catalogWarnings = Array.isArray(catalogStatus?.catalog_warnings)
        ? catalogStatus.catalog_warnings.filter((warning) => String(warning || '').trim())
        : []
    const catalogWarningMessage = catalogWarnings.length > 1
        ? `${catalogWarnings[0]} (${catalogWarnings.length - 1} more)`
        : (catalogWarnings[0] || '')
    // On first run the catalogue is downloaded in the background, so an empty species list
    // means "still arriving" rather than "nothing to show". Say which.
    const fetchingInitialCatalog = Boolean(catalogStatus?.initial_fetch_in_progress)
    const catalogUnavailable = catalogStatus?.catalog_available === false && !fetchingInitialCatalog
    const catalogLoadError = String(catalogStatus?.last_error || '').trim()
    const bg = isLight ? 'bg-gray-50' : 'bg-gray-900'
    const panelClass = `rounded-xl border overflow-hidden ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`
    const thClass = `px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide border-b ${isLight ? 'text-gray-500 bg-gray-50 border-gray-200' : 'text-gray-400 bg-gray-750 border-gray-700'}`
    const borderClass = isLight ? 'border-gray-200' : 'border-gray-700'
    const canCaptureRasterScreenshot = typeof window !== 'undefined' &&
        typeof window.electronAPI?.captureHtmlSnapshot === 'function'
    const screenshotTarget = useMemo(() => {
        const node = screenshotRootNode
        if (!node) return null
        const allowedFormats = canCaptureRasterScreenshot ? ['svg', 'png', 'jpeg'] : ['svg']
        return {
            id: 'download-view',
            label: 'Download view',
            allowedFormats,
            defaultFormat: canCaptureRasterScreenshot ? 'png' : 'svg',
            getVisibleRect: () => node.getBoundingClientRect(),
            getScrollElement: () => node,
            buildDefaultFilename: () => buildDefaultScreenshotName('ens_download_page'),
            buildExportSnapshot: async () => {
                const { width, height } = measureScreenshotNode(node)
                return buildDomNodeScreenshotSnapshot(node, {
                    width,
                    height,
                    backgroundColor: isLight ? '#f9fafb' : '#111827',
                })
            },
        }
    }, [canCaptureRasterScreenshot, isLight, screenshotRootNode])

    const defaultScreenshotDir = useMemo(() => {
        const base = String(config?.output_dir || '').trim().replace(/\/+$/, '')
        return base ? `${base}/screenshots` : ''
    }, [config?.output_dir])

    useEffect(() => {
        onScreenshotAvailabilityChange?.('download', Boolean(screenshotTarget))
        return () => onScreenshotAvailabilityChange?.('download', false)
    }, [onScreenshotAvailabilityChange, screenshotTarget])

    useEffect(() => {
        if (screenshotTarget || !screenshotMode) return
        onScreenshotModeChange?.(false)
        setSelectedScreenshotTarget(null)
    }, [onScreenshotModeChange, screenshotMode, screenshotTarget])

    const handleScreenshotSave = useCallback(async ({ filename, directory, format, scale, quality, target }) => {
        if (!target?.buildExportSnapshot) {
            return { ok: false, error: 'Screenshot target is no longer available.' }
        }

        try {
            const snapshot = await target.buildExportSnapshot()
            if (!snapshot?.svgMarkup) {
                return { ok: false, error: 'Failed to build screenshot export.' }
            }

            let payload
            if (format === 'svg') {
                payload = {
                    directory,
                    filename,
                    format,
                    mime_type: 'image/svg+xml',
                    encoding: 'utf8',
                    data: snapshot.svgMarkup,
                }
            } else {
                const electronBridge = typeof window !== 'undefined' ? window.electronAPI : null
                if (!snapshot.htmlMarkup || typeof electronBridge?.captureHtmlSnapshot !== 'function') {
                    return { ok: false, error: 'PNG/JPEG export for this view requires the Electron screenshot renderer. Export as SVG instead.' }
                }
                const raster = await electronBridge.captureHtmlSnapshot({
                    htmlMarkup: snapshot.bodyMarkup || snapshot.htmlMarkup,
                    width: snapshot.width,
                    height: snapshot.height,
                    format,
                    scale,
                    quality,
                    backgroundColor: snapshot.backgroundColor || (isLight ? '#f9fafb' : '#111827'),
                })
                payload = {
                    directory,
                    filename,
                    format,
                    mime_type: raster.mimeType,
                    encoding: 'base64',
                    data: raster.base64,
                }
            }

            const response = await fetch(`${API_BASE}/api/exports/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            const data = await response.json().catch(() => ({}))
            if (!response.ok || !data?.ok) {
                return { ok: false, error: data?.detail || 'Failed to save screenshot.' }
            }
            return { ok: true, path: data.path, filename: data.filename }
        } catch (error) {
            return { ok: false, error: error?.message || 'Failed to export screenshot.' }
        }
    }, [isLight])

    return (
        <>
        <div ref={setScreenshotRoot} className={`relative h-full flex flex-col ${bg} overflow-hidden`} data-screenshot-capture="view">
            {/* Header bar */}
            <div className={`px-6 py-3 border-b shrink-0 flex items-center gap-4 ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                <div>
                    <h2 className={`font-semibold ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                        {activeProvider === 'ncbi' ? 'RefSeq Genomes — Data Browser' : 'Ensembl Data Browser'}
                    </h2>
                        <p className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {activeProvider === 'ncbi'
                                ? 'Browse RefSeq annotated assemblies by taxonomic group, or search by name or accession'
                                : 'Browse and download genomes, gene annotations, and homologies from the Ensembl FTP'}
                        </p>
                    </div>
                <div className="ml-auto flex items-center gap-3">
                    <button
                        type="button"
                        onClick={handleRefreshCatalog}
                        disabled={refreshingCatalog || catalogStatus?.refresh_in_progress}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${refreshingCatalog || catalogStatus?.refresh_in_progress
                            ? (isLight ? 'bg-gray-100 text-gray-400' : 'bg-gray-700 text-gray-500')
                            : (isLight ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-blue-500 text-white hover:bg-blue-400')
                            }`}
                    >
                        {refreshingCatalog || catalogStatus?.refresh_in_progress ? 'Checking…' : 'Update'}
                    </button>
                    <div className={`flex items-center gap-1 rounded-xl border px-1 py-1 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/40'}`}>
                        {[
                            { id: 'ensembl', label: 'Ensembl' },
                            { id: 'ncbi', label: 'RefSeq' },
                        ].map((option) => {
                            const active = activeProvider === option.id
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    onClick={() => {
                                        setActiveProvider(option.id)
                                        setExpandedKey(null)
                                        setStatusMsg(null)
                                    }}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${active
                                        ? (isLight ? 'bg-blue-600 text-white' : 'bg-blue-500 text-white')
                                        : (isLight ? 'text-gray-600 hover:bg-white' : 'text-gray-300 hover:bg-gray-800')
                                        }`}
                                >
                                    {option.label}
                                </button>
                            )
                        })}
                    </div>
                </div>
                {!config?.output_dir && (
                    <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border ${isLight ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-amber-900/20 border-amber-700/50 text-amber-400'}`}>
                        ⚠ Set an Output Directory in Configuration before downloading
                    </div>
                )}
            </div>

            {/* Body: sidebar + main */}
            <div className="flex-1 min-h-0 flex overflow-hidden">

                {/* Left sidebar — group browser */}
                <div className={`w-52 shrink-0 border-r overflow-y-auto p-3 ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                    {activeProvider === 'ensembl' ? (
                        <>
                            <div className={`text-xs font-bold uppercase tracking-widest mb-2 px-1 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Browse by group
                            </div>
                            {loading
                                ? <div className="px-1 text-sm opacity-40">Loading…</div>
                                : <GroupBrowser
                                    groups={sidebarGroups}
                                    totalAssemblies={totalAssemblies}
                                    activeGroup={activeGroup}
                                    activeSubGroup={activeSubGroup}
                                    onSelectGroup={g => { setActiveGroup(g); setExpandedKey(null) }}
                                    onSelectSubGroup={sg => { setActiveSubGroup(sg); setExpandedKey(null) }}
                                    isLight={isLight}
                                />
                            }
                        </>
                    ) : (
                        <>
                            <div className={`text-xs font-bold uppercase tracking-widest mb-2 px-1 ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                                Browse by group
                            </div>
                            <RefSeqGroupBrowser
                                groups={refSeqGroups}
                                activeGroup={activeRefSeqGroup}
                                activeSubGroup={activeRefSeqSubGroup}
                                onSelectGroup={g => {
                                    setActiveRefSeqGroup(g)
                                    setActiveRefSeqSubGroup(null)
                                    setNcbiCurrentPageToken(null)
                                    setNcbiNextPageToken(null)
                                    setNcbiPageTokenHistory([])
                                    setExpandedKey(null)
                                }}
                                onSelectSubGroup={sg => {
                                    setActiveRefSeqSubGroup(sg)
                                    setNcbiCurrentPageToken(null)
                                    setNcbiNextPageToken(null)
                                    setNcbiPageTokenHistory([])
                                    setExpandedKey(null)
                                }}
                                isLight={isLight}
                                loading={refSeqGroupsLoading}
                            />
                        </>
                    )}
                </div>

                {/* Right: search + my list + species table */}
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

                    {/* Search bar */}
                    <div className={`px-4 py-3 border-b shrink-0 flex items-center gap-3 ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'}`}>
                        <div className={`flex items-center gap-2 flex-1 px-3 py-1.5 rounded-lg border ${isLight ? 'bg-gray-50 border-gray-300' : 'bg-gray-700 border-gray-600'}`}>
                            <span className="opacity-40"><IconSearch /></span>
                            <input
                                data-tour-id="download-search"
                                type="text"
                                placeholder={activeProvider === 'ncbi'
                                    ? 'Search NCBI species, assembly, or accession…'
                                    : 'Search species name, common name, or assembly accession…'}
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className={`flex-1 bg-transparent outline-none text-sm ${isLight ? 'text-gray-900 placeholder-gray-400' : 'text-gray-100 placeholder-gray-500'}`}
                            />
                            {search && <button onClick={() => setSearch('')} className="opacity-40 hover:opacity-70 text-xs">✕</button>}
                        </div>
                        <span className={`text-xs whitespace-nowrap ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {activeProvider === 'ncbi' && ncbiLoading
                                ? 'Loading…'
                                : activeProvider === 'ncbi' && !search.trim() && activeRefSeqGroup === 'All genomes' && ncbiTotalCount != null
                                    ? `${ncbiTotalCount.toLocaleString()} genomes`
                                : activeProvider === 'ensembl' && activeGroup === 'Local genomes'
                                    ? `${filteredLocalAssemblies.length.toLocaleString()} local genomes`
                                : `${filteredSpecies.length.toLocaleString()} ${activeProvider === 'ncbi' ? 'results' : 'species'}`}
                        </span>
                    </div>

                    {activeProvider === 'ensembl' && fetchingInitialCatalog && (
                        <div className={`mx-4 mt-4 rounded-xl border px-4 py-3 flex items-start gap-3 ${isLight ? 'bg-blue-50 border-blue-200 text-blue-900' : 'bg-blue-900/20 border-blue-700/50 text-blue-100'}`}>
                            <svg
                                className="w-4 h-4 mt-0.5 shrink-0 animate-spin"
                                viewBox="0 0 24 24"
                                fill="none"
                                aria-hidden="true"
                            >
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                            </svg>
                            <div className="min-w-0">
                                <div className="text-sm font-semibold">Fetching species catalogue…</div>
                                <div className={`text-xs mt-1 ${isLight ? 'text-blue-800/80' : 'text-blue-100/80'}`}>
                                    Downloading the list of available species from Ensembl. This happens once,
                                    on first run, and the list below fills in automatically when it finishes.
                                </div>
                            </div>
                        </div>
                    )}

                    {activeProvider === 'ensembl' && catalogUnavailable && (
                        <div className={`mx-4 mt-4 rounded-xl border px-4 py-3 flex items-start justify-between gap-4 ${isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-900/20 border-amber-700/50 text-amber-100'}`}>
                            <div className="min-w-0">
                                <div className="text-sm font-semibold">No species catalogue available</div>
                                <div className={`text-xs mt-1 ${isLight ? 'text-amber-800/80' : 'text-amber-100/80'}`}>
                                    {catalogLoadError
                                        ? `The species list could not be downloaded from Ensembl: ${catalogLoadError}`
                                        : 'The species list could not be downloaded from Ensembl. Check your internet connection and try again.'}
                                    {' '}Local genomes are still available.
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={handleRefreshCatalog}
                                disabled={refreshingCatalog}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap ${isLight ? 'border-amber-300 hover:bg-amber-100' : 'border-amber-500/40 hover:bg-amber-800/30'} ${refreshingCatalog ? 'opacity-50' : ''}`}
                            >
                                {refreshingCatalog ? 'Retrying…' : 'Retry'}
                            </button>
                        </div>
                    )}

                    {activeProvider === 'ensembl' && showCatalogChangeBanner && (
                        <div className={`mx-4 mt-4 rounded-xl border px-4 py-3 flex items-start justify-between gap-4 ${isLight ? 'bg-blue-50 border-blue-200 text-blue-900' : 'bg-blue-900/20 border-blue-700/50 text-blue-100'}`}>
                            <div className="min-w-0">
                                <div className="text-sm font-semibold">
                                    Catalogue updates found
                                </div>
                                <div className={`text-xs mt-1 ${isLight ? 'text-blue-800/80' : 'text-blue-100/80'}`}>
                                    {latestCatalogChangeMessage}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={handleAcknowledgeCatalogChange}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border whitespace-nowrap ${isLight ? 'border-blue-200 hover:bg-blue-100' : 'border-blue-500/40 hover:bg-blue-800/30'}`}
                            >
                                Dismiss
                            </button>
                        </div>
                    )}

                    {activeProvider === 'ensembl' && catalogWarningMessage && (
                        <div className={`mx-4 mt-4 rounded-xl border px-4 py-3 ${isLight ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-amber-900/20 border-amber-700/50 text-amber-100'}`}>
                            <div className="text-sm font-semibold">Catalogue warning</div>
                            <div className={`text-xs mt-1 ${isLight ? 'text-amber-800/80' : 'text-amber-100/80'}`}>
                                {catalogWarningMessage}
                            </div>
                        </div>
                    )}

                    {/* Content: local progress + species table */}
                    <div ref={speciesListScrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                        {statusMsg && (
                            <div className={`rounded-lg border px-3 py-2 text-sm ${statusMsg.isError
                                ? (isLight ? 'bg-red-50 border-red-200 text-red-800' : 'bg-red-900/20 border-red-700/50 text-red-100')
                                : statusMsg.isWarning
                                    ? (isLight ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-amber-900/20 border-amber-700/50 text-amber-100')
                                    : (isLight ? 'bg-green-50 border-green-200 text-green-800' : 'bg-green-900/20 border-green-700/50 text-green-100')
                                }`}>
                                {statusMsg.text}
                            </div>
                        )}

                        <ActiveDownloadsPanel theme={theme} />

                        {activeProvider === 'ensembl' && activeGroup === 'Local genomes' ? (
                            <>
                                <DownloadTypeToolbar
                                    activeProvider={activeProvider}
                                    selectedTypes={activeDownloadTypes}
                                    onToggleType={(type) => {
                                        setActiveDownloadTypes((prev) => {
                                            const next = new Set(prev)
                                            next.has(type) ? next.delete(type) : next.add(type)
                                            return next
                                        })
                                    }}
                                    isLight={isLight}
                                />
                                <LocalGenomesList
                                    items={filteredLocalAssemblies}
                                    activeItems={filteredActiveLocalItems}
                                    selectedTypes={activeDownloadTypes}
                                    tasksByItemKey={tasksByItemKey}
                                    onDownload={handleRowDownload}
                                    onDownloadFiles={handleDownloadFiles}
                                    onCancelFiles={handleCancelDownloadFiles}
                                    onDeleteFile={handleDeleteLocalFile}
                                    onDeleteLocalGenome={handleDeleteLocalGenome}
                                    onDeleteAllLocalGenomes={handleDeleteAllLocalGenomes}
                                    deletingLocalGenomes={deletingLocalGenomes}
                                    downloading={downloading}
                                    isLight={isLight}
                                />
                            </>
                        ) : (
                        <div className={`${panelClass} flex flex-col`}>
                            {/* Collapsible header */}
                            <PanelHeader
                                title="Species Browser"
                                count={activeProvider === 'ncbi' && ncbiTotalCount != null ? ncbiTotalCount : filteredSpecies.length}
                                countLabel={activeProvider === 'ncbi' && ncbiTotalCount != null
                                    ? `${filteredSpecies.length.toLocaleString()} shown / ${ncbiTotalCount.toLocaleString()} total`
                                    : filteredSpecies.length.toLocaleString()}
                                collapsed={speciesCollapsed}
                                onToggle={() => setSpeciesCollapsed(p => !p)}
                                isLight={isLight}
                            />

                            {!speciesCollapsed && (
                                <>
                                    <DownloadTypeToolbar
                                        activeProvider={activeProvider}
                                        selectedTypes={activeDownloadTypes}
                                        onToggleType={(type) => {
                                            setActiveDownloadTypes((prev) => {
                                                const next = new Set(prev)
                                                next.has(type) ? next.delete(type) : next.add(type)
                                                return next
                                            })
                                        }}
                                        isLight={isLight}
                                    />

                                    {/* Column headers */}
                                    <div className={`grid shrink-0 border-b ${borderClass}`}
                                        style={{ gridTemplateColumns: 'minmax(0, 2fr) 155px minmax(0, 1fr) 140px 92px' }}>
                                        <div className={thClass}>Species</div>
                                        <div className={thClass}>Accession</div>
                                        <div className={thClass}>Assembly Name</div>
                                        <div className={thClass}>Source</div>
                                        <div className={thClass}></div>
                                    </div>

                                    {/* Scrollable rows */}
                                    {activeProvider === 'ensembl' && loading ? (
                                        <div className="h-40 flex items-center justify-center gap-2 opacity-40 text-sm">
                                            <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
                                            Loading Ensembl genomes…
                                        </div>
                                    ) : activeProvider === 'ncbi' && ncbiLoading ? (
                                        <div className="h-40 flex items-center justify-center gap-2 opacity-40 text-sm">
                                            <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
                                            Loading RefSeq genomes…
                                        </div>
                                    ) : pageSpecies.length === 0 ? (
                                        <div className="h-40 flex items-center justify-center opacity-40 text-sm">No genomes found</div>
                                    ) : (
                                        <div data-tour-id="download-species-list">
                                            {pageSpecies.map(species => (
                                                <SpeciesRow
                                                    key={species.key}
                                                    species={species}
                                                    expanded={expandedKey === species.key}
                                                    onToggleExpand={key => setExpandedKey(prev => prev === key ? null : key)}
                                                    onDownload={handleRowDownload}
                                                    onDownloadAll={handleDownloadAllAssemblies}
                                                    onDownloadFiles={handleDownloadFiles}
                                                    onCancelFiles={handleCancelDownloadFiles}
                                                    onDeleteFile={handleDeleteLocalFile}
                                                    selectedTypes={activeDownloadTypes}
                                                    localTypeByKey={localTypeByKey}
                                                    localFileInfoByKey={localFileInfoByKey}
                                                    tasksByItemKey={tasksByItemKey}
                                                    downloading={downloading}
                                                    demoProgress={demoProgress}
                                                    isLight={isLight}
                                                />
                                            ))}
                                        </div>
                                    )}

                                    {activeProvider === 'ncbi' && !search.trim() && (ncbiPageTokenHistory.length > 0 || ncbiNextPageToken) && (
                                        <div className={`px-4 py-3 border-t shrink-0 flex items-center justify-between ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-750 border-gray-700'}`}>
                                            <button
                                                onClick={() => {
                                                    const history = [...ncbiPageTokenHistory]
                                                    const prevToken = history.pop() ?? null
                                                    setNcbiPageTokenHistory(history)
                                                    fetchNcbiSearchResults(prevToken)
                                                }}
                                                disabled={ncbiPageTokenHistory.length === 0}
                                                className={`px-3 py-1 text-xs rounded border transition-colors ${ncbiPageTokenHistory.length === 0
                                                    ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                                    : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                            >
                                                ← Previous
                                            </button>
                                            <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                Page {ncbiPageTokenHistory.length + 1}
                                                {ncbiTotalCount != null && (
                                                    <span className="ml-2 opacity-60">
                                                        ({ncbiSpecies.length.toLocaleString()} shown of {ncbiTotalCount.toLocaleString()})
                                                    </span>
                                                )}
                                            </span>
                                            <button
                                                onClick={() => {
                                                    if (!ncbiNextPageToken) return
                                                    setNcbiPageTokenHistory(prev => [...prev, ncbiCurrentPageToken ?? null])
                                                    fetchNcbiSearchResults(ncbiNextPageToken)
                                                }}
                                                disabled={!ncbiNextPageToken}
                                                className={`px-3 py-1 text-xs rounded border transition-colors ${!ncbiNextPageToken
                                                    ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                                    : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                            >
                                                Next →
                                            </button>
                                        </div>
                                    )}

                                    {totalPages > 1 && (
                                        <div className={`px-4 py-3 border-t shrink-0 flex items-center justify-between ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-750 border-gray-700'}`}>
                                            <button
                                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                                disabled={page === 1}
                                                className={`px-3 py-1 text-xs rounded border transition-colors ${page === 1
                                                    ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                                    : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                            >
                                                ← Previous
                                            </button>
                                            <span className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                                Page {page} of {totalPages}
                                                <span className="ml-2 opacity-60">
                                                    ({((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, filteredSpecies.length)} of {filteredSpecies.length.toLocaleString()})
                                                </span>
                                            </span>
                                            <button
                                                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                                disabled={page === totalPages}
                                                className={`px-3 py-1 text-xs rounded border transition-colors ${page === totalPages
                                                    ? (isLight ? 'text-gray-300 border-gray-200' : 'text-gray-600 border-gray-700')
                                                    : (isLight ? 'text-gray-700 border-gray-300 hover:bg-gray-100' : 'text-gray-300 border-gray-600 hover:bg-gray-700')}`}
                                            >
                                                Next →
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                        )}
                    </div>
                </div>
            </div>
            <ScreenshotSelectionOverlay
                active={screenshotMode && Boolean(screenshotTarget)}
                theme={theme}
                containerRef={screenshotRootRef}
                scrollContainerRef={screenshotRootRef}
                exemptRefs={[screenshotToggleButtonRef]}
                targets={screenshotTarget ? [screenshotTarget] : []}
                instructions="Click on the highlighted area to export"
                highlightSingleTarget={true}
                selectSingleTargetOnClick={true}
                onSelect={(target) => {
                    setSelectedScreenshotTarget(target)
                    onScreenshotModeChange?.(false)
                }}
                onCancel={() => {
                    onScreenshotModeChange?.(false)
                    setSelectedScreenshotTarget(null)
                }}
            />
        </div>
        <ScreenshotExportModal
            open={Boolean(selectedScreenshotTarget)}
            theme={theme}
            target={selectedScreenshotTarget}
            outputDir={defaultScreenshotDir}
            onSave={handleScreenshotSave}
            onClose={() => setSelectedScreenshotTarget(null)}
        />
        </>
    )
}
