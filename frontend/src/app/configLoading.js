// Loading the app configuration at startup (and again when the backend comes
// back): config, output directory, playlists and sidecar warnings.
import { normalizeActiveAppButtons } from '../appButtonConfig.js'
import { API_BASE } from '../backendRuntime.js'
import { migrateLegacyGenomeColors, normalizeCustomGenomeColors, normalizeGenomeColorAssignments, normalizeGenomeDefaultColor } from '../genomeColorSchemes.js'
import { peekRestoredSessionState } from '../sessionResume.js'
import { isTutorialSandboxActive, withoutTutorialSandboxFields } from '../tutorials/sandbox.js'
import { normalizeBrowsingControlSchemeId } from '../utils/browsingControls.js'
import { PREVIOUS_SESSION_PLAYLIST_ID } from './appLayout.js'
import { dedupeSpeciesList, speciesItemKey } from './genomeLists.js'
import {
    buildPreviousSessionGenomes,
    findNextPreviousSessionPlaylist,
    findPreviousSessionPlaylist,
    removeEmptyPreviousSessionPlaylist,
    upsertPreviousSessionPlaylist,
} from './previousSessionPlaylist.js'

export async function loadAppConfig(ctx) {
    const {
        nextPreviousSessionSignatureRef,
        persistedActiveButtonsRef,
        persistedGenomeColorsRef,
        savedConfigRef,
        setConfig,
        setConfigLoaded,
        setDualViewFocus,
        setInactiveSelectedSpecies,
    } = ctx
    // While a tutorial runs, `config` is the sandbox overlay — so re-reading here would
    // look up the sidecar for the tutorial's scratch directory and write its empty genome
    // list over the user's real one in state. The user's configuration cannot have changed
    // underneath us anyway, since the tutorial is forbidden from writing it.
    if (isTutorialSandboxActive()) return null
    try {
      const res = await fetch(`${API_BASE}/api/config`)
      if (res.ok) {
        // Both stores are swept of any tutorial scratch configuration before they are
        // read. Writing it is shut off at source, but a configuration saved before that
        // was true still carries the tutorial's own genomes and its scratch output
        // directory, and nothing else would ever take them out again.
        const data = withoutTutorialSandboxFields(await res.json())
        // Recover any fields the backend may have lost (e.g. output_dir wiped by a crashed write)
        // by merging in values from the Electron-side durable config store.
        const electronConfig = withoutTutorialSandboxFields(window.electronAPI?.getElectronConfig?.() || {})
        let recovered = {
          ...electronConfig,
          ...data,
          output_dir: data.output_dir || electronConfig.output_dir || '',
          working_dir: data.working_dir || electronConfig.working_dir || '',
        }
        if (recovered.output_dir || recovered.working_dir) {
          try {
            const configParams = new URLSearchParams()
            if (recovered.output_dir) configParams.set('output_dir', recovered.output_dir)
            if (recovered.working_dir) configParams.set('working_dir', recovered.working_dir)
            const outputConfigRes = await fetch(`${API_BASE}/api/config/output-dir?${configParams.toString()}`)
            if (outputConfigRes.ok) {
              const outputPayload = await outputConfigRes.json()
              const outputConfig = withoutTutorialSandboxFields(outputPayload?.config)
              if (outputPayload?.found && outputConfig) {
                recovered = {
                  ...recovered,
                  ...outputConfig,
                  output_dir: recovered.output_dir || outputConfig.output_dir || '',
                  working_dir: recovered.working_dir || outputConfig.working_dir || '',
                }
              }
            }
          } catch (error) {
            console.error('Failed to load configuration from output directory:', error)
          }
          try {
            const playlistParams = new URLSearchParams()
            if (recovered.output_dir) playlistParams.set('output_dir', recovered.output_dir)
            if (recovered.working_dir) playlistParams.set('working_dir', recovered.working_dir)
            const playlistRes = await fetch(`${API_BASE}/api/config/playlists?${playlistParams.toString()}`)
            if (playlistRes.ok) {
              const playlistState = await playlistRes.json()
              if ((playlistState.genome_playlists || []).length > 0) {
                recovered = {
                  ...recovered,
                  genome_playlists: playlistState.genome_playlists,
                  selected_genome_playlist_id: playlistState.selected_genome_playlist_id || recovered.selected_genome_playlist_id || '__all__',
                }
              }
            }
          } catch (error) {
            console.error('Failed to load genome playlists from output directory:', error)
          }
        }
        // If the backend was missing output_dir, resync it now so the backend is up to date.
        if (!data.output_dir && recovered.output_dir) {
          fetch(`${API_BASE}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(recovered),
          }).catch(() => {})
        }
        const previousPlaylist = findPreviousSessionPlaylist(recovered.genome_playlists)
        const nextPreviousPlaylist = findNextPreviousSessionPlaylist(recovered.genome_playlists)
        const nextPreviousPlaylistGenomes = buildPreviousSessionGenomes(nextPreviousPlaylist?.genomes || [])
        const fieldNextPreviousSessionGenomes = buildPreviousSessionGenomes(recovered.next_previous_session_genomes || [])
        const hasNextPreviousSessionSnapshot = Boolean(nextPreviousPlaylist) || fieldNextPreviousSessionGenomes.length > 0
        const promotedPreviousSessionGenomes = buildPreviousSessionGenomes(
          nextPreviousPlaylist
            ? nextPreviousPlaylistGenomes
            : (hasNextPreviousSessionSnapshot ? fieldNextPreviousSessionGenomes : (previousPlaylist?.genomes || []))
        )
        const hasPreviousPlaylist = promotedPreviousSessionGenomes.length > 0
        const shouldPromotePreviousSessionPlaylist = hasNextPreviousSessionSnapshot || Boolean(previousPlaylist)
        const recoveredWithPreviousPlaylist = shouldPromotePreviousSessionPlaylist
          ? (
              hasPreviousPlaylist
                ? upsertPreviousSessionPlaylist(recovered, promotedPreviousSessionGenomes)
                : removeEmptyPreviousSessionPlaylist(recovered)
            )
          : recovered
        const startupActiveSpecies = hasPreviousPlaylist
          ? promotedPreviousSessionGenomes
          : dedupeSpeciesList(recovered.active_species || [])
        const hasActiveSpecies = startupActiveSpecies.length > 0
        const startupSelectedPlaylistId = hasPreviousPlaylist
          ? PREVIOUS_SESSION_PLAYLIST_ID
          : (recovered.selected_genome_playlist_id === PREVIOUS_SESSION_PLAYLIST_ID ? '__all__' : (recovered.selected_genome_playlist_id || '__all__'))
        const startupConfig = {
          ...recoveredWithPreviousPlaylist,
          selected_genome_playlist_id: startupSelectedPlaylistId,
          active_species: startupActiveSpecies,
          next_previous_session_genomes: buildPreviousSessionGenomes(startupActiveSpecies),
          active_app_buttons: normalizeActiveAppButtons(recovered.active_app_buttons),
          // First launch under per-genome colours carries the old positional list
          // over: its first entry was the primary genome's colour, which is what
          // the default now is, and the rest join the palette.
          ...migrateLegacyGenomeColors(recovered),
          // `recovered` includes the hand-editable Electron store, so a stale or
          // invalid scheme id has to be coerced before it reaches the browser.
          browsing_control_scheme: normalizeBrowsingControlSchemeId(recovered.browsing_control_scheme),
          target_fasta: '',
          target_gff: '',
          target_index: '',
          ...(hasActiveSpecies ? {} : { ref_fasta: '', ref_gff: '', ref_index: '', homologies_file: '' })
        }
        // Resuming after a reload rather than launching: the saved configuration already
        // has the right genomes, but not the order the reader had them in, the playlist
        // they had open, the genomes they had selected without activating, or which of
        // the active ones each view was showing. Those come from the session snapshot.
        // Peeked, not taken: StrictMode runs this load twice in development, and both
        // runs must resume the same way. It stops applying once the restore window
        // closes, or an explicit save below asks for the configuration as saved.
        const resumedGenomes = peekRestoredSessionState('app.genomes')
        let resumedInactive = []
        let resumedFocus = null
        if (resumedGenomes && typeof resumedGenomes === 'object') {
          const activeByKey = new Map(dedupeSpeciesList(startupConfig.active_species).map((species) => [speciesItemKey(species), species]))
          const orderedKeys = Array.isArray(resumedGenomes.activeKeys) ? resumedGenomes.activeKeys.filter((key) => activeByKey.has(key)) : []
          if (orderedKeys.length) {
            const ordered = orderedKeys.map((key) => activeByKey.get(key))
            for (const [key, species] of activeByKey) {
              if (!orderedKeys.includes(key)) ordered.push(species)
            }
            startupConfig.active_species = ordered
            startupConfig.next_previous_session_genomes = buildPreviousSessionGenomes(ordered)
          }
          const playlistId = String(resumedGenomes.selectedPlaylistId || '')
          if (playlistId && (playlistId === '__all__' || (startupConfig.genome_playlists || []).some((playlist) => playlist?.id === playlistId))) {
            startupConfig.selected_genome_playlist_id = playlistId
          }
          if (Array.isArray(resumedGenomes.inactiveSelected)) {
            resumedInactive = dedupeSpeciesList(resumedGenomes.inactiveSelected.filter((species) => (
              species && typeof species === 'object' && !activeByKey.has(speciesItemKey(species))
            )))
          }
          const focus = resumedGenomes.viewFocus
          if (focus && activeByKey.has(focus.primaryKey)) {
            resumedFocus = {
              primaryKey: focus.primaryKey,
              secondaryKey: activeByKey.has(focus.secondaryKey) ? focus.secondaryKey : '',
            }
          }
        }
        const startupActive = dedupeSpeciesList(startupConfig.active_species)
        const startupPrimary = startupActive[0] || null
        const startupSecondary = startupActive[1] || null
        setConfig(startupConfig)
        setInactiveSelectedSpecies(resumedInactive)
        setDualViewFocus(resumedFocus || {
          primaryKey: startupPrimary ? speciesItemKey(startupPrimary) : '',
          secondaryKey: startupSecondary ? speciesItemKey(startupSecondary) : '',
        })
        savedConfigRef.current = { ...startupConfig }
        nextPreviousSessionSignatureRef.current = JSON.stringify(startupConfig.next_previous_session_genomes || [])
        persistedActiveButtonsRef.current = JSON.stringify(normalizeActiveAppButtons(startupConfig.active_app_buttons))
        // A configuration that already knows its colours is in sync with the
        // disk and needs no write. One that has just been migrated off the old
        // positional list is not: leaving the marker empty makes the persist
        // effect save the migration, so it happens once rather than being
        // recomputed — and undone — on every launch.
        persistedGenomeColorsRef.current = recovered.genome_default_color
          ? JSON.stringify({
            genome_default_color: normalizeGenomeDefaultColor(startupConfig.genome_default_color),
            genome_colors: normalizeGenomeColorAssignments(startupConfig.genome_colors),
            genome_color_palette: normalizeCustomGenomeColors(startupConfig.genome_color_palette),
          })
          : ''
        setConfigLoaded(true)
        if (shouldPromotePreviousSessionPlaylist) {
          window.electronAPI?.saveElectronConfig?.(startupConfig)
          fetch(`${API_BASE}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(startupConfig),
          }).catch(() => {})
        }
        return startupConfig
      }
    } catch (e) {
      console.error('Failed to fetch config:', e)
    }
    return null
  }

