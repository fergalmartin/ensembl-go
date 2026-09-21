import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import { FONT_MONO } from './utils/typography'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("ErrorBoundary caught an error:", error, info);
    this.setState({ info });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', background: 'red', color: 'white', whiteSpace: 'pre-wrap', zIndex: 9999, position: 'relative' }}>
          <h2>React Crash!</h2>
          <details style={{ whiteSpace: 'pre-wrap' }}>
            {this.state.error && this.state.error.toString()}
            <br />
            {this.state.info && this.state.info.componentStack}
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

import './App.css'
import { datasetReleaseDownloadMetadata } from './utils/downloadMetadata'
import TranscriptInput from './components/TranscriptInput'
import ControlPanel from './components/ControlPanel'
import RecentHistory from './components/RecentHistory'
import FeatureLegend from './components/FeatureLegend'
import ConfigurationView from './components/ConfigurationView'
import NeighbourhoodView from './components/NeighbourhoodView'
import StructuralVariationView from './components/StructuralVariationView'
import HomologyView from './components/HomologyView'
import StatsView from './components/StatsView'
import FeatureExplorerView from './components/FeatureExplorerView'
import DownloadView from './components/DownloadView'
import GenomeSelectorView from './components/GenomeSelectorView'
import GenomeBrowserView from './components/GenomeBrowserView'
import HomeView from './components/HomeView'
import GettingStartedOutputDirPrompt from './components/GettingStartedOutputDirPrompt'
import HelpView from './components/HelpView'
import TutorialsView from './components/TutorialsView'
import TrackManagerView from './components/TrackManagerView'
import NotesView from './components/NotesView'
import MultiAlignmentSidebar from './components/MultiAlignmentSidebar'
import MultiAlignmentPanel from './components/MultiAlignmentPanel'
const AlignmentExplorerView = React.lazy(() => import('./components/alignment-explorer/AlignmentExplorerView'))
const SequenceView = React.lazy(() => import('./components/sequence-view/SequenceView'))
import SaveAlignmentModal from './components/SaveAlignmentModal'
import LoadAlignmentModal from './components/LoadAlignmentModal'
import AppButtonIcon from './components/AppButtonIcon'
import NoGenomesPillsMessage from './components/NoGenomesPillsMessage'
import { useTutorialHost } from './hooks/useTutorial'
import { resetTutorialWorkspace } from './tutorials/demoGenomeApi'
import { isTutorialSandboxActive, withoutTutorialSandboxFields } from './tutorials/sandbox'
import SelectedSpeciesPillsBar from './components/SelectedSpeciesPillsBar'
import { cycleSelection } from './utils/genomeWheel'
import WindowsBackendSetupView from './components/WindowsBackendSetupView'
import ScreenshotSelectionOverlay from './components/ScreenshotSelectionOverlay'
import ScreenshotExportModal from './components/ScreenshotExportModal'
import {
  APP_BUTTON_META,
  DEFAULT_ACTIVE_APP_BUTTONS,
  normalizeActiveAppButtons,
} from './appButtonConfig'
import {
  API_BASE,
  fetchBackendRuntimeStatus,
  getInitialBackendRuntime,
  retryBackendCheck,
  retryBackendLaunch,
  subscribeToBackendRuntime,
} from './backendRuntime'
import {
  DEFAULT_GENOME_COLOR,
  migrateLegacyGenomeColors,
  normalizeCustomGenomeColors,
  normalizeGenomeColorAssignments,
  normalizeGenomeDefaultColor,
} from './genomeColorSchemes'
import {
  DEFAULT_BROWSING_CONTROL_SCHEME_ID,
  normalizeBrowsingControlSchemeId,
} from './utils/browsingControls'
import {
  buildDefaultScreenshotName,
  buildDomNodeScreenshotSnapshot,
  measureScreenshotNode,
  rasterizeSvgMarkup,
  subtreeContainsCanvas,
} from './utils/screenshotExport'
import { getGenomeKey, genomeKeysMatch, normalizeGenomeRecord, getAssemblyAccession, getAssemblyGenomeKey, normalizeGenomeProvider, MANUAL_PROVIDER } from './utils/genomeIdentity'
import { playlistTourSlug } from './utils/playlistGenomes'
import {
  primaryGenomeForIndex,
  shouldAutoEnsurePrimaryIndex,
} from './utils/genomeIndexingPolicy'

const SELECTOR_PENDING_GENOMES_STORAGE_KEY = 'ensembl_selector_pending_genomes'
const SELECTOR_REFRESH_EVENT = 'ensembl:selector-refresh'
const PREVIOUS_SESSION_PLAYLIST_ID = '__previous_session__'
const NEXT_PREVIOUS_SESSION_PLAYLIST_ID = '__next_previous_session__'

function readPendingSelectorGenomeIds() {
  if (typeof window === 'undefined' || !window.sessionStorage) return new Set()
  try {
    const raw = window.sessionStorage.getItem(SELECTOR_PENDING_GENOMES_STORAGE_KEY)
    const parsed = JSON.parse(raw || '[]')
    return new Set(Array.isArray(parsed) ? parsed.map((entry) => String(entry || '').trim()).filter(Boolean) : [])
  } catch {
    return new Set()
  }
}

function writePendingSelectorGenomeIds(ids) {
  if (typeof window === 'undefined' || !window.sessionStorage) return
  try {
    window.sessionStorage.setItem(SELECTOR_PENDING_GENOMES_STORAGE_KEY, JSON.stringify(Array.from(ids)))
  } catch {
    // Ignore session storage failures; the selector can still refresh normally.
  }
}

function formatSpeciesForLabel(species) {
  if (!species) return ''
  if (species.display_name) return species.display_name
  if (species.common_name) return species.common_name
  const sci = species.scientific_name || ''
  if (!sci) return ''
  const parts = sci.trim().split(/\s+/)
  if (parts.length < 2) return sci
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

function buildGenomeLabel(tag, species, fallback) {
  const name = formatSpeciesForLabel(species) || fallback
  const assembly = species?.assembly_name || species?.assembly || ''
  return assembly ? `${tag} ${name} - ${assembly}` : `${tag} ${name}`
}

function buildGenomePillLabel(species) {
  if (!species) return ''
  const name = formatSpeciesForLabel(species) || species.scientific_name || ''
  const assembly = species?.assembly_name || species?.assembly || ''
  return assembly ? `${name} - ${assembly}` : name
}

function speciesItemKey(species) {
  return getGenomeKey(species)
}

function snapshotGenomeForPreviousSession(species) {
  const normalized = normalizeGenomeRecord(species)
  const key = speciesItemKey(normalized)
  if (!key) return null
  const files = normalized?.files && typeof normalized.files === 'object'
    ? {
        fasta: String(normalized.files.fasta || '').trim(),
        gff3: String(normalized.files.gff3 || '').trim(),
        index: String(normalized.files.index || '').trim(),
        homology: String(normalized.files.homology || '').trim(),
        metadata: String(normalized.files.metadata || '').trim(),
      }
    : undefined
  return {
    key,
    assembly_key: String(normalized?.assembly_key || '').trim(),
    selection_key: String(normalized?.selection_key || key).trim(),
    species_key: String(normalized?.species_key || '').trim(),
    assembly: String(normalized?.assembly || normalized?.gca || '').trim(),
    scientific_name: String(normalized?.scientific_name || '').trim(),
    common_name: String(normalized?.common_name || '').trim(),
    display_name: String(normalized?.display_name || '').trim(),
    display_name_reason: String(normalized?.display_name_reason || '').trim(),
    assembly_name: String(normalized?.assembly_name || normalized?.assembly || normalized?.gca || '').trim(),
    provider: String(normalized?.provider || '').trim(),
    source_database: String(normalized?.source_database || '').trim(),
    gca: String(normalized?.gca || '').trim(),
    dataset_release_key: String(normalized?.dataset_release_key || '').trim(),
    dataset_release_source: String(normalized?.dataset_release_source || '').trim(),
    dataset_release_date: String(normalized?.dataset_release_date || '').trim(),
    dataset_release_label: String(normalized?.dataset_release_label || '').trim(),
    dataset_release_short_label: String(normalized?.dataset_release_short_label || '').trim(),
    is_manual: Boolean(normalized?.is_manual),
    ...(files ? { files } : {}),
    active_by_default: true,
  }
}

function buildPreviousSessionGenomes(speciesList) {
  const genomes = []
  for (const species of dedupeSpeciesList(speciesList)) {
    const snapshot = snapshotGenomeForPreviousSession(species)
    if (!snapshot || genomes.some((genome) => genomeKeysMatch(genome, snapshot))) continue
    genomes.push(snapshot)
  }
  return genomes
}

function isPreviousSessionPlaylist(playlist) {
  return playlist?.id === PREVIOUS_SESSION_PLAYLIST_ID ||
    String(playlist?.name || '').trim().toLowerCase() === 'previous session'
}

function isNextPreviousSessionPlaylist(playlist) {
  return playlist?.id === NEXT_PREVIOUS_SESSION_PLAYLIST_ID
}

function findPreviousSessionPlaylist(playlists) {
  return (Array.isArray(playlists) ? playlists : []).find(isPreviousSessionPlaylist) || null
}

function findNextPreviousSessionPlaylist(playlists) {
  return (Array.isArray(playlists) ? playlists : []).find(isNextPreviousSessionPlaylist) || null
}

function upsertPreviousSessionPlaylist(configObj, speciesList, { select = false } = {}) {
  if (!configObj) return configObj
  const playlists = Array.isArray(configObj.genome_playlists) ? configObj.genome_playlists : []
  const existing = findPreviousSessionPlaylist(playlists)
  const { system, ...existingFields } = existing || {}
  const previousPlaylist = {
    ...existingFields,
    id: PREVIOUS_SESSION_PLAYLIST_ID,
    name: 'Previous session',
    description: String(existing?.description || 'Active genomes from the last app session.').trim(),
    genomes: buildPreviousSessionGenomes(speciesList),
  }
  const otherPlaylists = playlists.filter((playlist) => !isPreviousSessionPlaylist(playlist))
  return {
    ...configObj,
    genome_playlists: [previousPlaylist, ...otherPlaylists],
    ...(select ? { selected_genome_playlist_id: PREVIOUS_SESSION_PLAYLIST_ID } : {}),
  }
}

function updatePreviousSessionPlaylist(configObj, speciesList, options = {}) {
  if (!configObj) return configObj
  const previousGenomes = buildPreviousSessionGenomes(speciesList)
  if (previousGenomes.length === 0 && !findPreviousSessionPlaylist(configObj.genome_playlists)) {
    return configObj
  }
  return upsertPreviousSessionPlaylist(configObj, previousGenomes, options)
}

function withNextPreviousSessionGenomes(configObj, speciesList) {
  if (!configObj) return configObj
  const playlists = Array.isArray(configObj.genome_playlists) ? configObj.genome_playlists : []
  const nextPlaylist = {
    id: NEXT_PREVIOUS_SESSION_PLAYLIST_ID,
    name: 'Next previous session',
    description: 'Hidden tracker for the next Previous session playlist.',
    genomes: buildPreviousSessionGenomes(speciesList),
    hidden: true,
  }
  return {
    ...configObj,
    genome_playlists: [nextPlaylist, ...playlists.filter((playlist) => !isNextPreviousSessionPlaylist(playlist))],
    next_previous_session_genomes: buildPreviousSessionGenomes(speciesList),
  }
}

function removeEmptyPreviousSessionPlaylist(configObj) {
  if (!configObj) return configObj
  const playlists = Array.isArray(configObj.genome_playlists) ? configObj.genome_playlists : []
  return {
    ...configObj,
    genome_playlists: playlists.filter((playlist) => !isPreviousSessionPlaylist(playlist)),
    selected_genome_playlist_id: configObj.selected_genome_playlist_id === PREVIOUS_SESSION_PLAYLIST_ID
      ? '__all__'
      : configObj.selected_genome_playlist_id,
  }
}

function basenameFromPath(value = '') {
  const normalized = String(value || '').replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || ''
}

function dirnameFromPath(value = '') {
  const normalized = String(value || '').replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return index === 0 ? '/' : ''
  return normalized.slice(0, index)
}

function speciesListsEqualByKey(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (speciesItemKey(a[i]) !== speciesItemKey(b[i])) return false
  }
  return true
}

function sameStringArrayItems(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((item, index) => item === b[index])
}

function dedupeSpeciesList(speciesList) {
  const out = []
  const seen = new Set()
  for (const species of Array.isArray(speciesList) ? speciesList : []) {
    if (!species) continue
    const key = speciesItemKey(species)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(species)
  }
  return out
}

function prependUniqueSpecies(speciesList, species) {
  if (!species) return dedupeSpeciesList(speciesList)
  const key = speciesItemKey(species)
  const filtered = dedupeSpeciesList(speciesList).filter((item) => speciesItemKey(item) !== key)
  return [species, ...filtered]
}

function appendUniqueSpecies(speciesList, species) {
  if (!species) return dedupeSpeciesList(speciesList)
  const key = speciesItemKey(species)
  const filtered = dedupeSpeciesList(speciesList).filter((item) => speciesItemKey(item) !== key)
  return [...filtered, species]
}

function hasFiniteGeneCoords(gene) {
  return Boolean(gene) &&
    Number.isFinite(Number(gene.start)) &&
    Number.isFinite(Number(gene.end)) &&
    String(gene.chrom || '').trim().length > 0
}

function geneFocusSignature(gene) {
  if (!gene) return ''
  return [
    String(gene.id || '').trim(),
    String(gene.name || '').trim(),
    String(gene.chrom || '').trim(),
    Number.isFinite(Number(gene.start)) ? Number(gene.start) : '',
    Number.isFinite(Number(gene.end)) ? Number(gene.end) : '',
    String(gene.strand || '').trim(),
    String(gene.biotype || '').trim(),
  ].join('|')
}

function mergeGeneFocus(prevGene, nextGene) {
  if (!nextGene) return null
  if (!prevGene) return nextGene
  const prevId = String(prevGene.id || '').trim()
  const nextId = String(nextGene.id || '').trim()
  const sameId = prevId && nextId && prevId === nextId
  if (!sameId) return nextGene

  const prevHasCoords = hasFiniteGeneCoords(prevGene)
  const nextHasCoords = hasFiniteGeneCoords(nextGene)
  if (prevHasCoords && !nextHasCoords) return prevGene
  const merged = { ...prevGene, ...nextGene }
  return geneFocusSignature(prevGene) === geneFocusSignature(merged) ? prevGene : merged
}

function normalizeGeneToken(value) {
  return String(value || '').trim().toLowerCase()
}

function updateGeneFocusMapEntry(prevMap, genomeKey, nextGene, fallbackGene = null) {
  const key = String(genomeKey || '').trim()
  if (!key) return prevMap

  const currentMap = prevMap || {}
  if (!nextGene) {
    if (!Object.prototype.hasOwnProperty.call(currentMap, key)) return prevMap
    const nextMap = { ...currentMap }
    delete nextMap[key]
    return nextMap
  }

  const merged = mergeGeneFocus(currentMap[key] || fallbackGene || null, nextGene)
  if (geneFocusSignature(currentMap[key] || null) === geneFocusSignature(merged)) {
    return prevMap
  }
  return {
    ...currentMap,
    [key]: merged,
  }
}

function getAlignmentWindowForTranscript(transcript, flank5 = 0, flank3 = 0) {
  if (!transcript) return null
  const txStart = Number(transcript.start)
  const txEnd = Number(transcript.end)
  if (!Number.isFinite(txStart) || !Number.isFinite(txEnd)) return null
  const strand = String(transcript.strand || '+')
  const safeFlank5 = Math.max(0, Number(flank5) || 0)
  const safeFlank3 = Math.max(0, Number(flank3) || 0)
  const left = Math.min(txStart, txEnd)
  const right = Math.max(txStart, txEnd)
  if (strand === '-') {
    return {
      start: left - safeFlank3,
      end: right + safeFlank5,
      strand,
    }
  }
  return {
    start: left - safeFlank5,
    end: right + safeFlank3,
    strand,
  }
}

function getTranscriptSpan(transcript) {
  if (!transcript) return null
  const txStart = Number(transcript.start)
  const txEnd = Number(transcript.end)
  if (!Number.isFinite(txStart) || !Number.isFinite(txEnd)) return null
  return {
    start: Math.min(txStart, txEnd),
    end: Math.max(txStart, txEnd),
    strand: String(transcript.strand || '+'),
  }
}

function getTranscriptBoundaryStatus(transcriptSpan, alignmentStart, alignmentEnd) {
  if (!transcriptSpan) return 'unknown'
  const left = Math.min(Number(alignmentStart), Number(alignmentEnd))
  const right = Math.max(Number(alignmentStart), Number(alignmentEnd))
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 'unknown'
  if (transcriptSpan.start >= left && transcriptSpan.end <= right) return 'within'
  if (transcriptSpan.end >= left && transcriptSpan.start <= right) return 'partial'
  return 'outside'
}

