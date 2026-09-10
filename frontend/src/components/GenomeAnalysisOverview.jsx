// Everything worth knowing about the active genomes, one genome per pill:
// what the registry says about the assembly, what its sequence looks like, and
// what each of its gene sets contains.
//
// The analysis half is the same analysis the genome selector offers per file,
// showing the same report in the same panel and reading and writing the same
// stored reports — run it in either place and the other already has it. Kept
// self-contained (genomes in, config updates out) so it can be dropped into any
// view that wants this, not just the stats overview.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { API_BASE } from '../backendRuntime'
import { genomeColorResolver } from '../genomeColorSchemes'
import GenomePill, { genomePillLabels } from './GenomePill'
import ValidationReportPanel from './ValidationReportPanel'
import { withGenomeAnalysis } from '../utils/genomeAnalysis'
import { analysisBodyFor, runGenomeAnalysis } from '../utils/genomeAnalysisRunner'
import {
  buildGenomeAnalysisTargets,
  defaultExpandedAnalysisSections,
  sectionIdsForOpenGenome,
} from '../utils/genomeAnalysisTargets'
import {
  buildAssemblyMetadataRows,
  equivalentAccessionNote,
  hasAssemblyMetadata,
} from '../utils/assemblyMetadataRows'

const basename = (value = '') => {
  const parts = String(value || '').replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || ''
}