export function applyAppConfigCascade(ctx) {
    const {
        config,
        savedConfigRef,
        setAlignment,
        setAlignmentViewError,
        setBrowserRefGene,
        setBrowserRefViewport,
        setBrowserTgtGene,
        setConfig,
        setLastSuccessfulMultiAlignmentSignature,
        setLoadedParams,
        setMultiAlignmentResult,
        setNeighbourhoodData,
        setRecentItems,
        setRefBrowserReloadKey,
        setRefInput,
        setRefResolved,
        setTgtBrowserReloadKey,
        setTgtInput,
        setTgtResolved,
    } = ctx
    const prev = savedConfigRef.current
    const curr = config

    if (!prev) return curr

    const refChanged = curr.ref_fasta !== prev.ref_fasta || curr.ref_gff !== prev.ref_gff
    const tgtChanged = curr.target_fasta !== prev.target_fasta || curr.target_gff !== prev.target_gff

    // Cascade: clear dependent fields that weren't explicitly updated.
    // If GFF changed but index didn't change → stale index, clear it.
    // If GFF changed AND index also changed → new index was set alongside new GFF, keep it.
    let cascaded = { ...curr }
    if (curr.ref_gff !== prev.ref_gff && curr.ref_index === prev.ref_index) cascaded.ref_index = ''
    if (curr.target_gff !== prev.target_gff && curr.target_index === prev.target_index) cascaded.target_index = ''
    if (refChanged || tgtChanged) cascaded.homologies_file = ''

    if (cascaded.ref_index !== curr.ref_index ||
      cascaded.target_index !== curr.target_index ||
      cascaded.homologies_file !== curr.homologies_file) {
      setConfig(cascaded)
    }

    // Browser track reloads
    if (refChanged) setRefBrowserReloadKey(k => k + 1)
    if (tgtChanged) setTgtBrowserReloadKey(k => k + 1)

    // Selective alignment/neighbourhood reset
    if (refChanged || tgtChanged) {
      setAlignment(null)
      setMultiAlignmentResult(null)
      setLastSuccessfulMultiAlignmentSignature('')
      setAlignmentViewError(null)
      setNeighbourhoodData(null)

      setLoadedParams(null)
      setRecentItems([])
      Promise.all([
        fetch(`${API_BASE}/api/recent/clear`, { method: 'POST' }),
        fetch(`${API_BASE}/api/cache/clear`, { method: 'POST' })
      ]).catch(console.error)

      if (refChanged) {
        setRefResolved(null)
        setRefInput('')
        setBrowserRefGene(null)
        setBrowserRefViewport(null)
      }
      if (tgtChanged) {
        setTgtResolved(null)
        setTgtInput('')
        setBrowserTgtGene(null)
      }
    }

    return cascaded
  }