function normalizeResolvedTranscriptSegments(segments, type) {
  if (!Array.isArray(segments)) return []
  return segments
    .map((segment) => {
      const start = Math.min(Number(segment?.start), Number(segment?.end))
      const end = Math.max(Number(segment?.start), Number(segment?.end))
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null
      return { type, start, end }
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

function classifyResolvedUtrType(utr, cdsSegments, strand) {
  const rawType = String(
    utr?.feature_type
    || utr?.featureType
    || utr?.type
    || ''
  ).trim().toLowerCase()
  if (rawType.includes('five')) return 'utr5'
  if (rawType.includes('three')) return 'utr3'
  if (rawType.includes('5')) return 'utr5'
  if (rawType.includes('3')) return 'utr3'

  const normalizedCds = normalizeResolvedTranscriptSegments(cdsSegments, 'cds')
  if (!normalizedCds.length) return 'utr'
  const cdsMin = Math.min(...normalizedCds.map((segment) => segment.start))
  const cdsMax = Math.max(...normalizedCds.map((segment) => segment.end))
  const utrStart = Math.min(Number(utr?.start), Number(utr?.end))
  const utrEnd = Math.max(Number(utr?.start), Number(utr?.end))
  if (!Number.isFinite(utrStart) || !Number.isFinite(utrEnd)) return 'utr'

  if (String(strand || '+') === '-') {
    if (utrStart > cdsMax) return 'utr5'
    if (utrEnd < cdsMin) return 'utr3'
  } else {
    if (utrEnd < cdsMin) return 'utr5'
    if (utrStart > cdsMax) return 'utr3'
  }
  return 'utr'
}

function projectedFeaturePriority(type) {
  const t = String(type || '').trim().toLowerCase()
  if (t === 'start_codon' || t === 'stop_codon' || t === 'donor' || t === 'acceptor' || t === 'splice_site') return 3
  if (t === 'cds' || t === 'utr' || t === 'utr5' || t === 'utr3') return 2
  return 1 // exon / intron / fallback
}

function buildProjectedTranscriptFeatures(transcript, genomicToAlign) {
  if (!transcript || !(genomicToAlign instanceof Map) || genomicToAlign.size === 0) return []

  const mapRange = (features) => {
    const projected = []
    for (const feature of features) {
      let projectedStart = null
      let projectedEnd = null
      for (let pos = feature.start; pos <= feature.end; pos += 1) {
        const mapped = genomicToAlign.get(pos)
        if (mapped == null) continue
        if (projectedStart == null) projectedStart = mapped
        projectedEnd = mapped
      }
      if (projectedStart == null || projectedEnd == null) continue
      projected.push({
        ...feature,
        start: Math.min(projectedStart, projectedEnd),
        end: Math.max(projectedStart, projectedEnd),
      })
    }
    return projected
  }

  const strand = String(transcript.strand || '+')
  const genomicExons = normalizeResolvedTranscriptSegments(transcript.exons, 'exon')
  const genomicCds = normalizeResolvedTranscriptSegments(transcript.cds_list, 'cds')
  const genomicUtrs = (Array.isArray(transcript.utrs) ? transcript.utrs : [])
    .map((utr) => {
      const start = Math.min(Number(utr?.start), Number(utr?.end))
      const end = Math.max(Number(utr?.start), Number(utr?.end))
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null
      return {
        type: classifyResolvedUtrType(utr, transcript.cds_list, strand),
        start,
        end,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const genomicIntrons = []
  for (let i = 0; i < genomicExons.length - 1; i += 1) {
    const start = Number(genomicExons[i].end) + 1
    const end = Number(genomicExons[i + 1].start) - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    genomicIntrons.push({ type: 'intron', start, end })
  }

  const biologicalExons = [...genomicExons].sort((a, b) => (
    strand === '-'
      ? (b.start - a.start || b.end - a.end)
      : (a.start - b.start || a.end - b.end)
  ))
  const genomicSpliceSites = []
  for (let i = 0; i < biologicalExons.length; i += 1) {
    const exon = biologicalExons[i]
    if (i < biologicalExons.length - 1) {
      if (strand === '-') genomicSpliceSites.push({ type: 'donor', start: exon.start - 2, end: exon.start - 1 })
      else genomicSpliceSites.push({ type: 'donor', start: exon.end + 1, end: exon.end + 2 })
    }
    if (i > 0) {
      if (strand === '-') genomicSpliceSites.push({ type: 'acceptor', start: exon.end + 1, end: exon.end + 2 })
      else genomicSpliceSites.push({ type: 'acceptor', start: exon.start - 2, end: exon.start - 1 })
    }
  }

  const genomicCodons = []
  if (genomicCds.length > 0) {
    const sortedCds = [...genomicCds].sort((a, b) => a.start - b.start || a.end - b.end)
    if (strand === '-') {
      const firstBiologicalCds = sortedCds[sortedCds.length - 1]
      const lastBiologicalCds = sortedCds[0]
      genomicCodons.push({ type: 'start_codon', start: firstBiologicalCds.end - 2, end: firstBiologicalCds.end })
      genomicCodons.push({ type: 'stop_codon', start: lastBiologicalCds.start, end: lastBiologicalCds.start + 2 })
    } else {
      const firstBiologicalCds = sortedCds[0]
      const lastBiologicalCds = sortedCds[sortedCds.length - 1]
      genomicCodons.push({ type: 'start_codon', start: firstBiologicalCds.start, end: firstBiologicalCds.start + 2 })
      genomicCodons.push({ type: 'stop_codon', start: lastBiologicalCds.end - 2, end: lastBiologicalCds.end })
    }
  }

  const exons = mapRange(genomicExons)
  const introns = mapRange(genomicIntrons)
  const cds = mapRange(genomicCds)
  const utrs = mapRange(genomicUtrs)
  const spliceSites = mapRange(genomicSpliceSites.filter((feature) => Number.isFinite(feature.start) && Number.isFinite(feature.end) && feature.end >= feature.start))
  const codons = mapRange(genomicCodons.filter((feature) => Number.isFinite(feature.start) && Number.isFinite(feature.end) && feature.end >= feature.start))

  return [...exons, ...introns, ...cds, ...utrs, ...spliceSites, ...codons]
    .sort((a, b) => {
      const pa = projectedFeaturePriority(a?.type)
      const pb = projectedFeaturePriority(b?.type)
      // Keep low-priority features first; viewer picks highest priority from the end.
      if (pa !== pb) return pa - pb
      return a.start - b.start || a.end - b.end
    })
}

function buildAlignmentGenomicToColumnMap(alignedSequence, genomicStart, genomicEnd, strand) {
  const sequence = String(alignedSequence || '')
  const left = Math.min(Number(genomicStart), Number(genomicEnd))
  const right = Math.max(Number(genomicStart), Number(genomicEnd))
  if (!sequence || !Number.isFinite(left) || !Number.isFinite(right)) return new Map()

  const genomicToAlign = new Map()
  let genomicPos = String(strand || '+') === '-' ? right : left
  const step = String(strand || '+') === '-' ? -1 : 1
  for (let col = 0; col < sequence.length; col += 1) {
    const base = sequence[col]
    if (!base || base === '-') continue
    genomicToAlign.set(genomicPos, col)
    genomicPos += step
  }
  return genomicToAlign
}

function getCoveredAlignmentColumnRange(genomicToAlign, requestedWindow) {
  if (!(genomicToAlign instanceof Map) || genomicToAlign.size === 0 || !requestedWindow) return null
  let minCol = null
  let maxCol = null
  const left = Math.min(Number(requestedWindow.start), Number(requestedWindow.end))
  const right = Math.max(Number(requestedWindow.start), Number(requestedWindow.end))
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null

  for (const [genomicPos, col] of genomicToAlign.entries()) {
    if (!Number.isFinite(Number(genomicPos)) || !Number.isFinite(Number(col))) continue
    if (genomicPos < left || genomicPos > right) continue
    if (minCol == null || col < minCol) minCol = col
    if (maxCol == null || col > maxCol) maxCol = col
  }

  if (minCol == null || maxCol == null) return null
  return { start: minCol, end: maxCol }
}


const TWO_GENOME_VIEWS = new Set(['homology'])
const NEIGHBOURHOOD_FLANK_WINDOW_SIZE = 100

const SV_REF_GRCH38_ALIASES = [
  'grch38',
  'grch38p14',
  'gca00000140529',
  'gcf00000140540',
]

const SV_TARGET_HG00438_ALIASES = [
  'hg00438',
  'hg00438pathprcf2',
  'gca0184725952',
]

const SV_TARGET_HG00733_ALIASES = [
  'hg007332',
  'hg00733mat',
  'hg00733mathprcf2',
  'gca0185069752',
  'gca0185069753',
  '0fb76cdf6c6b4c20beef7f7d4151651b',
]
const SV_NO_ANCHOR_KEY = '__sv_no_anchor__'

function normalizeSvSpeciesToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function collectSvSpeciesTokens(species) {
  if (!species) return []
  const rawValues = [
    species?.assembly_name,
    species?.assembly,
    species?.gca,
    species?.accession,
    species?.name,
    species?.key,
    species?.scientific_name,
    species?.common_name,
  ]
  const tokens = []
  for (const value of rawValues) {
    const normalized = normalizeSvSpeciesToken(value)
    if (!normalized || tokens.includes(normalized)) continue
    tokens.push(normalized)
  }
  return tokens
}

function speciesMatchesSvAliases(species, aliases) {
  const tokens = collectSvSpeciesTokens(species)
  return aliases.some((alias) => tokens.some((token) => token.includes(alias)))
}

function resolveStructuralVariationTrioSpecies(activeSpecies) {
  const active = dedupeSpeciesList(activeSpecies)
  if (active.length !== 3) return null

  const reference = active.find((species) => speciesMatchesSvAliases(species, SV_REF_GRCH38_ALIASES)) || null
  const secondary = active.find((species) => speciesMatchesSvAliases(species, SV_TARGET_HG00438_ALIASES)) || null
  const third = active.find((species) => speciesMatchesSvAliases(species, SV_TARGET_HG00733_ALIASES)) || null

  if (!reference || !secondary || !third) return null

  const usedKeys = new Set([speciesItemKey(reference), speciesItemKey(secondary), speciesItemKey(third)])
  if (usedKeys.size !== 3) return null

  return { reference, secondary, third }
}

function getViewActiveCapacity(viewId) {
  if (viewId === 'genome_browser') return Number.POSITIVE_INFINITY
  if (viewId === 'alignment') return Number.POSITIVE_INFINITY
  if (viewId === 'stats') return Number.POSITIVE_INFINITY
  if (viewId === 'feature_explorer') return Number.POSITIVE_INFINITY
  if (viewId === 'neighbourhood') return Number.POSITIVE_INFINITY
  if (viewId === 'structural_variation') return 3
  // One genome at a time, and the pill for it says so: the strip showed every
  // genome half-lit, including the one actually on screen.
  if (viewId === 'sequence') return 1
  if (TWO_GENOME_VIEWS.has(viewId)) return 2
  return 0
}

function buildNeighbourhoodPairKey(refGenomeKey, targetGenomeKey) {
  const ref = String(refGenomeKey || '').trim()
  const tgt = String(targetGenomeKey || '').trim()
  return ref && tgt ? `${ref}__${tgt}` : ''
}

function mergeNeighbourhoodTrack(prevTrack, incomingGenes, centerGeneId, requestGeneId, windowSize = NEIGHBOURHOOD_FLANK_WINDOW_SIZE) {
  const genes = Array.isArray(incomingGenes) ? incomingGenes.filter((gene) => gene?.id) : []
  const centerId = String(centerGeneId || '').trim()
  const requestId = String(requestGeneId || centerId).trim()
  const incomingCenter = genes.find((gene) => String(gene?.id || '').trim() === centerId) || null
  const incomingChrom = String(incomingCenter?.chrom || genes[0]?.chrom || '').trim()
  const prevGenes = Array.isArray(prevTrack?.genes) ? prevTrack.genes.filter((gene) => gene?.id) : []
  const prevCenter = prevGenes.find((gene) => String(gene?.id || '').trim() === String(prevTrack?.centerGeneId || '').trim()) || null
  const prevChrom = String(prevCenter?.chrom || prevGenes[0]?.chrom || '').trim()
  const canAccumulate = Boolean(incomingChrom && prevChrom && incomingChrom === prevChrom)
  const sourceGenes = canAccumulate ? [...prevGenes, ...genes] : genes
  const byId = new Map()

  for (const gene of sourceGenes) {
    const id = String(gene?.id || '').trim()
    if (!id) continue
    byId.set(id, {
      ...gene,
      is_focal: id === centerId,
    })
  }

  if (centerId && byId.has(centerId)) {
    const centerGene = byId.get(centerId)
    byId.set(centerId, { ...centerGene, is_focal: true })
  }

  const mergedGenes = [...byId.values()].sort((a, b) => {
    const chromCompare = String(a?.chrom || '').localeCompare(String(b?.chrom || ''))
    if (chromCompare !== 0) return chromCompare
    const aStart = Number(a?.start || 0)
    const bStart = Number(b?.start || 0)
    if (aStart !== bStart) return aStart - bStart
    return String(a?.id || '').localeCompare(String(b?.id || ''))
  })

  return {
    genes: mergedGenes,
    centerGeneId: centerId,
    requestGeneId: requestId,
    windowSize,
  }
}

function reorderWithInsertPosition(order, sourceId, targetId, insertPosition = 'before') {
  const sourceIndex = order.indexOf(sourceId)
  const targetIndex = order.indexOf(targetId)
  if (sourceIndex < 0 || targetIndex < 0) return order
  if (sourceId === targetId) return order

  const next = [...order]
  const [moved] = next.splice(sourceIndex, 1)
  const adjustedTargetIndex = next.indexOf(targetId)
  if (adjustedTargetIndex < 0) return order
  const insertIndex = insertPosition === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex
  next.splice(insertIndex, 0, moved)
  return next
}

function FpsCounter() {
  const [fps, setFps] = useState(0)
  const frameTimesRef = useRef([])
  const rafRef = useRef(null)
  useEffect(() => {
    let active = true
    const tick = (now) => {
      if (!active) return
      const times = frameTimesRef.current
      times.push(now)
      while (times.length > 0 && now - times[0] > 1000) times.shift()
      setFps(times.length)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { active = false; if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])
  const color = fps >= 50 ? '#4ade80' : fps >= 30 ? '#fbbf24' : '#f87171'
  return (
    <div style={{
      position: 'fixed', top: 6, left: 6, zIndex: 9999,
      padding: '2px 7px', borderRadius: 4,
      background: 'rgba(0,0,0,0.72)', color,
      fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700,
      lineHeight: 1.5, pointerEvents: 'none', userSelect: 'none',
    }}>
      {fps} fps
    </div>
  )
}

function App() {
  const [backendRuntime, setBackendRuntime] = useState(() => getInitialBackendRuntime())
  const [alignment, setAlignment] = useState(null)
  const [alignmentOverlay, setAlignmentOverlay] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [recentItems, setRecentItems] = useState([])

  // Display options
  const [collapseIntrons, setCollapseIntrons] = useState(false)
  const [collapseSource, setCollapseSource] = useState('')
  const [refFlankBp, setRefFlankBp] = useState(100)
  const [tgtFlankBp, setTgtFlankBp] = useState(100)
  const [flankLocked, setFlankLocked] = useState(true)

  // Dual input state
  const [refInput, setRefInput] = useState('')
  const [tgtInput, setTgtInput] = useState('')
  const [refResolved, setRefResolved] = useState(null)   // { gene, transcripts, selectedTranscriptId, resolvedType }
  const [tgtResolved, setTgtResolved] = useState(null)
  const [refLoading, setRefLoading] = useState(false)
  const [tgtLoading, setTgtLoading] = useState(false)
  const [refError, setRefError] = useState(null)
  const [tgtError, setTgtError] = useState(null)

  // Genes selected in the genome browser (shared across views)
  const [browserRefGene, setBrowserRefGene] = useState(null)
  const [browserTgtGene, setBrowserTgtGene] = useState(null)
  const [browserRefViewport, setBrowserRefViewport] = useState(null)
  const refResolveInFlightQueryRef = useRef('')
  const tgtResolveInFlightQueryRef = useRef('')
  const refLastResolvedQueryRef = useRef('')
  const tgtLastResolvedQueryRef = useRef('')

  // Snapshot of last-saved config for change detection
  const savedConfigRef = useRef(null)
  const persistedActiveButtonsRef = useRef('')
  const persistActiveButtonsTimerRef = useRef(null)
  const persistedGenomeColorsRef = useRef('')
  const persistGenomeColorsTimerRef = useRef(null)
  const persistConfigurationTimerRef = useRef(null)
  const selectorRefreshCompletedTaskIdsRef = useRef(new Set())

  // Whether initial config has been loaded from backend
  const [configLoaded, setConfigLoaded] = useState(false)

  // Incrementing keys to trigger selective browser track reloads
  const [refBrowserReloadKey, setRefBrowserReloadKey] = useState(0)
  const [tgtBrowserReloadKey, setTgtBrowserReloadKey] = useState(0)

  // Theme: 'dark' (default) or 'light'
  const [theme, setTheme] = useState('dark')
  const [screenshotMode, setScreenshotMode] = useState(false)
  const [genomePlaylistPopoverOpen, setGenomePlaylistPopoverOpen] = useState(false)
  const [applyingGenomePlaylistId, setApplyingGenomePlaylistId] = useState('')
  const [screenshotAvailabilityByView, setScreenshotAvailabilityByView] = useState({})
  const [selectedFallbackScreenshotTarget, setSelectedFallbackScreenshotTarget] = useState(null)
  const [mainContentNode, setMainContentNode] = useState(null)
  const [activeViewContentNode, setActiveViewContentNode] = useState(null)
  const screenshotActionButtonRef = useRef(null)
  const genomePlaylistActionButtonRef = useRef(null)
  const genomePlaylistPopoverRef = useRef(null)
  const fallbackScreenshotOverlayRef = useMemo(
    () => ({ current: mainContentNode }),
    [mainContentNode]
  )

  // Navigation: which view is active
  const [currentView, setCurrentView] = useState('home')
  // What the sequence view should open on when another view hands off to it. A
  // fresh object each time, so asking for the same gene twice still arrives as a
  // new request -- the same contract as browserLocationFocusByGenome.
  const [sequenceViewEntry, setSequenceViewEntry] = useState(null)
  const [explorerIncoming, setExplorerIncoming] = useState(null)
  const [gettingStartedOutputDirDismissed, setGettingStartedOutputDirDismissed] = useState(false)
  const [outputDirNotification, setOutputDirNotification] = useState('')
  const previousViewRef = useRef('home')
  const [headerCollapsed, setHeaderCollapsed] = useState(false)
  const [draggedTopButtonId, setDraggedTopButtonId] = useState('')
  const [dragOverTopButtonId, setDragOverTopButtonId] = useState('')
  const [dragTopInsertPosition, setDragTopInsertPosition] = useState('before')
  const topBarDragMovedRef = useRef(false)

  // Alignment Action state (Run vs Load)
  const [alignmentAction, setAlignmentAction] = useState('Run')

  // Tracks the exact params of the alignment currently displayed so we can disable
  // the button when nothing has changed since the last run.
  const [loadedParams, setLoadedParams] = useState(null)

  // Multi-genome alignment state
  const [alignmentInputs, setAlignmentInputs] = useState([])
  const [multiAlignmentResult, setMultiAlignmentResult] = useState(null)
  const [loadedAlignmentBaselineByGenome, setLoadedAlignmentBaselineByGenome] = useState({})
  const [lastSuccessfulMultiAlignmentSignature, setLastSuccessfulMultiAlignmentSignature] = useState('')
  const [alignmentViewError, setAlignmentViewError] = useState(null)
  const [alignmentViewLoading, setAlignmentViewLoading] = useState(false)
  const [saveAlignmentModalOpen, setSaveAlignmentModalOpen] = useState(false)
  const [loadAlignmentModalOpen, setLoadAlignmentModalOpen] = useState(false)
  const [alignmentGlobalFlanks, setAlignmentGlobalFlanks] = useState({ flank5: 100, flank3: 100 })
  const [alignmentGlobalFlanksLocked, setAlignmentGlobalFlanksLocked] = useState(true)
  const [alignmentGlobalFlankMax, setAlignmentGlobalFlankMax] = useState(1000)
  const [alignmentSidebarCollapsed, setAlignmentSidebarCollapsed] = useState(false)
  const [alignmentRunSettings, setAlignmentRunSettings] = useState({
    profile: 'balanced',
    soft_warn_sequences: 6,
    hard_cap_sequences: 10,
    max_total_bp: 500000,
    timeout_sec: 300,
  })
  const [browserFocusByGenome, setBrowserFocusByGenome] = useState({})
  // genomeKey -> { chrom, start, end } asked for from outside the browser — a
  // location note or alignment selection offering to take the reader to its
  // region. Consumed by the panel, which focuses it the same way a search does.
  const [browserLocationFocusByGenome, setBrowserLocationFocusByGenome] = useState({})
  // The genome the sequence view is reading, reported by the view itself: it
  // chooses its own, and the top bar has to light the same pill.
  const [sequenceGenomeKey, setSequenceGenomeKey] = useState('')
  const alignmentInputsRef = useRef(alignmentInputs)
  const alignmentResolveControllersRef = useRef({})
  const alignmentResolveRequestTokenRef = useRef({})

  // Configuration state. `userConfig` is what is really on disk; `config` below is what
  // the app runs on, which a tutorial can shadow without ever writing to the real one.
  const [userConfig, setUserConfig] = useState({
    working_dir: '',
    ref_fasta: '',
    ref_gff: '',
    target_fasta: '',
    target_gff: '',
    homologies_file: '',
    active_species: [],
    next_previous_session_genomes: [],
    manual_species: [],
    genome_file_overrides: {},
    genome_analysis_reports: {},
    deregistered_genome_keys: [],
    genome_playlists: [],
    selected_genome_playlist_id: '__all__',
    default_light_mode: false,
    dim_non_selected_genes: true,
    show_fps_counter: false,
    browsing_control_scheme: DEFAULT_BROWSING_CONTROL_SCHEME_ID,
    sv_hide_inactive_tracks: false,
    genome_default_color: DEFAULT_GENOME_COLOR,
    genome_colors: {},
    genome_color_palette: [],
    active_app_buttons: DEFAULT_ACTIVE_APP_BUTTONS,
  })

  // The real configuration is frozen for as long as a tutorial runs.
  //
  // Plenty of code here reads the current config, changes a field and writes the whole
  // thing back. During a tutorial "the current config" is the sandbox overlay, so those
  // writes would fold the tutorial's scratch directory into the user's real settings.
  // Rather than auditing every one of them, the single setter refuses. Anything the
  // tutorial genuinely needs to change lives in its override instead.
  const setConfig = useCallback((update) => {
    if (isTutorialSandboxActive()) return
    setUserConfig(update)
  }, [])

  // Lets a running tutorial follow the user between apps and move them itself.
  const tutorialRuntime = useTutorialHost({ currentView, theme, navigate: setCurrentView })

  // A tutorial runs in a sandbox: its own scratch output directory and its own set of
  // active genomes, layered over the user's configuration rather than replacing it.
  // Nothing here is ever written back, so quitting mid-tutorial leaves the real
  // configuration exactly as it was and the next launch needs no recovery.
  const {
    configOverride: tutorialConfig,
    updateSandboxConfig,
    toggleTutorialGenome,
  } = tutorialRuntime
  const config = useMemo(
    () => (tutorialConfig ? { ...userConfig, ...tutorialConfig } : userConfig),
    [tutorialConfig, userConfig]
  )

  const configRef = useRef(config)
  const [inactiveSelectedSpecies, setInactiveSelectedSpecies] = useState([])
  const sandboxInactiveSnapshotRef = useRef(null)
  const [dualViewFocus, setDualViewFocus] = useState({ primaryKey: '', secondaryKey: '' })
  const [svFullyActiveSpeciesKeys, setSvFullyActiveSpeciesKeys] = useState([])
  const [svAnchorRegionId, setSvAnchorRegionId] = useState('')
  const [svAnchorSpeciesKey, setSvAnchorSpeciesKey] = useState('')
  const [svSecondSpeciesKey, setSvSecondSpeciesKey] = useState('')
  const [svThirdSpeciesKey, setSvThirdSpeciesKey] = useState('')
  const [svRegionExplicitlySelected, setSvRegionExplicitlySelected] = useState(false)
  const svSavedViewportRef = useRef(null)
  const [featureExplorerGenomeKey, setFeatureExplorerGenomeKey] = useState('')
  const [lastDemotedFeatureExplorerGenomeKey, setLastDemotedFeatureExplorerGenomeKey] = useState('')
  const dualViewFocusRef = useRef(dualViewFocus)
  const inactiveSelectedSpeciesRef = useRef(inactiveSelectedSpecies)
  const nextPreviousSessionSignatureRef = useRef('')
  const activeIndexBuildsRef = useRef(new Map())
  const ensuredGenomeIndexKeysRef = useRef(new Set())
  const suppressViewSyncRef = useRef(false)
  const shouldShowWindowsBackendSetup = backendRuntime.isElectron &&
    backendRuntime.platform === 'win32' &&
    backendRuntime.mode === 'wsl' &&
    !backendRuntime.ready
  const shouldGateStartupFetch = backendRuntime.isElectron &&
    backendRuntime.platform === 'win32' &&
    backendRuntime.mode === 'wsl'

  const refSpecies = useMemo(
    () => config?.active_species?.find((species) => species.files?.gff3 === config?.ref_gff) || null,
    [config?.active_species, config?.ref_gff]
  )
  const tgtSpecies = useMemo(
    () => config?.active_species?.find((species) => species.files?.gff3 === config?.target_gff) || null,
    [config?.active_species, config?.target_gff]
  )
  const svActiveSpecies = useMemo(
    () => dedupeSpeciesList(config?.active_species || []),
    [config?.active_species]
  )
  const svActiveSpeciesByKey = useMemo(
    () => new Map(svActiveSpecies.map((species) => [speciesItemKey(species), species])),
    [svActiveSpecies]
  )
  const resolveSvActiveSpeciesForKey = useCallback((key) => {
    const wanted = String(key || '').trim()
    if (!wanted) return null
    return svActiveSpeciesByKey.get(wanted)
      || svActiveSpecies.find((species) => genomeKeysMatch(species, wanted))
      || null
  }, [svActiveSpecies, svActiveSpeciesByKey])
  const svAnchorSpecies = svAnchorSpeciesKey === SV_NO_ANCHOR_KEY
    ? null
    : (resolveSvActiveSpeciesForKey(svAnchorSpeciesKey) || svActiveSpecies[0] || null)
  const svSecondSpecies = svSecondSpeciesKey ? resolveSvActiveSpeciesForKey(svSecondSpeciesKey) : null
  const svThirdSpecies = svThirdSpeciesKey ? resolveSvActiveSpeciesForKey(svThirdSpeciesKey) : null
  const refGenomeKey = refSpecies ? speciesItemKey(refSpecies) : ''
  const tgtGenomeKey = tgtSpecies ? speciesItemKey(tgtSpecies) : ''

  const handleSvAlignmentAvailabilityChange = useCallback((speciesKeys) => {
    const next = Array.from(new Set((speciesKeys || []).filter(Boolean)))
    setSvFullyActiveSpeciesKeys((prev) => sameStringArrayItems(prev, next) ? prev : next)
  }, [])

  useEffect(() => {
    if (currentView !== 'structural_variation' && svFullyActiveSpeciesKeys.length) {
      setSvFullyActiveSpeciesKeys([])
    }
  }, [currentView, svFullyActiveSpeciesKeys.length])

  useEffect(() => {
    const activeKeys = new Set(svActiveSpecies.map((species) => speciesItemKey(species)))
    const knownSvSpecies = [
      ...svActiveSpecies,
      ...dedupeSpeciesList(inactiveSelectedSpeciesRef.current),
    ]
    const knownSvKeys = new Set([
      ...knownSvSpecies,
    ].map((species) => speciesItemKey(species)).filter(Boolean))
    const hasActiveSvKey = (key) => {
      const wanted = String(key || '').trim()
      return Boolean(wanted && (activeKeys.has(wanted) || svActiveSpecies.some((species) => genomeKeysMatch(species, wanted))))
    }
    const hasKnownSvKey = (key) => {
      const wanted = String(key || '').trim()
      return Boolean(wanted && (knownSvKeys.has(wanted) || knownSvSpecies.some((species) => genomeKeysMatch(species, wanted))))
    }
    const primaryActiveKey = svActiveSpecies[0] ? speciesItemKey(svActiveSpecies[0]) : ''

    if (svAnchorSpeciesKey && svAnchorSpeciesKey !== SV_NO_ANCHOR_KEY) {
      if (!hasActiveSvKey(svAnchorSpeciesKey)) {
        if (hasKnownSvKey(svAnchorSpeciesKey)) return
        setSvAnchorSpeciesKey(primaryActiveKey || '')
        setSvSecondSpeciesKey('')
        setSvThirdSpeciesKey('')
        setSvAnchorRegionId('')
        setSvRegionExplicitlySelected(false)
        setSvFullyActiveSpeciesKeys(primaryActiveKey ? [primaryActiveKey] : [])
        return
      }
      if (primaryActiveKey && svAnchorSpeciesKey !== primaryActiveKey) {
        setSvAnchorSpeciesKey(primaryActiveKey)
        setSvSecondSpeciesKey('')
        setSvThirdSpeciesKey('')
        setSvAnchorRegionId('')
        setSvRegionExplicitlySelected(false)
        setSvFullyActiveSpeciesKeys([primaryActiveKey])
        return
      }
    }

  }, [svActiveSpecies, svAnchorSpeciesKey, svSecondSpeciesKey, svThirdSpeciesKey])

  useEffect(() => {
    const unsubscribe = subscribeToBackendRuntime((nextRuntime) => {
      setBackendRuntime(nextRuntime)
    })

    fetchBackendRuntimeStatus()
      .then((nextRuntime) => {
        setBackendRuntime(nextRuntime)
      })
      .catch((err) => {
        console.error('Failed to fetch backend runtime status:', err)
      })

    return unsubscribe
  }, [])

  useEffect(() => {
    if (shouldGateStartupFetch && !backendRuntime.ready) return
    fetchRecent()
    fetchConfig()
  }, [backendRuntime.ready, shouldGateStartupFetch])

  // Coming out of a tutorial, re-read the configuration and let the app derive itself
  // from it again. The stored configuration was never touched, but state derived from it
  // — which genomes are active, which are merely selected — was emptied for the sandbox
  // and has to be rebuilt from the real thing.
  // Keyed on the sandbox itself going away rather than on the tutorial stopping: a
  // finished tutorial still shows its completion card, and its overlay config is still
  // in force until the user dismisses it.
  // What the browser was looking at before a tutorial took over.
  //
  // The configuration override is enough to keep a tutorial out of the user's settings,
  // but the browser's focused gene is component state and not covered by it. Left alone,
  // a tutorial that focuses one of the demo genome's invented genes hands the session back
  // still focused on it — so the user returns to their own genomes with a gene none of
  // them contain pinned to the focus bar, and clearing it leaves the track blank until the
  // genome is toggled off and on again.
  //
  // Snapshotted rather than simply cleared, because a focus the user had before the
  // tutorial is theirs and should survive it, the same as everything else.
  const tutorialSandboxWasUpRef = useRef(false)
  const preTutorialBrowserFocusRef = useRef(null)
  useEffect(() => {
    const sandboxUp = Boolean(tutorialConfig)
    const tookOver = !tutorialSandboxWasUpRef.current && sandboxUp
    const handedBack = tutorialSandboxWasUpRef.current && !sandboxUp
    tutorialSandboxWasUpRef.current = sandboxUp

    if (tookOver) {
      preTutorialBrowserFocusRef.current = {
        refGene: browserRefGene,
        tgtGene: browserTgtGene,
        byGenome: browserFocusByGenome,
        refInput,
        tgtInput,
      }
    }

    if (handedBack) {
      const saved = preTutorialBrowserFocusRef.current
      preTutorialBrowserFocusRef.current = null
      setBrowserRefGene(saved?.refGene ?? null)
      setBrowserTgtGene(saved?.tgtGene ?? null)
      setBrowserFocusByGenome(saved?.byGenome ?? {})
      setRefInput(saved?.refInput ?? '')
      setTgtInput(saved?.tgtInput ?? '')
      fetchConfig()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tutorialConfig])

  // A tutorial cleans up after itself, but it cannot if the app was killed while one was
  // running. Sweeping on launch means an interrupted tutorial leaves nothing behind —
  // and since a tutorial never writes to the real configuration, there is nothing else to
  // undo: this session starts as the user left it.
  const sweptTutorialWorkspaceRef = useRef(false)
  useEffect(() => {
    const outputDir = userConfig?.output_dir
    if (!configLoaded || !outputDir || sweptTutorialWorkspaceRef.current) return
    sweptTutorialWorkspaceRef.current = true
    resetTutorialWorkspace(outputDir)
  }, [configLoaded, userConfig?.output_dir])

  useEffect(() => {
    configRef.current = config
  }, [config])

  // Selected-but-inactive genomes are React state rather than configuration. Give the
  // tutorial sandbox its own copy too, otherwise Genome Selector either leaks the
  // author's existing genomes into the scene or changes that real selection while the
  // author experiments with playlists.
  useEffect(() => {
    if (tutorialConfig) {
      if (sandboxInactiveSnapshotRef.current === null) {
        sandboxInactiveSnapshotRef.current = inactiveSelectedSpeciesRef.current
        setInactiveSelectedSpecies([])
      }
      return
    }
    if (sandboxInactiveSnapshotRef.current !== null) {
      const restored = sandboxInactiveSnapshotRef.current
      sandboxInactiveSnapshotRef.current = null
      setInactiveSelectedSpecies(restored)
    }
  }, [tutorialConfig])

  useEffect(() => {
    if (!configLoaded) return undefined

    const flushConfig = () => {
      const currentConfig = configRef.current
      if (!currentConfig) return
      try {
        fetch(`${API_BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentConfig),
          keepalive: true,
        }).catch(() => {})
      } catch {
        // The app is unloading; there is nowhere useful to surface this.
      }
    }

    window.addEventListener('pagehide', flushConfig)
    window.addEventListener('beforeunload', flushConfig)
    return () => {
      window.removeEventListener('pagehide', flushConfig)
      window.removeEventListener('beforeunload', flushConfig)
    }
  }, [configLoaded])

  useEffect(() => {
    dualViewFocusRef.current = dualViewFocus
  }, [dualViewFocus])

  useEffect(() => {
    inactiveSelectedSpeciesRef.current = inactiveSelectedSpecies
  }, [inactiveSelectedSpecies])

  useEffect(() => {
    const validKeys = new Set(
      dedupeSpeciesList(config?.active_species || []).map((species) => speciesItemKey(species))
    )
    setBrowserFocusByGenome((prev) => {
      const next = {}
      let changed = false
      for (const [key, gene] of Object.entries(prev || {})) {
        if (!validKeys.has(key)) {
          changed = true
          continue
        }
        next[key] = gene
      }
      return changed ? next : prev
    })
  }, [config?.active_species])

  // Several alignment callbacks intentionally read the latest rows from a ref so
  // that async resolve completions cannot overwrite one another. Keep that ref in
  // sync before the browser paints: a passive effect leaves a short window where
  // a transcript is visibly selected but a Run/Go click still sees the old row.
  useLayoutEffect(() => {
    alignmentInputsRef.current = alignmentInputs
  }, [alignmentInputs])

  useEffect(() => {
    let cancelled = false
    const inProgressStatuses = new Set(['pending', 'downloading'])

    const pollDownloadTasksForSelectorRefresh = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/remote/tasks`)
        if (!res.ok || cancelled) return
        const tasks = await res.json()
        if (cancelled || !Array.isArray(tasks)) return

        const latestByGenomeKey = new Map()
        const newlyCompleted = []
        for (const task of tasks) {
          const genomeKey = getAssemblyGenomeKey(task)
          if (genomeKey) {
            if (!latestByGenomeKey.has(genomeKey)) latestByGenomeKey.set(genomeKey, [])
            latestByGenomeKey.get(genomeKey).push(task)
          }
          if (task?.status === 'completed' && task?.id && !selectorRefreshCompletedTaskIdsRef.current.has(task.id)) {
            selectorRefreshCompletedTaskIdsRef.current.add(task.id)
            newlyCompleted.push(task)
          }
          if (task?.file_type === 'homology' && (task?.status === 'completed' || task?.status === 'failed')) {
            const homologyTaskMap = neighbourhoodHomologyDownloadTaskByGenomeRef.current || {}
            const matchedGenomeKey = Object.keys(homologyTaskMap).find((gk) => homologyTaskMap[gk] === task.id)
            if (matchedGenomeKey) {
              const nextAvailability = task.status === 'completed' ? 'local' : 'download_failed'
              setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [matchedGenomeKey]: nextAvailability }))
              setNeighbourhoodHomologyDownloadTaskByGenome((prev) => {
                if (!Object.prototype.hasOwnProperty.call(prev || {}, matchedGenomeKey)) return prev
                const next = { ...prev }
                delete next[matchedGenomeKey]
                return next
              })
            }
          }
        }

        const pendingIds = readPendingSelectorGenomeIds()
        let pendingChanged = false
        for (const id of Array.from(pendingIds)) {
          const genomeTasks = latestByGenomeKey.get(id) || []
          const stillInProgress = genomeTasks.some((task) => inProgressStatuses.has(String(task?.status || '')))
          if (genomeTasks.length > 0 && stillInProgress) continue
          pendingIds.delete(id)
          pendingChanged = true
        }

        if (pendingChanged) {
          writePendingSelectorGenomeIds(pendingIds)
        }
        if ((pendingChanged || newlyCompleted.length > 0) && typeof window !== 'undefined') {
          window.dispatchEvent(new Event(SELECTOR_REFRESH_EVENT))
        }
      } catch {
        // Keep this silent; the visible Download view owns task error messaging.
      }
    }

    pollDownloadTasksForSelectorRefresh()
    const id = window.setInterval(pollDownloadTasksForSelectorRefresh, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  useEffect(() => {
    return () => {
      const controllers = alignmentResolveControllersRef.current || {}
      Object.values(controllers).forEach((controller) => {
        try { controller?.abort() } catch { }
      })
      alignmentResolveControllersRef.current = {}
      alignmentResolveRequestTokenRef.current = {}
    }
  }, [])

  useEffect(() => {
    return () => {
      if (persistActiveButtonsTimerRef.current) {
        clearTimeout(persistActiveButtonsTimerRef.current)
        persistActiveButtonsTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (persistGenomeColorsTimerRef.current) {
        clearTimeout(persistGenomeColorsTimerRef.current)
        persistGenomeColorsTimerRef.current = null
      }
    }
  }, [])

  // Persist app-button organizer changes immediately so selections survive restart.
  useEffect(() => {
    if (!configLoaded) return

    const normalizedButtons = normalizeActiveAppButtons(config.active_app_buttons)
    const serialized = JSON.stringify(normalizedButtons)
    if (serialized === persistedActiveButtonsRef.current) return

    if (persistActiveButtonsTimerRef.current) {
      clearTimeout(persistActiveButtonsTimerRef.current)
      persistActiveButtonsTimerRef.current = null
    }

    persistActiveButtonsTimerRef.current = setTimeout(async () => {
      persistActiveButtonsTimerRef.current = null
      const baseConfig = savedConfigRef.current || configRef.current || config
      const payload = { ...baseConfig, active_app_buttons: normalizedButtons }
      try {
        await fetch(`${API_BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        persistedActiveButtonsRef.current = serialized
        savedConfigRef.current = { ...(savedConfigRef.current || {}), active_app_buttons: normalizedButtons }
      } catch (e) {
        console.error('Failed to persist active app buttons:', e)
      }
    }, 180)

    return () => {
      if (persistActiveButtonsTimerRef.current) {
        clearTimeout(persistActiveButtonsTimerRef.current)
        persistActiveButtonsTimerRef.current = null
      }
    }
  }, [configLoaded, config.active_app_buttons])

  // Colours are changed from three different places — the configuration view's
  // default, the selector's per-genome swatch, its bulk control — and none of
  // them is a moment worth a full configuration save. Debounced together, as the
  // positional colour list was before them.
  const genomeColorState = useMemo(() => ({
    genome_default_color: normalizeGenomeDefaultColor(config.genome_default_color),
    genome_colors: normalizeGenomeColorAssignments(config.genome_colors),
    genome_color_palette: normalizeCustomGenomeColors(config.genome_color_palette),
  }), [config.genome_default_color, config.genome_colors, config.genome_color_palette])

  useEffect(() => {
    if (!configLoaded) return

    const serialized = JSON.stringify(genomeColorState)
    if (serialized === persistedGenomeColorsRef.current) return

    if (persistGenomeColorsTimerRef.current) {
      clearTimeout(persistGenomeColorsTimerRef.current)
      persistGenomeColorsTimerRef.current = null
    }

    persistGenomeColorsTimerRef.current = setTimeout(async () => {
      persistGenomeColorsTimerRef.current = null
      const payload = {
        ...(configRef.current || config),
        ...genomeColorState,
      }
      try {
        await fetch(`${API_BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        persistedGenomeColorsRef.current = serialized
        savedConfigRef.current = {
          ...(savedConfigRef.current || {}),
          ...payload,
        }
      } catch (e) {
        console.error('Failed to persist genome colours:', e)
      }
    }, 180)

    return () => {
      if (persistGenomeColorsTimerRef.current) {
        clearTimeout(persistGenomeColorsTimerRef.current)
        persistGenomeColorsTimerRef.current = null
      }
    }
  }, [configLoaded, genomeColorState])

  // Sync body background with theme to prevent white borders
  useEffect(() => {
    document.body.style.backgroundColor = theme === 'light' ? '#f3f4f6' : '#111827';
  }, [theme]);

  // Apply default theme from config when it first loads
  useEffect(() => {
    if (config.default_light_mode) {
      setTheme('light')
    }
  }, [config.default_light_mode])

  // Neighbourhood State
  const [neighbourhoodData, setNeighbourhoodData] = useState(null)
  const [neighbourhoodLoading, setNeighbourhoodLoading] = useState(false)
  const [neighbourhoodError, setNeighbourhoodError] = useState(null)
  const neighbourhoodRequestSeqRef = useRef(0)
  const neighbourhoodAbortRef = useRef(null)
  const [neighbourhoodQueryByGenome, setNeighbourhoodQueryByGenome] = useState({})
  const [neighbourhoodTracksByGenome, setNeighbourhoodTracksByGenome] = useState({})
  const [neighbourhoodLinksByPair, setNeighbourhoodLinksByPair] = useState({})
  const [neighbourhoodPairRequestByKey, setNeighbourhoodPairRequestByKey] = useState({})
  const [neighbourhoodLoadingByGenome, setNeighbourhoodLoadingByGenome] = useState({})
  const [neighbourhoodResolvingByGenome, setNeighbourhoodResolvingByGenome] = useState({})
  const [neighbourhoodErrorByGenome, setNeighbourhoodErrorByGenome] = useState({})
  const [neighbourhoodGenomeOrderKeys, setNeighbourhoodGenomeOrderKeys] = useState([])
  const [neighbourhoodDisabledByGenome, setNeighbourhoodDisabledByGenome] = useState({})
  const neighbourhoodTrackRequestSeqRef = useRef({})
  const neighbourhoodPairRequestSeqRef = useRef({})
  const neighbourhoodTrackAbortRef = useRef({})
  const neighbourhoodPairAbortRef = useRef({})
  const lastRefFocusKeyRef = useRef('')
  const lastTgtFocusKeyRef = useRef('')

  // Neighbourhood "Use Homology" state — real Ensembl Compara homology-link mode
  const [neighbourhoodUseHomology, setNeighbourhoodUseHomology] = useState(false)
  const [neighbourhoodHomologyFilters, setNeighbourhoodHomologyFilters] = useState({
    showRbh: true,
    showRegular: true,
    types: [],
    minIdentity: 0,
    minCoverage: 0,
  })
  const [neighbourhoodHomologyLinksByPair, setNeighbourhoodHomologyLinksByPair] = useState({})
  const [neighbourhoodHomologyAvailabilityByGenome, setNeighbourhoodHomologyAvailabilityByGenome] = useState({})
  const [neighbourhoodHomologyDownloadTaskByGenome, setNeighbourhoodHomologyDownloadTaskByGenome] = useState({})
  const [neighbourhoodHomologyError, setNeighbourhoodHomologyError] = useState('')
  const [neighbourhoodHomologyPairLoading, setNeighbourhoodHomologyPairLoading] = useState({})
  const [neighbourhoodNoHitGenomeKeys, setNeighbourhoodNoHitGenomeKeys] = useState([])
  const neighbourhoodAnchorResolutionAttemptRef = useRef({})
  const neighbourhoodQueryResolutionAttemptRef = useRef({})
  const neighbourhoodHomologyCheckedGenomeKeysRef = useRef(new Set())
  const neighbourhoodHomologyDownloadTaskByGenomeRef = useRef({})
  useEffect(() => {
    neighbourhoodHomologyDownloadTaskByGenomeRef.current = neighbourhoodHomologyDownloadTaskByGenome
  }, [neighbourhoodHomologyDownloadTaskByGenome])
  const neighbourhoodHomologyAvailabilityByGenomeRef = useRef({})
  useEffect(() => {
    neighbourhoodHomologyAvailabilityByGenomeRef.current = neighbourhoodHomologyAvailabilityByGenome
  }, [neighbourhoodHomologyAvailabilityByGenome])

  // Check alignment status (Run vs Load) when selected transcripts change
  useEffect(() => {
    if (currentView !== 'alignment') {
      setAlignmentAction('Run')
      return
    }
    const refTx = refResolved?.selectedTranscriptId
    const tgtTx = tgtResolved?.selectedTranscriptId
    if (!refTx || !tgtTx) { setAlignmentAction('Run'); return }

    const timer = setTimeout(async () => {
      try {
        const url = `${API_BASE}/api/align/check?transcript_id=${encodeURIComponent(refTx)}&target_transcript_id=${encodeURIComponent(tgtTx)}&ref_flank=${refFlankBp}&tgt_flank=${tgtFlankBp}`
        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          if (data.type) {
            setAlignmentAction(data.type.split(' ')[0]) // "Run" or "Load"
          }
        }
      } catch {
        setAlignmentAction('Run')
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [currentView, refResolved?.selectedTranscriptId, tgtResolved?.selectedTranscriptId, refFlankBp, tgtFlankBp])

  const fetchConfig = async () => {
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
        const startupActive = dedupeSpeciesList(startupConfig.active_species)
        const startupPrimary = startupActive[0] || null
        const startupSecondary = startupActive[1] || null
        setConfig(startupConfig)
        setInactiveSelectedSpecies([])
        setDualViewFocus({
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

  const fetchRecent = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/recent`)
      if (res.ok) {
        const data = await res.json()
        setRecentItems(data)
      }
    } catch (e) {
      console.error('Failed to fetch recent:', e)
    }
  }

  const loadNeighbourhoodTrack = useCallback(async (genomeKey, geneId) => {
    const key = String(genomeKey || '').trim()
    const anchorGeneId = String(geneId || '').trim()
    if (!key || !anchorGeneId) return null

    const prevController = neighbourhoodTrackAbortRef.current[key]
    if (prevController) {
      try { prevController.abort() } catch { }
    }
    const controller = new AbortController()
    neighbourhoodTrackAbortRef.current[key] = controller

    const reqSeq = (Number(neighbourhoodTrackRequestSeqRef.current[key]) || 0) + 1
    neighbourhoodTrackRequestSeqRef.current[key] = reqSeq
    setNeighbourhoodLoadingByGenome((prev) => ({ ...prev, [key]: true }))
    setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))

    try {
      const url = `${API_BASE}/api/neighbourhood?ref_genome=${encodeURIComponent(key)}&ref_gene_id=${encodeURIComponent(anchorGeneId)}&window_size=${NEIGHBOURHOOD_FLANK_WINDOW_SIZE}`
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.detail || 'Failed to load neighbourhood data')
      }
      const json = await res.json()
      if ((Number(neighbourhoodTrackRequestSeqRef.current[key]) || 0) !== reqSeq) return null
      const genes = Array.isArray(json?.reference_genes) ? json.reference_genes : []
      const centerGeneId = String(json?.center_ref_id || '').trim()
      const requestGeneId = String(json?.request_ref_gene_id || anchorGeneId).trim()
      setNeighbourhoodTracksByGenome((prev) => ({
        ...prev,
        [key]: mergeNeighbourhoodTrack(prev?.[key], genes, centerGeneId, requestGeneId, NEIGHBOURHOOD_FLANK_WINDOW_SIZE),
      }))
      setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))
      return json
    } catch (e) {
      if (e?.name === 'AbortError') return null
      if ((Number(neighbourhoodTrackRequestSeqRef.current[key]) || 0) !== reqSeq) return null
      console.error(`Neighbourhood track fetch error (${key}):`, e)
      setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: e?.message || 'Failed to load neighbourhood data' }))
      return null
    } finally {
      if ((Number(neighbourhoodTrackRequestSeqRef.current[key]) || 0) !== reqSeq) return
      if (neighbourhoodTrackAbortRef.current[key] === controller) {
        delete neighbourhoodTrackAbortRef.current[key]
      }
      setNeighbourhoodLoadingByGenome((prev) => ({ ...prev, [key]: false }))
    }
  }, [])

  const loadNeighbourhoodPairLinks = useCallback(async ({
    refGenomeKey: pairRefGenomeKey,
    targetGenomeKey: pairTargetGenomeKey,
    refGeneId,
    targetGeneId,
    useHomology = false,
  }) => {
    const refKey = String(pairRefGenomeKey || '').trim()
    const tgtKey = String(pairTargetGenomeKey || '').trim()
    const srcGeneId = String(refGeneId || '').trim()
    const dstGeneId = String(targetGeneId || '').trim()
    const pairKey = buildNeighbourhoodPairKey(refKey, tgtKey)
    if (!pairKey || !srcGeneId || !dstGeneId) return null

    const prevController = neighbourhoodPairAbortRef.current[pairKey]
    if (prevController) {
      try { prevController.abort() } catch { }
    }
    const controller = new AbortController()
    neighbourhoodPairAbortRef.current[pairKey] = controller
    const reqSeq = (Number(neighbourhoodPairRequestSeqRef.current[pairKey]) || 0) + 1
    neighbourhoodPairRequestSeqRef.current[pairKey] = reqSeq

    if (useHomology) {
      setNeighbourhoodHomologyPairLoading((prev) => (prev?.[pairKey] ? prev : { ...prev, [pairKey]: true }))
    }

    try {
      const url = `${API_BASE}/api/neighbourhood?ref_genome=${encodeURIComponent(refKey)}&target_genome=${encodeURIComponent(tgtKey)}&ref_gene_id=${encodeURIComponent(srcGeneId)}&target_gene_id=${encodeURIComponent(dstGeneId)}&window_size=${NEIGHBOURHOOD_FLANK_WINDOW_SIZE}${useHomology ? '&use_homology=true' : ''}`
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.detail || 'Failed to load neighbourhood links')
      }
      const json = await res.json()
      if ((Number(neighbourhoodPairRequestSeqRef.current[pairKey]) || 0) !== reqSeq) return null
      const homologies = Array.isArray(json?.homologies)
        ? json.homologies.filter((pair) => Array.isArray(pair) && pair.length >= 2)
        : []
      const homologyLinks = Array.isArray(json?.homology_links) ? json.homology_links : []
      const refGenes = Array.isArray(json?.reference_genes) ? json.reference_genes : []
      const targetGenes = Array.isArray(json?.target_genes) ? json.target_genes : []
      const resolvedRefGeneId = String(json?.request_ref_gene_id || srcGeneId).trim()
      const resolvedTargetGeneId = String(json?.request_target_gene_id || dstGeneId).trim()
      setNeighbourhoodLinksByPair((prev) => ({ ...prev, [pairKey]: homologies }))
      setNeighbourhoodHomologyLinksByPair((prev) => ({ ...prev, [pairKey]: homologyLinks }))
      if (refGenes.length || targetGenes.length) {
        setNeighbourhoodTracksByGenome((prev) => {
          const next = { ...(prev || {}) }
          if (refGenes.length) {
            next[refKey] = mergeNeighbourhoodTrack(
              prev?.[refKey],
              refGenes,
              String(json?.center_ref_id || resolvedRefGeneId).trim(),
              resolvedRefGeneId,
              NEIGHBOURHOOD_FLANK_WINDOW_SIZE,
            )
          }
          if (targetGenes.length) {
            next[tgtKey] = mergeNeighbourhoodTrack(
              prev?.[tgtKey],
              targetGenes,
              String(json?.center_target_id || resolvedTargetGeneId).trim(),
              resolvedTargetGeneId,
              NEIGHBOURHOOD_FLANK_WINDOW_SIZE,
            )
          }
          return next
        })
      }
      setNeighbourhoodPairRequestByKey((prev) => ({
        ...prev,
        [pairKey]: {
          refGeneId: resolvedRefGeneId,
          targetGeneId: resolvedTargetGeneId,
          windowSize: NEIGHBOURHOOD_FLANK_WINDOW_SIZE,
          useHomology,
        },
      }))
      return json
    } catch (e) {
      if (e?.name === 'AbortError') return null
      if ((Number(neighbourhoodPairRequestSeqRef.current[pairKey]) || 0) !== reqSeq) return null
      console.error(`Neighbourhood pair fetch error (${pairKey}):`, e)
      return null
    } finally {
      if ((Number(neighbourhoodPairRequestSeqRef.current[pairKey]) || 0) !== reqSeq) return
      if (neighbourhoodPairAbortRef.current[pairKey] === controller) {
        delete neighbourhoodPairAbortRef.current[pairKey]
      }
      if (useHomology) {
        setNeighbourhoodHomologyPairLoading((prev) => {
          if (!prev?.[pairKey]) return prev
          const next = { ...prev }
          delete next[pairKey]
          return next
        })
      }
    }
  }, [])

  // Resolve a gene/transcript ID for either side
  const resolveInput = useCallback(async (side, query) => {
    const setSideLoading = side === 'ref' ? setRefLoading : setTgtLoading
    const setSideError = side === 'ref' ? setRefError : setTgtError
    const setSideResolved = side === 'ref' ? setRefResolved : setTgtResolved
    const genome = side === 'ref' ? 'reference' : 'target'

    // Focusing a gene pushes its name into this input, which then looks for the same gene
    // on the comparison side. During a tutorial that side is still the user's own
    // reference genome, and the gene is one of the demo genome's invented ones — so the
    // lookup can only fail, noisily, for something nobody asked for.
    if (isTutorialSandboxActive()) {
      setSideResolved(null)
      setSideError(null)
      return null
    }

    // With no annotation configured for this side there is nothing to resolve against,
    // so the request can only come back 404 — and the "Not found" it produces says the
    // gene is missing when really the side is simply unset.
    const configured = side === 'ref'
      ? configRef.current?.ref_gff
      : configRef.current?.target_gff
    if (!String(configured || '').trim()) {
      setSideResolved(null)
      setSideError(null)
      return null
    }

    setSideLoading(true)
    setSideError(null)

    try {
      const res = await fetch(
        `${API_BASE}/api/resolve_id?genome=${genome}&query=${encodeURIComponent(query.trim())}`
      )
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Not found')
      }
      const data = await res.json()
      const resolved = {
        query: data.query,
        resolvedType: data.resolved_type,
        gene: data.gene,
        transcripts: data.transcripts,
        selectedTranscriptId: data.selected_transcript_id,
      }
      setSideResolved(resolved)
      return resolved
    } catch (e) {
      setSideError(e.message)
      setSideResolved(null)
      return null
    } finally {
      setSideLoading(false)
    }
  }, [])

  const handleRefGeneSelect = useCallback((gene) => {
    if (gene?.name || gene?.id) {
      tutorialRuntime.emitSignal('browser.geneFocused', { gene: gene.name || gene.id })
    }
    setBrowserRefGene((prev) => {
      const next = mergeGeneFocus(prev, gene)
      return geneFocusSignature(prev) === geneFocusSignature(next) ? prev : next
    })
    if (refGenomeKey) {
      setBrowserFocusByGenome((prev) => updateGeneFocusMapEntry(prev, refGenomeKey, gene, browserRefGene))
    }
  }, [refGenomeKey, browserRefGene])

  const handleTgtGeneSelect = useCallback((gene) => {
    setBrowserTgtGene((prev) => {
      const next = mergeGeneFocus(prev, gene)
      return geneFocusSignature(prev) === geneFocusSignature(next) ? prev : next
    })
    if (tgtGenomeKey) {
      setBrowserFocusByGenome((prev) => updateGeneFocusMapEntry(prev, tgtGenomeKey, gene, browserTgtGene))
    }
  }, [tgtGenomeKey, browserTgtGene])

  const handleGenomeFocusGeneSelect = useCallback((genomeKey, gene) => {
    const key = String(genomeKey || '').trim()
    if (!key) return

    if (key === refGenomeKey) {
      handleRefGeneSelect(gene)
      if (gene?.name || gene?.id) {
        setRefInput(gene.name || gene.id)
      }
      return
    }

    if (key === tgtGenomeKey) {
      handleTgtGeneSelect(gene)
      if (gene?.name || gene?.id) {
        setTgtInput(gene.name || gene.id)
      }
      return
    }

    setBrowserFocusByGenome((prev) => updateGeneFocusMapEntry(prev, key, gene))
  }, [refGenomeKey, tgtGenomeKey, handleRefGeneSelect, handleTgtGeneSelect])

  const handleGenomeFocusLocationSelect = useCallback((genomeKey, location) => {
    const key = String(genomeKey || '').trim()
    if (!key || !location) return
    // A new object every time, so asking for the same region twice still
    // reaches the panel as a fresh request.
    setBrowserLocationFocusByGenome((prev) => ({ ...prev, [key]: { ...location } }))
  }, [])

  const handleClearAllFocusedGenes = useCallback(() => {
    setBrowserRefGene(null)
    setBrowserTgtGene(null)
    setBrowserFocusByGenome({})
  }, [])

  const handleNeighbourhoodLinkSelect = useCallback((payload = {}) => {
    const payloadGenesByGenome = payload?.genesByGenome && typeof payload.genesByGenome === 'object'
      ? payload.genesByGenome
      : null
    if (payloadGenesByGenome && Object.keys(payloadGenesByGenome).length > 0) {
      const focusUpdatesByGenome = {}
      const queryLabelByGenome = {}
      for (const [genomeKeyRaw, geneRaw] of Object.entries(payloadGenesByGenome)) {
        const genomeKey = String(genomeKeyRaw || '').trim()
        const gene = geneRaw || null
        const geneId = String(gene?.id || '').trim()
        if (!genomeKey || !geneId) continue
        focusUpdatesByGenome[genomeKey] = gene
        const label = String(gene?.name || gene?.id || '').trim()
        if (label) queryLabelByGenome[genomeKey] = label
      }

      const refGeneUpdate = refGenomeKey ? focusUpdatesByGenome[refGenomeKey] : null
      const tgtGeneUpdate = tgtGenomeKey ? focusUpdatesByGenome[tgtGenomeKey] : null
      if (refGeneUpdate) {
        setBrowserRefGene((prev) => {
          const next = mergeGeneFocus(prev, refGeneUpdate)
          return geneFocusSignature(prev) === geneFocusSignature(next) ? prev : next
        })
        if (refGeneUpdate?.name || refGeneUpdate?.id) {
          setRefInput(refGeneUpdate.name || refGeneUpdate.id)
        }
      }
      if (tgtGeneUpdate) {
        setBrowserTgtGene((prev) => {
          const next = mergeGeneFocus(prev, tgtGeneUpdate)
          return geneFocusSignature(prev) === geneFocusSignature(next) ? prev : next
        })
        if (tgtGeneUpdate?.name || tgtGeneUpdate?.id) {
          setTgtInput(tgtGeneUpdate.name || tgtGeneUpdate.id)
        }
      }

      setBrowserFocusByGenome((prev) => {
        let next = prev
        for (const [genomeKey, gene] of Object.entries(focusUpdatesByGenome)) {
          const fallbackGene = genomeKey === refGenomeKey
            ? browserRefGene
            : (genomeKey === tgtGenomeKey ? browserTgtGene : null)
          next = updateGeneFocusMapEntry(next, genomeKey, gene, fallbackGene)
        }
        return next
      })

      setNeighbourhoodQueryByGenome((prev) => {
        const next = { ...(prev || {}) }
        let changed = false
        for (const [genomeKey, label] of Object.entries(queryLabelByGenome)) {
          if (next[genomeKey] !== label) {
            next[genomeKey] = label
            changed = true
          }
        }
        return changed ? next : prev
      })
      return
    }

    const refGenome = String(payload?.refGenomeKey || '').trim()
    const tgtGenome = String(payload?.targetGenomeKey || '').trim()
    const referenceGene = payload?.referenceGene || null
    const targetGene = payload?.targetGene || null
    if (!refGenome || !tgtGenome || !referenceGene?.id || !targetGene?.id) return
    setNeighbourhoodQueryByGenome((prev) => ({
      ...prev,
      [refGenome]: referenceGene?.name || referenceGene?.id || prev?.[refGenome] || '',
      [tgtGenome]: targetGene?.name || targetGene?.id || prev?.[tgtGenome] || '',
    }))
    handleGenomeFocusGeneSelect(refGenome, referenceGene)
    handleGenomeFocusGeneSelect(tgtGenome, targetGene)
  }, [handleGenomeFocusGeneSelect, refGenomeKey, tgtGenomeKey, browserRefGene, browserTgtGene])

  const handleNeighbourhoodResolveGenome = useCallback(async (genomeKey, queryOverride = null) => {
    const key = String(genomeKey || '').trim()
    if (!key) return null
    const query = String(queryOverride != null ? queryOverride : neighbourhoodQueryByGenome?.[key] || '').trim()
    if (!query) return null

    setNeighbourhoodResolvingByGenome((prev) => ({ ...prev, [key]: true }))
    setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))
    try {
      const res = await fetch(`${API_BASE}/api/resolve_id?genome=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.detail || 'Not found')
      }
      const data = await res.json()
      const resolvedGene = data?.gene || null
      if (!resolvedGene?.id) throw new Error('No gene resolved')
      handleGenomeFocusGeneSelect(key, resolvedGene)
      const label = resolvedGene?.name || resolvedGene?.id || query
      setNeighbourhoodQueryByGenome((prev) => ({ ...prev, [key]: label }))
      setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))
      loadNeighbourhoodTrack(key, resolvedGene.id)
      return data
    } catch (e) {
      setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: e?.message || 'Resolve failed' }))
      return null
    } finally {
      setNeighbourhoodResolvingByGenome((prev) => ({ ...prev, [key]: false }))
    }
  }, [neighbourhoodQueryByGenome, handleGenomeFocusGeneSelect, loadNeighbourhoodTrack])

  const handleNeighbourhoodFlipGenome = useCallback((_genomeKey) => {
    // Flip state is currently local to the Neighbourhood view.
  }, [])

  useEffect(() => {
    const activeGenomes = dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3))
    const activeGenomeKeys = activeGenomes.map((species) => speciesItemKey(species)).filter(Boolean)
    const activeKeySet = new Set(activeGenomeKeys)
    setNeighbourhoodGenomeOrderKeys((prev) => {
      const current = Array.isArray(prev) ? prev : []
      const next = []
      const seen = new Set()
      for (const key of current) {
        if (!activeKeySet.has(key) || seen.has(key)) continue
        seen.add(key)
        next.push(key)
      }
      for (const key of activeGenomeKeys) {
        if (seen.has(key)) continue
        seen.add(key)
        next.push(key)
      }
      if (next.length === current.length && next.every((key, idx) => key === current[idx])) return prev
      return next
    })
    setNeighbourhoodDisabledByGenome((prev) => {
      const next = {}
      let changed = false
      for (const key of activeGenomeKeys) {
        if (prev?.[key]) next[key] = true
      }
      if (Object.keys(next).length !== Object.keys(prev || {}).length) changed = true
      if (!changed) {
        for (const [key, value] of Object.entries(next)) {
          if (Boolean(prev?.[key]) !== Boolean(value)) {
            changed = true
            break
          }
        }
      }
      return changed ? next : prev
    })
  }, [config?.active_species])

  const handleNeighbourhoodSwapAdjacent = useCallback((upperGenomeKey, lowerGenomeKey) => {
    const upperKey = String(upperGenomeKey || '').trim()
    const lowerKey = String(lowerGenomeKey || '').trim()
    if (!upperKey || !lowerKey || upperKey === lowerKey) return
    setNeighbourhoodGenomeOrderKeys((prev) => {
      const current = Array.isArray(prev) ? [...prev] : []
      const upperIdx = current.indexOf(upperKey)
      const lowerIdx = current.indexOf(lowerKey)
      if (upperIdx < 0 || lowerIdx < 0) return prev
      if (Math.abs(upperIdx - lowerIdx) !== 1) return prev
      const next = [...current]
      next[upperIdx] = lowerKey
      next[lowerIdx] = upperKey
      if (next.every((key, idx) => key === current[idx])) return prev
      return next
    })
  }, [])

  const handleNeighbourhoodToggleGenome = useCallback((genomeKey) => {
    const key = String(genomeKey || '').trim()
    if (!key) return
    setNeighbourhoodDisabledByGenome((prev) => {
      const currentlyDisabled = Boolean(prev?.[key])
      if (currentlyDisabled) {
        if (!Object.prototype.hasOwnProperty.call(prev || {}, key)) return prev
        const next = { ...(prev || {}) }
        delete next[key]
        return next
      }
      return { ...(prev || {}), [key]: true }
    })
  }, [])

  // Select a different transcript from the expanded list
  const selectTranscript = useCallback((side, transcriptId) => {
    const setSideResolved = side === 'ref' ? setRefResolved : setTgtResolved
    setSideResolved(prev => prev ? { ...prev, selectedTranscriptId: transcriptId } : prev)
  }, [])

  // Execute alignment
  const executeAlignment = async (refId, targetId) => {
    if (!refId || !targetId) return

    setLoading(true)
    setError(null)

    try {
      const alignPromise = fetch(`${API_BASE}/api/align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript_id: refId,
          target_transcript_id: targetId,
          ref_flank_bp: refFlankBp,
          tgt_flank_bp: tgtFlankBp
        })
      })

      const res = await alignPromise
      if (!res.ok) {
        const errData = await res.json()
        throw new Error(errData.detail || 'Failed to load alignment')
      }

      const data = await res.json()
      setAlignment(data)

      setLoadedParams({ refId, targetId, refFlank: refFlankBp, tgtFlank: tgtFlankBp })
      fetchRecent()
    } catch (e) {
      setError(e.message)
      setAlignment(null)
      setMultiAlignmentResult(null)
      setLastSuccessfulMultiAlignmentSignature('')
      setAlignmentViewError(null)
    } finally {
      setLoading(false)
    }
  }

  // Run alignment with currently selected transcripts
  const handleRunAlignment = useCallback(() => {
    const refTx = refResolved?.selectedTranscriptId
    const tgtTx = tgtResolved?.selectedTranscriptId
    if (!refTx || !tgtTx) return
    executeAlignment(refTx, tgtTx)
  }, [refResolved?.selectedTranscriptId, tgtResolved?.selectedTranscriptId, refFlankBp, tgtFlankBp])

  // Load from history
  const loadFromHistory = async (refId, targetId) => {
    setRefInput(refId)
    setTgtInput(targetId)
    // Resolve both for UI display (fire and forget)
    resolveInput('ref', refId)
    resolveInput('tgt', targetId)
    // Execute immediately with known IDs
    executeAlignment(refId, targetId)
  }

  // Auto-populate alignment inputs when browser genes change
  useEffect(() => {
    const focusKey = `${normalizeGeneToken(browserRefGene?.id)}|${normalizeGeneToken(browserRefGene?.name)}`
    const focusChanged = lastRefFocusKeyRef.current !== focusKey
    if (lastRefFocusKeyRef.current !== focusKey) {
      lastRefFocusKeyRef.current = focusKey
    }
    if (!browserRefGene) {
      refResolveInFlightQueryRef.current = ''
      refLastResolvedQueryRef.current = ''
      return
    }
    if (focusChanged) {
      const display = browserRefGene.name || browserRefGene.id
      setRefInput(display)
    }

    // In multi-alignment and neighbourhood views, browser focus is already the source
    // of truth, so avoid re-resolving IDs and stomping manual text edits.
    if (currentView === 'alignment' || currentView === 'neighbourhood') {
      return
    }

    // Legacy pairwise flow: new gene selection invalidates displayed alignment.
    setAlignment(null)
    setLoadedParams(null)
    setError(null)
    const query = browserRefGene.id || browserRefGene.name
    const queryNorm = String(query || '').trim().toLowerCase()
    if (!queryNorm) return

    if (
      refResolveInFlightQueryRef.current === queryNorm ||
      refLastResolvedQueryRef.current === queryNorm
    ) {
      return
    }

    refResolveInFlightQueryRef.current = queryNorm
    let cancelled = false
    resolveInput('ref', query).then((resolved) => {
      if (cancelled || !resolved?.gene || !queryNorm) return
      refLastResolvedQueryRef.current = queryNorm
      setBrowserRefGene((prev) => {
        if (!prev || hasFiniteGeneCoords(prev)) return prev
        const prevId = String(prev.id || '').trim().toLowerCase()
        const prevName = String(prev.name || '').trim().toLowerCase()
        const resolvedId = String(resolved.gene.id || '').trim().toLowerCase()
        const resolvedName = String(resolved.gene.name || '').trim().toLowerCase()
        const matches = prevId === queryNorm || prevName === queryNorm || resolvedId === queryNorm || resolvedName === queryNorm
        if (!matches || !hasFiniteGeneCoords(resolved.gene)) return prev
        return mergeGeneFocus(prev, resolved.gene)
      })
    }).finally(() => {
      if (refResolveInFlightQueryRef.current === queryNorm) {
        refResolveInFlightQueryRef.current = ''
      }
    })
    return () => {
      cancelled = true
    }
  }, [browserRefGene, currentView, resolveInput])

  useEffect(() => {
    const focusKey = `${normalizeGeneToken(browserTgtGene?.id)}|${normalizeGeneToken(browserTgtGene?.name)}`
    const focusChanged = lastTgtFocusKeyRef.current !== focusKey
    if (lastTgtFocusKeyRef.current !== focusKey) {
      lastTgtFocusKeyRef.current = focusKey
    }
    if (!browserTgtGene) {
      tgtResolveInFlightQueryRef.current = ''
      tgtLastResolvedQueryRef.current = ''
      return
    }
    if (focusChanged) {
      const display = browserTgtGene.name || browserTgtGene.id
      setTgtInput(display)
    }

    // In multi-alignment and neighbourhood views, browser focus is already the source
    // of truth, so avoid re-resolving IDs and stomping manual text edits.
    if (currentView === 'alignment' || currentView === 'neighbourhood') {
      return
    }

    // Legacy pairwise flow: new gene selection invalidates displayed alignment.
    setAlignment(null)
    setLoadedParams(null)
    setError(null)
    const query = browserTgtGene.id || browserTgtGene.name
    const queryNorm = String(query || '').trim().toLowerCase()
    if (!queryNorm) return

    if (
      tgtResolveInFlightQueryRef.current === queryNorm ||
      tgtLastResolvedQueryRef.current === queryNorm
    ) {
      return
    }

    tgtResolveInFlightQueryRef.current = queryNorm
    let cancelled = false
    resolveInput('tgt', query).then((resolved) => {
      if (cancelled || !resolved?.gene || !queryNorm) return
      tgtLastResolvedQueryRef.current = queryNorm
      setBrowserTgtGene((prev) => {
        if (!prev || hasFiniteGeneCoords(prev)) return prev
        const prevId = String(prev.id || '').trim().toLowerCase()
        const prevName = String(prev.name || '').trim().toLowerCase()
        const resolvedId = String(resolved.gene.id || '').trim().toLowerCase()
        const resolvedName = String(resolved.gene.name || '').trim().toLowerCase()
        const matches = prevId === queryNorm || prevName === queryNorm || resolvedId === queryNorm || resolvedName === queryNorm
        if (!matches || !hasFiniteGeneCoords(resolved.gene)) return prev
        return mergeGeneFocus(prev, resolved.gene)
      })
    }).finally(() => {
      if (tgtResolveInFlightQueryRef.current === queryNorm) {
        tgtResolveInFlightQueryRef.current = ''
      }
    })
    return () => {
      cancelled = true
    }
  }, [browserTgtGene, currentView, resolveInput])

  // Auto-load neighbourhood rows from shared focus state for all active genomes.
  useEffect(() => {
    if (currentView !== 'neighbourhood') return

    const activeGenomesUnordered = dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3))
    const byGenomeKey = new Map(activeGenomesUnordered.map((species) => [speciesItemKey(species), species]))
    const activeGenomes = []
    const seenGenomeKeys = new Set()
    for (const key of neighbourhoodGenomeOrderKeys) {
      const species = byGenomeKey.get(key)
      if (!species || seenGenomeKeys.has(key)) continue
      seenGenomeKeys.add(key)
      activeGenomes.push(species)
    }
    for (const species of activeGenomesUnordered) {
      const key = speciesItemKey(species)
      if (!key || seenGenomeKeys.has(key)) continue
      seenGenomeKeys.add(key)
      activeGenomes.push(species)
    }
    const activeGenomeKeys = activeGenomes.map((species) => speciesItemKey(species)).filter(Boolean)
    const activeGenomeKeySet = new Set(activeGenomeKeys)
    const enabledGenomeKeys = activeGenomeKeys.filter((key) => !Boolean(neighbourhoodDisabledByGenome?.[key]))

    const getFocusGeneForGenome = (genomeKey) => {
      const key = String(genomeKey || '').trim()
      if (!key) return null
      if (key === refGenomeKey) return browserRefGene || browserFocusByGenome?.[key] || null
      if (key === tgtGenomeKey) return browserTgtGene || browserFocusByGenome?.[key] || null
      return browserFocusByGenome?.[key] || null
    }

    setNeighbourhoodTracksByGenome((prev) => {
      const next = {}
      for (const key of Object.keys(prev || {})) {
        if (activeGenomeKeySet.has(key)) next[key] = prev[key]
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodLoadingByGenome((prev) => {
      const next = {}
      for (const key of Object.keys(prev || {})) {
        if (activeGenomeKeySet.has(key)) next[key] = prev[key]
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodResolvingByGenome((prev) => {
      const next = {}
      for (const key of Object.keys(prev || {})) {
        if (activeGenomeKeySet.has(key)) next[key] = prev[key]
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodErrorByGenome((prev) => {
      const next = {}
      for (const key of Object.keys(prev || {})) {
        if (activeGenomeKeySet.has(key)) next[key] = prev[key]
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodQueryByGenome((prev) => {
      const next = {}
      let changed = false
      for (const key of activeGenomeKeys) {
        const focusGene = getFocusGeneForGenome(key)
        const fallback = focusGene ? String(focusGene.name || focusGene.id || '').trim() : ''
        const existing = String(prev?.[key] || '').trim()
        const value = fallback || existing
        if (value) next[key] = value
        if (value !== existing) changed = true
      }
      if (!changed && Object.keys(next).length === Object.keys(prev || {}).length) return prev
      return next
    })

    for (const key of Object.keys(neighbourhoodTrackAbortRef.current || {})) {
      if (activeGenomeKeySet.has(key)) continue
      try { neighbourhoodTrackAbortRef.current[key]?.abort() } catch { }
      delete neighbourhoodTrackAbortRef.current[key]
      delete neighbourhoodTrackRequestSeqRef.current[key]
    }

    for (const genomeKey of activeGenomeKeys) {
      if (Boolean(neighbourhoodDisabledByGenome?.[genomeKey])) continue
      const focusGene = getFocusGeneForGenome(genomeKey)
      const focusGeneId = String(focusGene?.id || '').trim()
      if (!focusGeneId) {
        setNeighbourhoodTracksByGenome((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev || {}, genomeKey)) return prev
          const next = { ...(prev || {}) }
          delete next[genomeKey]
          return next
        })
        continue
      }
      const loadedRequestGeneId = String(neighbourhoodTracksByGenome?.[genomeKey]?.requestGeneId || '').trim()
      const loadedWindowSize = Number(neighbourhoodTracksByGenome?.[genomeKey]?.windowSize || 0)
      if (loadedRequestGeneId === focusGeneId && loadedWindowSize >= NEIGHBOURHOOD_FLANK_WINDOW_SIZE) continue
      loadNeighbourhoodTrack(genomeKey, focusGeneId)
    }

    const validPairKeys = new Set()
    for (let idx = 0; idx < enabledGenomeKeys.length - 1; idx += 1) {
      const refKey = enabledGenomeKeys[idx]
      const tgtKey = enabledGenomeKeys[idx + 1]
      const pairKey = buildNeighbourhoodPairKey(refKey, tgtKey)
      if (!pairKey) continue
      validPairKeys.add(pairKey)
      const refFocusGeneId = String(getFocusGeneForGenome(refKey)?.id || '').trim()
      const tgtFocusGeneId = String(getFocusGeneForGenome(tgtKey)?.id || '').trim()
      if (!refFocusGeneId || !tgtFocusGeneId) {
        setNeighbourhoodLinksByPair((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev || {}, pairKey)) return prev
          const next = { ...(prev || {}) }
          delete next[pairKey]
          return next
        })
        setNeighbourhoodPairRequestByKey((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev || {}, pairKey)) return prev
          const next = { ...(prev || {}) }
          delete next[pairKey]
          return next
        })
        continue
      }
      const requestMeta = neighbourhoodPairRequestByKey?.[pairKey] || null
      if (
        String(requestMeta?.refGeneId || '').trim() === refFocusGeneId &&
        String(requestMeta?.targetGeneId || '').trim() === tgtFocusGeneId &&
        Number(requestMeta?.windowSize || 0) >= NEIGHBOURHOOD_FLANK_WINDOW_SIZE &&
        Boolean(requestMeta?.useHomology) === Boolean(neighbourhoodUseHomology)
      ) {
        continue
      }
      loadNeighbourhoodPairLinks({
        refGenomeKey: refKey,
        targetGenomeKey: tgtKey,
        refGeneId: refFocusGeneId,
        targetGeneId: tgtFocusGeneId,
        useHomology: neighbourhoodUseHomology,
      })
    }

    for (const pairKey of Object.keys(neighbourhoodPairAbortRef.current || {})) {
      if (validPairKeys.has(pairKey)) continue
      try { neighbourhoodPairAbortRef.current[pairKey]?.abort() } catch { }
      delete neighbourhoodPairAbortRef.current[pairKey]
      delete neighbourhoodPairRequestSeqRef.current[pairKey]
    }
    setNeighbourhoodLinksByPair((prev) => {
      const next = {}
      for (const [key, value] of Object.entries(prev || {})) {
        if (validPairKeys.has(key)) next[key] = value
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
    setNeighbourhoodPairRequestByKey((prev) => {
      const next = {}
      for (const [key, value] of Object.entries(prev || {})) {
        if (validPairKeys.has(key)) next[key] = value
      }
      return Object.keys(next).length === Object.keys(prev || {}).length ? prev : next
    })
  }, [
    currentView,
    config?.active_species,
    neighbourhoodGenomeOrderKeys,
    browserFocusByGenome,
    browserRefGene,
    browserTgtGene,
    refGenomeKey,
    tgtGenomeKey,
    neighbourhoodDisabledByGenome,
    neighbourhoodTracksByGenome,
    neighbourhoodPairRequestByKey,
    neighbourhoodUseHomology,
    loadNeighbourhoodTrack,
    loadNeighbourhoodPairLinks,
  ])

  useEffect(() => {
    return () => {
      for (const controller of Object.values(neighbourhoodTrackAbortRef.current || {})) {
        try { controller?.abort() } catch { }
      }
      for (const controller of Object.values(neighbourhoodPairAbortRef.current || {})) {
        try { controller?.abort() } catch { }
      }
      neighbourhoodTrackAbortRef.current = {}
      neighbourhoodPairAbortRef.current = {}
      neighbourhoodTrackRequestSeqRef.current = {}
      neighbourhoodPairRequestSeqRef.current = {}

      neighbourhoodRequestSeqRef.current += 1
      if (neighbourhoodAbortRef.current) {
        neighbourhoodAbortRef.current.abort()
        neighbourhoodAbortRef.current = null
      }
    }
  }, [])

  const buildAlignmentInputRow = useCallback((species, index, previousRow = null) => {
    const genomeKey = speciesItemKey(species)
    const tag = `G${index + 1}`
    const fallbackLabel = buildGenomePillLabel(species) || `${tag} ${species?.species_key || 'Genome'}`
    const prevSettings = previousRow?.settings || {}
    const selectedTranscriptId = prevSettings.selectedTranscriptId || previousRow?.resolved?.selectedTranscriptId || ''
    return {
      genome_key: genomeKey,
      genome_param: genomeKey,
      tag,
      pillLabel: fallbackLabel,
      query: previousRow?.query || '',
      status: previousRow?.status || 'idle',
      error: previousRow?.error || '',
      include: true,
      resolved: previousRow?.resolved || null,
      settings: {
        useGlobalFlanks: prevSettings.useGlobalFlanks ?? true,
        useGeneBoundaries: prevSettings.useGeneBoundaries ?? true,
        flank5: Number.isFinite(Number(prevSettings.flank5)) ? Number(prevSettings.flank5) : 100,
        flank3: Number.isFinite(Number(prevSettings.flank3)) ? Number(prevSettings.flank3) : 100,
        flankMax: Number.isFinite(Number(prevSettings.flankMax)) ? Math.max(100, Number(prevSettings.flankMax)) : 1000,
        flanksLocked: prevSettings.flanksLocked ?? true,
        overlayAnnotation: prevSettings.overlayAnnotation ?? true,
        selectedTranscriptId,
      },
      lastAutoQuery: previousRow?.lastAutoQuery || '',
    }
  }, [])

  useEffect(() => {
    const activeSpecies = dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3))
    setAlignmentInputs((prev) => {
      const byKey = new Map((prev || []).map((row) => [row.genome_key, row]))
      return activeSpecies.map((species, idx) => buildAlignmentInputRow(species, idx, byKey.get(speciesItemKey(species)) || null))
    })
  }, [config?.active_species, buildAlignmentInputRow])

  useEffect(() => {
    const keys = (alignmentInputs || []).map((row) => String(row.genome_key || '').trim()).filter(Boolean)
    if (keys.length === 0) return
    if (!keys.includes(String(collapseSource || '').trim())) {
      setCollapseSource(keys[0])
    }
  }, [alignmentInputs, collapseSource])

  const resolveAlignmentInput = useCallback(async (genomeKey, queryOverride = null, options = {}) => {
    const row = (alignmentInputsRef.current || []).find((item) => item.genome_key === genomeKey)
    if (!row) return null
    const query = String(queryOverride != null ? queryOverride : row.query || '').trim()
    if (!query) return null

    const requestToken = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    alignmentResolveRequestTokenRef.current[genomeKey] = requestToken
    try {
      alignmentResolveControllersRef.current[genomeKey]?.abort()
    } catch { }
    const controller = new AbortController()
    alignmentResolveControllersRef.current[genomeKey] = controller
    setAlignmentInputs((prev) => prev.map((item) => (
      item.genome_key === genomeKey
        ? { ...item, status: 'resolving', error: '' }
        : item
    )))

    try {
      const res = await fetch(
        `${API_BASE}/api/resolve_id?genome=${encodeURIComponent(genomeKey)}&query=${encodeURIComponent(query)}`,
        { signal: controller.signal }
      )
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err?.detail || 'Not found')
      }
      const data = await res.json()
      const resolvedTranscripts = Array.isArray(data.transcripts) ? data.transcripts : []
      const fallbackSelectedTranscriptId = String(
        data.selected_transcript_id
        || resolvedTranscripts.find((tx) => tx?.is_canonical)?.id
        || resolvedTranscripts[0]?.id
        || ''
      ).trim()
      const resolved = {
        query: data.query,
        resolvedType: data.resolved_type,
        gene: data.gene,
        transcripts: resolvedTranscripts,
        selectedTranscriptId: fallbackSelectedTranscriptId,
      }
      if (alignmentResolveRequestTokenRef.current[genomeKey] !== requestToken) return null
      const preferredSelectedTranscriptId = String(options?.selectedTranscriptId || '').trim()
      setAlignmentInputs((prev) => prev.map((item) => {
        if (item.genome_key !== genomeKey) return item
        const currentSelectedTranscriptId = String(item.settings?.selectedTranscriptId || '').trim()
        const hasCurrentSelectedTranscript = currentSelectedTranscriptId
          ? resolved.transcripts?.some((tx) => String(tx?.id || '').trim() === currentSelectedTranscriptId)
          : false
        const hasPreferredSelectedTranscript = preferredSelectedTranscriptId
          ? resolved.transcripts?.some((tx) => String(tx?.id || '').trim() === preferredSelectedTranscriptId)
          : false
        const nextSelected = String(
          (options?.preferSelectedTranscriptId && hasPreferredSelectedTranscript ? preferredSelectedTranscriptId : '')
          || (hasCurrentSelectedTranscript ? currentSelectedTranscriptId : '')
          || (hasPreferredSelectedTranscript ? preferredSelectedTranscriptId : '')
          || resolved.selectedTranscriptId
          || resolved.transcripts?.find((tx) => tx?.is_canonical)?.id
          || resolved.transcripts?.[0]?.id
          || ''
        ).trim()
        return {
          ...item,
          query,
          status: 'resolved',
          error: '',
          include: true,
          resolved,
          settings: {
            ...(item.settings || {}),
            selectedTranscriptId: nextSelected,
          },
          lastAutoQuery: options?.auto ? String(query).toLowerCase() : item.lastAutoQuery,
        }
      }))
      return resolved
    } catch (e) {
      if (alignmentResolveRequestTokenRef.current[genomeKey] !== requestToken) return null
      const message = e?.message || 'Resolve failed'
      setAlignmentInputs((prev) => prev.map((item) => (
        item.genome_key === genomeKey
          ? { ...item, status: 'error', error: message, include: true, resolved: null }
          : item
      )))
      return null
    } finally {
      if (alignmentResolveControllersRef.current[genomeKey] === controller) {
        delete alignmentResolveControllersRef.current[genomeKey]
      }
    }
  }, [])

  const cancelAlignmentInputResolve = useCallback((genomeKey) => {
    const controller = alignmentResolveControllersRef.current[genomeKey]
    if (controller) {
      try { controller.abort() } catch { }
      delete alignmentResolveControllersRef.current[genomeKey]
    }
    alignmentResolveRequestTokenRef.current[genomeKey] = `cancelled-${Date.now()}`
    setAlignmentInputs((prev) => prev.map((item) => (
      item.genome_key === genomeKey && item.status === 'resolving'
        ? { ...item, status: 'idle', error: '' }
        : item
    )))
  }, [])

  const handleAlignmentResolveRow = useCallback((genomeKey) => {
    const row = (alignmentInputsRef.current || []).find((item) => item.genome_key === genomeKey)
    if (!row) return
    if (row.status === 'resolving') {
      cancelAlignmentInputResolve(genomeKey)
      return
    }
    resolveAlignmentInput(genomeKey)
  }, [cancelAlignmentInputResolve, resolveAlignmentInput])

  useEffect(() => {
    const rows = alignmentInputsRef.current || []
    if (!rows.length) return
    rows.forEach((row, idx) => {
      const genomeKey = row.genome_key
      const focus = (idx === 0 ? browserRefGene : (idx === 1 ? browserTgtGene : null))
        || browserFocusByGenome?.[genomeKey]
      const token = String(focus?.name || focus?.id || '').trim()
      if (!token) return
      const tokenNorm = token.toLowerCase()
      const currentNorm = String(row.query || '').trim().toLowerCase()
      const alreadyAuto = String(row.lastAutoQuery || '') === tokenNorm
      if (alreadyAuto && currentNorm === tokenNorm && row.status === 'resolved') return
      if (alreadyAuto && currentNorm === tokenNorm && row.status === 'resolving') return

      setAlignmentInputs((prev) => prev.map((item) => (
        item.genome_key === genomeKey
          ? { ...item, query: token, lastAutoQuery: tokenNorm }
          : item
      )))
      resolveAlignmentInput(genomeKey, token, { auto: true })
    })
  }, [browserFocusByGenome, browserRefGene, browserTgtGene, resolveAlignmentInput])

  const handleAlignmentRowQueryChange = useCallback((genomeKey, value) => {
    setAlignmentInputs((prev) => prev.map((row) => (
      row.genome_key === genomeKey
        ? {
          ...row,
          query: value,
          status: value ? 'idle' : row.status,
          error: value ? '' : row.error,
          resolved: value ? null : row.resolved,
          settings: value
            ? { ...(row.settings || {}), selectedTranscriptId: '' }
            : row.settings,
        }
        : row
    )))
  }, [])

  const handleAlignmentGlobalFlanksChange = useCallback((patch) => {
    setAlignmentGlobalFlanks((prev) => {
      const incoming = { ...(patch || {}) }
      const max = Math.max(100, Number(alignmentGlobalFlankMax) || 1000)
      const hasF5 = Object.prototype.hasOwnProperty.call(incoming, 'flank5')
      const hasF3 = Object.prototype.hasOwnProperty.call(incoming, 'flank3')
      let flank5 = hasF5 ? Math.max(0, Number(incoming.flank5) || 0) : Number(prev.flank5 || 0)
      let flank3 = hasF3 ? Math.max(0, Number(incoming.flank3) || 0) : Number(prev.flank3 || 0)

      if (alignmentGlobalFlanksLocked) {
        if (hasF5 && !hasF3) {
          flank3 = flank5
        } else if (hasF3 && !hasF5) {
          flank5 = flank3
        } else if (hasF5 && hasF3) {
          flank3 = flank5
        }
      }

      return {
        flank5: Math.min(max, flank5),
        flank3: Math.min(max, flank3),
      }
    })
  }, [alignmentGlobalFlankMax, alignmentGlobalFlanksLocked])

  const handleAlignmentGlobalFlankMaxChange = useCallback((nextMaxRaw) => {
    const nextMax = Math.max(100, Number(nextMaxRaw) || 1000)
    setAlignmentGlobalFlankMax(nextMax)
    setAlignmentGlobalFlanks((prev) => ({
      flank5: Math.min(nextMax, Math.max(0, Number(prev.flank5) || 0)),
      flank3: Math.min(nextMax, Math.max(0, Number(prev.flank3) || 0)),
    }))
  }, [])

  const handleAlignmentGlobalFlanksLockToggle = useCallback(() => {
    setAlignmentGlobalFlanksLocked((prevLocked) => {
      const nextLocked = !prevLocked
      if (nextLocked) {
        setAlignmentGlobalFlanks((prev) => ({ flank5: prev.flank5, flank3: prev.flank5 }))
      }
      return nextLocked
    })
  }, [])

  const handleAlignmentRowSettingChange = useCallback((genomeKey, patch) => {
    setAlignmentInputs((prev) => prev.map((row) => {
      if (row.genome_key !== genomeKey) return row
      const current = { ...(row.settings || {}) }
      const incoming = { ...(patch || {}) }
      const resolvedMax = Number.isFinite(Number(incoming.flankMax))
        ? Math.max(100, Number(incoming.flankMax))
        : (Number.isFinite(Number(current.flankMax)) ? Math.max(100, Number(current.flankMax)) : 1000)

      let flank5 = Number.isFinite(Number(incoming.flank5))
        ? Math.max(0, Number(incoming.flank5))
        : (Number.isFinite(Number(current.flank5)) ? Math.max(0, Number(current.flank5)) : 100)
      let flank3 = Number.isFinite(Number(incoming.flank3))
        ? Math.max(0, Number(incoming.flank3))
        : (Number.isFinite(Number(current.flank3)) ? Math.max(0, Number(current.flank3)) : 100)

      const lockFromPatch = Object.prototype.hasOwnProperty.call(incoming, 'flanksLocked')
        ? Boolean(incoming.flanksLocked)
        : Boolean(current.flanksLocked ?? true)

      if (lockFromPatch) {
        const hasF5 = Object.prototype.hasOwnProperty.call(incoming, 'flank5')
        const hasF3 = Object.prototype.hasOwnProperty.call(incoming, 'flank3')
        if (hasF5 && !hasF3) {
          flank3 = flank5
        } else if (hasF3 && !hasF5) {
          flank5 = flank3
        } else if (!hasF5 && !hasF3 && Object.prototype.hasOwnProperty.call(incoming, 'flanksLocked')) {
          flank3 = flank5
        } else if (hasF5 && hasF3) {
          flank3 = flank5
        }
      }

      flank5 = Math.min(resolvedMax, flank5)
      flank3 = Math.min(resolvedMax, flank3)

      const nextSettings = {
        ...current,
        ...incoming,
        flankMax: resolvedMax,
        flanksLocked: lockFromPatch,
        flank5,
        flank3,
      }
      const nextSelectedTranscriptId = String(nextSettings.selectedTranscriptId || '').trim()
      const nextResolved = row.resolved
        ? {
          ...row.resolved,
          selectedTranscriptId: nextSelectedTranscriptId || row.resolved.selectedTranscriptId || '',
        }
        : row.resolved
      return { ...row, settings: nextSettings, resolved: nextResolved }
    }))
  }, [])

  const handleAlignmentRunSettingsChange = useCallback((patch) => {
    setAlignmentRunSettings((prev) => ({ ...prev, ...(patch || {}), profile: 'balanced' }))
  }, [])

  const buildPairwiseOverlayFromMulti = useCallback((multiResult) => {
    const rows = multiResult?.rows || []
    if (rows.length < 2) return null
    const first = rows[0]
    const second = rows[1]
    const seq1 = String(first.aligned_sequence || '')
    const seq2 = String(second.aligned_sequence || '')
    if (!seq1 || !seq2 || seq1.length !== seq2.length) return null

    let matches = 0
    let denom = 0
    let gaps = 0
    for (let i = 0; i < seq1.length; i += 1) {
      const a = seq1[i]
      const b = seq2[i]
      if (a === '-' || b === '-') {
        gaps += 1
      } else {
        denom += 1
        if (a === b) matches += 1
      }
    }
    const identity = denom > 0 ? (matches / denom) * 100 : 0
    return {
      transcript_id: first.transcript_id || '',
      target_transcript_id: second.transcript_id || '',
      reference: {
        name: first.tag || 'reference',
        sequence: seq1,
        features: first.features || [],
        chrom: first.chrom || '',
        genomic_start: Number(first.genomic_start || 0),
        genomic_end: Number(first.genomic_end || 0),
        strand: first.strand || '+',
      },
      target: {
        name: second.tag || 'target',
        sequence: seq2,
        features: second.features || [],
        chrom: second.chrom || '',
        genomic_start: Number(second.genomic_start || 0),
        genomic_end: Number(second.genomic_end || 0),
        strand: second.strand || '+',
      },
      alignment_length: seq1.length,
      identity,
      gaps,
      timestamp: multiResult?.timestamp || new Date().toISOString(),
    }
  }, [])

  const buildResolvedAlignmentSignature = useCallback((rows, globalFlanksSource) => {
    const flankSource = globalFlanksSource || { flank5: 100, flank3: 100 }
    const normalized = (rows || []).map((row, idx) => {
      const useGlobal = row.settings?.useGlobalFlanks !== false
      const flank5 = useGlobal ? flankSource.flank5 : row.settings?.flank5
      const flank3 = useGlobal ? flankSource.flank3 : row.settings?.flank3
      const bestQuery = String(
        row.query
        || row.resolved?.query
        || row.resolved?.gene?.id
        || row.resolved?.gene?.name
        || ''
      ).trim()
      const transcriptId = String(
        row.settings?.selectedTranscriptId
        || row.resolved?.selectedTranscriptId
        || row.resolved?.transcripts?.find((tx) => tx?.is_canonical)?.id
        || row.resolved?.transcripts?.[0]?.id
        || ''
      ).trim()
      const include = row.status === 'resolved' && Boolean(transcriptId || bestQuery)
      if (!include) return null
      return {
        genome_key: String(row.genome_key || ''),
        tag: String(row.tag || `G${idx + 1}`),
        query: bestQuery,
        transcript_id: transcriptId,
        use_gene_boundaries: row.settings?.useGeneBoundaries !== false,
        flank_5_bp: Math.max(0, parseInt(flank5 || 0, 10) || 0),
        flank_3_bp: Math.max(0, parseInt(flank3 || 0, 10) || 0),
        overlay_annotation: Boolean(row.settings?.overlayAnnotation),
      }
    }).filter(Boolean)
    return JSON.stringify(normalized)
  }, [])

  const runMultiAlignment = useCallback(async () => {
    // Use the rows from the render that supplied this click handler. In
    // particular, this guarantees that the transcript shown in the controlled
    // select is the transcript sent to the backend.
    const rows = alignmentInputs || []
    if (!rows.length) return
    const runSignature = buildResolvedAlignmentSignature(rows, alignmentGlobalFlanks)
    const nextLoadedBaseline = {}

    const payloadRows = rows.map((row) => {
      const useGlobal = row.settings?.useGlobalFlanks !== false
      const flank5 = useGlobal ? alignmentGlobalFlanks.flank5 : row.settings?.flank5
      const flank3 = useGlobal ? alignmentGlobalFlanks.flank3 : row.settings?.flank3
      const bestQuery = String(
        row.query
        || row.resolved?.query
        || row.resolved?.gene?.id
        || row.resolved?.gene?.name
        || ''
      ).trim()
      const transcriptQueryFallback = String(
        row.resolved?.resolvedType === 'transcript'
          ? (bestQuery || row.resolved?.query || '')
          : ''
      ).trim()
      const chosenTranscriptId = String(
        row.settings?.selectedTranscriptId
        || row.resolved?.selectedTranscriptId
        || row.resolved?.transcripts?.find((tx) => tx?.is_canonical)?.id
        || row.resolved?.transcripts?.[0]?.id
        || transcriptQueryFallback
        || ''
      ).trim()
      if (String(row.genome_key || '').trim()) {
        nextLoadedBaseline[String(row.genome_key || '').trim()] = {
          genomeKey: String(row.genome_key || '').trim(),
          query: bestQuery,
          geneId: String(row.resolved?.gene?.id || '').trim(),
          geneName: String(row.resolved?.gene?.name || '').trim(),
          selectedTranscriptId: chosenTranscriptId,
        }
      }
      return {
        genome: row.genome_param || row.genome_key,
        genome_key: row.genome_key,
        tag: row.tag,
        query: bestQuery,
        include: Boolean(chosenTranscriptId || bestQuery),
        transcript_id: chosenTranscriptId,
        selected_transcript_id: chosenTranscriptId,
        use_gene_boundaries: row.settings?.useGeneBoundaries !== false,
        flank_5_bp: Math.max(0, parseInt(flank5 || 0, 10) || 0),
        flank_3_bp: Math.max(0, parseInt(flank3 || 0, 10) || 0),
        overlay_annotation: Boolean(row.settings?.overlayAnnotation),
      }
    })

    setAlignmentViewLoading(true)
    setAlignmentViewError(null)
    try {
      const res = await fetch(`${API_BASE}/api/align/multi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: payloadRows,
          run_scope: 'resolved_subset',
          run_settings: {
            ...alignmentRunSettings,
            profile: 'balanced',
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data?.detail || 'Failed to run multi alignment')
      }
      const alignedRows = Array.isArray(data?.rows) ? data.rows : []
      const includedCount = Number.isFinite(Number(data?.included_count))
        ? Number(data.included_count)
        : alignedRows.length
      if (includedCount < 2 || alignedRows.length < 2) {
        const warningMessage = Array.isArray(data?.warnings) && data.warnings.length > 0
          ? String(data.warnings[0] || '').trim()
          : ''
        throw new Error(warningMessage || 'Need at least two resolved genomes with selected transcripts to run alignment.')
      }
      setLoadedAlignmentBaselineByGenome(nextLoadedBaseline)
      setMultiAlignmentResult(data)
      setLastSuccessfulMultiAlignmentSignature(runSignature)
      // Bridge from alignment view to browser alignment overlay is disabled for now.
      setAlignmentOverlay(null)
    } catch (e) {
      setAlignmentViewError(e?.message || 'Failed to run multi alignment')
    } finally {
      setAlignmentViewLoading(false)
    }
  }, [alignmentInputs, alignmentRunSettings, alignmentGlobalFlanks, buildResolvedAlignmentSignature])

  // Build a map of genome_key → full species object from active_species for use in save modal
  const activeSpeciesByKey = useMemo(() => {
    const map = new Map()
    for (const s of dedupeSpeciesList(config?.active_species || [])) {
      map.set(speciesItemKey(s), s)
    }
    return map
  }, [config?.active_species])

  useEffect(() => {
    if (multiAlignmentResult) return
    setLoadedAlignmentBaselineByGenome({})
  }, [multiAlignmentResult])

  const handleSaveAlignment = useCallback(() => {
    if (!multiAlignmentResult) return
    setSaveAlignmentModalOpen(true)
  }, [multiAlignmentResult])

  const handleDoSaveAlignment = useCallback(async ({ name }) => {
    if (!multiAlignmentResult) return { ok: false, error: 'No alignment result' }
    const outputDir = config?.output_dir || ''
    if (!outputDir) return { ok: false, error: 'Output directory not configured' }

    // Build aligned_sequences map and genomes list from the result rows
    const alignedSequences = {}
    const genomes = []
    for (const row of (multiAlignmentResult.rows || [])) {
      const key = row.genome_key || row.genome || ''
      if (!key) continue
      alignedSequences[key] = row.aligned_sequence || ''
      const species = activeSpeciesByKey.get(key) || {}
      const loadedBaseline = loadedAlignmentBaselineByGenome?.[key] || null
        genomes.push({
          genome_key: key,
          species_key: species.species_key || '',
          assembly: species.assembly || '',
        assembly_name: species.assembly_name || '',
        scientific_name: species.scientific_name || '',
        common_name: species.common_name || '',
        gene_symbol: loadedBaseline?.geneName || row.query || '',
        gene_id: loadedBaseline?.geneId || row.query || '',
        transcript_id: row.transcript_id || '',
        tag: row.tag || '',
        chrom: row.chrom || '',
        genomic_start: row.genomic_start || 0,
        genomic_end: row.genomic_end || 0,
        strand: row.strand || '+',
          raw_length: row.raw_length || 0,
          flank_5_bp: row.flank_5_bp || 0,
          flank_3_bp: row.flank_3_bp || 0,
          use_gene_boundaries: row.use_gene_boundaries !== false,
          identity_to_consensus: row.identity_to_consensus || 0,
          gap_fraction: row.gap_fraction || 0,
          features: row.features || [],
        })
    }
    const stats = {
      alignment_length: multiAlignmentResult.alignment_length || 0,
      average_identity: multiAlignmentResult.average_identity || 0,
      requested_count: multiAlignmentResult.requested_count || 0,
      included_count: multiAlignmentResult.included_count || 0,
      profile: multiAlignmentResult.profile || 'balanced',
      strategy: multiAlignmentResult.strategy || '',
    }
    try {
      const res = await fetch(`${API_BASE}/api/alignments/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          output_dir: outputDir,
          genomes,
          aligned_sequences: alignedSequences,
          stats,
          consensus: multiAlignmentResult.consensus || '',
        }),
      })
      const data = await res.json()
      if (!res.ok) return { ok: false, error: data?.detail || 'Save failed' }
      return { ok: true, name: data.name }
    } catch (e) {
      return { ok: false, error: e?.message || 'Save failed' }
    }
  }, [multiAlignmentResult, config?.output_dir, activeSpeciesByKey, loadedAlignmentBaselineByGenome])

  const handleLoadAlignment = useCallback(async ({ name, loadMode, alignmentGenomes, localAssemblies }) => {
    const outputDir = config?.output_dir || ''
    if (!outputDir) return { ok: false, error: 'Output directory not configured' }

    const currentConfig = configRef.current || config
    const currentActive = dedupeSpeciesList(currentConfig?.active_species || [])
    const currentActiveKeys = new Set(currentActive.map((s) => speciesItemKey(s)))
    const currentInactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)
    const currentInactiveKeys = new Set(currentInactive.map((s) => speciesItemKey(s)))

    // Determine which genome_keys to include and which species to activate
    const fileKeys = (alignmentGenomes || []).map((g) => g.genome_key).filter(Boolean)
    let includeKeys = []
    let newActive = [...currentActive]
    let newInactive = [...currentInactive]

    for (const gKey of fileKeys) {
      if (currentActiveKeys.has(gKey)) {
        includeKeys.push(gKey)
      } else if (currentInactiveKeys.has(gKey)) {
        if (loadMode === 'active_inactive' || loadMode === 'all') {
          // Move from inactive → active
          const species = currentInactive.find((s) => speciesItemKey(s) === gKey)
          if (species) {
            newActive = [...newActive, species]
            newInactive = newInactive.filter((s) => speciesItemKey(s) !== gKey)
            includeKeys.push(gKey)
          }
        }
      } else {
        // Check local assemblies (available but not selected)
        const localMatch = (localAssemblies || []).find((a) => speciesItemKey(a) === gKey)
        if (localMatch && loadMode === 'all') {
          newActive = [...newActive, localMatch]
          includeKeys.push(gKey)
        }
      }
    }

    if (includeKeys.length === 0) {
      return { ok: false, error: 'No matching genomes found for current selection' }
    }

    // Apply genome activation if needed
    const activationChanged = newActive.length !== currentActive.length
    if (activationChanged) {
      const updatedConfig = { ...currentConfig, active_species: dedupeSpeciesList(newActive) }
      setConfig(updatedConfig)
      configRef.current = updatedConfig
      setInactiveSelectedSpecies(dedupeSpeciesList(newInactive))
      try {
        await fetch(`${API_BASE}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedConfig),
        })
      } catch (e) {
        console.error('Failed to save config after genome activation:', e)
      }
    }

    // Load alignment data from backend
    try {
      const res = await fetch(`${API_BASE}/api/alignments/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, output_dir: outputDir, genome_keys: includeKeys }),
      })
      const data = await res.json()
      if (!res.ok) return { ok: false, error: data?.detail || 'Load failed' }
      const loadedRows = Array.isArray(data?.rows) ? data.rows : []
      const loadedRowByGenomeKey = new Map(
        loadedRows
          .map((row) => [String(row?.genome_key || row?.genome || '').trim(), row])
          .filter(([key]) => key)
      )
      const nextAlignmentSpecies = dedupeSpeciesList(newActive).filter((species) => Boolean(species?.files?.gff3))
      const previousRowsByGenomeKey = new Map((alignmentInputsRef.current || []).map((row) => [row.genome_key, row]))
      const nextAlignmentRows = nextAlignmentSpecies.map((species, idx) => {
        const row = buildAlignmentInputRow(species, idx, previousRowsByGenomeKey.get(speciesItemKey(species)) || null)
        const loadedRow = loadedRowByGenomeKey.get(String(row.genome_key || '').trim())
        if (!loadedRow) {
          return {
            ...row,
            query: '',
            status: 'idle',
            error: '',
            resolved: null,
            lastAutoQuery: '',
            settings: {
              ...(row.settings || {}),
              selectedTranscriptId: '',
            },
          }
        }
        return {
          ...row,
          query: String(loadedRow?.query || '').trim(),
          status: 'idle',
          error: '',
          resolved: null,
          lastAutoQuery: '',
          settings: {
            ...(row.settings || {}),
            overlayAnnotation: loadedRow?.overlay_annotation !== false,
            useGeneBoundaries: loadedRow?.use_gene_boundaries !== false,
            selectedTranscriptId: String(loadedRow?.transcript_id || '').trim(),
          },
        }
      })
      const immediateLoadedBaseline = {}
      for (const genome of alignmentGenomes || []) {
        const genomeKey = String(genome?.genome_key || '').trim()
        if (!genomeKey) continue
        immediateLoadedBaseline[genomeKey] = {
          genomeKey,
          query: String(genome?.gene_symbol || genome?.gene_id || genome?.transcript_id || '').trim(),
          geneId: String(genome?.gene_id || '').trim(),
          geneName: String(genome?.gene_symbol || '').trim(),
          selectedTranscriptId: String(genome?.transcript_id || '').trim(),
        }
      }
      alignmentInputsRef.current = nextAlignmentRows
      setAlignmentInputs(nextAlignmentRows)
      setLoadedAlignmentBaselineByGenome(immediateLoadedBaseline)
      setMultiAlignmentResult(data)
      setAlignmentViewError(null)

      const loadedRefQuery = refGenomeKey ? String(loadedRowByGenomeKey.get(refGenomeKey)?.query || '').trim() : ''
      const loadedTgtQuery = tgtGenomeKey ? String(loadedRowByGenomeKey.get(tgtGenomeKey)?.query || '').trim() : ''
      setRefInput(loadedRefQuery)
      setTgtInput(loadedTgtQuery)
      setRefResolved(null)
      setTgtResolved(null)
      setRefError(null)
      setTgtError(null)

      const activeAlignmentGenomeKeys = new Set(nextAlignmentRows.map((row) => String(row?.genome_key || '').trim()).filter(Boolean))
      for (const genomeKey of activeAlignmentGenomeKeys) {
        if (!loadedRowByGenomeKey.has(genomeKey)) {
          handleGenomeFocusGeneSelect(genomeKey, null)
        }
      }

      const resolvedLoadedRows = await Promise.all(loadedRows.map(async (row) => {
        const genomeKey = String(row?.genome_key || row?.genome || '').trim()
        const query = String(row?.query || '').trim()
        const selectedTranscriptId = String(row?.transcript_id || '').trim()
        if (!genomeKey || !query) return null
        const resolved = await resolveAlignmentInput(genomeKey, query, {
          auto: true,
          selectedTranscriptId,
          preferSelectedTranscriptId: true,
        })
        if (resolved?.gene) {
          handleGenomeFocusGeneSelect(genomeKey, resolved.gene)
        }
        return {
          genomeKey,
          query,
          selectedTranscriptId,
          resolved,
        }
      }))

      const nextLoadedBaseline = {}
      for (const item of resolvedLoadedRows) {
        if (!item?.genomeKey) continue
        nextLoadedBaseline[item.genomeKey] = {
          genomeKey: item.genomeKey,
          query: item.query || '',
          geneId: String(item?.resolved?.gene?.id || '').trim(),
          geneName: String(item?.resolved?.gene?.name || '').trim(),
          selectedTranscriptId: item.selectedTranscriptId || '',
        }
      }
      setLoadedAlignmentBaselineByGenome(nextLoadedBaseline)

      return { ok: true, excludedCount: data.excluded_count || 0 }
    } catch (e) {
      return { ok: false, error: e?.message || 'Load failed' }
    }
  }, [config, buildAlignmentInputRow, refGenomeKey, tgtGenomeKey, resolveAlignmentInput, handleGenomeFocusGeneSelect])

  const collapseSourceOptions = useMemo(
    () => (alignmentInputs || []).map((row) => ({
      genome_key: row.genome_key,
      tag: row.tag,
      label: row.pillLabel,
    })),
    [alignmentInputs]
  )

  // Theme-specific styles
  const isLight = theme === 'light'
  const explicitScreenshotViews = useMemo(() => new Set(['genome_browser', 'feature_explorer', 'download', 'genome_selector']), [])
  const fallbackScreenshotViews = useMemo(() => new Set([
    'home',
    'feature_explorer',
    'alignment',
    'sequence',
    'alignment_explorer',
    'neighbourhood',
    'structural_variation',
    'homology',
    'stats',
    'configuration',
    'help',
    'track_manager',
  ]), [])
  const explicitScreenshotAvailable = explicitScreenshotViews.has(currentView) && Boolean(screenshotAvailabilityByView[currentView])
  const fallbackScreenshotAvailable = (
    !shouldShowWindowsBackendSetup &&
    fallbackScreenshotViews.has(currentView) &&
    Boolean(activeViewContentNode)
  )
  const usingFallbackScreenshot = screenshotMode && !explicitScreenshotAvailable && fallbackScreenshotAvailable
  const screenshotSupported = explicitScreenshotViews.has(currentView) || fallbackScreenshotViews.has(currentView)
  const screenshotAvailable = explicitScreenshotAvailable || fallbackScreenshotAvailable
  const shouldRenderFallbackContentWrapper = shouldShowWindowsBackendSetup || currentView !== 'genome_browser'
  const themeStyles = {
    bg: isLight ? 'bg-gray-100' : 'bg-gray-900',
    header: isLight ? 'bg-white border-gray-200 shadow-sm' : 'bg-gray-800 border-gray-700',
    panel: isLight ? 'bg-white border border-gray-200 shadow-sm' : 'bg-gray-800',
    text: isLight ? 'text-gray-900' : 'text-gray-100',
    subtext: isLight ? 'text-gray-500' : 'text-gray-400',
    accent: isLight ? 'text-[#0099ff]' : 'text-blue-400',
    button: isLight ? 'bg-[#0099ff] hover:bg-[#0088ee]' : 'bg-blue-600 hover:bg-blue-700',
  }

  const handleScreenshotAvailabilityChange = useCallback((viewId, available) => {
    const key = String(viewId || '').trim()
    if (!key) return
    setScreenshotAvailabilityByView((prev) => {
      const nextValue = Boolean(available)
      if (prev[key] === nextValue) return prev
      return { ...prev, [key]: nextValue }
    })
  }, [])

  const viewTitles = {
    home: 'Home',
    genome_selector: 'Genome Selector',
    genome_browser: 'Genome Browser',
    feature_explorer: 'Feature Explorer',
    alignment: 'Alignment',
    sequence: 'Sequence',
    alignment_explorer: 'Alignment Explorer',
    neighbourhood: 'Neighbourhood',
    structural_variation: 'Structural Variation',
    homology: 'Homology',
    stats: 'Statistics',
    notes: 'Notes',
    download: 'Download',
    configuration: 'Configuration',
    tutorials: 'Tutorials',
    help: 'Help',
    track_manager: 'Track Manager',
  }

  const viewDescriptions = {
    home: 'Download, browse and analyse Ensembl data locally',
    genome_selector: 'Select downloaded genomes for visualisation in the Genome Browser',
    genome_browser: 'Navigate gene annotations across chromosomes',
    feature_explorer: 'Inspect transcript-level features for a selected gene in an active genome',
    alignment: 'Comparative genomic annotation visualisation',
    sequence: 'Read sequence base by base, from a whole region down to a single exon',
    alignment_explorer: 'Explore alignment blocks and connected sequence paths in named layers',
    neighbourhood: 'Explore gene neighbourhood context',
    structural_variation: 'Inspect structural variation and chain-based syntenic mappings between two genomes',
    homology: 'Query homology TSV files for cross-species gene matches',
    stats: 'Compare genome and annotation statistics across selected genomes',
    notes: 'Browse and manage every note you have written, across all your genomes',
    download: 'Download genomes, annotations and homologies locally',
    configuration: 'Set up genome paths and index files',
    tutorials: 'Follow guided walkthroughs of the main Ensembl Go workflows',
    help: 'Read guidance and workflow notes for each view',
    track_manager: 'Register and manage custom data tracks for the Genome Browser',
  }

  const currentViewTitle = shouldShowWindowsBackendSetup
    ? 'Windows setup'
    : (viewTitles[currentView] ?? 'Home')
  const currentViewDescription = shouldShowWindowsBackendSetup
    ? 'Connect the packaged Windows app to a Python backend running inside WSL.'
    : (viewDescriptions[currentView] ?? '')
  const currentViewButtonId = shouldShowWindowsBackendSetup
    ? ''
    : (Object.values(APP_BUTTON_META).find(
      (entry) => entry.kind === 'data_view' && entry.viewId === currentView
    )?.id || '')
  const defaultFallbackScreenshotDir = useMemo(() => {
    const base = String(config?.output_dir || '').trim().replace(/\/+$/, '')
    return base ? `${base}/screenshots` : ''
  }, [config?.output_dir])
  const fallbackScreenshotNode = useMemo(() => {
    if (!activeViewContentNode) return null
    return activeViewContentNode.matches?.('[data-screenshot-capture="view"]')
      ? activeViewContentNode
      : (activeViewContentNode.querySelector?.('[data-screenshot-capture="view"]') || activeViewContentNode)
  }, [activeViewContentNode, currentView])
  const fallbackViewContainsCanvas = useMemo(
    () => subtreeContainsCanvas(fallbackScreenshotNode),
    [fallbackScreenshotNode, currentView]
  )
  const fallbackScreenshotTarget = useMemo(() => {
    if (!(fallbackScreenshotAvailable && fallbackScreenshotNode)) return null
    const captureNode = fallbackScreenshotNode
    const visibleNode = activeViewContentNode || captureNode
    const { width: measuredCaptureWidth, height: captureHeight } = measureScreenshotNode(captureNode)
    const { width: visibleWidth } = measureScreenshotNode(visibleNode, { preferScrollSize: false })
    const captureWidth = Math.max(measuredCaptureWidth, visibleWidth)
    const allowedFormats = fallbackViewContainsCanvas ? ['png', 'jpeg'] : ['svg', 'png', 'jpeg']
    const defaultFormat = fallbackViewContainsCanvas ? 'png' : 'svg'
    return {
      id: `fallback:${currentView}`,
      label: `${currentViewTitle} view`,
      allowedFormats,
      defaultFormat,
      getVisibleRect: () => visibleNode.getBoundingClientRect(),
      getScrollElement: () => captureNode,
      buildDefaultFilename: () => buildDefaultScreenshotName(`ens_${currentView}_page`),
      buildExportSnapshot: async () => buildDomNodeScreenshotSnapshot(captureNode, {
        width: captureWidth,
        height: captureHeight,
        backgroundColor: isLight ? '#f3f4f6' : '#111827',
      }),
    }
  }, [activeViewContentNode, currentView, currentViewTitle, fallbackScreenshotAvailable, fallbackScreenshotNode, fallbackViewContainsCanvas, isLight])
  const fallbackScreenshotTargets = useMemo(
    () => (fallbackScreenshotTarget ? [fallbackScreenshotTarget] : []),
    [fallbackScreenshotTarget]
  )

  const handleFallbackScreenshotModalClose = useCallback(() => {
    setSelectedFallbackScreenshotTarget(null)
  }, [])

  const handleFallbackScreenshotSave = useCallback(async ({ filename, directory, format, scale, quality, target }) => {
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
        let raster = null

        if (snapshot.htmlMarkup && typeof electronBridge?.captureHtmlSnapshot === 'function') {
          try {
            raster = await electronBridge.captureHtmlSnapshot({
              htmlMarkup: snapshot.htmlMarkup,
              width: snapshot.width,
              height: snapshot.height,
              format,
              scale,
              quality,
              backgroundColor: snapshot.backgroundColor || (isLight ? '#ffffff' : '#111827'),
            })
          } catch {
            raster = null
          }
        }

        if (!raster) {
          raster = await rasterizeSvgMarkup({
            svgMarkup: snapshot.svgMarkup,
            width: snapshot.width,
            height: snapshot.height,
            format,
            scale,
            quality: format === 'jpeg' ? Math.max(0.7, Math.min(1, quality / 100)) : undefined,
            backgroundColor: snapshot.backgroundColor || (isLight ? '#ffffff' : '#111827'),
          })
        }
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

  // Detect changes between current config and savedConfigRef, apply cascading clears,
  // trigger selective browser reloads, and reset alignment state as needed.
  // Returns the (possibly cascaded) config to save.
  const applyConfigCascade = () => {
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

  const handleRetryBackendCheck = useCallback(async () => {
    try {
      const nextRuntime = await retryBackendCheck()
      setBackendRuntime(nextRuntime)
    } catch (e) {
      console.error('Retry backend check failed:', e)
    }
  }, [])

  const handleRetryBackendLaunch = useCallback(async () => {
    try {
      const nextRuntime = await retryBackendLaunch()
      setBackendRuntime(nextRuntime)
    } catch (e) {
      console.error('Retry backend launch failed:', e)
    }
  }, [])

  const persistConfigToBackend = useCallback(async (nextConfig, label = 'config') => {
    // Tutorial state is deliberately transient. The fetch shim also refuses config
    // writes, but the Electron store is reached directly here, so this guard must come
    // before either persistence path.
    if (!nextConfig || isTutorialSandboxActive()) return false
    window.electronAPI?.saveElectronConfig?.(nextConfig)
    try {
      await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig)
      })
      savedConfigRef.current = { ...nextConfig }
      return true
    } catch (e) {
      console.error(`Failed to save ${label}:`, e)
      return false
    }
  }, [])

  const persistNextPreviousSessionGenomes = useCallback((speciesList, baseConfig = null) => {
    const nextPreviousGenomes = buildPreviousSessionGenomes(speciesList)
    const base = baseConfig || configRef.current || {}
    const signature = JSON.stringify(nextPreviousGenomes)
    if (signature === nextPreviousSessionSignatureRef.current) return
    nextPreviousSessionSignatureRef.current = signature

    const nextConfig = withNextPreviousSessionGenomes(base, nextPreviousGenomes)
    configRef.current = nextConfig
    setConfig((prev) => {
      const prevSignature = JSON.stringify(buildPreviousSessionGenomes(prev?.next_previous_session_genomes || []))
      if (prevSignature === signature) return prev
      return withNextPreviousSessionGenomes(prev, nextPreviousGenomes)
    })
    void persistConfigToBackend(nextConfig, 'next previous session')
  }, [persistConfigToBackend])

  useEffect(() => {
    if (!configLoaded) return

    const playlistSignature = JSON.stringify({
      genome_playlists: config.genome_playlists || [],
      selected_genome_playlist_id: config.selected_genome_playlist_id || '__all__',
    })
    const savedPlaylistSignature = JSON.stringify({
      genome_playlists: savedConfigRef.current?.genome_playlists || [],
      selected_genome_playlist_id: savedConfigRef.current?.selected_genome_playlist_id || '__all__',
    })
    if (playlistSignature === savedPlaylistSignature) return

    persistConfigToBackend(configRef.current || config, 'playlist configuration')
  }, [configLoaded, config.genome_playlists, config.selected_genome_playlist_id, persistConfigToBackend])

  const scheduleConfigurationAutosave = useCallback((nextConfig, { immediate = false } = {}) => {
    if (!configLoaded || !nextConfig) return

    if (persistConfigurationTimerRef.current) {
      clearTimeout(persistConfigurationTimerRef.current)
      persistConfigurationTimerRef.current = null
    }

    if (immediate) {
      persistConfigToBackend(nextConfig, 'configuration')
      return
    }

    persistConfigurationTimerRef.current = setTimeout(() => {
      persistConfigurationTimerRef.current = null
      persistConfigToBackend(configRef.current || nextConfig, 'configuration')
    }, 250)
  }, [configLoaded, persistConfigToBackend])

  const handleConfigurationChange = useCallback((configUpdate) => {
    // Playback and the builder preview both edit a scratch configuration. Let normal UI
    // controls (notably Genome Selector playlists) behave truthfully, but route their
    // result into that override instead of dropping the interaction or touching the
    // user's real settings.
    if (tutorialConfig) {
      const previous = configRef.current || config
      const nextConfig = typeof configUpdate === 'function'
        ? configUpdate(previous)
        : configUpdate
      if (nextConfig) {
        configRef.current = nextConfig
        updateSandboxConfig(nextConfig)
      }
      return
    }
    setConfig((prev) => {
      const nextConfig = typeof configUpdate === 'function'
        ? configUpdate(prev)
        : configUpdate
      if (!nextConfig) return prev

      const directoryChanged =
        (nextConfig.output_dir || '') !== (prev.output_dir || '') ||
        (nextConfig.working_dir || '') !== (prev.working_dir || '')

      configRef.current = nextConfig
      scheduleConfigurationAutosave(nextConfig, { immediate: directoryChanged })
      return nextConfig
    })
  }, [config, scheduleConfigurationAutosave, tutorialConfig, updateSandboxConfig])

  useEffect(() => {
    // This is a launch prompt, not a permanent warning. If this session opened with a
    // configured directory, clearing it deliberately later must not restart onboarding.
    if (configLoaded && String(userConfig?.output_dir || '').trim()) {
      setGettingStartedOutputDirDismissed(true)
    }
  }, [configLoaded, userConfig?.output_dir])

  const handleGettingStartedOutputDir = useCallback(async (path) => {
    const outputDir = String(path || '').trim()
    if (!outputDir) return false
    handleConfigurationChange((previous) => ({ ...previous, output_dir: outputDir }))
    setGettingStartedOutputDirDismissed(true)
    setOutputDirNotification(outputDir)
    return true
  }, [handleConfigurationChange])

  useEffect(() => {
    if (!outputDirNotification) return undefined
    const notificationTimer = setTimeout(() => setOutputDirNotification(''), 4000)
    return () => clearTimeout(notificationTimer)
  }, [outputDirNotification])

  useEffect(() => {
    return () => {
      if (persistConfigurationTimerRef.current) {
        clearTimeout(persistConfigurationTimerRef.current)
        persistConfigurationTimerRef.current = null
      }
    }
  }, [])

  // Save config to backend with cascading clears applied.
  // Called when navigating away from config view.
  const handleConfigSave = async () => {
    const cascaded = applyConfigCascade()
    await persistConfigToBackend(cascaded, 'config')
  }

  // Called after ConfigurationView's own Save/Generate actions POST to the backend.
  // Fetches the latest config from backend first (to pick up backend-side changes
  // like newly generated index paths), then detects what changed and triggers
  // selective browser reloads and cascading clears.
  const handleConfigSaved = async () => {
    const prev = savedConfigRef.current
    tutorialRuntime.emitSignal('config.saved')
    // Fetch latest config from backend (may have new index paths, etc.)
    const newConfig = await fetchConfig()
    if (!newConfig || !prev) return

    const refChanged = newConfig.ref_fasta !== prev.ref_fasta || newConfig.ref_gff !== prev.ref_gff
    const tgtChanged = newConfig.target_fasta !== prev.target_fasta || newConfig.target_gff !== prev.target_gff
    const refIndexChanged = newConfig.ref_index !== prev.ref_index
    const tgtIndexChanged = newConfig.target_index !== prev.target_index

    // Browser track reloads — needed when genome files OR indexes change
    if (refChanged || refIndexChanged) setRefBrowserReloadKey(k => k + 1)
    if (tgtChanged || tgtIndexChanged) setTgtBrowserReloadKey(k => k + 1)

    // Selective alignment/neighbourhood reset when genome files change
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
  }

  const buildFocusFromActive = useCallback((activeSpecies, focusOverride = null) => {
    const active = dedupeSpeciesList(activeSpecies)
    const focusInput = focusOverride || dualViewFocusRef.current || { primaryKey: '', secondaryKey: '' }
    const byKey = new Map(active.map((species) => [speciesItemKey(species), species]))

    let primaryKey = byKey.has(focusInput.primaryKey || '') ? (focusInput.primaryKey || '') : ''
    let secondaryKey = byKey.has(focusInput.secondaryKey || '') ? (focusInput.secondaryKey || '') : ''

    if (!primaryKey && active.length > 0) {
      primaryKey = speciesItemKey(active[0])
    }
    if (secondaryKey && secondaryKey === primaryKey) {
      secondaryKey = ''
    }
    if (!secondaryKey && active.length > 1) {
      const fallbackSecondary = active.find((species) => speciesItemKey(species) !== primaryKey)
      secondaryKey = fallbackSecondary ? speciesItemKey(fallbackSecondary) : ''
    }

    return { primaryKey, secondaryKey }
  }, [])

  const getContextFullyActiveSpecies = useCallback((activeSpecies, viewId, focusOverride = null) => {
    const active = dedupeSpeciesList(activeSpecies)
    const capacity = getViewActiveCapacity(viewId)
    if (active.length === 0 || capacity === 0) return []
    if (!Number.isFinite(capacity)) return active

    if (viewId === 'structural_variation') {
      return active.slice(0, capacity)
    }

    const byKey = new Map(active.map((species) => [speciesItemKey(species), species]))
    const focus = buildFocusFromActive(active, focusOverride)
    const out = []

    const primary = byKey.get(focus.primaryKey || '') || active[0] || null
    if (primary) out.push(primary)
    if (capacity >= 2) {
      const secondary = byKey.get(focus.secondaryKey || '') || null
      if (secondary && (!primary || speciesItemKey(secondary) !== speciesItemKey(primary))) {
        out.push(secondary)
      }
    }

    return out.slice(0, capacity)
  }, [buildFocusFromActive])

  const getAlignedGenomeConfigForView = useCallback((configObj, viewId, focusOverride = null) => {
    const activeSpecies = dedupeSpeciesList(configObj?.active_species)
    const byKey = new Map(activeSpecies.map((species) => [speciesItemKey(species), species]))
    const byGff = new Map(activeSpecies.map((species) => [species?.files?.gff3 || '', species]))
    const focus = buildFocusFromActive(activeSpecies, focusOverride)

    const currentPrimary = byGff.get(configObj?.ref_gff || '') || null
    const currentSecondary = byGff.get(configObj?.target_gff || '') || null
    const focusPrimary = byKey.get(focus.primaryKey || '') || null
    const focusSecondary = byKey.get(focus.secondaryKey || '') || null

    let primary = focusPrimary || currentPrimary || activeSpecies[0] || null
    let secondary = null

    if (viewId === 'structural_variation') {
      primary = activeSpecies[0] || primary
      secondary = activeSpecies[1] || null
    } else if (TWO_GENOME_VIEWS.has(viewId)) {
      secondary = focusSecondary || null
    } else {
      secondary = secondary || focusSecondary || currentSecondary || null
    }

    if (primary && secondary && speciesItemKey(primary) === speciesItemKey(secondary)) {
      secondary = null
    }

    return {
      ...configObj,
      active_species: activeSpecies,
      ref_fasta: primary?.files?.fasta || '',
      ref_gff: primary?.files?.gff3 || '',
      ref_index: primary?.files?.index || '',
      homologies_file: primary?.files?.homology || '',
      target_fasta: secondary?.files?.fasta || '',
      target_gff: secondary?.files?.gff3 || '',
      target_index: secondary?.files?.index || '',
    }
  }, [buildFocusFromActive])

  // Called when GenomeBrowserView or GenomeSelectorView changes active genome selection.
  // Immediately saves new config to backend so browser fetch calls get the right index/gff paths.
  const handleBrowserConfigChange = async (configUpdate) => {
    const prev = configRef.current
    const rawNewConfig = typeof configUpdate === 'function'
      ? configUpdate(prev)
      : configUpdate
    if (!rawNewConfig) return
    const hasExplicitNextPreviousSessionUpdate = Array.isArray(rawNewConfig.next_previous_session_genomes)
    const sessionSpeciesSource = hasExplicitNextPreviousSessionUpdate
      ? rawNewConfig.next_previous_session_genomes
      : [
          ...dedupeSpeciesList(rawNewConfig.active_species || []),
          ...dedupeSpeciesList(inactiveSelectedSpeciesRef.current || []),
        ]
    const newConfig = withNextPreviousSessionGenomes(rawNewConfig, sessionSpeciesSource)
    if (!newConfig) return

    // View-alignment effects can run as the tutorial swaps in its temporary genome set.
    // That must never turn into an Electron config write: the tutorial provider owns the
    // overlay, and dropping it is what restores the user's browser configuration.
    if (isTutorialSandboxActive()) {
      configRef.current = newConfig
      updateSandboxConfig(newConfig)
      return
    }
    nextPreviousSessionSignatureRef.current = JSON.stringify(buildPreviousSessionGenomes(newConfig.next_previous_session_genomes || []))

    // Special case: deactivating primary while secondary is active promotes
    // the previous target genome into primary. Preserve target-side state.
    const targetPromotedToRef =
      !!prev?.target_gff &&
      newConfig.ref_gff === prev.target_gff &&
      !newConfig.target_gff

    const refGenomeChanged = newConfig.ref_gff !== prev.ref_gff || newConfig.ref_fasta !== prev.ref_fasta
    const tgtGenomeChanged = newConfig.target_gff !== prev.target_gff || newConfig.target_fasta !== prev.target_fasta

    setConfig(newConfig)
    configRef.current = newConfig
    // Persist to backend right away — GenomeBrowser fetches data from the backend
    // using the on-disk config, so we must save before reload triggers fetch.
    window.electronAPI?.saveElectronConfig?.(newConfig)
    try {
      await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      })
    } catch (e) {
      console.error('Failed to save genome config:', e)
    }
    savedConfigRef.current = { ...newConfig }

    // Trigger browser reloads when ref/target genome selection changes
    const refChanged = newConfig.ref_gff !== prev.ref_gff || newConfig.ref_index !== prev.ref_index
    const tgtChanged = newConfig.target_gff !== prev.target_gff || newConfig.target_index !== prev.target_index
    if (refChanged) setRefBrowserReloadKey(k => k + 1)
    if (tgtChanged) setTgtBrowserReloadKey(k => k + 1)

    // Keep pairwise/neighbourhood state consistent with active genomes.
    // If either genome assignment changed, clear stale pairwise/alignment state.
    if (refGenomeChanged || tgtGenomeChanged) {
      setAlignment(null)
      setMultiAlignmentResult(null)
      setLastSuccessfulMultiAlignmentSignature('')
      setAlignmentViewError(null)
      setAlignmentOverlay(null)
      setLoadedParams(null)
      setError(null)
    }

    // Neighbourhood handling:
    // - ref change => reset neighbourhood entirely (different anchor genome)
    // - tgt change => preserve ref neighbourhood but clear target-side/links
    if (targetPromotedToRef) {
      setNeighbourhoodError(null)
      setNeighbourhoodLoading(false)
      setNeighbourhoodData((prevData) => {
        if (!prevData) return prevData
        const promotedGenes = (prevData.target_genes && prevData.target_genes.length > 0)
          ? prevData.target_genes
          : prevData.reference_genes
        return {
          ...prevData,
          reference_genes: promotedGenes || [],
          center_ref_id: prevData.center_target_id || prevData.center_ref_id,
          target_genes: [],
          center_target_id: null,
          homologies: [],
          request_transcript_id: prevData.request_target_transcript_id || prevData.request_transcript_id,
          request_target_transcript_id: null,
          request_ref_gene_id: prevData.request_target_gene_id || prevData.request_ref_gene_id || null,
          request_target_gene_id: null,
        }
      })
    } else if (refGenomeChanged) {
      setNeighbourhoodData(null)
      setNeighbourhoodError(null)
      setNeighbourhoodLoading(false)
    } else if (tgtGenomeChanged) {
      setNeighbourhoodError(null)
      setNeighbourhoodLoading(false)
      setNeighbourhoodData((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          target_genes: [],
          center_target_id: null,
          homologies: [],
          request_target_transcript_id: null,
          request_target_gene_id: null,
        }
      })
    }

    // Clear changed sides. When a genome is deactivated, drop any focused gene tied to that browser slot.
    if (targetPromotedToRef) {
      setRefResolved(null)
      setRefInput('')
      setRefError(null)
      setBrowserRefGene(null)
      setBrowserRefViewport(null)
      setTgtResolved(null)
      setTgtInput('')
      setTgtError(null)
      setBrowserTgtGene(null)
    } else if (refGenomeChanged) {
      setRefResolved(null)
      setRefInput('')
      setRefError(null)
      setBrowserRefGene(null)
      setBrowserRefViewport(null)
    }
    if (!targetPromotedToRef && tgtGenomeChanged) {
      setTgtResolved(null)
      setTgtInput('')
      setTgtError(null)
      setBrowserTgtGene(null)
    }

    if (!newConfig.ref_gff && !newConfig.target_gff) {
      setRefResolved(null)
      setTgtResolved(null)
      setRefInput('')
      setTgtInput('')
      setRefError(null)
      setTgtError(null)
      setBrowserRefGene(null)
      setBrowserRefViewport(null)
      setBrowserTgtGene(null)
      setNeighbourhoodData(null)
      setNeighbourhoodError(null)
      setNeighbourhoodLoading(false)
    }

  }

  const hasGenomeAssignmentChanges = useCallback((a, b) => {
    if (!a || !b) return true
    return (
      (a.ref_gff || '') !== (b.ref_gff || '') ||
      (a.ref_fasta || '') !== (b.ref_fasta || '') ||
      (a.ref_index || '') !== (b.ref_index || '') ||
      (a.target_gff || '') !== (b.target_gff || '') ||
      (a.target_fasta || '') !== (b.target_fasta || '') ||
      (a.target_index || '') !== (b.target_index || '') ||
      (a.homologies_file || '') !== (b.homologies_file || '')
    )
  }, [])

  const persistBuiltIndexForGenome = useCallback(async (species, indexPath) => {
    const gffPath = String(species?.files?.gff3 || '').trim()
    if (!gffPath || !indexPath) return

    const genomeKey = speciesItemKey(species)
    let nextConfig = null

    setConfig((prev) => {
      let changed = false
      const applyIndex = (items) => (items || []).map((item) => {
        if (speciesItemKey(item) !== genomeKey) return item
        if ((item.files?.index || '') === indexPath) return item
        changed = true
        return {
          ...item,
          files: {
            ...(item.files || {}),
            index: indexPath,
          },
        }
      })

      const updated = {
        ...prev,
        active_species: applyIndex(prev.active_species),
        manual_species: applyIndex(prev.manual_species),
      }

      if (updated.ref_gff === gffPath && updated.ref_index !== indexPath) {
        updated.ref_index = indexPath
        changed = true
      }
      if (updated.target_gff === gffPath && updated.target_index !== indexPath) {
        updated.target_index = indexPath
        changed = true
      }

      nextConfig = changed ? updated : prev
      return nextConfig
    })

    setInactiveSelectedSpecies((prev) => {
      let changed = false
      const next = (prev || []).map((item) => {
        if (speciesItemKey(item) !== genomeKey) return item
        if ((item.files?.index || '') === indexPath) return item
        changed = true
        return {
          ...item,
          files: {
            ...(item.files || {}),
            index: indexPath,
          },
        }
      })
      return changed ? next : prev
    })

    if (!nextConfig || nextConfig === configRef.current) return

    configRef.current = nextConfig
    savedConfigRef.current = { ...nextConfig }

    try {
      await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig),
      })
    } catch (e) {
      console.error('Failed to persist built genome index:', e)
    }
  }, [])

  const fileExistsAtPath = useCallback(async (path) => {
    const targetPath = String(path || '').trim()
    if (!targetPath) return false
    try {
      const dir = dirnameFromPath(targetPath)
      const name = basenameFromPath(targetPath)
      if (!dir || !name) return false
      const res = await fetch(`${API_BASE}/api/files/list?path=${encodeURIComponent(dir)}`)
      if (!res.ok) return false
      const data = await res.json()
      return (data.items || []).some((item) => !item.is_dir && item.name === name)
    } catch {
      return false
    }
  }, [])

  // Whether the backend considers a genome's index built and current. Falls back
  // to "is the file there" for a genome it does not know about yet, which is the
  // only case it cannot answer for.
  const backendWillUseIndex = useCallback(async (genomeKey, indexPath) => {
    const key = String(genomeKey || '').trim()
    if (key) {
      try {
        const res = await fetch(`${API_BASE}/api/browse/index-status?genome=${encodeURIComponent(key)}`)
        if (res.ok) return (await res.json())?.state === 'ready'
      } catch {
        // Fall through to the filesystem check below.
      }
    }
    return fileExistsAtPath(indexPath)
  }, [fileExistsAtPath])

  const ensureSelectedGenomeIndex = useCallback((species) => {
    const gffPath = String(species?.files?.gff3 || '').trim()
    if (!gffPath) return Promise.resolve(null)

    const genomeKey = speciesItemKey(species)
    const currentIndex = String(species?.files?.index || '').trim()
    const ensureKey = `${genomeKey}|${gffPath}|${currentIndex}`
    const indexlessEnsureKey = `${genomeKey}|${gffPath}|`
    if (ensuredGenomeIndexKeysRef.current.has(ensureKey) || ensuredGenomeIndexKeysRef.current.has(indexlessEnsureKey)) {
      return Promise.resolve(currentIndex || null)
    }

    const existingPromise = activeIndexBuildsRef.current.get(genomeKey)
    if (existingPromise) return existingPromise

    const promise = (async () => {
      const currentConfig = configRef.current || {}

      if (currentIndex) {
        // Ask the backend whether it would actually browse with this index, not
        // merely whether the file is there. An index built from an older copy of
        // the annotation is on disk and unusable: accepting it here marked the
        // genome as sorted, so nothing queued a rebuild or followed its
        // progress, and the browser was left polling a build it had started for
        // itself with nothing watching it.
        const usable = await backendWillUseIndex(genomeKey, currentIndex)
        if (usable) {
          await persistBuiltIndexForGenome(species, currentIndex)
          ensuredGenomeIndexKeysRef.current.add(ensureKey)
          return currentIndex
        }
      }

      const outputDir = String(currentConfig.output_dir || '').trim()
      const outputDirHint = currentIndex ? (dirnameFromPath(currentIndex) || outputDir) : outputDir
      if (!outputDirHint) return null

      try {
        const res = await fetch(`${API_BASE}/api/index/generate-for-genome`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gff_path: gffPath,
            output_dir: outputDirHint,
            index_path: currentIndex || undefined,
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          console.error('Failed to start genome index build:', err?.detail || res.statusText)
          return null
        }

        const { task_id } = await res.json()
        if (!task_id) return null

        const builtIndexPath = await new Promise((resolve) => {
          let consecutivePollFailures = 0
          const maxPollFailures = 5
          const poll = async () => {
            try {
              const statusRes = await fetch(`${API_BASE}/api/index/task-status/${task_id}`)
              if (statusRes.ok) {
                consecutivePollFailures = 0
                const statusData = await statusRes.json()
                if (statusData.status === 'success') {
                  resolve(statusData.index_path || null)
                  return
                }
                if (statusData.status === 'failed') {
                  console.error('Genome index build failed:', statusData.error || 'Unknown error')
                  resolve(null)
                  return
                }
              } else {
                consecutivePollFailures += 1
              }
            } catch (error) {
              consecutivePollFailures += 1
              console.error('Genome index build poll failed:', error)
            }
            if (consecutivePollFailures >= maxPollFailures) {
              console.error('Genome index build poll stopped after repeated status fetch failures.')
              resolve(null)
              return
            }
            window.setTimeout(poll, 3000)
          }
          poll()
        })

        if (builtIndexPath) {
          await persistBuiltIndexForGenome(species, builtIndexPath)
          ensuredGenomeIndexKeysRef.current.add(ensureKey)
          ensuredGenomeIndexKeysRef.current.add(`${genomeKey}|${gffPath}|${builtIndexPath}`)
        }
        return builtIndexPath
      } catch (error) {
        console.error('Failed to ensure genome index:', error)
        return null
      }
    })()

    activeIndexBuildsRef.current.set(genomeKey, promise)
    promise.finally(() => {
      activeIndexBuildsRef.current.delete(genomeKey)
    })

    return promise
  }, [backendWillUseIndex, persistBuiltIndexForGenome])

  useEffect(() => {
    if (!shouldAutoEnsurePrimaryIndex(currentView)) return
    const primary = primaryGenomeForIndex(
      dedupeSpeciesList(config?.active_species || []),
      config?.ref_gff,
    )
    if (primary) ensureSelectedGenomeIndex(primary)
  }, [currentView, config?.active_species, config?.ref_gff, ensureSelectedGenomeIndex])

  useEffect(() => {
    if (suppressViewSyncRef.current) return
    const currentConfig = configRef.current || config
    const normalizedFocus = buildFocusFromActive(currentConfig?.active_species, dualViewFocusRef.current)
    if (
      normalizedFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
      normalizedFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
    ) {
      setDualViewFocus(normalizedFocus)
    }
    const aligned = getAlignedGenomeConfigForView(currentConfig, currentView, normalizedFocus)
    const activeUnchanged = speciesListsEqualByKey(currentConfig?.active_species || [], aligned?.active_species || [])
    if (activeUnchanged && !hasGenomeAssignmentChanges(currentConfig, aligned)) return
    handleBrowserConfigChange(aligned)
  }, [currentView, config?.active_species, dualViewFocus.primaryKey, dualViewFocus.secondaryKey, buildFocusFromActive, getAlignedGenomeConfigForView, hasGenomeAssignmentChanges])

	  // `options.desired` states the outcome the caller wants — 'selected' or 'deselected'
	  // — for a change applied on a delay, which may find the world already in that state
	  // by the time it runs. Without it the delayed change flips whatever it finds and
	  // takes back a selection something else has since made.
	  const handleSpeciesPillToggle = useCallback(async (species, source = 'pill', options = {}) => {
	    if (!species) return { ok: false, reason: 'missing_species' }
	    const desired = options?.desired || ''

	    // A tutorial keeps its own set of active genomes, so choosing one here must not
	    // reach the user's real selection.
	    if (tutorialConfig) {
	      toggleTutorialGenome(species, desired)
	      return { ok: true }
	    }

	    const key = speciesItemKey(species)
	    const currentConfig = configRef.current || config
	    const active = dedupeSpeciesList(currentConfig?.active_species)
	    const inactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)
	    if (desired) {
	      const chosen = active.some((item) => speciesItemKey(item) === key)
	        || inactive.some((item) => speciesItemKey(item) === key)
	      if ((desired === 'selected' && chosen) || (desired === 'deselected' && !chosen)) {
	        return { ok: true, reason: 'already_in_desired_state' }
	      }
	    }
	    const viewCapacity = getViewActiveCapacity(currentView)
	    const activeIndex = active.findIndex((item) => speciesItemKey(item) === key)
	    const inactiveIndex = inactive.findIndex((item) => speciesItemKey(item) === key)
	    if (source === 'selector_remove' && (activeIndex >= 0 || inactiveIndex >= 0)) {
	      const nextActive = active.filter((item) => speciesItemKey(item) !== key)
	      const nextInactive = inactive.filter((item) => speciesItemKey(item) !== key)
	      let nextFocus = buildFocusFromActive(nextActive, {
	        primaryKey: dualViewFocusRef.current.primaryKey === key ? '' : dualViewFocusRef.current.primaryKey,
	        secondaryKey: dualViewFocusRef.current.secondaryKey === key ? '' : dualViewFocusRef.current.secondaryKey,
	      })

	      suppressViewSyncRef.current = true
	      try {
	        setInactiveSelectedSpecies(nextInactive)
	        persistNextPreviousSessionGenomes([...nextActive, ...nextInactive], currentConfig)
	        if (
	          nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
	          nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
	        ) {
	          dualViewFocusRef.current = nextFocus
	          setDualViewFocus(nextFocus)
	        }
		        const nextConfig = getAlignedGenomeConfigForView(
		          withNextPreviousSessionGenomes(
		            { ...currentConfig, active_species: nextActive },
		            [...nextActive, ...nextInactive]
		          ),
	          currentView,
	          nextFocus
	        )
	        const activeChanged = !speciesListsEqualByKey(currentConfig?.active_species || [], nextConfig?.active_species || [])
	        if (activeChanged || hasGenomeAssignmentChanges(currentConfig, nextConfig)) {
	          await handleBrowserConfigChange(nextConfig)
	        }
	        return { ok: true, deselected: true }
	      } finally {
	        suppressViewSyncRef.current = false
	      }
	    }

	    let nextActive = active
    let nextInactive = inactive
    let nextFocus = buildFocusFromActive(active, dualViewFocusRef.current)
    const contextFullyActive = getContextFullyActiveSpecies(active, currentView, nextFocus)
    const contextFullyActiveKeys = new Set(contextFullyActive.map((item) => speciesItemKey(item)))
    const isGloballyActive = activeIndex >= 0
    const isFullyActive = isGloballyActive && contextFullyActiveKeys.has(key)
    const isSemiActive = isGloballyActive && !isFullyActive

    if (isSemiActive) {
      if ((Number.isFinite(viewCapacity) && viewCapacity <= 0) || (Number.isFinite(viewCapacity) && viewCapacity > 0 && contextFullyActive.length >= viewCapacity)) {
        const removed = active[activeIndex]
        nextActive = active.filter((item) => speciesItemKey(item) !== key)
        nextInactive = prependUniqueSpecies(inactive, removed)
        if (nextFocus.primaryKey === key) {
          nextFocus.primaryKey = nextFocus.secondaryKey || ''
          nextFocus.secondaryKey = ''
        } else if (nextFocus.secondaryKey === key) {
          nextFocus.secondaryKey = ''
        }
        nextFocus = buildFocusFromActive(nextActive, nextFocus)
      } else {
        nextInactive = inactive.filter((item) => speciesItemKey(item) !== key)
        if (viewCapacity === 1) {
          nextFocus.primaryKey = key
          nextFocus.secondaryKey = ''
        } else if (viewCapacity >= 2) {
          if (!nextFocus.primaryKey) {
            nextFocus.primaryKey = key
          } else if (!nextFocus.secondaryKey || nextFocus.secondaryKey === nextFocus.primaryKey) {
            nextFocus.secondaryKey = key
          }
        }
        nextFocus = buildFocusFromActive(nextActive, nextFocus)
      }
    } else if (isFullyActive) {
      const removed = active[activeIndex]
      nextActive = active.filter((item) => speciesItemKey(item) !== key)
      nextInactive = prependUniqueSpecies(inactive, removed)
      if (nextFocus.primaryKey === key) {
        nextFocus.primaryKey = nextFocus.secondaryKey || ''
        nextFocus.secondaryKey = ''
      } else if (nextFocus.secondaryKey === key) {
        nextFocus.secondaryKey = ''
      }
      nextFocus = buildFocusFromActive(nextActive, nextFocus)
    } else {
      if (source === 'selector' && currentView !== 'genome_browser' && currentView !== 'structural_variation' && active.length > 0) {
	        if (inactiveIndex >= 0) {
	          const trimmedInactive = inactive.filter((item) => speciesItemKey(item) !== key)
	          setInactiveSelectedSpecies(trimmedInactive)
	          persistNextPreviousSessionGenomes([...active, ...trimmedInactive], currentConfig)
	          return { ok: true, activated: false, deselected: true }
	        }
	        const appendedInactive = appendUniqueSpecies(inactive, species)
	        setInactiveSelectedSpecies(appendedInactive)
	        persistNextPreviousSessionGenomes([...active, ...appendedInactive], currentConfig)
	        return { ok: true, activated: false, reason: 'added_inactive' }
      }

      if (Number.isFinite(viewCapacity) && viewCapacity > 0 && contextFullyActive.length >= viewCapacity) {
        return {
          ok: false,
          reason: 'view_limit_reached',
          message: 'Deactivate one active genome in this view before activating another.',
        }
      }

      nextActive = appendUniqueSpecies(active, species)
      nextInactive = inactive.filter((item) => speciesItemKey(item) !== key)
      if (viewCapacity === 1) {
        nextFocus.primaryKey = key
        nextFocus.secondaryKey = ''
      } else if (TWO_GENOME_VIEWS.has(currentView)) {
        if (!nextFocus.primaryKey) {
          nextFocus.primaryKey = key
        } else if (!nextFocus.secondaryKey && nextFocus.primaryKey !== key) {
          nextFocus.secondaryKey = key
        }
      } else if (!nextFocus.primaryKey && nextActive.length > 0) {
        nextFocus.primaryKey = speciesItemKey(nextActive[0])
      }
      nextFocus = buildFocusFromActive(nextActive, nextFocus)
    }

    suppressViewSyncRef.current = true
    try {
      setInactiveSelectedSpecies(nextInactive)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

	      const nextConfig = getAlignedGenomeConfigForView(
	        withNextPreviousSessionGenomes(
	          { ...currentConfig, active_species: nextActive },
	          [...nextActive, ...nextInactive]
	        ),
	        currentView,
	        nextFocus
      )
      const activeChanged = !speciesListsEqualByKey(currentConfig?.active_species || [], nextConfig?.active_species || [])
      if (activeChanged || hasGenomeAssignmentChanges(currentConfig, nextConfig)) {
        await handleBrowserConfigChange(nextConfig)
      }
      return { ok: true, activated: activeIndex < 0 }
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [
    buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView,
    getContextFullyActiveSpecies, hasGenomeAssignmentChanges, persistNextPreviousSessionGenomes,
    toggleTutorialGenome, tutorialConfig,
  ])

  const handleApplyPlaylistFromSelector = useCallback(async ({ playlistId, activeSpecies, selectedSpecies }) => {
    const currentConfig = configRef.current || config
    const nextSelected = dedupeSpeciesList(selectedSpecies || activeSpecies || [])
    const nextActive = dedupeSpeciesList(activeSpecies || nextSelected.slice(0, 1))
    const activeKeys = new Set(nextActive.map((species) => speciesItemKey(species)))
    const nextInactive = nextSelected.filter((species) => !activeKeys.has(speciesItemKey(species)))
    const nextFocus = buildFocusFromActive(nextActive, {
      primaryKey: nextActive[0] ? speciesItemKey(nextActive[0]) : '',
      secondaryKey: nextActive[1] ? speciesItemKey(nextActive[1]) : '',
    })

    suppressViewSyncRef.current = true
    try {
      setInactiveSelectedSpecies(nextInactive)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

	      const nextConfig = getAlignedGenomeConfigForView(
	        withNextPreviousSessionGenomes(
	          {
	            ...currentConfig,
	            selected_genome_playlist_id: playlistId || '__all__',
	            active_species: nextActive,
	          },
	          nextSelected
	        ),
        currentView,
        nextFocus
      )

      await handleBrowserConfigChange(nextConfig)
      return { ok: true }
    } catch (error) {
      console.error('Failed to apply genome playlist:', error)
      return { ok: false, message: error?.message || 'Unable to apply genome playlist.' }
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView, persistNextPreviousSessionGenomes])

  const resolveLocalSpeciesForPlaylist = useCallback(async (playlist) => {
    const currentConfig = configRef.current || config
    const outputDir = String(currentConfig?.output_dir || '').trim()
    let localAssemblies = []
    if (outputDir) {
      const res = await fetch(`${API_BASE}/api/remote/local-assemblies?output_dir=${encodeURIComponent(outputDir)}`)
      if (res.ok) {
        const data = await res.json()
        localAssemblies = Array.isArray(data) ? data : []
      }
    }

    const byKey = new Map()
    const addCandidate = (item) => {
      const normalized = normalizeGenomeRecord(item)
      const key = speciesItemKey(normalized)
      if (key && !byKey.has(key)) byKey.set(key, normalized)
    }
    for (const item of localAssemblies) {
      addCandidate(item)
      for (const instance of Array.isArray(item?.dataset_instances) ? item.dataset_instances : []) {
        addCandidate(instance)
      }
    }
    for (const item of currentConfig?.manual_species || []) addCandidate({ ...item, is_manual: true })

    const playlistGenomes = Array.isArray(playlist?.genomes) ? playlist.genomes : []
    const hasExplicitActiveDefaults = playlistGenomes.some((genome) => Object.prototype.hasOwnProperty.call(genome || {}, 'active_by_default'))
    const availablePairs = []
    for (const genome of playlistGenomes) {
      const liveItem = Array.from(byKey.values()).find((item) => genomeKeysMatch(item, genome))
      if (!liveItem?.files?.gff3) continue
      if (availablePairs.some((entry) => genomeKeysMatch(entry.liveItem, liveItem))) continue
      availablePairs.push({ genome, liveItem })
    }
    const availableSpecies = availablePairs.map((entry) => entry.liveItem)
    const activeSpecies = availablePairs
      .filter((entry) => Boolean(entry.genome?.active_by_default))
      .map((entry) => entry.liveItem)
    return {
      activeSpecies: activeSpecies.length > 0 || hasExplicitActiveDefaults ? activeSpecies : availableSpecies.slice(0, 1),
      availableSpecies,
    }
  }, [config])

  const handleTopBarPlaylistSelect = useCallback(async (playlist) => {
    if (!playlist?.id || applyingGenomePlaylistId) return
    setApplyingGenomePlaylistId(playlist.id)
    try {
      const { activeSpecies, availableSpecies } = await resolveLocalSpeciesForPlaylist(playlist)
      const result = await handleApplyPlaylistFromSelector({
        playlistId: playlist.id,
        playlist,
        activeSpecies,
        selectedSpecies: availableSpecies,
      })
      if (result?.ok !== false) {
        setGenomePlaylistPopoverOpen(false)
      }
    } catch (error) {
      console.error('Failed to apply genome playlist from top bar:', error)
    } finally {
      setApplyingGenomePlaylistId('')
    }
  }, [applyingGenomePlaylistId, handleApplyPlaylistFromSelector, resolveLocalSpeciesForPlaylist])

  const handleSpeciesPillReorder = useCallback(async ({
    source,
    target,
    sourceKey = '',
    targetKey = '',
    insertPosition = 'before',
  }) => {
    const normalizedSourceKey = sourceKey || speciesItemKey(source)
    const normalizedTargetKey = targetKey || speciesItemKey(target)
    if (!normalizedSourceKey || !normalizedTargetKey || normalizedSourceKey === normalizedTargetKey) return

    const currentConfig = configRef.current || config
    const active = dedupeSpeciesList(currentConfig?.active_species)
    const inactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)
    const sourceInActive = active.some((item) => speciesItemKey(item) === normalizedSourceKey)
    const targetInActive = active.some((item) => speciesItemKey(item) === normalizedTargetKey)
    if (!targetInActive) return

    let nextActive = active
    let nextInactive = inactive

    if (sourceInActive) {
      const orderedKeys = active.map((item) => speciesItemKey(item))
      const reorderedKeys = reorderWithInsertPosition(orderedKeys, normalizedSourceKey, normalizedTargetKey, insertPosition)
      if (orderedKeys.join('|') === reorderedKeys.join('|')) return
      const byKey = new Map(active.map((item) => [speciesItemKey(item), item]))
      nextActive = reorderedKeys.map((key) => byKey.get(key)).filter(Boolean)
    } else {
      const sourceSpecies = inactive.find((item) => speciesItemKey(item) === normalizedSourceKey) || source
      if (!sourceSpecies) return
      const targetIndex = active.findIndex((item) => speciesItemKey(item) === normalizedTargetKey)
      if (targetIndex < 0) return
      const insertionIndex = insertPosition === 'after' ? targetIndex + 1 : targetIndex
      nextActive = [...active]
      nextActive.splice(insertionIndex, 0, sourceSpecies)
      nextActive = dedupeSpeciesList(nextActive)
      nextInactive = inactive.filter((item) => speciesItemKey(item) !== normalizedSourceKey)
    }

    const first = nextActive[0] ? speciesItemKey(nextActive[0]) : ''
    const second = nextActive[1] ? speciesItemKey(nextActive[1]) : ''
    const nextFocus = buildFocusFromActive(nextActive, { primaryKey: first, secondaryKey: second })

    suppressViewSyncRef.current = true
    try {
      setInactiveSelectedSpecies(nextInactive)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

		      const nextConfig = getAlignedGenomeConfigForView(
		        withNextPreviousSessionGenomes(
		          { ...currentConfig, active_species: nextActive },
		          [...nextActive, ...nextInactive]
		        ),
	        currentView,
	        nextFocus
      )
      if (
        !speciesListsEqualByKey(currentConfig?.active_species || [], nextConfig?.active_species || []) ||
        hasGenomeAssignmentChanges(currentConfig, nextConfig)
      ) {
        await handleBrowserConfigChange(nextConfig)
      }
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView, hasGenomeAssignmentChanges, handleBrowserConfigChange])

  const handleGenomeWheelPromote = useCallback(async (sourceKey, action, source) => {
    const currentConfig = tutorialConfig || configRef.current || config
    const active = dedupeSpeciesList(currentConfig.active_species)
    const listed = dedupeSpeciesList([
      ...active,
      ...(tutorialConfig ? (tutorialConfig.tutorial_selected_genomes || []) : inactiveSelectedSpeciesRef.current || []),
      ...(source ? [source] : []),
    ])
    const selection = cycleSelection(active, listed, sourceKey, action)
    if (!selection) throw new Error('This genome cannot be opened')
    if (speciesListsEqualByKey(active, selection.active)) return
    const nextFocus = buildFocusFromActive(selection.active, {
      primaryKey: speciesItemKey(selection.active[0]),
      secondaryKey: selection.active[1] ? speciesItemKey(selection.active[1]) : '',
    })
    suppressViewSyncRef.current = true
    try {
      if (!tutorialConfig) setInactiveSelectedSpecies(selection.inactive)
      dualViewFocusRef.current = nextFocus
      setDualViewFocus(nextFocus)
      const nextConfig = getAlignedGenomeConfigForView(
        withNextPreviousSessionGenomes({ ...currentConfig, active_species: selection.active }, listed),
        'genome_browser', nextFocus,
      )
      await handleBrowserConfigChange(nextConfig)
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, tutorialConfig, getAlignedGenomeConfigForView, handleBrowserConfigChange])

  const handleStructuralVariationGenomeOrderChange = useCallback(async (orderedSpecies, options = {}) => {
    const currentConfig = configRef.current || config
    const active = dedupeSpeciesList(currentConfig?.active_species)
    const inactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)
    const byKey = new Map([...active, ...inactive].map((species) => [speciesItemKey(species), species]))
    const hasOption = (name) => Object.prototype.hasOwnProperty.call(options || {}, name)
    const deactivated = dedupeSpeciesList(options?.deactivateSpecies || [])
      .map((species) => byKey.get(speciesItemKey(species)) || species)
      .filter(Boolean)
    const deactivatedKeys = new Set(deactivated.map((species) => speciesItemKey(species)))
    const ordered = dedupeSpeciesList(orderedSpecies || [])
      .map((species) => byKey.get(speciesItemKey(species)) || species)
      .filter((species) => !deactivatedKeys.has(speciesItemKey(species)))
      .filter(Boolean)
    if (!ordered.length && !options?.allowEmpty) return

    const orderedKeys = new Set(ordered.map((species) => speciesItemKey(species)))
    const preservedActive = active.filter((species) => {
      const key = speciesItemKey(species)
      return !orderedKeys.has(key) && !deactivatedKeys.has(key)
    })
    const nextActive = dedupeSpeciesList([
      ...ordered,
      ...preservedActive,
    ])
    const nextInactive = dedupeSpeciesList([
      ...deactivated,
      ...inactive.filter((species) => {
        const key = speciesItemKey(species)
        return !orderedKeys.has(key) && !deactivatedKeys.has(key)
      }),
    ])
    const nextFocus = buildFocusFromActive(nextActive, {
      primaryKey: nextActive[0] ? speciesItemKey(nextActive[0]) : '',
      secondaryKey: nextActive[1] ? speciesItemKey(nextActive[1]) : '',
    })
    const nextSvAnchorKey = hasOption('anchorKey')
      ? String(options.anchorKey || '')
      : (ordered[0] ? speciesItemKey(ordered[0]) : svAnchorSpeciesKey)
    const nextSvSecondKey = hasOption('secondKey')
      ? String(options.secondKey || '')
      : (ordered[1] ? speciesItemKey(ordered[1]) : svSecondSpeciesKey)
    const nextSvThirdKey = hasOption('thirdKey')
      ? String(options.thirdKey || '')
      : (ordered[2] ? speciesItemKey(ordered[2]) : svThirdSpeciesKey)
    const nextSvRegionId = options?.clearRegion ? '' : (hasOption('regionId') ? String(options.regionId || '') : svAnchorRegionId)
    const nextSvRegionExplicitlySelected = options?.clearRegion
      ? false
      : (hasOption('regionExplicitlySelected') ? Boolean(options.regionExplicitlySelected) : svRegionExplicitlySelected)
    const svStateChanged =
      nextSvAnchorKey !== svAnchorSpeciesKey ||
      nextSvSecondKey !== svSecondSpeciesKey ||
      nextSvThirdKey !== svThirdSpeciesKey ||
      nextSvRegionId !== svAnchorRegionId ||
      nextSvRegionExplicitlySelected !== svRegionExplicitlySelected

    if (
      !svStateChanged &&
      speciesListsEqualByKey(active, nextActive) &&
      speciesListsEqualByKey(inactive, nextInactive) &&
      nextFocus.primaryKey === dualViewFocusRef.current.primaryKey &&
      nextFocus.secondaryKey === dualViewFocusRef.current.secondaryKey
    ) {
      return
    }

    suppressViewSyncRef.current = true
    try {
      if (nextSvAnchorKey !== svAnchorSpeciesKey) setSvAnchorSpeciesKey(nextSvAnchorKey)
      if (nextSvSecondKey !== svSecondSpeciesKey) setSvSecondSpeciesKey(nextSvSecondKey)
      if (nextSvThirdKey !== svThirdSpeciesKey) setSvThirdSpeciesKey(nextSvThirdKey)
      if (nextSvRegionId !== svAnchorRegionId) setSvAnchorRegionId(nextSvRegionId)
      if (nextSvRegionExplicitlySelected !== svRegionExplicitlySelected) {
        setSvRegionExplicitlySelected(nextSvRegionExplicitlySelected)
      }
      const immediateFullyActiveKeys = nextSvAnchorKey && nextSvAnchorKey !== SV_NO_ANCHOR_KEY
        ? [
            nextSvAnchorKey,
            ...(nextSvRegionExplicitlySelected ? [nextSvSecondKey, nextSvThirdKey] : []),
          ].filter(Boolean)
        : []
      setSvFullyActiveSpeciesKeys((prev) => (
        sameStringArrayItems(prev, immediateFullyActiveKeys) ? prev : immediateFullyActiveKeys
      ))
      setInactiveSelectedSpecies(nextInactive)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

      const nextConfig = getAlignedGenomeConfigForView(
        withNextPreviousSessionGenomes(
          { ...currentConfig, active_species: nextActive },
          [...nextActive, ...nextInactive],
        ),
        'structural_variation',
        nextFocus,
      )
      if (
        !speciesListsEqualByKey(currentConfig?.active_species || [], nextConfig?.active_species || []) ||
        hasGenomeAssignmentChanges(currentConfig, nextConfig)
      ) {
        await handleBrowserConfigChange(nextConfig)
      }
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [
    buildFocusFromActive,
    config,
    getAlignedGenomeConfigForView,
    hasGenomeAssignmentChanges,
    handleBrowserConfigChange,
    svAnchorRegionId,
    svAnchorSpeciesKey,
    svSecondSpeciesKey,
    svThirdSpeciesKey,
    svRegionExplicitlySelected,
  ])

  const handleStructuralVariationPillToggle = useCallback(async (species, source = 'pill') => {
    if (!species) return { ok: false, reason: 'missing_species' }
    const key = speciesItemKey(species)
    const anchorKey = svAnchorSpecies ? speciesItemKey(svAnchorSpecies) : ''
    const secondKey = svSecondSpecies ? speciesItemKey(svSecondSpecies) : ''
    const thirdKey = svThirdSpecies ? speciesItemKey(svThirdSpecies) : ''

    if (anchorKey && key === anchorKey) {
      await handleStructuralVariationGenomeOrderChange([], {
        allowEmpty: true,
        deactivateSpecies: [species],
        anchorKey: SV_NO_ANCHOR_KEY,
        secondKey: '',
        thirdKey: '',
        clearRegion: true,
      })
      return { ok: true, deactivated: true }
    }

    if (secondKey && key === secondKey) {
      const promotedThird = svThirdSpecies || null
      await handleStructuralVariationGenomeOrderChange(
        [svAnchorSpecies, promotedThird].filter(Boolean),
        {
          deactivateSpecies: [species],
          anchorKey,
          secondKey: promotedThird ? speciesItemKey(promotedThird) : '',
          thirdKey: '',
        },
      )
      return { ok: true, deactivated: true }
    }

    if (thirdKey && key === thirdKey) {
      await handleStructuralVariationGenomeOrderChange(
        [svAnchorSpecies, svSecondSpecies].filter(Boolean),
        {
          deactivateSpecies: [species],
          anchorKey,
          secondKey,
          thirdKey: '',
        },
      )
      return { ok: true, deactivated: true }
    }

    return handleSpeciesPillToggle(species, source)
  }, [
    handleSpeciesPillToggle,
    handleStructuralVariationGenomeOrderChange,
    svAnchorSpecies,
    svSecondSpecies,
    svThirdSpecies,
  ])

  const handleRemoveSpeciesFromList = useCallback(async (species) => {
    if (!species) return { ok: false, reason: 'missing_species' }

    const key = speciesItemKey(species)
    const currentConfig = configRef.current || config
    const active = dedupeSpeciesList(currentConfig?.active_species)
    const inactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)

    const nextActive = active.filter((item) => speciesItemKey(item) !== key)
    const nextInactive = inactive.filter((item) => speciesItemKey(item) !== key)
    const activeChanged = !speciesListsEqualByKey(active, nextActive)

    suppressViewSyncRef.current = true
    try {
      setInactiveSelectedSpecies(nextInactive)

      let nextFocus = buildFocusFromActive(active, dualViewFocusRef.current)
      if (nextFocus.primaryKey === key) {
        nextFocus.primaryKey = nextFocus.secondaryKey || ''
        nextFocus.secondaryKey = ''
      } else if (nextFocus.secondaryKey === key) {
        nextFocus.secondaryKey = ''
      }
      nextFocus = buildFocusFromActive(nextActive, nextFocus)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

	      persistNextPreviousSessionGenomes([...nextActive, ...nextInactive], currentConfig)
	      if (!activeChanged) return { ok: true }

	      const nextConfig = getAlignedGenomeConfigForView(
	        withNextPreviousSessionGenomes(
	          { ...currentConfig, active_species: nextActive },
	          [...nextActive, ...nextInactive]
	        ),
	        currentView,
	        nextFocus
	      )
      await handleBrowserConfigChange(nextConfig)
      return { ok: true }
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView, persistNextPreviousSessionGenomes])

  const handlePromoteSecondaryToPrimary = useCallback(async () => {
    const currentConfig = configRef.current || config
    const active = dedupeSpeciesList(currentConfig?.active_species)
    if (active.length === 0) return { ok: false, reason: 'no_active_genomes' }

    const primarySpecies = active.find((species) => species?.files?.gff3 === currentConfig?.ref_gff) || null
    const secondarySpecies = active.find((species) => species?.files?.gff3 === currentConfig?.target_gff) || null
    if (!secondarySpecies) return { ok: false, reason: 'no_secondary' }

    const nextFocus = buildFocusFromActive(active, {
      primaryKey: speciesItemKey(secondarySpecies),
      secondaryKey: primarySpecies ? speciesItemKey(primarySpecies) : '',
    })

    suppressViewSyncRef.current = true
    try {
      dualViewFocusRef.current = nextFocus
      setDualViewFocus(nextFocus)

      const nextConfig = getAlignedGenomeConfigForView(currentConfig, currentView, nextFocus)
      if (hasGenomeAssignmentChanges(currentConfig, nextConfig)) {
        await handleBrowserConfigChange(nextConfig)
      }
      return { ok: true }
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView, hasGenomeAssignmentChanges])

  const alignmentLoaded = loadedParams !== null &&
    loadedParams.refId === refResolved?.selectedTranscriptId &&
    loadedParams.targetId === tgtResolved?.selectedTranscriptId &&
    loadedParams.refFlank === refFlankBp &&
    loadedParams.tgtFlank === tgtFlankBp
  const bothResolved = !!refResolved?.selectedTranscriptId && !!tgtResolved?.selectedTranscriptId

  const G1_TAG = 'G1'
  const G2_TAG = 'G2'
  const g1Label = buildGenomeLabel(G1_TAG, refSpecies, 'Reference')
  const g2Label = buildGenomeLabel(G2_TAG, tgtSpecies, 'Secondary')
  const g1PillLabel = buildGenomePillLabel(refSpecies)
  const g2PillLabel = buildGenomePillLabel(tgtSpecies)
  const svAnchorPillLabel = buildGenomePillLabel(svAnchorSpecies)
  const svSecondPillLabel = buildGenomePillLabel(svSecondSpecies)
  const svThirdPillLabel = buildGenomePillLabel(svThirdSpecies)
  const structuralVariationViewKey = [
    'structural_variation',
    speciesItemKey(svAnchorSpecies),
  ].join('|')
  const featureExplorerAvailableGenomes = useMemo(
    () => dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3)),
    [config?.active_species]
  )
  const featureExplorerDefaultGenomeKey = refGenomeKey || (featureExplorerAvailableGenomes[0] ? speciesItemKey(featureExplorerAvailableGenomes[0]) : '')
  const focusGeneByGenome = useMemo(() => {
    const next = { ...(browserFocusByGenome || {}) }
    if (refGenomeKey) {
      if (browserRefGene) next[refGenomeKey] = browserRefGene
      else delete next[refGenomeKey]
    }
    if (tgtGenomeKey && tgtGenomeKey !== refGenomeKey) {
      if (browserTgtGene) next[tgtGenomeKey] = browserTgtGene
      else delete next[tgtGenomeKey]
    }
    return next
  }, [browserFocusByGenome, browserRefGene, browserTgtGene, refGenomeKey, tgtGenomeKey])
  // Where each genome is being read, gathered from wherever the reader left it:
  // the gene in focus in the browser's panels, and any region pinned there. The
  // sequence view opens on this when the reader switches genomes, rather than
  // dropping them at that genome's default starting locus.
  const genomeStartingPoints = useMemo(() => {
    const out = {}
    for (const [key, gene] of Object.entries(focusGeneByGenome || {})) {
      if (gene) out[key] = { gene }
    }
    for (const [key, location] of Object.entries(browserLocationFocusByGenome || {})) {
      if (location) out[key] = { ...(out[key] || {}), location }
    }
    return out
  }, [focusGeneByGenome, browserLocationFocusByGenome])

  const neighbourhoodGenomes = useMemo(
    () => {
      const activeGenomes = dedupeSpeciesList(config?.active_species || []).filter((species) => Boolean(species?.files?.gff3))
      if (!activeGenomes.length) return []
      const byKey = new Map(activeGenomes.map((species) => [speciesItemKey(species), species]))
      const ordered = []
      const seen = new Set()
      for (const key of neighbourhoodGenomeOrderKeys) {
        const species = byKey.get(key)
        if (!species || seen.has(key)) continue
        seen.add(key)
        ordered.push(species)
      }
      for (const species of activeGenomes) {
        const key = speciesItemKey(species)
        if (!key || seen.has(key)) continue
        seen.add(key)
        ordered.push(species)
      }
      return ordered
    },
    [config?.active_species, neighbourhoodGenomeOrderKeys]
  )

  // Pre-check homology-TSV availability for every genome currently in the Neighbourhood
  // view, so the "Use Homology" button's enabled/disabled state and tooltip are correct
  // before the user ever clicks it. Genomes with a local file are 'local' immediately
  // (no network call); others are checked once each against the remote files catalog.
  useEffect(() => {
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      if (!key) continue
      if (species?.files?.homology) {
        setNeighbourhoodHomologyAvailabilityByGenome((prev) => (
          prev?.[key] === 'local' ? prev : { ...prev, [key]: 'local' }
        ))
        continue
      }
      if (neighbourhoodHomologyCheckedGenomeKeysRef.current.has(key)) continue
      neighbourhoodHomologyCheckedGenomeKeysRef.current.add(key)

      const provider = normalizeGenomeProvider(species)
      if (provider === MANUAL_PROVIDER) {
        setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'unavailable' }))
        continue
      }

      const speciesKey = String(species?.species_key || '').trim()
      const assembly = getAssemblyAccession(species)
      if (!speciesKey || !assembly) {
        setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'unavailable' }))
        continue
      }

      setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'checking' }))
      const url = `${API_BASE}/api/remote/files/${encodeURIComponent(speciesKey)}/${encodeURIComponent(assembly)}?provider=${encodeURIComponent(provider)}&file_types=homology`
      fetch(url)
        .then((res) => (res.ok ? res.json() : []))
        .then((files) => {
          const available = Array.isArray(files) && files.some((f) => f?.type === 'homology')
          setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: available ? 'downloadable' : 'unavailable' }))
        })
        .catch(() => {
          setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'unavailable' }))
        })
    }
  }, [neighbourhoodGenomes])

  // "Use Homology" — toggle real Compara-homology links in the Neighbourhood view,
  // auto-downloading any missing-but-available homology TSV files first.
  const handleNeighbourhoodUseHomologyClick = useCallback(async () => {
    if (neighbourhoodUseHomology) {
      setNeighbourhoodUseHomology(false)
      setNeighbourhoodHomologyPairLoading({})
      return
    }

    const eligibleGenomes = neighbourhoodGenomes.filter((species) => {
      const availability = neighbourhoodHomologyAvailabilityByGenome?.[speciesItemKey(species)]
      return availability === 'local' || availability === 'downloadable'
    })
    if (!eligibleGenomes.length) return

    // Mark every adjacent, enabled genome pair as "loading" immediately so the view can
    // blank out old links and show a spinner right away, covering both the download
    // wait (below) and the subsequent /api/neighbourhood fetch once homology mode flips on.
    const enabledKeysForLoading = neighbourhoodGenomes
      .map((species) => speciesItemKey(species))
      .filter((key) => key && !neighbourhoodDisabledByGenome?.[key])
    const seedLoadingPairKeys = []
    for (let i = 0; i < enabledKeysForLoading.length - 1; i += 1) {
      const pk = buildNeighbourhoodPairKey(enabledKeysForLoading[i], enabledKeysForLoading[i + 1])
      if (pk) seedLoadingPairKeys.push(pk)
    }
    if (seedLoadingPairKeys.length) {
      setNeighbourhoodHomologyPairLoading((prev) => {
        const next = { ...prev }
        for (const pk of seedLoadingPairKeys) next[pk] = true
        return next
      })
    }

    const downloadableGenomes = eligibleGenomes.filter((species) => (
      neighbourhoodHomologyAvailabilityByGenome?.[speciesItemKey(species)] === 'downloadable'
    ))

    if (downloadableGenomes.length) {
      if (!config?.output_dir) {
        setNeighbourhoodHomologyError('Set an Output Directory in Configuration before downloading homology data.')
        setNeighbourhoodHomologyPairLoading({})
        return
      }
      setNeighbourhoodHomologyError('')

      await Promise.all(downloadableGenomes.map(async (species) => {
        const key = speciesItemKey(species)
        const provider = normalizeGenomeProvider(species)
        const speciesKey = String(species?.species_key || '').trim()
        const assembly = getAssemblyAccession(species)
        setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'downloading' }))
        try {
          const filesRes = await fetch(`${API_BASE}/api/remote/files/${encodeURIComponent(speciesKey)}/${encodeURIComponent(assembly)}?provider=${encodeURIComponent(provider)}&file_types=homology`)
          if (!filesRes.ok) throw new Error('Could not fetch homology file info')
          const files = await filesRes.json()
          const file = Array.isArray(files) ? files.find((f) => f?.type === 'homology') : null
          if (!file) throw new Error('No homology file found')

          const res = await fetch(`${API_BASE}/api/remote/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: file.url,
              filename: file.filename,
              provider,
              species_key: speciesKey,
              assembly,
              file_type: 'homology',
              output_dir: config.output_dir,
              scientific_name: species.scientific_name || '',
              common_name: species.common_name || '',
              display_name: species.display_name || '',
              display_name_reason: species.display_name_reason || '',
              assembly_name: species.assembly_name || '',
              source_database: species.source_database || '',
              equivalent_accessions: species.equivalent_accessions || [],
              ...datasetReleaseDownloadMetadata(file, species),
            }),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data?.detail || 'Failed to start homology download')

          if (data?.status === 'already_exists' || data?.status === 'completed') {
            setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'local' }))
          } else if (data?.task_id) {
            setNeighbourhoodHomologyDownloadTaskByGenome((prev) => ({ ...prev, [key]: data.task_id }))
          } else {
            setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'download_failed' }))
          }
        } catch {
          setNeighbourhoodHomologyAvailabilityByGenome((prev) => ({ ...prev, [key]: 'download_failed' }))
        }
      }))

      // Wait for the /api/remote/tasks poller (above) to resolve every triggered
      // download to 'local' or 'download_failed' before switching modes on, so the
      // very first homology-mode fetch already has the files it needs.
      const downloadKeys = downloadableGenomes.map((species) => speciesItemKey(species))
      const deadline = Date.now() + 120000
      while (Date.now() < deadline) {
        const availability = neighbourhoodHomologyAvailabilityByGenomeRef.current || {}
        const stillWaiting = downloadKeys.some((key) => availability[key] === 'downloading')
        if (!stillWaiting) break
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    }

    const finalAvailability = neighbourhoodHomologyAvailabilityByGenomeRef.current || {}
    const unavailableKeys = neighbourhoodGenomes
      .map((species) => speciesItemKey(species))
      .filter((key) => {
        const state = finalAvailability[key]
        return state === 'unavailable' || state === 'download_failed' || state === 'downloading'
      })
    setNeighbourhoodHomologyError(
      unavailableKeys.length
        ? `${unavailableKeys.length} of ${neighbourhoodGenomes.length} genomes lack homology data — those links will use approximate matching instead.`
        : ''
    )
    setNeighbourhoodUseHomology(true)
  }, [neighbourhoodUseHomology, neighbourhoodGenomes, neighbourhoodHomologyAvailabilityByGenome, config?.output_dir])

  // Auto-populate focus genes for genomes that don't have one yet, using the first
  // (primary) enabled genome's focus gene as the sole source — never the reverse, and
  // never from any other non-primary genome. Symbol/ID mode looks for the same gene
  // symbol/ID in each missing genome; Homology mode looks up the best Compara hit.
  useEffect(() => {
    // Focus is shared between views, but cross-genome completion belongs to the
    // Neighbourhood view. Without this guard, selecting a gene in Genome Browser
    // searched every other active genome even though the user had not linked them.
    if (currentView !== 'neighbourhood') return

    const enabledGenomes = neighbourhoodGenomes.filter((species) => {
      const key = speciesItemKey(species)
      return key && !neighbourhoodDisabledByGenome?.[key]
    })
    if (enabledGenomes.length < 2) return

    const primarySpecies = enabledGenomes[0]
    const primaryKey = speciesItemKey(primarySpecies)
    const primaryGene = focusGeneByGenome?.[primaryKey]
    const primaryGeneId = String(primaryGene?.id || '').trim()
    if (!primaryGeneId) return

    const missingGenomes = enabledGenomes.slice(1).filter((species) => {
      const key = speciesItemKey(species)
      return key && !focusGeneByGenome?.[key]
    })
    if (!missingGenomes.length) return

    const mode = neighbourhoodUseHomology ? 'homology' : 'symbol'
    const attemptSignature = `${mode}:${primaryKey}:${primaryGeneId}`
    const pendingGenomes = missingGenomes.filter((species) => (
      neighbourhoodAnchorResolutionAttemptRef.current[speciesItemKey(species)] !== attemptSignature
    ))
    if (!pendingGenomes.length) return
    for (const species of pendingGenomes) {
      neighbourhoodAnchorResolutionAttemptRef.current[speciesItemKey(species)] = attemptSignature
    }

    let cancelled = false

    const run = async () => {
      const noHitKeys = []

      if (mode === 'symbol') {
        // Same endpoint the Genome Browser's own cross-genome "link genes" feature
        // uses (case-insensitive name/ID match) — kept consistent so a gene that
        // resolves there also resolves here, regardless of symbol-casing differences
        // between genomes' own annotations.
        const query = String(primaryGene?.name || primaryGene?.id || '').trim()
        await Promise.all(pendingGenomes.map(async (species) => {
          const key = speciesItemKey(species)
          if (!query) { noHitKeys.push(key); return }
          try {
            const res = await fetch(`${API_BASE}/api/browse/search_gene?genome=${encodeURIComponent(key)}&query=${encodeURIComponent(query)}`)
            if (!res.ok) { noHitKeys.push(key); return }
            const gene = await res.json()
            if (!gene?.id) { noHitKeys.push(key); return }
            if (!cancelled) {
              handleGenomeFocusGeneSelect(key, gene)
              const label = String(gene?.name || gene?.id || query).trim()
              if (label) setNeighbourhoodQueryByGenome((prev) => ({ ...prev, [key]: label }))
              handleNeighbourhoodResolveGenome(key, label || gene.id)
            }
          } catch {
            noHitKeys.push(key)
          }
        }))
      } else {
        const targetKeys = pendingGenomes.map((species) => speciesItemKey(species)).filter(Boolean)
        try {
          const url = `${API_BASE}/api/neighbourhood/homology_anchor?genome=${encodeURIComponent(primaryKey)}&gene_id=${encodeURIComponent(primaryGeneId)}&target_genomes=${encodeURIComponent(targetKeys.join(','))}`
          const res = await fetch(url)
          const data = res.ok ? await res.json() : null
          const hits = data?.hits || {}
          for (const key of targetKeys) {
            const hit = hits?.[key]
            if (hit?.gene_id && !cancelled) {
              const gene = { id: hit.gene_id, name: hit.gene_name || hit.gene_id }
              handleGenomeFocusGeneSelect(key, gene)
              const label = String(gene.name || gene.id || '').trim()
              if (label) setNeighbourhoodQueryByGenome((prev) => ({ ...prev, [key]: label }))
              handleNeighbourhoodResolveGenome(key, label || gene.id)
            } else {
              noHitKeys.push(key)
            }
          }
        } catch {
          noHitKeys.push(...targetKeys)
        }
      }

      if (cancelled) return
      const pendingKeySet = new Set(pendingGenomes.map((species) => speciesItemKey(species)))
      setNeighbourhoodNoHitGenomeKeys((prev) => [...prev.filter((key) => !pendingKeySet.has(key)), ...noHitKeys])
    }

    run()
    return () => { cancelled = true }
  }, [currentView, neighbourhoodGenomes, neighbourhoodDisabledByGenome, focusGeneByGenome, neighbourhoodUseHomology, handleGenomeFocusGeneSelect, handleNeighbourhoodResolveGenome])

  // Independent cleanup: drop any genome from the "no hit" list as soon as it has a
  // focus gene from any source (auto-resolved or chosen directly by the user), or once
  // it's no longer an active genome at all.
  useEffect(() => {
    setNeighbourhoodNoHitGenomeKeys((prev) => {
      if (!prev.length) return prev
      const activeKeys = new Set(neighbourhoodGenomes.map((species) => speciesItemKey(species)))
      const next = prev.filter((key) => activeKeys.has(key) && !focusGeneByGenome?.[key])
      return next.length === prev.length ? prev : next
    })
  }, [neighbourhoodGenomes, focusGeneByGenome])

  // Backstop for auto-populated Neighbourhood search boxes: if a row has a
  // query label but no loaded track yet, resolve that label just as the Go
  // button would. This keeps symbol-case matches such as PHGDH -> Phgdh from
  // stopping at "text in the box" without loading the mouse region.
  useEffect(() => {
    if (currentView !== 'neighbourhood') return

    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      if (!key || neighbourhoodDisabledByGenome?.[key]) continue
      if (neighbourhoodLoadingByGenome?.[key] || neighbourhoodResolvingByGenome?.[key]) continue

      const query = String(neighbourhoodQueryByGenome?.[key] || '').trim()
      if (!query) continue

      const track = neighbourhoodTracksByGenome?.[key]
      const hasLoadedTrack = Array.isArray(track?.genes) && track.genes.length > 0
      if (hasLoadedTrack) continue

      const queryNorm = query.toLowerCase()
      const signature = `${key}:${queryNorm}`
      if (neighbourhoodQueryResolutionAttemptRef.current[key] === signature) continue
      neighbourhoodQueryResolutionAttemptRef.current[key] = signature
      handleNeighbourhoodResolveGenome(key, query)
    }
  }, [
    currentView,
    neighbourhoodGenomes,
    neighbourhoodDisabledByGenome,
    neighbourhoodLoadingByGenome,
    neighbourhoodResolvingByGenome,
    neighbourhoodQueryByGenome,
    neighbourhoodTracksByGenome,
    handleNeighbourhoodResolveGenome,
  ])

  const neighbourhoodLoadingStateByGenome = useMemo(() => {
    const next = {}
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      next[key] = Boolean(neighbourhoodLoadingByGenome?.[key] || neighbourhoodResolvingByGenome?.[key])
    }
    return next
  }, [neighbourhoodGenomes, neighbourhoodLoadingByGenome, neighbourhoodResolvingByGenome])
  const neighbourhoodQueryStateByGenome = useMemo(() => {
    const next = {}
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      next[key] = String(neighbourhoodQueryByGenome?.[key] || '')
    }
    return next
  }, [neighbourhoodGenomes, neighbourhoodQueryByGenome])
  const neighbourhoodTrackStateByGenome = useMemo(() => {
    const next = {}
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      const row = neighbourhoodTracksByGenome?.[key]
      next[key] = row || { genes: [], centerGeneId: '', requestGeneId: '', windowSize: 0 }
    }
    return next
  }, [neighbourhoodGenomes, neighbourhoodTracksByGenome])
  const neighbourhoodErrorStateByGenome = useMemo(() => {
    const next = {}
    for (const species of neighbourhoodGenomes) {
      const key = speciesItemKey(species)
      next[key] = String(neighbourhoodErrorByGenome?.[key] || '')
    }
    return next
  }, [neighbourhoodGenomes, neighbourhoodErrorByGenome])
  const featureExplorerSelectedGenome = useMemo(() => {
    const key = String(featureExplorerGenomeKey || '').trim()
    return featureExplorerAvailableGenomes.find((species) => speciesItemKey(species) === key) || null
  }, [featureExplorerAvailableGenomes, featureExplorerGenomeKey])
  const featureExplorerActiveGenome = featureExplorerSelectedGenome || refSpecies || featureExplorerAvailableGenomes[0] || null
  const featureExplorerActiveGenomeKey = featureExplorerActiveGenome ? speciesItemKey(featureExplorerActiveGenome) : ''
  const featureExplorerOtherGenomes = useMemo(() => {
    const activeKey = String(featureExplorerActiveGenomeKey || '').trim()
    const demotedKey = String(lastDemotedFeatureExplorerGenomeKey || '').trim()
    const otherGenomes = featureExplorerAvailableGenomes.filter((species) => speciesItemKey(species) !== activeKey)
    const focused = []
    const unfocused = []
    for (const species of otherGenomes) {
      const key = speciesItemKey(species)
      if (focusGeneByGenome?.[key]) focused.push(species)
      else unfocused.push(species)
    }
    const prioritizeDemoted = (items) => {
      if (!demotedKey) return items
      const idx = items.findIndex((species) => speciesItemKey(species) === demotedKey)
      if (idx <= 0) return items
      const next = [...items]
      const [demoted] = next.splice(idx, 1)
      next.unshift(demoted)
      return next
    }
    return [...prioritizeDemoted(focused), ...prioritizeDemoted(unfocused)]
  }, [featureExplorerAvailableGenomes, featureExplorerActiveGenomeKey, focusGeneByGenome, lastDemotedFeatureExplorerGenomeKey])
  const featureExplorerSeedQuery = useMemo(() => {
    const genomeKey = String(featureExplorerActiveGenomeKey || '').trim()
    if (!genomeKey) return ''
    const focusedGene = focusGeneByGenome?.[genomeKey]
    if (focusedGene?.name || focusedGene?.id) return focusedGene.name || focusedGene.id
    return ''
  }, [featureExplorerActiveGenomeKey, focusGeneByGenome])
  const activeAppButtons = useMemo(
    () => normalizeActiveAppButtons(config.active_app_buttons),
    [config.active_app_buttons]
  )
  const topBarButtonRows = useMemo(() => {
    const all = activeAppButtons.filter((buttonId) => Boolean(APP_BUTTON_META[buttonId]))
    const rows = []
    for (let i = 0; i < all.length; i += 9) {
      rows.push(all.slice(i, i + 9))
    }
    return rows
  }, [activeAppButtons])
  const sortedGenomePlaylists = useMemo(() => {
    return [...(Array.isArray(config?.genome_playlists) ? config.genome_playlists : [])]
      .filter((playlist) => (
        playlist?.id &&
        String(playlist?.name || '').trim() &&
        !playlist?.hidden &&
        !isNextPreviousSessionPlaylist(playlist) &&
        (!isPreviousSessionPlaylist(playlist) || (playlist.genomes || []).length > 0)
      ))
      .sort((a, b) => {
        if (a?.id === PREVIOUS_SESSION_PLAYLIST_ID) return -1
        if (b?.id === PREVIOUS_SESSION_PLAYLIST_ID) return 1
        return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
      })
  }, [config?.genome_playlists])
  const selectorPlaylistConfig = useMemo(() => ({
    ...config,
    genome_playlists: (Array.isArray(config?.genome_playlists) ? config.genome_playlists : [])
      .filter((playlist) => !playlist?.hidden && !isNextPreviousSessionPlaylist(playlist) && (!isPreviousSessionPlaylist(playlist) || (playlist.genomes || []).length > 0)),
  }), [config])
  const topListMode = 'all'
  const contextFullyActiveSpecies = useMemo(() => {
    const active = Array.isArray(config?.active_species) ? config.active_species : []
    // The sequence view keeps its own choice of genome rather than following
    // the shared two-genome focus, so it says which one, and only for the
    // strip: nothing here is written back to the configuration.
    const focus = currentView === 'sequence' && sequenceGenomeKey
      ? { primaryKey: sequenceGenomeKey, secondaryKey: '' }
      : dualViewFocus
    return getContextFullyActiveSpecies(active, currentView, focus)
  }, [config?.active_species, currentView, dualViewFocus, sequenceGenomeKey, getContextFullyActiveSpecies])
  const selectedSpeciesKeysForView = useMemo(() => {
    if (currentView === 'structural_variation') {
      if (svFullyActiveSpeciesKeys.length) return new Set(svFullyActiveSpeciesKeys)
      return new Set(svAnchorSpecies ? [speciesItemKey(svAnchorSpecies)] : [])
    }
    return new Set(contextFullyActiveSpecies.map((species) => speciesItemKey(species)))
  }, [contextFullyActiveSpecies, currentView, svAnchorSpecies, svFullyActiveSpeciesKeys])
  const semiSelectedSpeciesKeysForView = useMemo(() => {
    const active = Array.isArray(config?.active_species) ? config.active_species : []
    const selected = selectedSpeciesKeysForView
    const semi = new Set()
    for (const species of active) {
      const key = speciesItemKey(species)
      if (selected.has(key)) continue
      semi.add(key)
    }
    return semi
  }, [config?.active_species, selectedSpeciesKeysForView])
  // The active genomes as an ordered list: the overview colours its pills by
  // position in it, the same way the browser colours its panels.
  const statsActiveGenomeKeys = useMemo(
    () => [...selectedSpeciesKeysForView],
    [selectedSpeciesKeysForView],
  )
  const topBarSpecies = useMemo(() => {
    const active = Array.isArray(config?.active_species) ? config.active_species : []
    const fullyActiveKeys = new Set(contextFullyActiveSpecies.map((species) => speciesItemKey(species)))
    const semiActive = active.filter((species) => !fullyActiveKeys.has(speciesItemKey(species)))
    const orderedActive = [...contextFullyActiveSpecies, ...semiActive]
    const orderedActiveKeys = new Set(orderedActive.map((species) => speciesItemKey(species)))
    const activeKeys = new Set(active.map((species) => speciesItemKey(species)))
    // Inactive selections are component state rather than configuration, so the
    // tutorial override cannot replace them. Never append that user-owned state while
    // the sandbox is up: a tutorial starts with no pills unless it explicitly activates
    // one of its own datasets, and dropping the override reveals the user's list again.
    const extras = tutorialConfig
      ? (tutorialConfig.tutorial_selected_genomes || []).filter((species) => !activeKeys.has(speciesItemKey(species)))
      : inactiveSelectedSpecies.filter((species) => !activeKeys.has(speciesItemKey(species)) && !orderedActiveKeys.has(speciesItemKey(species)))
    if (tutorialConfig?.tutorial_selected_genomes) return tutorialConfig.tutorial_selected_genomes
    return [...orderedActive, ...extras]
  }, [config?.active_species, contextFullyActiveSpecies, inactiveSelectedSpecies, tutorialConfig])
  const handleOpenAlignmentExplorerLoci = async ({ loci = [] } = {}) => {
    const wanted=[]
    for(const locus of loci){
      const assembly=String(locus?.assembly||'').trim().toUpperCase()
      const species=topBarSpecies.find(item=>getAssemblyAccession(item).toUpperCase()===assembly&&item?.files?.gff3)
      if(species&&!wanted.some(item=>speciesItemKey(item)===speciesItemKey(species)))wanted.push(species)
    }
    if(!wanted.length)return
    const wantedKeys=new Set(wanted.map(speciesItemKey))
    const inactive=topBarSpecies.filter(species=>!wantedKeys.has(speciesItemKey(species)))
    const nextFocus=buildFocusFromActive(wanted,{
      primaryKey:speciesItemKey(wanted[0]),
      secondaryKey:wanted[1]?speciesItemKey(wanted[1]):'',
    })
    const currentConfig=tutorialConfig||configRef.current||config
    suppressViewSyncRef.current=true
    try{
      if(!tutorialConfig)setInactiveSelectedSpecies(inactive)
      dualViewFocusRef.current=nextFocus;setDualViewFocus(nextFocus)
      setCurrentView('genome_browser')
      const nextConfig=getAlignedGenomeConfigForView(
        withNextPreviousSessionGenomes({...currentConfig,active_species:wanted},topBarSpecies),
        'genome_browser',nextFocus,
      )
      await handleBrowserConfigChange(nextConfig)
      const positioned=loci.map(locus=>{
        const species=wanted.find(item=>getAssemblyAccession(item).toUpperCase()===String(locus?.assembly||'').trim().toUpperCase())
        return species?{...locus,genomeKey:speciesItemKey(species)}:null
      }).filter(Boolean)
      // These are regions, not synthetic genes. Using the browser's location
      // navigation gives every panel its location focus and frames it without
      // reserving the gene drawer width (which can magnify narrow multi-genome
      // panels by an order of magnitude).
      setBrowserLocationFocusByGenome(Object.fromEntries(positioned.map(locus=>[
        locus.genomeKey,
        {chrom:locus.chrom||locus.region,start:locus.start,end:locus.end,strand:locus.strand},
      ])))
    }finally{suppressViewSyncRef.current=false}
  }
  const selectorSelectedSpecies = useMemo(() => (
    tutorialConfig
      ? dedupeSpeciesList([...(config?.active_species || []), ...inactiveSelectedSpecies])
      : topBarSpecies
  ), [config?.active_species, inactiveSelectedSpecies, topBarSpecies, tutorialConfig])
  // A fixed selector scene used to hide this strip outright, so that ticking a genome
  // could not change the header height and push the rows being selected down the page.
  // That also took away the very thing selecting a genome is supposed to show. Instead
  // the strip keeps its place in the layout from the moment the scene arrives — present
  // but invisible while nothing is selected — so the first tick fills a space that was
  // already there and nothing below it moves.
  //
  // Reserved for any tutorial standing in the Genome Selector, not only one that asked for
  // the fixed list scene. A tutorial that walks the reader through registering a genome and
  // then ticking it has the same two problems — a header that grows under the row being
  // ticked, and a step that points at a strip which does not exist yet — without ever
  // framing the list.
  const reserveTutorialSelectorPills = Boolean(tutorialConfig && currentView === 'genome_selector')
  // With nothing in it the strip used to vanish, which left the emptiest possible app
  // saying nothing about how to fill it, and made the header jump the moment a first
  // genome arrived. Not during a tutorial: its sandbox has its own way in, and telling a
  // reader to go and download something is the opposite of what the tutorial is doing.
  const showNoGenomesMessage = topBarSpecies.length === 0 && !tutorialConfig
  const showsPillsStrip = Boolean(
    !headerCollapsed
    && !shouldShowWindowsBackendSetup
    && (topBarSpecies.length > 0 || reserveTutorialSelectorPills || showNoGenomesMessage)
  )

  useEffect(() => {
    // The top bar intentionally changes when a tutorial takes over. It is a view of the
    // sandbox, not a new "previous session" selection to persist for the user.
    if (!configLoaded || tutorialConfig) return
    persistNextPreviousSessionGenomes(topBarSpecies, configRef.current || config)
  }, [configLoaded, topBarSpecies, persistNextPreviousSessionGenomes, tutorialConfig])

  useEffect(() => {
    const previousView = previousViewRef.current
    if (currentView === 'feature_explorer' && previousView !== 'feature_explorer') {
      setFeatureExplorerGenomeKey(featureExplorerDefaultGenomeKey)
      setLastDemotedFeatureExplorerGenomeKey('')
    }
    previousViewRef.current = currentView
  }, [currentView, featureExplorerDefaultGenomeKey])

  useEffect(() => {
    const validKeys = new Set(featureExplorerAvailableGenomes.map((species) => speciesItemKey(species)))
    const fallbackKey = String(featureExplorerDefaultGenomeKey || '').trim()
    setFeatureExplorerGenomeKey((prev) => {
      const currentKey = String(prev || '').trim()
      if (currentKey && validKeys.has(currentKey)) return prev
      return fallbackKey
    })
    setLastDemotedFeatureExplorerGenomeKey((prev) => {
      const currentKey = String(prev || '').trim()
      return currentKey && validKeys.has(currentKey) ? prev : ''
    })
  }, [featureExplorerAvailableGenomes, featureExplorerDefaultGenomeKey])

  const handleFeatureExplorerGenomeSelect = useCallback((species) => {
    const nextKey = speciesItemKey(species)
    if (!nextKey || nextKey === featureExplorerActiveGenomeKey) return
    setLastDemotedFeatureExplorerGenomeKey(featureExplorerActiveGenomeKey)
    setFeatureExplorerGenomeKey(nextKey)
  }, [featureExplorerActiveGenomeKey])

  const alignmentInputByGenomeKey = useMemo(() => {
    const next = new Map()
    for (const row of alignmentInputs || []) {
      const key = String(row?.genome_key || '').trim()
      if (!key) continue
      next.set(key, row)
    }
    return next
  }, [alignmentInputs])

  const alignmentDisplayRows = useMemo(() => {
    try {
      const loadedRows = Array.isArray(multiAlignmentResult?.rows) ? multiAlignmentResult.rows : []
      return loadedRows.map((rawRow) => {
        const genomeKey = String(rawRow?.genome_key || rawRow?.genome || '').trim()
        const inputRow = alignmentInputByGenomeKey.get(genomeKey) || null
        const baseline = loadedAlignmentBaselineByGenome?.[genomeKey] || null
        const resolved = inputRow?.status === 'resolved' ? inputRow.resolved : null
        const resolvedTranscripts = Array.isArray(resolved?.transcripts) ? resolved.transcripts : []
        const selectedTranscriptId = String(
          inputRow?.settings?.selectedTranscriptId
          || resolved?.selectedTranscriptId
          || baseline?.selectedTranscriptId
          || rawRow?.transcript_id
          || ''
        ).trim()
        const selectedTranscript = resolvedTranscripts.find((tx) => String(tx?.id || '').trim() === selectedTranscriptId) || null
        const selectedTranscriptCoordLabel = selectedTranscript
          ? `${String(selectedTranscript.chrom || rawRow?.chrom || '').trim()}:${Math.min(Number(selectedTranscript.start), Number(selectedTranscript.end))}-${Math.max(Number(selectedTranscript.start), Number(selectedTranscript.end))} (${String(selectedTranscript.strand || rawRow?.strand || '+')})`
          : ''
        const geneLabel = String(
          resolved?.gene?.name
          || resolved?.gene?.id
          || baseline?.geneName
          || baseline?.geneId
          || rawRow?.query
          || rawRow?.transcript_id
          || genomeKey
        ).trim()

        const baseRow = {
          ...rawRow,
          transcript_id: selectedTranscriptId || String(rawRow?.transcript_id || '').trim(),
          gene_label: geneLabel,
          loaded_gene_id: String(baseline?.geneId || '').trim(),
          selected_transcript_coord_label: selectedTranscriptCoordLabel,
          boundary_status: 'unknown',
          boundary_message: '',
          coverage_status: 'full',
          not_aligned_bp_left: 0,
          not_aligned_bp_right: 0,
          covered_column_start: null,
          covered_column_end: null,
          no_coverage: false,
          display_features: Array.isArray(rawRow?.features) ? rawRow.features : [],
        }

        try {
          if (!resolved || !selectedTranscript) {
            return baseRow
          }

          const baselineTranscriptId = String(
            baseline?.selectedTranscriptId
            || rawRow?.transcript_id
            || ''
          ).trim()
          const isSwitchedTranscript = Boolean(
            baseline
            && selectedTranscriptId
            && baselineTranscriptId
            && selectedTranscriptId !== baselineTranscriptId
          )
          const transcriptSpan = getTranscriptSpan(selectedTranscript)
          const coveredStart = Math.min(Number(rawRow?.genomic_start), Number(rawRow?.genomic_end))
          const coveredEnd = Math.max(Number(rawRow?.genomic_start), Number(rawRow?.genomic_end))
          let coverageStatus = 'full'
          let boundaryStatus = 'unknown'
          let boundaryMessage = ''
          let notAlignedBpLeft = 0
          let notAlignedBpRight = 0
          let coveredColumnStart = null
          let coveredColumnEnd = null
          let noCoverage = false
          let displayFeatures = Array.isArray(rawRow?.features) ? rawRow.features : []

          if (baseline && transcriptSpan && Number.isFinite(coveredStart) && Number.isFinite(coveredEnd)) {
            const overlapWindow = {
              start: Math.max(transcriptSpan.start, coveredStart),
              end: Math.min(transcriptSpan.end, coveredEnd),
            }
            boundaryStatus = getTranscriptBoundaryStatus(transcriptSpan, coveredStart, coveredEnd)
            if (isSwitchedTranscript) {
              if (boundaryStatus === 'within') boundaryMessage = 'Transcript matches on or within boundaries'
              else if (boundaryStatus === 'partial') boundaryMessage = 'Transcript partially overlaps boundaries'
              else if (boundaryStatus === 'outside') boundaryMessage = 'Transcript outside boundaries'
            }
            if (String(transcriptSpan.strand || rawRow?.strand || '+') === '-') {
              notAlignedBpLeft = Math.max(0, Math.round(transcriptSpan.end - coveredEnd))
              notAlignedBpRight = Math.max(0, Math.round(coveredStart - transcriptSpan.start))
            } else {
              notAlignedBpLeft = Math.max(0, Math.round(coveredStart - transcriptSpan.start))
              notAlignedBpRight = Math.max(0, Math.round(transcriptSpan.end - coveredEnd))
            }
            if (notAlignedBpLeft > 0 && notAlignedBpRight > 0) coverageStatus = 'truncated_both'
            else if (notAlignedBpLeft > 0) coverageStatus = 'truncated_left'
            else if (notAlignedBpRight > 0) coverageStatus = 'truncated_right'
            if (boundaryStatus === 'within') {
              coverageStatus = 'full'
              notAlignedBpLeft = 0
              notAlignedBpRight = 0
            } else if (boundaryStatus === 'outside') {
              coverageStatus = 'outside'
              noCoverage = true
            }
            if (isSwitchedTranscript) {
              const genomicToAlign = buildAlignmentGenomicToColumnMap(
                rawRow?.aligned_sequence,
                rawRow?.genomic_start,
                rawRow?.genomic_end,
                rawRow?.strand
              )
              const projectedFeatures = buildProjectedTranscriptFeatures(selectedTranscript, genomicToAlign)
              if (projectedFeatures.length > 0) {
                displayFeatures = projectedFeatures
              }
              if (boundaryStatus === 'partial') {
                const coveredRange = overlapWindow.start <= overlapWindow.end
                  ? getCoveredAlignmentColumnRange(genomicToAlign, overlapWindow)
                  : null
                if (coveredRange) {
                  coveredColumnStart = coveredRange.start
                  coveredColumnEnd = coveredRange.end
                }
              }
            }
          }

          return {
            ...baseRow,
            boundary_status: boundaryStatus,
            boundary_message: boundaryMessage,
            coverage_status: coverageStatus,
            not_aligned_bp_left: notAlignedBpLeft,
            not_aligned_bp_right: notAlignedBpRight,
            covered_column_start: coveredColumnStart,
            covered_column_end: coveredColumnEnd,
            no_coverage: noCoverage,
            display_features: displayFeatures,
          }
        } catch (error) {
          console.error('Failed to derive alignment display row:', genomeKey, error)
          return {
            ...baseRow,
            boundary_status: 'unknown',
            boundary_message: '',
            no_coverage: false,
          }
        }
      })
    } catch (error) {
      console.error('Failed to derive alignment display rows:', error)
      return (Array.isArray(multiAlignmentResult?.rows) ? multiAlignmentResult.rows : []).map((rawRow) => ({
        ...rawRow,
        gene_label: String(rawRow?.query || rawRow?.transcript_id || rawRow?.genome_key || rawRow?.genome || '').trim(),
        loaded_gene_id: '',
        coverage_status: 'full',
        not_aligned_bp_left: 0,
        not_aligned_bp_right: 0,
        covered_column_start: null,
        covered_column_end: null,
        no_coverage: false,
        display_features: Array.isArray(rawRow?.features) ? rawRow.features : [],
      }))
    }
  }, [multiAlignmentResult?.rows, alignmentInputByGenomeKey, loadedAlignmentBaselineByGenome, alignmentGlobalFlanks])

  const alignmentDisplayMetaByGenomeKey = useMemo(() => {
    const next = {}
    try {
      for (const row of alignmentDisplayRows) {
        const key = String(row?.genome_key || row?.genome || '').trim()
        if (!key) continue
        next[key] = {
          geneLabel: String(row?.gene_label || '').trim(),
          selectedTranscriptId: String(row?.transcript_id || '').trim(),
          coverageStatus: String(row?.coverage_status || 'full').trim(),
          notAlignedBpLeft: Math.max(0, Number(row?.not_aligned_bp_left) || 0),
          notAlignedBpRight: Math.max(0, Number(row?.not_aligned_bp_right) || 0),
        }
      }
    } catch (error) {
      console.error('Failed to derive alignment display metadata:', error)
    }
    return next
  }, [alignmentDisplayRows])

  const alignmentViewerDisplayKey = useMemo(() => {
    return alignmentDisplayRows.map((row) => {
      const genomeKey = String(row?.genome_key || row?.genome || '').trim()
      const transcriptId = String(row?.transcript_id || '').trim()
      const coverageStatus = String(row?.coverage_status || 'full').trim()
      const coveredStart = Number.isFinite(Number(row?.covered_column_start)) ? Number(row.covered_column_start) : ''
      const coveredEnd = Number.isFinite(Number(row?.covered_column_end)) ? Number(row.covered_column_end) : ''
      const noCoverage = row?.no_coverage ? '1' : '0'
      return [genomeKey, transcriptId, coverageStatus, coveredStart, coveredEnd, noCoverage].join(':')
    }).join('|')
  }, [alignmentDisplayRows])

  const alignmentIncludedResolvedCount = useMemo(
    () => (alignmentInputs || []).filter((row) => row.status === 'resolved').length,
    [alignmentInputs]
  )
  const alignmentNeedsRerun = useMemo(() => {
    try {
      if (!multiAlignmentResult) return false
      const loadedGenomeKeys = new Set(
        alignmentDisplayRows.map((row) => String(row?.genome_key || row?.genome || '').trim()).filter(Boolean)
      )
      const hasCoverageIssue = alignmentDisplayRows.some((row) => {
        const status = String(row?.coverage_status || 'full')
        return status === 'outside' || status.startsWith('truncated') || status === 'partial'
      })
      const hasResolvedGenomeOutsideLoadedAlignment = (alignmentInputs || []).some((row) => {
        const genomeKey = String(row?.genome_key || '').trim()
        const selectedTranscriptId = String(row?.settings?.selectedTranscriptId || row?.resolved?.selectedTranscriptId || '').trim()
        if (!genomeKey || row?.status !== 'resolved' || !selectedTranscriptId) return false
        return !loadedGenomeKeys.has(genomeKey)
      })
      return hasCoverageIssue || hasResolvedGenomeOutsideLoadedAlignment
    } catch (error) {
      console.error('Failed to derive alignment rerun state:', error)
      return false
    }
  }, [multiAlignmentResult, alignmentDisplayRows, alignmentInputs])
  const alignedGenomeCount = useMemo(
    () => (Array.isArray(multiAlignmentResult?.rows) ? multiAlignmentResult.rows.length : 0),
    [multiAlignmentResult]
  )
  const unalignedGenomeCount = Math.max(0, (alignmentInputs || []).length - alignedGenomeCount)
  const alignmentPreparedCount = useMemo(
    () => (alignmentInputs || []).filter((row) => {
      const transcriptId = row.settings?.selectedTranscriptId || row.resolved?.selectedTranscriptId || ''
      return Boolean(String(transcriptId).trim())
    }).length,
    [alignmentInputs]
  )
  const alignmentRunDisabled = alignmentIncludedResolvedCount < 2 || alignmentViewLoading

  useEffect(() => {
    const active = Array.isArray(config?.active_species) ? config.active_species : []
    const activeKeys = new Set(active.map((species) => speciesItemKey(species)))
    setInactiveSelectedSpecies((prev) => {
      const next = prev.filter((species) => !activeKeys.has(speciesItemKey(species)))
      return speciesListsEqualByKey(prev, next) ? prev : next
    })
  }, [config?.active_species])

  useEffect(() => {
    const currentViewIsAvailable = activeAppButtons.some((buttonId) => APP_BUTTON_META[buttonId]?.viewId === currentView)
    if (currentViewIsAvailable) return
    const fallbackView = activeAppButtons
      .map((buttonId) => APP_BUTTON_META[buttonId])
      .find((meta) => meta?.kind === 'data_view')?.viewId || 'configuration'
    if (fallbackView !== currentView) {
      setCurrentView(fallbackView)
    }
  }, [activeAppButtons, currentView])

  useEffect(() => {
    if (!screenshotSupported || !screenshotAvailable) {
      setScreenshotMode(false)
    }
  }, [screenshotAvailable, screenshotSupported])

  useEffect(() => {
    if (!fallbackScreenshotAvailable) {
      setSelectedFallbackScreenshotTarget(null)
    }
  }, [fallbackScreenshotAvailable])

  useEffect(() => {
    setSelectedFallbackScreenshotTarget(null)
  }, [currentView])

  useEffect(() => {
    if (!usingFallbackScreenshot) return undefined
    const previousBodyCursor = document.body.style.cursor
    const previousRootCursor = document.documentElement.style.cursor
    document.body.style.cursor = 'crosshair'
    document.documentElement.style.cursor = 'crosshair'
    return () => {
      document.body.style.cursor = previousBodyCursor
      document.documentElement.style.cursor = previousRootCursor
    }
  }, [usingFallbackScreenshot])

  /** Open or close the top-bar playlist popover because a tutorial step says so.
   *
   * The same reconciliation the Genome Selector does for its playlist dialog, for the one
   * piece of this flow that lives in the app shell. A step that names any other dialog is
   * saying this one is closed — the field holds which one is open, not a set. */
  useEffect(() => {
    const dialog = tutorialRuntime.dialogRequest?.dialog
    if (!dialog) return
    setGenomePlaylistPopoverOpen(dialog === 'playlistPopover')
  }, [tutorialRuntime.dialogRequest])

  useEffect(() => {
    if (!genomePlaylistPopoverOpen) return undefined
    const handlePointerDown = (event) => {
      const button = genomePlaylistActionButtonRef.current
      const popover = genomePlaylistPopoverRef.current
      if (button && button.contains(event.target)) return
      if (popover && popover.contains(event.target)) return
      setGenomePlaylistPopoverOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setGenomePlaylistPopoverOpen(false)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [genomePlaylistPopoverOpen])

  useEffect(() => {
    if (draggedTopButtonId && !activeAppButtons.includes(draggedTopButtonId)) {
      setDraggedTopButtonId('')
      setDragOverTopButtonId('')
      setDragTopInsertPosition('before')
      topBarDragMovedRef.current = false
    }
  }, [activeAppButtons, draggedTopButtonId])

  const reorderTopBarButtons = useCallback((sourceButtonId, targetButtonId, insertPosition = 'before') => {
    if (!sourceButtonId || !targetButtonId || sourceButtonId === targetButtonId) return
    setConfig((prev) => {
      const base = prev || configRef.current || config
      const ordered = normalizeActiveAppButtons(base.active_app_buttons)
      const nextOrder = reorderWithInsertPosition(ordered, sourceButtonId, targetButtonId, insertPosition)
      if (nextOrder === ordered) return base
      return { ...base, active_app_buttons: nextOrder }
    })
  }, [config])

  const handleTopBarButtonClick = async (buttonId) => {
    const buttonMeta = APP_BUTTON_META[buttonId]
    if (!buttonMeta) return

    if (buttonMeta.kind === 'action') {
      if (buttonId === 'genome_playlist') {
        setGenomePlaylistPopoverOpen((prev) => !prev)
      } else if (buttonId === 'theme_toggle') {
        setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
      } else if (buttonId === 'screenshot_toggle') {
        if (!(screenshotSupported && screenshotAvailable)) return
        setScreenshotMode((prev) => !prev)
      }
      return
    }

    const nextView = buttonMeta.viewId
    if (!nextView || nextView === currentView) return

    if (currentView === 'configuration' && nextView !== 'configuration') {
      await handleConfigSave()
    }

    if (screenshotMode) {
      setScreenshotMode(false)
    }
    setCurrentView(nextView)
  }

  const handleSpeciesToggleFromSelector = useCallback((species, source = 'selector', options = {}) => {
    return handleSpeciesPillToggle(species, source, options)
  }, [handleSpeciesPillToggle])

  const handleSelectorConfigChange = useCallback(async (configUpdate) => {
    const currentConfig = configRef.current || config
    const rawConfigWithSystemPlaylists = typeof configUpdate === 'function'
      ? configUpdate(currentConfig)
      : configUpdate
    if (!rawConfigWithSystemPlaylists) return
    const manualBatchAddedKeys = new Set(
      Array.isArray(rawConfigWithSystemPlaylists.__manual_batch_added_keys)
        ? rawConfigWithSystemPlaylists.__manual_batch_added_keys
        : []
    )
    const removedGenomeKeys = Array.isArray(rawConfigWithSystemPlaylists.__removed_genome_keys)
      ? rawConfigWithSystemPlaylists.__removed_genome_keys
      : []
    const {
      __manual_batch_added_keys: _manualBatchAddedKeys,
      __removed_genome_keys: _removedGenomeKeys,
      ...rawNextConfig
    } = rawConfigWithSystemPlaylists

    const previousActive = dedupeSpeciesList(currentConfig?.active_species)
    const previousKeys = new Set(previousActive.map((species) => speciesItemKey(species)))
    let nextActive = dedupeSpeciesList(rawNextConfig?.active_species)
    let nextInactive = dedupeSpeciesList(inactiveSelectedSpeciesRef.current)

    // A removed genome has to leave the selected-but-inactive list before the
    // session snapshot below is rebuilt from it, or it is written straight back
    // and returns on the next launch.
    if (removedGenomeKeys.length > 0) {
      const survivors = nextInactive.filter(
        (species) => !removedGenomeKeys.some((key) => genomeKeysMatch(species, key))
      )
      if (survivors.length !== nextInactive.length) {
        nextInactive = survivors
        setInactiveSelectedSpecies(survivors)
      }
    }

    suppressViewSyncRef.current = true
    try {
      const newlyAdded = nextActive.filter((species) => !previousKeys.has(speciesItemKey(species)))
      if (newlyAdded.length > 0 && (previousActive.length > 0 || manualBatchAddedKeys.size > 0)) {
        // Preserve the current view. A manual batch with no previous selection
        // activates its first genome and appends the rest as selected/inactive.
        const additionsToKeepActive = previousActive.length === 0
          ? newlyAdded.filter((species) => manualBatchAddedKeys.has(speciesItemKey(species))).slice(0, 1)
          : []
        const additionsToKeepActiveKeys = new Set(additionsToKeepActive.map((species) => speciesItemKey(species)))
        const additionsToMakeInactive = newlyAdded.filter(
          (species) => !additionsToKeepActiveKeys.has(speciesItemKey(species))
        )
        const inactiveAdditionKeys = new Set(additionsToMakeInactive.map((species) => speciesItemKey(species)))
        nextActive = nextActive.filter((species) => !inactiveAdditionKeys.has(speciesItemKey(species)))
        for (const species of additionsToMakeInactive) {
          nextInactive = appendUniqueSpecies(nextInactive, species)
        }
        if (additionsToMakeInactive.length > 0) setInactiveSelectedSpecies(nextInactive)
      }

      const nextFocus = buildFocusFromActive(nextActive, dualViewFocusRef.current)
      if (
        nextFocus.primaryKey !== dualViewFocusRef.current.primaryKey ||
        nextFocus.secondaryKey !== dualViewFocusRef.current.secondaryKey
      ) {
        dualViewFocusRef.current = nextFocus
        setDualViewFocus(nextFocus)
      }

      const alignedConfig = getAlignedGenomeConfigForView(
        withNextPreviousSessionGenomes(
          { ...rawNextConfig, active_species: nextActive },
          [...nextActive, ...nextInactive]
        ),
        currentView,
        nextFocus
      )
      await handleBrowserConfigChange(alignedConfig)
    } finally {
      suppressViewSyncRef.current = false
    }
  }, [buildFocusFromActive, config, currentView, getAlignedGenomeConfigForView])

  return (
    <div className={`h-screen flex flex-col ${themeStyles.bg} ${themeStyles.text}`}>
      {config.show_fps_counter && <FpsCounter />}
      {/* Header */}
      <header
        /* The pills strip ends in the assembly badges, which already sit at the foot of
           the pills; a full `pb-4` under that read as a gap rather than as breathing
           room. With no strip below them the button rows still want the full padding. */
        className={`${themeStyles.header} border-b px-6 ${headerCollapsed ? 'py-3 cursor-pointer' : `pt-4 ${showsPillsStrip ? 'pb-2' : 'pb-4'}`} flex-none rounded-xl relative`}
        onClick={headerCollapsed ? () => setHeaderCollapsed(false) : undefined}
      >
        <div className={`flex flex-col ${headerCollapsed ? 'gap-0' : 'gap-3'} w-full h-full`}>
          <div className={`flex items-start justify-between gap-4 w-full ${headerCollapsed ? '' : 'h-full'}`}>
            <div className="min-w-0 flex-1 pr-2">
              <div className={`min-w-0 overflow-hidden ${themeStyles.text} flex ${headerCollapsed ? 'items-end' : 'items-center'} gap-1`}>
                <span className="flex shrink-0 items-center gap-1.5">
                  <img src="ensembl-logotype-blue.svg" alt="Ensembl" className="h-6" />
                  <span className={`leading-none font-normal ${isLight ? 'text-gray-900' : 'text-white'}`} style={{fontSize: '30px'}}>Go</span>
                </span>
                {headerCollapsed && (
                  <h1
                    className={`ml-2 min-w-0 truncate font-normal leading-none ${isLight ? 'text-gray-900' : 'text-white'}`}
                    style={{ fontSize: '24px' }}
                    title={currentViewTitle}
                  >
                    {currentViewTitle}
                  </h1>
                )}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setHeaderCollapsed((prev) => !prev)
                  }}
                  className="w-8 h-8 shrink-0 rounded-md border-0 bg-transparent text-[#0099ff] flex items-center justify-center transition-colors hover:bg-[#0099ff]/10"
                  title={headerCollapsed ? 'Expand top bar' : 'Collapse top bar'}
                  aria-label={headerCollapsed ? 'Expand top bar' : 'Collapse top bar'}
                >
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                    {headerCollapsed ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
                  </svg>
                </button>
              </div>
              {!headerCollapsed && (
                <div className="mt-2 min-w-0 flex items-start gap-3">
                  {currentViewButtonId && (
                    <span
                      aria-hidden="true"
                      className="w-11 h-11 shrink-0 rounded-lg bg-[#0099ff] text-white flex items-center justify-center overflow-hidden"
                    >
                      <AppButtonIcon buttonId={currentViewButtonId} isLight={isLight} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <h1
                      className={`min-w-0 truncate font-normal leading-none ${isLight ? 'text-gray-900' : 'text-white'}`}
                      style={{ fontSize: '24px' }}
                      title={currentViewTitle}
                    >
                      {currentViewTitle}
                    </h1>
                    <p className={`text-sm ${themeStyles.subtext} mt-1 text-left leading-snug whitespace-normal break-words`}>
                      {currentViewDescription}
                    </p>
                  </div>
                </div>
              )}
            </div>
            {!headerCollapsed && !shouldShowWindowsBackendSetup && (
              <div className="shrink-0 flex items-start gap-3">
                <div className="flex flex-col items-start gap-2">
                  {topBarButtonRows.map((row, rowIndex) => (
                    <div key={`topbar-row-${rowIndex}`} className="grid grid-cols-9 gap-2 justify-items-start">
                      {row.map((buttonId) => {
                        const buttonMeta = APP_BUTTON_META[buttonId]
                        if (!buttonMeta) return null
                        const isActionButton = buttonMeta.kind === 'action'
                        const isSelectedView = buttonMeta.kind === 'data_view' && buttonMeta.viewId === currentView
                        const isActionActive = isActionButton && (
                          (buttonId === 'screenshot_toggle' && screenshotMode) ||
                          (buttonId === 'genome_playlist' && genomePlaylistPopoverOpen)
                        )
                        const isTopButtonActive = isSelectedView || isActionActive
                        const isActionDisabled = isActionButton && buttonId === 'screenshot_toggle' && !screenshotAvailable
                        const isDragging = draggedTopButtonId === buttonId
                        const isDropTarget = Boolean(
                          dragOverTopButtonId &&
                          draggedTopButtonId &&
                          dragOverTopButtonId === buttonId &&
                          draggedTopButtonId !== buttonId
                        )
                        const insertLineColor = isLight ? 'rgba(0, 153, 255, 0.92)' : 'rgba(125, 211, 252, 0.92)'
                        const buttonNode = (
                          <button
                            key={buttonId}
                            data-tour-id={`app-button-${buttonId}`}
                            ref={buttonId === 'screenshot_toggle'
                              ? screenshotActionButtonRef
                              : (buttonId === 'genome_playlist' ? genomePlaylistActionButtonRef : null)}
                            onClick={() => {
                              if (topBarDragMovedRef.current) {
                                topBarDragMovedRef.current = false
                                return
                              }
                              if (isActionDisabled) return
                              handleTopBarButtonClick(buttonId)
                            }}
                            draggable
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', buttonId)
                              setDraggedTopButtonId(buttonId)
                              setDragOverTopButtonId(buttonId)
                              setDragTopInsertPosition('before')
                              topBarDragMovedRef.current = false
                            }}
                            onDragOver={(event) => {
                              if (!draggedTopButtonId || draggedTopButtonId === buttonId) return
                              event.preventDefault()
                              event.dataTransfer.dropEffect = 'move'
                              const rect = event.currentTarget.getBoundingClientRect()
                              const nextInsertPosition = event.clientX < (rect.left + rect.width / 2) ? 'before' : 'after'
                              setDragOverTopButtonId(buttonId)
                              setDragTopInsertPosition(nextInsertPosition)
                              topBarDragMovedRef.current = true
                            }}
                            onDrop={(event) => {
                              event.preventDefault()
                              const source = draggedTopButtonId || event.dataTransfer.getData('text/plain')
                              reorderTopBarButtons(source, buttonId, dragTopInsertPosition)
                              setDraggedTopButtonId('')
                              setDragOverTopButtonId('')
                              setDragTopInsertPosition('before')
                              topBarDragMovedRef.current = false
                            }}
                            onDragEnd={() => {
                              setDraggedTopButtonId('')
                              setDragOverTopButtonId('')
                              setDragTopInsertPosition('before')
                              setTimeout(() => { topBarDragMovedRef.current = false }, 0)
                            }}
                            className={`w-11 h-11 rounded-lg flex items-center justify-center transition-all duration-200 relative ${(isTopButtonActive && !isActionDisabled)
                              ? (isActionButton
                                ? 'bg-[#bfe6ff] text-[#006fbf] shadow-md shadow-[#0099ff]/25 border-2 border-[#0099ff]'
                                : 'bg-[#0077cc] text-white shadow-md shadow-[#0077cc]/40 border-2 border-white/40')
                              : (isActionDisabled
                                ? 'bg-[#6b7280] text-white/60 border-2 border-transparent cursor-not-allowed'
                                : (isActionButton
                                  ? 'bg-[#e1f4ff] text-[#0077cc] hover:text-[#005f9f] hover:bg-[#cbeeff] border-2 border-[#0099ff]'
                                  : 'bg-[#0099ff] text-white/80 hover:text-white hover:bg-[#0088ee] border-2 border-transparent'))
                              }`}
                            style={{
                              opacity: isDragging ? 0.62 : 1,
                              boxShadow: isDropTarget
                                ? (dragTopInsertPosition === 'before'
                                  ? `inset 3px 0 0 ${insertLineColor}`
                                  : `inset -3px 0 0 ${insertLineColor}`)
                                : undefined,
                              cursor: isActionDisabled ? 'not-allowed' : 'pointer',
                            }}
                            title={buttonId === 'theme_toggle'
                              ? (isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode')
                              : buttonId === 'genome_playlist'
                                ? 'Choose a genome playlist'
                              : buttonId === 'screenshot_toggle'
                                ? (screenshotAvailable
                                  ? (screenshotMode ? 'Cancel screenshot capture' : 'Capture a screenshot from this view')
                                  : 'No exportable screenshot panels are available in this view')
                              : buttonMeta.label}
                          >
                            {buttonId === 'track_manager' ? (
                              <span style={{ display: 'inline-flex', transform: 'scale(0.76)' }}>
                                <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                              </span>
                            ) : (
                              <AppButtonIcon buttonId={buttonId} isLight={isLight} />
                            )}
                            {isTopButtonActive && !isActionDisabled && (
                              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-6 h-[3px] rounded-full bg-white shadow-sm"></span>
                            )}
                          </button>
                        )
                        if (buttonId !== 'genome_playlist') return buttonNode
                        return (
                          <div key={buttonId} className="relative">
                            {buttonNode}
                            <div
                              ref={genomePlaylistPopoverRef}
                              data-tour-id={genomePlaylistPopoverOpen ? 'app-playlist-popover' : undefined}
                              className={`absolute right-0 top-full mt-2 w-72 origin-top-right rounded-xl border shadow-2xl z-50 overflow-hidden transition-all duration-200 ${genomePlaylistPopoverOpen
                                ? 'opacity-100 translate-y-0 pointer-events-auto'
                                : 'opacity-0 -translate-y-2 pointer-events-none'
                              } ${isLight ? 'bg-white border-gray-200 text-gray-900' : 'bg-gray-900 border-gray-700 text-gray-100'}`}
                            >
                              <div className={`px-4 py-3 border-b ${isLight ? 'border-gray-100 bg-gray-50' : 'border-gray-700 bg-gray-800'}`}>
                                <div className="text-sm font-bold">Genome Playlists</div>
                              </div>
                              <div className="max-h-80 overflow-y-auto themed-scrollbar">
                                {sortedGenomePlaylists.length === 0 ? (
                                  <div className={`px-4 py-4 text-sm ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    No playlists yet.
                                  </div>
                                ) : sortedGenomePlaylists.map((playlist) => {
                                  const isSelectedPlaylist = String(config?.selected_genome_playlist_id || '') === playlist.id
                                  const isApplying = applyingGenomePlaylistId === playlist.id
                                  return (
                                    <button
                                      key={playlist.id}
                                      data-tour-id={`app-playlist-option-${playlistTourSlug(playlist.name)}`}
                                      type="button"
                                      disabled={Boolean(applyingGenomePlaylistId)}
                                      onClick={() => handleTopBarPlaylistSelect(playlist)}
                                      className={`w-full px-4 py-3 text-left transition-colors border-b last:border-b-0 ${isLight
                                        ? 'border-gray-100 hover:bg-blue-50 disabled:hover:bg-white'
                                        : 'border-gray-800 hover:bg-blue-900/20 disabled:hover:bg-gray-900'
                                      } ${isSelectedPlaylist ? (isLight ? 'bg-blue-50' : 'bg-blue-900/20') : ''}`}
                                    >
                                      <div className="flex items-center gap-2">
                                        <div className="min-w-0 flex-1">
                                          <div className={`text-sm font-semibold truncate ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{playlist.name}</div>
                                          <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                            {(playlist.genomes || []).length} genome{(playlist.genomes || []).length === 1 ? '' : 's'}
                                          </div>
                                        </div>
                                        {isApplying ? (
                                          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                        ) : isSelectedPlaylist ? (
                                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={isLight ? 'text-blue-600' : 'text-blue-300'}>
                                            <path d="M20 6 9 17l-5-5" />
                                          </svg>
                                        ) : null}
                                      </div>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
                {/* Ensembl logo */}
                <img
                  src="ensembl-e-blue.svg"
                  alt="Ensembl"
                  className="h-14 ml-6"
                />
              </div>
            )}
          </div>

          {showsPillsStrip && (
            <div
              data-tour-id="app-genome-pills"
              className={`border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
              style={{
                // A tutorial reserves this strip's place without showing anything in it,
                // so that ticking the first genome does not change the header height
                // under the rows being selected. That reservation stays blank; only the
                // ordinary empty app gets the message.
                visibility: (topBarSpecies.length === 0 && !showNoGenomesMessage) ? 'hidden' : undefined,
                backgroundColor: isLight ? '#f1f3f5' : '#1E2938',
                borderRadius: '0.5rem',
                paddingLeft: '0.5rem',
                paddingRight: '0.5rem',
                paddingTop: '0.5rem',
                paddingBottom: '0.125rem',
              }}
            >
              <SelectedSpeciesPillsBar
                theme={theme}
                config={config}
                onToggleSpecies={currentView === 'structural_variation' ? handleStructuralVariationPillToggle : handleSpeciesPillToggle}
                onRemoveSpecies={handleRemoveSpeciesFromList}
                onReorderSpecies={handleSpeciesPillReorder}
                mode={topListMode}
                selectedSpeciesKeys={selectedSpeciesKeysForView}
                semiSelectedSpeciesKeys={semiSelectedSpeciesKeysForView}
                speciesList={topBarSpecies}
                primarySpeciesKey={speciesItemKey(refSpecies)}
                reserveRowHeight={reserveTutorialSelectorPills}
                emptyState={showNoGenomesMessage ? (
                  <NoGenomesPillsMessage isLight={isLight} onOpenView={handleTopBarButtonClick} />
                ) : null}
              />
            </div>
          )}

        </div>
      </header>

      {/* Main content container with flex-grow to fill remaining height */}
      <div
        ref={setMainContentNode}
        data-tutorial-page-scroll={['genome_selector', 'genome_browser'].includes(currentView) ? 'true' : undefined}
        className={`relative min-h-0 flex-grow w-full ${currentView === 'notes' ? 'py-6 pl-6 pr-0' : 'p-6'} ${(currentView === 'genome_browser' || currentView === 'alignment' || currentView === 'structural_variation' || currentView === 'genome_selector') ? `overflow-y-auto overflow-x-hidden themed-scrollbar ${isLight ? 'themed-scrollbar-light' : 'themed-scrollbar-dark'}` : 'overflow-hidden'}`}
      >
        {shouldRenderFallbackContentWrapper ? (
          <div ref={setActiveViewContentNode} className="h-full">
            {shouldShowWindowsBackendSetup ? (
            <WindowsBackendSetupView
              backendRuntime={backendRuntime}
              onRetryCheck={handleRetryBackendCheck}
              onRetryLaunch={handleRetryBackendLaunch}
            />
          ) : currentView === 'home' ? (
            /* ========== HOME VIEW ========== */
            <div className="h-full">
              <HomeView
                theme={theme}
                onNavigate={(viewId) => setCurrentView(viewId)}
              />
            </div>
          ) : currentView === 'alignment' ? (
            /* ========== ALIGNMENT VIEW ========== */
            <ErrorBoundary>
              <div data-screenshot-capture="view" className="min-h-full flex items-start gap-4">
              {/* Left sidebar */}
              <div
                className="flex-shrink-0 self-start transition-[width] duration-300 ease-out"
                style={{ width: alignmentSidebarCollapsed ? '42px' : '360px' }}
              >
                <MultiAlignmentSidebar
                  theme={theme}
                  rows={alignmentInputs}
                  rowDisplayMetaByGenomeKey={alignmentDisplayMetaByGenomeKey}
                  globalFlanks={alignmentGlobalFlanks}
                  globalFlanksLocked={alignmentGlobalFlanksLocked}
                  globalFlankMax={alignmentGlobalFlankMax}
                  collapseIntrons={collapseIntrons}
                  collapseSourceGenomeKey={collapseSource}
                  collapseSourceOptions={collapseSourceOptions}
                  collapsed={alignmentSidebarCollapsed}
                  runSettings={alignmentRunSettings}
                  loading={alignmentViewLoading}
                  runDisabled={alignmentRunDisabled}
                  alignedGenomeCount={alignedGenomeCount}
                  unalignedGenomeCount={unalignedGenomeCount}
                  showUpdateNotice={alignmentNeedsRerun}
                  warnings={alignmentNeedsRerun ? [] : (multiAlignmentResult?.warnings || [])}
                  onRowQueryChange={handleAlignmentRowQueryChange}
                  onResolveRow={handleAlignmentResolveRow}
                  onRowSettingChange={handleAlignmentRowSettingChange}
                  onGlobalFlanksChange={handleAlignmentGlobalFlanksChange}
                  onGlobalFlanksLockToggle={handleAlignmentGlobalFlanksLockToggle}
                  onGlobalFlankMaxChange={handleAlignmentGlobalFlankMaxChange}
                  onCollapseIntronsChange={setCollapseIntrons}
                  onCollapseSourceChange={setCollapseSource}
                  onRunSettingsChange={handleAlignmentRunSettingsChange}
                  onRunAlignment={runMultiAlignment}
                  onSaveAlignment={handleSaveAlignment}
                  onLoadAlignment={() => setLoadAlignmentModalOpen(true)}
                  hasResult={Boolean(multiAlignmentResult)}
                  onToggleCollapsed={() => setAlignmentSidebarCollapsed((prev) => !prev)}
                />
              </div>

              {/* Main content - Alignment area */}
              <div className="flex-1 min-w-0 flex flex-col">
                {alignmentViewError && (
                  <div className="bg-red-900/50 border border-red-700 rounded-lg p-4 mb-4 flex-none">
                    <p className="text-red-300">{alignmentViewError}</p>
                  </div>
                )}

                {alignmentViewLoading && (
                  <div className={`${themeStyles.panel} rounded-lg p-12 text-center flex-grow flex flex-col items-center justify-center`}>
                    <div className={`animate-spin w-8 h-8 border-4 ${isLight ? 'border-[#0099ff]' : 'border-blue-500'} border-t-transparent rounded-full mb-4`}></div>
                    <p className={themeStyles.subtext}>Running multi alignment...</p>
                  </div>
                )}

                {!alignmentViewLoading && !multiAlignmentResult && !alignmentViewError && (
                  <div className={`${themeStyles.panel} rounded-lg p-12 text-center flex-grow flex flex-col items-center justify-center`}>
                    <img
                      src="ensembl-e-blue.svg"
                      alt="Ensembl"
                      className="mb-4"
                      style={{
                        width: '160px',
                        height: '160px'
                      }}
                    />
                    <h2 className="text-xl font-semibold mb-2">No alignment loaded</h2>
                    <p className={themeStyles.subtext}>
                      {alignmentPreparedCount >= 2
                        ? 'Click the Run alignment button in the left hand panel to run/load the alignment'
                        : 'Use the search boxes or selected two or more genes across genomes in the browser to prepare sequences for alignment'}
                    </p>
                  </div>
                )}

                {multiAlignmentResult && !alignmentViewLoading && (
                  <>
                    <button type="button" className="self-end mb-2 px-3 py-2 rounded border border-teal-600 text-teal-400" onClick={() => { setExplorerIncoming(multiAlignmentResult); setCurrentView('alignment_explorer') }}>Open in Alignment Explorer</button>
                    <MultiAlignmentPanel
                      key={alignmentViewerDisplayKey}
                      result={multiAlignmentResult ? { ...multiAlignmentResult, rows: alignmentDisplayRows } : multiAlignmentResult}
                      theme={theme}
                      collapseIntrons={collapseIntrons}
                      collapseSourceGenomeKey={collapseSource}
                      collapseSourceOptions={collapseSourceOptions}
                      onCollapseSourceChange={setCollapseSource}
                      onCollapseIntronsChange={setCollapseIntrons}
                    />
                    <div className="mt-4">
                      <FeatureLegend theme={theme} horizontal={true} defaultExpanded={true} />
                    </div>
                  </>
                )}
              </div>
              </div>
            </ErrorBoundary>
          ) : currentView === 'sequence' ? (
            <ErrorBoundary><React.Suspense fallback={<div className="p-6 text-gray-400">Loading Sequence…</div>}><SequenceView theme={theme} config={config} genomes={config?.active_species || []} startingPoints={genomeStartingPoints} onGenomeChange={setSequenceGenomeKey} incoming={sequenceViewEntry} onIncomingConsumed={() => setSequenceViewEntry(null)} onFocusLocationSelect={handleGenomeFocusLocationSelect} onNavigateToBrowser={() => setCurrentView('genome_browser')} /></React.Suspense></ErrorBoundary>
          ) : currentView === 'alignment_explorer' ? (
            <ErrorBoundary><React.Suspense fallback={<div className="p-6 text-gray-400">Loading Alignment Explorer…</div>}><AlignmentExplorerView theme={theme} config={config} genomes={config?.active_species || []} topBarGenomes={topBarSpecies} onAddGenome={handleSpeciesPillToggle} incoming={explorerIncoming} onIncomingConsumed={() => setExplorerIncoming(null)} onOpenGenome={handleOpenAlignmentExplorerLoci} /></React.Suspense></ErrorBoundary>
          ) : currentView === 'neighbourhood' ? (
            /* ========== NEIGHBOURHOOD VIEW ========== */
            <div className="h-full">
              <NeighbourhoodView
                theme={theme}
                config={config}
                genomes={neighbourhoodGenomes}
                disabledByGenome={neighbourhoodDisabledByGenome}
                focusGeneByGenome={focusGeneByGenome}
                queryByGenome={neighbourhoodQueryStateByGenome}
                trackByGenome={neighbourhoodTrackStateByGenome}
                linksByPair={neighbourhoodLinksByPair}
                loadingByGenome={neighbourhoodLoadingStateByGenome}
                errorByGenome={neighbourhoodErrorStateByGenome}
                onQueryChange={(genomeKey, value) => {
                  const key = String(genomeKey || '').trim()
                  if (!key) return
                  setNeighbourhoodQueryByGenome((prev) => ({ ...prev, [key]: value }))
                  setNeighbourhoodErrorByGenome((prev) => ({ ...prev, [key]: null }))
                }}
                onResolveGenome={handleNeighbourhoodResolveGenome}
                onLinkSelect={handleNeighbourhoodLinkSelect}
                onFlipGenome={handleNeighbourhoodFlipGenome}
                onSwapAdjacent={handleNeighbourhoodSwapAdjacent}
                onToggleGenome={handleNeighbourhoodToggleGenome}
                useHomology={neighbourhoodUseHomology}
                homologyLinksByPair={neighbourhoodHomologyLinksByPair}
                homologyAvailabilityByGenome={neighbourhoodHomologyAvailabilityByGenome}
                homologyFilters={neighbourhoodHomologyFilters}
                homologyError={neighbourhoodHomologyError}
                onToggleUseHomology={handleNeighbourhoodUseHomologyClick}
                onHomologyFiltersChange={setNeighbourhoodHomologyFilters}
                homologyPairLoading={neighbourhoodHomologyPairLoading}
                noHitGenomeKeys={neighbourhoodNoHitGenomeKeys}
              />
            </div>
          ) : currentView === 'homology' ? (
            /* ========== HOMOLOGY VIEW ========== */
            <div className="h-full">
              <HomologyView
                theme={theme}
                config={config}
                refSpecies={refSpecies}
                tgtSpecies={tgtSpecies}
                refPillLabel={g1PillLabel}
                tgtPillLabel={g2PillLabel}
                refResolved={refResolved}
                tgtResolved={tgtResolved}
                browserRefGene={browserRefGene}
                browserTgtGene={browserTgtGene}
                onRefPillClick={() => refSpecies ? handleSpeciesPillToggle(refSpecies) : null}
                onTgtPillClick={() => tgtSpecies ? handleSpeciesPillToggle(tgtSpecies) : null}
                onRefGeneFocus={(gene) => handleRefGeneSelect(gene)}
                onTgtGeneFocus={(gene) => handleTgtGeneSelect(gene)}
              />
            </div>
          ) : currentView === 'feature_explorer' ? (
            /* ========== FEATURE EXPLORER VIEW ========== */
            <div className="h-full">
              <FeatureExplorerView
              key={featureExplorerActiveGenomeKey || 'feature-explorer-empty'}
              theme={theme}
              config={config}
              genomeKey={featureExplorerActiveGenomeKey}
              selectedGenome={featureExplorerActiveGenome}
              focusGene={featureExplorerActiveGenomeKey ? (focusGeneByGenome?.[featureExplorerActiveGenomeKey] || null) : null}
              seedQuery={featureExplorerSeedQuery}
              onFocusGene={(gene) => handleGenomeFocusGeneSelect(featureExplorerActiveGenomeKey, gene)}
              otherGenomes={featureExplorerOtherGenomes}
              focusGeneByGenome={focusGeneByGenome}
              onSelectGenome={handleFeatureExplorerGenomeSelect}
              screenshotMode={currentView === 'feature_explorer' ? screenshotMode : false}
              onScreenshotModeChange={setScreenshotMode}
              onScreenshotAvailabilityChange={handleScreenshotAvailabilityChange}
              screenshotToggleButtonRef={screenshotActionButtonRef}
              />
            </div>
          ) : currentView === 'stats' ? (
            /* ========== STATS VIEW ========== */
            <div className="h-full">
              <StatsView
                theme={theme}
                config={config}
                onConfigChange={handleConfigurationChange}
                listedGenomes={topBarSpecies}
                activeGenomeKeys={statsActiveGenomeKeys}
              />
            </div>
          ) : currentView === 'structural_variation' ? (
            /* ========== STRUCTURAL VARIATION VIEW ========== */
            <div className="min-h-full">
              <StructuralVariationView
                key={structuralVariationViewKey}
                theme={theme}
                config={config}
                refSpecies={svAnchorSpecies}
                tgtSpecies={svSecondSpecies}
                thirdSpecies={svThirdSpecies}
                activeSpecies={dedupeSpeciesList(config?.active_species || [])}
                inactiveSpecies={inactiveSelectedSpecies}
                thirdGenomeId={svThirdSpecies ? speciesItemKey(svThirdSpecies) : ''}
                refPillLabel={svAnchorPillLabel}
                tgtPillLabel={svSecondPillLabel}
                thirdPillLabel={svThirdPillLabel}
                onRefPillClick={() => svAnchorSpecies ? handleStructuralVariationPillToggle(svAnchorSpecies) : null}
                onTgtPillClick={() => svSecondSpecies ? handleStructuralVariationPillToggle(svSecondSpecies) : null}
                onThirdPillClick={() => svThirdSpecies ? handleStructuralVariationPillToggle(svThirdSpecies) : null}
                onGenomeOrderChange={handleStructuralVariationGenomeOrderChange}
                onAlignmentAvailabilityChange={handleSvAlignmentAvailabilityChange}
                selectedAnchorRegionId={svAnchorRegionId}
                regionExplicitlySelected={svRegionExplicitlySelected}
                onSelectedAnchorRegionIdChange={(nextRegionId, options = {}) => {
                  setSvAnchorRegionId(String(nextRegionId || ''))
                  setSvRegionExplicitlySelected(Boolean(options.explicit))
                }}
                onOpenGenomeSelector={() => setCurrentView('download')}
                browserRefGene={browserRefGene}
                browserRefViewport={browserRefViewport}
                savedViewportRef={svSavedViewportRef}
              />
            </div>
          ) : currentView === 'download' ? (
            /* ========== DOWNLOAD VIEW ========== */
            <div className="h-full">
              <DownloadView
                config={config}
                theme={theme}
                screenshotMode={currentView === 'download' ? screenshotMode : false}
                onScreenshotModeChange={setScreenshotMode}
                onScreenshotAvailabilityChange={handleScreenshotAvailabilityChange}
                screenshotToggleButtonRef={screenshotActionButtonRef}
              />
            </div>
          ) : currentView === 'genome_selector' ? (
            /* ========== GENOME SELECTOR VIEW ========== */
            <div className="min-h-full">
              <GenomeSelectorView
                config={selectorPlaylistConfig}
                onConfigChange={handleSelectorConfigChange}
                onToggleSpecies={handleSpeciesToggleFromSelector}
                onApplyPlaylist={handleApplyPlaylistFromSelector}
                selectedSpeciesList={selectorSelectedSpecies}
                tutorialListPresentation={tutorialRuntime.selectorListPresentation}
                tutorialDialogRequest={tutorialRuntime.dialogRequest}
                tutorialCustomGenomeRequest={tutorialRuntime.customGenomeRequest}
                theme={theme}
                screenshotMode={currentView === 'genome_selector' ? screenshotMode : false}
                onScreenshotModeChange={setScreenshotMode}
                onScreenshotAvailabilityChange={handleScreenshotAvailabilityChange}
                screenshotToggleButtonRef={screenshotActionButtonRef}
                scrollContainerNode={mainContentNode}
              />
            </div>
          ) : currentView === 'tutorials' ? (
            /* ========== TUTORIALS VIEW ========== */
            <div className="h-full">
              <TutorialsView
                theme={theme}
                config={config}
                onOpenConfiguration={() => setCurrentView('configuration')}
              />
            </div>
          ) : currentView === 'help' ? (
            /* ========== HELP VIEW ========== */
            <div className="h-full">
              <HelpView
                theme={theme}
              />
            </div>
          ) : currentView === 'notes' ? (
            /* ========== NOTES VIEW ========== */
            <div className="h-full">
              <NotesView
                theme={theme}
                config={config}
                topBarSpecies={topBarSpecies}
                activeSpecies={dedupeSpeciesList(config?.active_species || [])}
                onGenomeFocusGeneSelect={handleGenomeFocusGeneSelect}
                onGenomeFocusLocationSelect={handleGenomeFocusLocationSelect}
                onNavigateToBrowser={() => setCurrentView('genome_browser')}
                onAddGenome={handleSpeciesPillToggle}
                onRedownloadGenome={() => setCurrentView('download')}
              />
            </div>
          ) : currentView === 'track_manager' ? (
            /* ========== TRACK MANAGER VIEW ========== */
            <div className="h-full">
              <TrackManagerView
                theme={theme}
                config={config}
                inactiveSpecies={inactiveSelectedSpecies}
                tutorialTrackRequest={tutorialRuntime.trackRequest}
                onTutorialTracksRegistered={tutorialRuntime.reportRegisteredTracks}
              />
            </div>
          ) : currentView === 'genome_browser' ? null : (
            /* ========== CONFIGURATION VIEW ========== */
            <ConfigurationView
              config={config}
              onConfigChange={handleConfigurationChange}
              onSave={handleConfigSaved}
              theme={theme}
            />
          )}
          </div>
        ) : null}

        {/* Genome Browser - always mounted, hidden when not active, to preserve state.
            Only render after config has loaded so browsers fetch the correct genome data. */}
        {!shouldShowWindowsBackendSetup && configLoaded && (
          <div className="w-full h-full" style={{ display: currentView === 'genome_browser' ? 'block' : 'none' }}>
            <ErrorBoundary>
              <GenomeBrowserView
                listedGenomes={topBarSpecies}
                onPromoteGenome={handleGenomeWheelPromote}
                theme={theme}
                config={config}
                isActive={currentView === 'genome_browser'}
                allowBackgroundPrep={currentView !== 'download'}
                alignmentOverlay={null}
                onClearAlignmentOverlay={() => { }}
                onRefGeneSelect={handleRefGeneSelect}
                onTgtGeneSelect={handleTgtGeneSelect}
                onRefViewportChange={setBrowserRefViewport}
                refReloadKey={refBrowserReloadKey}
                tgtReloadKey={tgtBrowserReloadKey}
                externalRefGene={browserRefGene}
                externalTgtGene={browserTgtGene}
                externalFocusGenesByGenome={focusGeneByGenome}
                externalFocusLocationsByGenome={browserLocationFocusByGenome}
                onGeneFocusByGenomeChange={setBrowserFocusByGenome}
                onClearFocusedGenes={handleClearAllFocusedGenes}
                screenshotMode={currentView === 'genome_browser' ? screenshotMode : false}
                onScreenshotModeChange={setScreenshotMode}
                onScreenshotAvailabilityChange={handleScreenshotAvailabilityChange}
                screenshotToggleButtonRef={screenshotActionButtonRef}
              />
            </ErrorBoundary>
          </div>
        )}

        <ScreenshotSelectionOverlay
          active={usingFallbackScreenshot && Boolean(fallbackScreenshotTarget)}
          theme={theme}
          containerRef={fallbackScreenshotOverlayRef}
          scrollContainerRef={fallbackScreenshotOverlayRef}
          targets={fallbackScreenshotTargets}
          instructions="Click on the highlighted area to export"
          highlightSingleTarget={true}
          selectSingleTargetOnClick={true}
          onSelect={(target) => {
            setSelectedFallbackScreenshotTarget(target)
            setScreenshotMode(false)
          }}
          onCancel={() => {
            setScreenshotMode(false)
            setSelectedFallbackScreenshotTarget(null)
          }}
        />
      </div>

      {/* ── Alignment save/load modals ────────────────────────────────── */}
      {saveAlignmentModalOpen && (
        <SaveAlignmentModal
          open={saveAlignmentModalOpen}
          theme={theme}
          result={multiAlignmentResult}
          activeSpeciesByKey={activeSpeciesByKey}
          onSave={handleDoSaveAlignment}
          onClose={() => setSaveAlignmentModalOpen(false)}
        />
      )}
      {loadAlignmentModalOpen && (
        <LoadAlignmentModal
          open={loadAlignmentModalOpen}
          theme={theme}
          apiBase={API_BASE}
          outputDir={config?.output_dir || ''}
          activeGenomes={dedupeSpeciesList(config?.active_species || [])}
          inactiveGenomes={dedupeSpeciesList(inactiveSelectedSpecies)}
          onLoad={handleLoadAlignment}
          onClose={() => setLoadAlignmentModalOpen(false)}
        />
      )}
      <ScreenshotExportModal
        open={Boolean(selectedFallbackScreenshotTarget)}
        theme={theme}
        target={selectedFallbackScreenshotTarget}
        outputDir={defaultFallbackScreenshotDir}
        onSave={handleFallbackScreenshotSave}
        onClose={handleFallbackScreenshotModalClose}
      />
      {outputDirNotification && (
        <div
          role="status"
          data-output-dir-notification="true"
          data-tutorial-notification="true"
          aria-live="polite"
          className="fixed right-4 top-24 z-50 max-w-[calc(100vw-32px)] break-words rounded-lg border border-emerald-400 bg-emerald-500/90 px-6 py-4 text-white shadow-lg backdrop-blur-sm sm:right-6 sm:max-w-md"
        >
          <div className="flex items-start gap-3">
            <svg
              className="mt-0.5 shrink-0"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points="22 4 12 14.01 9 11.01" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="min-w-0 font-medium break-words">
              Output directory set: <span className="font-mono">{outputDirNotification}</span>
            </span>
          </div>
        </div>
      )}
      <GettingStartedOutputDirPrompt
        open={Boolean(
          configLoaded &&
          currentView === 'home' &&
          !String(userConfig?.output_dir || '').trim() &&
          !gettingStartedOutputDirDismissed &&
          !shouldShowWindowsBackendSetup &&
          !tutorialRuntime.isRunning
        )}
        outputDir={userConfig?.output_dir || ''}
        workingDir={userConfig?.working_dir || ''}
        theme={theme}
        onSave={handleGettingStartedOutputDir}
        onSkip={() => setGettingStartedOutputDirDismissed(true)}
      />
    </div >
  )
}

export default App