function Chevron({ open }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function MetaTiles({ entries, isLight, columnsClass = 'grid-cols-2 sm:grid-cols-4' }) {
  const present = entries.filter(([, value]) => value !== '' && value !== null && value !== undefined)
  if (!present.length) return null
  return (
    <div className={`grid ${columnsClass} gap-1.5`}>
      {present.map(([label, value]) => (
        <div
          key={label}
          className={`rounded-md border px-2 py-1 ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900/60 border-gray-700'}`}
        >
          <div className={`truncate text-[10px] font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
            {label}
          </div>
          <div className={`truncate text-xs font-semibold tabular-nums ${isLight ? 'text-gray-900' : 'text-gray-100'}`} title={String(value)}>
            {value}
          </div>
        </div>
      ))}
    </div>
  )
}

function SectionShell({ title, subtitle, status, open, onToggle, isLight, action, children }) {
  return (
    <div className={`rounded-lg border ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-800/40'}`}>
      {/* The whole header row toggles — the padding and the gap before the
          button are as easy to hit as the title, and nothing else in the row
          does anything. The button inside stays as the keyboard control. */}
      <div className="flex cursor-pointer items-center gap-2 px-3 py-2" onClick={onToggle}>
        <button
          type="button"
          onClick={(event) => {
            // The row handles it; without this the click would toggle twice.
            event.stopPropagation()
            onToggle()
          }}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left ${isLight ? 'text-gray-700' : 'text-gray-200'}`}
          aria-expanded={open}
        >
          <Chevron open={open} />
          <span className="text-xs font-bold uppercase tracking-wide">{title}</span>
          {/* Filenames and accessions are set in the mono face the style guide
              reserves for identifiers, as the genome selector sets them. */}
          {subtitle ? (
            <span className={`truncate text-xs font-normal font-mono ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
              {subtitle}
            </span>
          ) : null}
          {status ? (
            <span className={`ml-auto shrink-0 pl-2 text-[10px] tracking-wide ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
              {status}
            </span>
          ) : null}
        </button>
        {action ? <div onClick={(event) => event.stopPropagation()}>{action}</div> : null}
      </div>
      {open ? (
        <div className={`border-t px-3 py-3 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>{children}</div>
      ) : null}
    </div>
  )
}

function AnalyseButton({ label, onClick, disabled, isLight, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors ${disabled
        ? (isLight ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-default' : 'bg-gray-800 text-gray-500 border-gray-700 cursor-default')
        : (isLight
          ? 'text-blue-700 bg-white border-blue-200 hover:bg-blue-50'
          : 'text-blue-300 bg-gray-800 border-blue-900/40 hover:bg-blue-900/20')
        }`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="5 3 19 12 5 21 5 3" />
      </svg>
      {label}
    </button>
  )
}

function MetadataSection({ target, info, loading, open, onToggle, isLight }) {
  const ena = info?.ena || {}
  const ready = hasAssemblyMetadata(info)
  // Shared with the genome browser's assembly drawer, so the two surfaces
  // cannot drift on which fields they show or how they format them.
  const rows = buildAssemblyMetadataRows({ genome: target.genome, assemblyInfo: info })
  const equivalentNote = equivalentAccessionNote(info, target.assembly)

  return (
    <SectionShell
      title="Assembly metadata"
      subtitle={target.assembly}
      status={loading ? 'Loading' : ready ? '' : 'Unavailable'}
      open={open}
      onToggle={onToggle}
      isLight={isLight}
    >
      {loading && !ready ? (
        <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Reading assembly report…</div>
      ) : ready ? (
        <div className="space-y-2">
          {/* One grid, one column count: every box the same size, whatever the
              registry happens to know about a given assembly. */}
          <MetaTiles
            isLight={isLight}
            entries={rows.map((row) => [row.label, row.value])}
          />
          {equivalentNote ? (
            <p className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{equivalentNote}</p>
          ) : null}
        </div>
      ) : (
        <div className={`rounded-lg border border-dashed px-3 py-3 text-xs ${isLight ? 'border-gray-300 text-gray-500' : 'border-gray-600 text-gray-400'}`}>
          {ena.message || 'No assembly metadata is available for this genome.'}
        </div>
      )}
    </SectionShell>
  )
}

function AnalysisSection({ section, title, subtitle, open, onToggle, live, theme, isLight, onAnalyse }) {
  const stored = section.analysis
  const state = live || (stored
    ? { status: 'success', progress: 100, report: stored.report, analysed_at: stored.analysed_at, error: null }
    : null)
  const busy = state?.status === 'queued' || state?.status === 'running'
  const analysed = state?.status === 'success'
  const analysedOn = analysed && state?.analysed_at && !Number.isNaN(Date.parse(state.analysed_at))
    ? new Date(state.analysed_at).toLocaleString()
    : ''

  return (
    <SectionShell
      title={title}
      subtitle={subtitle}
      status={busy
        ? 'Analysing'
        : analysed
          ? (analysedOn ? `Analysed ${analysedOn}` : 'Analysed')
          : state?.status === 'failed' ? 'Failed' : 'Not analysed'}
      open={open}
      onToggle={onToggle}
      isLight={isLight}
      action={(
        <AnalyseButton
          label={analysed || state?.status === 'failed' ? 'Re-analyse' : 'Analyse'}
          onClick={onAnalyse}
          disabled={busy || !section.path}
          isLight={isLight}
          title={section.path || 'No file available'}
        />
      )}
    >
      {state ? (
        <ValidationReportPanel
          embedded
          kind={section.kind}
          theme={theme}
          status={state.status}
          progress={state.progress}
          stage={state.stage}
          message={state.message}
          counters={state.counters}
          report={state.report}
          error={state.error}
        />
      ) : (
        <div className={`rounded-lg border border-dashed px-3 py-4 text-xs ${isLight ? 'border-gray-300 text-gray-500' : 'border-gray-600 text-gray-400'}`}>
          {section.path
            ? <>Not analysed yet. Analysing reads <span className="font-mono">{basename(section.path)}</span> end to end and reports what it contains.</>
            : 'No file is configured for this section.'}
        </div>
      )}
    </SectionShell>
  )
}

export default function GenomeAnalysisOverview({
  genomes,
  theme = 'dark',
  activeGenomeKeys = null,
  config = null,
  analysisReports = {},
  fileOverrides = {},
  onAnalysisStored = null,
  assemblyInfoByKey = null,
  emptyMessage = 'No genomes are active. Add one in the genome selector to analyse it here.',
}) {
  const isLight = theme === 'light'
  const [liveBySection, setLiveBySection] = useState({})
  const [fetchedAssemblyInfo, setFetchedAssemblyInfo] = useState(null)
  const [assemblyLoading, setAssemblyLoading] = useState(false)
  const runningRef = useRef(new Set())

  const resolveGenomeColor = useMemo(() => genomeColorResolver(config), [config])

  const targets = useMemo(() => buildGenomeAnalysisTargets(genomes, {
    analysisReports,
    activeGenomeKeys,
    fileOverrides,
  }), [genomes, analysisReports, activeGenomeKeys, fileOverrides])

  // Assembly metadata comes from the report downloaded with the genome, so this
  // is a cache read rather than a computation. Callers that already hold it can
  // pass it in; otherwise it is fetched once for the genomes on screen.
  const genomesSignature = useMemo(
    () => targets.map((t) => t.genomeKey).join('|'),
    [targets],
  )
  useEffect(() => {
    if (assemblyInfoByKey || !genomesSignature) return undefined
    let cancelled = false
    setAssemblyLoading(true)
    fetch(`${API_BASE}/api/stats/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ genomes, sections: ['assembly'] }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        const next = {}
        for (const record of data.records || []) {
          if (record?.genome_key) next[record.genome_key] = record.assembly_info || {}
        }
        setFetchedAssemblyInfo(next)
      })
      .catch(() => { if (!cancelled) setFetchedAssemblyInfo({}) })
      .finally(() => { if (!cancelled) setAssemblyLoading(false) })
    return () => { cancelled = true }
  }, [assemblyInfoByKey, genomesSignature, genomes])

  const assemblyInfo = assemblyInfoByKey || fetchedAssemblyInfo

  // Re-seed only when the set of genomes (or which one leads) actually changes,
  // so a finished analysis does not fold the tree back up under the reader.
  const seed = useMemo(
    () => targets.map((t) => `${t.genomeKey}:${t.isActive ? 1 : 0}`).join('|'),
    [targets],
  )
  const [expanded, setExpanded] = useState(() => defaultExpandedAnalysisSections(targets))
  const seedRef = useRef(seed)
  useEffect(() => {
    if (seedRef.current === seed) return
    seedRef.current = seed
    setExpanded(defaultExpandedAnalysisSections(targets))
  }, [seed, targets])

  const toggleGenome = useCallback((target) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(target.genomeKey)) {
        next.delete(target.genomeKey)
        return next
      }
      next.add(target.genomeKey)
      // Opening a genome shows something worth reading: its metadata, its
      // assembly and the gene set it browses with. Deeper choices stay as the
      // reader left them.
      for (const id of sectionIdsForOpenGenome(target)) next.add(id)
      return next
    })
  }, [])

  const toggleSection = useCallback((sectionId) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }, [])

  const analyse = useCallback(async (section) => {
    const kind = section.kind === 'genome' ? 'genome' : 'annotation'
    const body = analysisBodyFor(kind, section.files)
    if (!body || runningRef.current.has(section.id)) return
    runningRef.current.add(section.id)
    setExpanded((prev) => (prev.has(section.id) ? prev : new Set(prev).add(section.id)))
    setLiveBySection((prev) => ({
      ...prev,
      [section.id]: { status: 'queued', progress: 0, stage: 'queued', message: 'Queued for analysis', counters: {}, report: null, error: null },
    }))
    try {
      const payload = await runGenomeAnalysis({
        kind,
        body,
        onUpdate: (update) => {
          setLiveBySection((prev) => ({
            ...prev,
            [section.id]: {
              status: update.status,
              progress: update.progress,
              stage: update.stage,
              message: update.message,
              counters: update.counters || {},
              report: update.report,
              error: update.error,
              analysed_at: update.completed_at || '',
            },
          }))
        },
      })
      if (payload?.status === 'success') {
        // The reader may have collapsed this while it ran, or wandered off and
        // come back. A finished report is worth showing.
        setExpanded((prev) => (prev.has(section.id) ? prev : new Set(prev).add(section.id)))
      }
      if (payload?.status === 'success' && payload.report && onAnalysisStored) {
        onAnalysisStored((cache) => withGenomeAnalysis(
          cache,
          section.analysisKey,
          section.type,
          section.files,
          payload.report,
          payload.completed_at || new Date().toISOString(),
        ))
        // The stored report now carries this, so drop the live copy and let the
        // two views read from the one place.
        setLiveBySection((prev) => {
          const next = { ...prev }
          delete next[section.id]
          return next
        })
      }
    } catch (error) {
      setLiveBySection((prev) => ({
        ...prev,
        [section.id]: {
          status: 'failed',
          progress: 0,
          report: null,
          error: error?.message || 'Analysis failed',
        },
      }))
    } finally {
      runningRef.current.delete(section.id)
    }
  }, [onAnalysisStored])

  if (targets.length === 0) {
    return (
      <div className={`rounded-lg border border-dashed px-4 py-10 text-center text-sm ${isLight ? 'border-gray-300 text-gray-500' : 'border-gray-600 text-gray-400'}`}>
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {targets.map((target) => {
        const genomeOpen = expanded.has(target.genomeKey)
        const labels = genomePillLabels(target.genome)
        // An active genome wears the colour it is drawn in everywhere else, so
        // a pill here and a track in the browser are recognisably the same
        // genome. A deactivated one rests in grey, as it does in the top bar.
        const pillColors = target.isActive
          ? {
            backgroundColor: resolveGenomeColor(target.genome),
            textColor: '#ffffff',
            borderColor: 'transparent',
          }
          : {
            backgroundColor: isLight ? '#ffffff' : '#1E2938',
            textColor: isLight ? '#4b5563' : '#9ca3af',
            borderColor: isLight ? '#d1d5db' : '#4b5563',
          }

        return (
          // No card around the genome: the pill is enough to say where one
          // genome's sections end and the next begins, and a box holding boxes
          // holding boxes was reading as chrome rather than structure.
          <div key={target.genomeKey}>
            <div
              className="flex cursor-pointer items-center gap-2 pb-1"
              onClick={() => toggleGenome(target)}
            >
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  toggleGenome(target)
                }}
                className={`shrink-0 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}
                aria-expanded={genomeOpen}
                aria-label={`${genomeOpen ? 'Collapse' : 'Expand'} ${target.displayName}`}
              >
                <Chevron open={genomeOpen} />
              </button>
              {/* The pill is the heading: a genome is named the same way here as
                  in the bar above, badge and all. */}
              <div className="relative flex-shrink-0" style={{ paddingBottom: 8 }}>
                <GenomePill
                  displayName={target.displayName}
                  displayAssembly={target.assemblyName}
                  badge={labels.badge}
                  badgeTooltip={labels.badgeTooltip}
                  tooltip={labels.pillTooltip}
                  isLight={isLight}
                  maxWidth="320px"
                  {...pillColors}
                />
              </div>
            </div>

            {genomeOpen ? (
              <div className="space-y-2">
                <MetadataSection
                  target={target}
                  info={assemblyInfo?.[target.genomeKey]}
                  loading={assemblyLoading && !assemblyInfo}
                  open={expanded.has(target.metadata_section.id)}
                  onToggle={() => toggleSection(target.metadata_section.id)}
                  isLight={isLight}
                />
                <AnalysisSection
                  section={target.assembly_section}
                  title="Genome analysis"
                  subtitle={basename(target.assembly_section.path)}
                  open={expanded.has(target.assembly_section.id)}
                  onToggle={() => toggleSection(target.assembly_section.id)}
                  live={liveBySection[target.assembly_section.id]}
                  theme={theme}
                  isLight={isLight}
                  onAnalyse={() => analyse(target.assembly_section)}
                />
                {target.geneSets.map((geneSet) => (
                  <AnalysisSection
                    key={geneSet.id}
                    section={geneSet}
                    title={`Gene set — ${geneSet.label}${geneSet.isDefault ? ' (default)' : ''}`}
                    subtitle={basename(geneSet.path)}
                    open={expanded.has(geneSet.id)}
                    onToggle={() => toggleSection(geneSet.id)}
                    live={liveBySection[geneSet.id]}
                    theme={theme}
                    isLight={isLight}
                    onAnalyse={() => analyse(geneSet)}
                  />
                ))}
                {target.geneSets.length === 0 ? (
                  <div className={`rounded-lg border border-dashed px-3 py-3 text-xs ${isLight ? 'border-gray-300 text-gray-500' : 'border-gray-600 text-gray-400'}`}>
                    This genome has no annotation to analyse.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
