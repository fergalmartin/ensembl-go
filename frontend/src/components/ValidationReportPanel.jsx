import { useMemo, useState } from 'react'

import ShareBar, { OTHER_SEGMENT_COLOR, ShareList, sequentialRamp, shareSegments } from './ShareBar'

// Renders the reports produced by /api/custom/validate-genome and
// /api/custom/validate-annotation. Both share the same shell: headline stat
// tiles, breakdown tables, then issues grouped by severity.

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 }

const SEVERITY_LABEL = {
    error: 'Blocking',
    warning: 'Check',
    info: 'Note',
}

const formatInt = (value) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return '—'
    return number.toLocaleString()
}

const formatBases = (value) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return '—'
    if (number >= 1e9) return `${(number / 1e9).toFixed(2)} Gb`
    if (number >= 1e6) return `${(number / 1e6).toFixed(2)} Mb`
    if (number >= 1e3) return `${(number / 1e3).toFixed(1)} kb`
    return `${number} bp`
}

const formatPercent = (value, digits = 1) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return '—'
    return `${number.toFixed(digits)}%`
}

const StatTile = ({ label, value, sub, isLight }) => (
    <div
        className={`rounded-lg border px-3 py-2 ${isLight
            ? 'bg-white border-gray-200'
            : 'bg-gray-900/60 border-gray-700'
            }`}
    >
        <div className={`text-[10px] font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
            {label}
        </div>
        <div className={`text-base font-semibold tabular-nums ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
            {value}
        </div>
        {sub ? (
            <div className={`text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{sub}</div>
        ) : null}
    </div>
)

const CountTable = ({ title, rows, isLight, total, emptyLabel = 'None' }) => {
    const entries = Object.entries(rows || {})
    if (!entries.length) {
        return (
            <div>
                <h5 className={`text-xs font-semibold mb-1 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{title}</h5>
                <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{emptyLabel}</p>
            </div>
        )
    }
    const sorted = entries.sort((a, b) => b[1] - a[1])
    const denominator = total || sorted.reduce((sum, [, n]) => sum + n, 0)
    return (
        <div>
            <h5 className={`text-xs font-semibold mb-1 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{title}</h5>
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <tbody>
                        {sorted.map(([key, count]) => (
                            <tr key={key} className={isLight ? 'border-b border-gray-100' : 'border-b border-gray-800'}>
                                <td className={`py-1 pr-2 font-mono ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{key}</td>
                                <td className={`py-1 text-right tabular-nums ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                    {formatInt(count)}
                                </td>
                                <td className={`py-1 pl-2 text-right tabular-nums w-14 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    {denominator ? formatPercent((count / denominator) * 100) : '—'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

//: The classes worth leading with, in the order a reader scans them. Keys are
//: the major classes the backend resolves every biotype into.
const MAJOR_CLASS_LABELS = [
    ['coding', 'protein_coding'],
    ['lnoncoding', 'lncRNA'],
    ['snoncoding', 'sncRNA'],
    ['pseudogene', 'pseudogene'],
    ['other', 'other'],
]

const MajorClassTable = ({ geneClasses, transcriptClasses, geneTotal, transcriptTotal, isLight }) => {
    const genes = geneClasses || {}
    const transcripts = transcriptClasses || {}
    const geneDenominator = geneTotal || Object.values(genes).reduce((sum, n) => sum + Number(n || 0), 0)
    const txDenominator = transcriptTotal || Object.values(transcripts).reduce((sum, n) => sum + Number(n || 0), 0)
    // "other" only earns a row when something actually landed in it.
    const rows = MAJOR_CLASS_LABELS.filter(([key]) => (
        key !== 'other' || Number(genes[key] || 0) > 0 || Number(transcripts[key] || 0) > 0
    ))

    if (!geneDenominator && !txDenominator) {
        return <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>No genes were modelled.</p>
    }

    const headClass = `py-1 text-[10px] font-semibold uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-xs">
                <thead>
                    <tr className={isLight ? 'border-b border-gray-200' : 'border-b border-gray-700'}>
                        <th className={`${headClass} text-left`}>Class</th>
                        <th className={`${headClass} text-right`}>Genes</th>
                        <th className={`${headClass} text-right w-14`}>%</th>
                        <th className={`${headClass} text-right`}>Transcripts</th>
                        <th className={`${headClass} text-right w-14`}>%</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(([key, label]) => {
                        const geneCount = Number(genes[key] || 0)
                        const txCount = Number(transcripts[key] || 0)
                        return (
                            <tr key={key} className={isLight ? 'border-b border-gray-100' : 'border-b border-gray-800'}>
                                <td className={`py-1 pr-2 font-mono ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{label}</td>
                                <td className={`py-1 text-right tabular-nums ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{formatInt(geneCount)}</td>
                                <td className={`py-1 pl-2 text-right tabular-nums ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    {geneDenominator ? formatPercent((geneCount / geneDenominator) * 100) : '\u2014'}
                                </td>
                                <td className={`py-1 pl-3 text-right tabular-nums ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>{formatInt(txCount)}</td>
                                <td className={`py-1 pl-2 text-right tabular-nums ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    {txDenominator ? formatPercent((txCount / txDenominator) * 100) : '\u2014'}
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}

const Disclosure = ({ label, children, isLight }) => {
    const [open, setOpen] = useState(false)
    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className={`text-xs underline underline-offset-2 ${isLight ? 'text-gray-500 hover:text-gray-800' : 'text-gray-400 hover:text-gray-100'}`}
            >
                {open ? `Hide ${label}` : `Show ${label}`}
            </button>
            {open ? <div className="mt-2">{children}</div> : null}
        </div>
    )
}

//: Small labelled values laid out across the panel rather than down it. A
//: five-row table of base counts wasted most of a wide panel on white space.
const TileGrid = ({ title, entries, isLight, columnsClass = 'grid-cols-3 sm:grid-cols-6' }) => {
    if (!entries.length) return null
    return (
        <div>
            {title ? (
                <h5 className={`text-xs font-semibold mb-1 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{title}</h5>
            ) : null}
            <div className={`grid ${columnsClass} gap-1.5`}>
                {entries.map(([label, value, sub]) => (
                    <div
                        key={label}
                        className={`rounded-md border px-2 py-1 ${isLight ? 'bg-white border-gray-200' : 'bg-gray-900/60 border-gray-700'}`}
                    >
                        <div className={`truncate text-[10px] font-mono ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={label}>
                            {label}
                        </div>
                        <div className={`truncate text-xs font-semibold tabular-nums ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                            {value}
                        </div>
                        {sub ? (
                            <div className={`truncate text-[10px] tabular-nums ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{sub}</div>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    )
}

//: Base identities, in the order the stack reads. The first four slots of the
//: categorical palette (validated for adjacent pairs in both modes); N is not a
//: base call, so it takes the neutral rather than a fifth hue.
const BASE_COLORS = {
    light: { A: '#2a78d6', C: '#eb6834', G: '#1baf7a', T: '#eda100', N: OTHER_SEGMENT_COLOR.light },
    dark: { A: '#3987e5', C: '#d95926', G: '#199e70', T: '#c98500', N: OTHER_SEGMENT_COLOR.dark },
}
const BASE_ORDER = ['A', 'C', 'G', 'T', 'N']

const DefinitionList = ({ rows, isLight }) => (
    <dl className="space-y-1">
        {rows.filter(([, value]) => value !== '' && value !== null && value !== undefined).map(([label, value, sub]) => (
            <div
                key={label}
                className={`flex items-baseline gap-2 border-b pb-1 text-xs ${isLight ? 'border-gray-100' : 'border-gray-800'}`}
            >
                <dt className={isLight ? 'text-gray-600' : 'text-gray-400'}>{label}</dt>
                <dd className={`ml-auto shrink-0 font-semibold tabular-nums ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                    {value}
                </dd>
                {sub ? (
                    <dd className={`w-24 shrink-0 text-right tabular-nums ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{sub}</dd>
                ) : null}
            </div>
        ))}
    </dl>
)

/** A share bar and the list that names its parts, hovering as one. */
const ShareFigure = ({ title, segments, isLight, listColumnsClass, primaryWidthClass, secondaryWidthClass }) => {
    const [hovered, setHovered] = useState('')
    if (!segments.length) return null
    return (
        <div className="space-y-1.5">
            {title ? (
                <h5 className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{title}</h5>
            ) : null}
            <ShareBar
                segments={segments}
                isLight={isLight}
                hoveredKey={hovered}
                onHover={setHovered}
                ariaLabel={title || 'Share of total'}
            />
            <ShareList
                segments={segments}
                isLight={isLight}
                hoveredKey={hovered}
                onHover={setHovered}
                columnsClass={listColumnsClass}
                primaryWidthClass={primaryWidthClass}
                secondaryWidthClass={secondaryWidthClass}
            />
        </div>
    )
}

const IssueList = ({ issues, isLight }) => {
    const [expanded, setExpanded] = useState({})
    const sorted = useMemo(
        () => [...(issues || [])].sort(
            (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
        ),
        [issues],
    )

    if (!sorted.length) {
        return (
            <div className={`rounded-lg px-3 py-2 text-xs ${isLight
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : 'bg-emerald-900/20 text-emerald-300 border border-emerald-800/40'
                }`}>
                No problems found.
            </div>
        )
    }

    const tone = (severity) => {
        if (severity === 'error') {
            return isLight
                ? 'bg-red-50 border-red-200 text-red-800'
                : 'bg-red-900/20 border-red-800/40 text-red-300'
        }
        if (severity === 'warning') {
            return isLight
                ? 'bg-amber-50 border-amber-200 text-amber-800'
                : 'bg-amber-900/20 border-amber-800/40 text-amber-300'
        }
        return isLight
            ? 'bg-gray-50 border-gray-200 text-gray-700'
            : 'bg-gray-800/60 border-gray-700 text-gray-300'
    }

    return (
        <div className="space-y-1.5">
            {sorted.map((issue) => {
                const open = !!expanded[issue.code]
                const hasExamples = (issue.examples || []).length > 0
                return (
                    <div key={issue.code} className={`rounded-lg border px-3 py-2 text-xs ${tone(issue.severity)}`}>
                        <div className="flex items-start gap-2">
                            <span className="font-semibold shrink-0">
                                {SEVERITY_LABEL[issue.severity] || issue.severity}
                            </span>
                            <span className="flex-1">{issue.message}</span>
                            {issue.count > 1 ? (
                                <span className="shrink-0 tabular-nums font-semibold">×{formatInt(issue.count)}</span>
                            ) : null}
                        </div>
                        {hasExamples ? (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setExpanded((prev) => ({ ...prev, [issue.code]: !open }))}
                                    className="mt-1 underline underline-offset-2 opacity-80 hover:opacity-100"
                                >
                                    {open ? 'Hide examples' : `Show ${issue.examples.length} example${issue.examples.length === 1 ? '' : 's'}`}
                                </button>
                                {open ? (
                                    <ul className="mt-1 space-y-0.5 font-mono opacity-90">
                                        {issue.examples.map((example, index) => (
                                            <li key={`${issue.code}-${index}`} className="break-all">{example}</li>
                                        ))}
                                    </ul>
                                ) : null}
                            </>
                        ) : null}
                    </div>
                )
            })}
        </div>
    )
}

const Section = ({ title, children, isLight }) => (
    <div className="space-y-2">
        <h4 className={`text-xs font-bold uppercase tracking-wide ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
            {title}
        </h4>
        {children}
    </div>
)

const GenomeReport = ({ report, isLight }) => {
    const bases = report.base_counts || {}
    const invalid = report.invalid_counts || {}
    const palette = isLight ? BASE_COLORS.light : BASE_COLORS.dark

    const baseSegments = useMemo(() => {
        const total = Object.values(bases).reduce((sum, n) => sum + Number(n || 0), 0)
        const listed = BASE_ORDER
            .filter((base) => Number(bases[base] || 0) > 0)
            .map((base) => ({ key: base, label: base, value: Number(bases[base]) }))
        return shareSegments(listed, total).map((segment) => ({
            ...segment,
            color: segment.isOther
                ? (isLight ? OTHER_SEGMENT_COLOR.light : OTHER_SEGMENT_COLOR.dark)
                : palette[segment.key],
            primary: formatPercent(segment.share),
            secondary: formatInt(segment.value),
        }))
    }, [bases, palette, isLight])

    // Ranked by length and coloured by rank, so the bar reads as one gradient:
    // longest darkest, and everything below the tenth folded into "other" rather
    // than seating hues nobody can tell apart.
    const longestSegments = useMemo(() => {
        const listed = (report.longest_sequences || []).slice(0, 10)
        if (!listed.length) return []
        const ramp = sequentialRamp(listed.length, isLight)
        const unlisted = Math.max(0, Number(report.sequence_count || 0) - listed.length)
        return shareSegments(
            listed.map((sequence) => ({ key: sequence.name, label: sequence.name, value: sequence.length })),
            Number(report.total_length || 0),
            { otherLabel: `other (${formatInt(unlisted)})` },
        ).map((segment, index) => ({
            ...segment,
            color: segment.isOther
                ? (isLight ? OTHER_SEGMENT_COLOR.light : OTHER_SEGMENT_COLOR.dark)
                : ramp[index],
            primary: formatBases(segment.value),
            secondary: formatPercent(segment.share),
        }))
    }, [report.longest_sequences, report.total_length, report.sequence_count, isLight])

    return (
        <div className="space-y-4">
            <Section title="Sequences" isLight={isLight}>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <StatTile isLight={isLight} label="Sequences" value={formatInt(report.sequence_count)} />
                    <StatTile isLight={isLight} label="Total length" value={formatBases(report.total_length)} />
                    <StatTile isLight={isLight} label="Longest" value={formatBases(report.longest_length)} />
                    <StatTile isLight={isLight} label="Shortest" value={formatBases(report.shortest_length)} />
                    <StatTile isLight={isLight} label="Mean" value={formatBases(report.mean_length)} />
                    <StatTile isLight={isLight} label="Median" value={formatBases(report.median_length)} />
                    <StatTile isLight={isLight} label="N50" value={formatBases(report.n50)} sub={`L50 ${formatInt(report.l50)}`} />
                    <StatTile isLight={isLight} label="N90" value={formatBases(report.n90)} sub={`L90 ${formatInt(report.l90)}`} />
                </div>
            </Section>

            <Section title="Base composition" isLight={isLight}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <DefinitionList
                        isLight={isLight}
                        rows={[
                            ['GC', formatPercent(report.gc_percent, 2), 'of A/C/G/T'],
                            ['N', formatPercent(report.n_percent, 2), formatInt(bases.N || 0)],
                            ['Ambiguity codes', formatPercent(report.ambiguity_percent, 3), ''],
                            ['Soft-masked', formatPercent(report.softmasked_percent, 2), formatInt(report.softmasked_bases)],
                            ['Compression', report.compression || 'none', ''],
                        ]}
                    />
                    <ShareFigure
                        title="Bases present"
                        segments={baseSegments}
                        isLight={isLight}
                        listColumnsClass="sm:grid-cols-1"
                        primaryWidthClass="w-14"
                        secondaryWidthClass="w-28"
                    />
                </div>
                {Object.keys(invalid).length ? (
                    <TileGrid
                        title="Invalid characters"
                        entries={Object.entries(invalid)
                            .sort((a, b) => b[1] - a[1])
                            .map(([code, count]) => [code, formatInt(count), ''])}
                        isLight={isLight}
                    />
                ) : null}
            </Section>

            {longestSegments.length ? (
                <Section title="Longest sequences" isLight={isLight}>
                    <ShareFigure
                        segments={longestSegments}
                        isLight={isLight}
                        listColumnsClass="sm:grid-cols-2 lg:grid-cols-3"
                    />
                </Section>
            ) : null}

            <Section title="Issues" isLight={isLight}>
                <IssueList issues={report.issues} isLight={isLight} />
            </Section>
        </div>
    )
}

const AnnotationReport = ({ report, isLight }) => {
    const detected = report.detected || {}
    const counts = report.counts || {}
    const classification = report.classification || {}
    const regions = report.sequence_regions || {}
    const identifiers = report.identifiers || {}

    return (
        <div className="space-y-4">
            <Section title="Detected" isLight={isLight}>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <StatTile isLight={isLight} label="Format" value={(detected.dialect || 'unknown').toUpperCase()} />
                    <StatTile isLight={isLight} label="Producer" value={detected.producer_guess || '—'} />
                    <StatTile isLight={isLight} label="Compression" value={detected.compression || 'none'} />
                    <StatTile isLight={isLight} label="Lines read" value={formatInt(detected.lines_read)} />
                </div>
            </Section>

            <Section title="Model" isLight={isLight}>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <StatTile isLight={isLight} label="Genes" value={formatInt(counts.genes)} />
                    <StatTile isLight={isLight} label="Transcripts" value={formatInt(counts.transcripts)} />
                    <StatTile isLight={isLight} label="Exons" value={formatInt(counts.exons)} />
                    <StatTile isLight={isLight} label="CDS features" value={formatInt(counts.cds)} />
                    <StatTile
                        isLight={isLight}
                        label="Coding transcripts"
                        value={formatInt(counts.coding_transcripts)}
                    />
                    <StatTile
                        isLight={isLight}
                        label="Mono-exonic"
                        value={formatInt(counts.monoexonic_transcripts)}
                    />
                    <StatTile
                        isLight={isLight}
                        label="Transcripts / gene"
                        value={(counts.transcripts_per_gene?.mean ?? 0).toFixed(2)}
                        sub={`max ${formatInt(counts.transcripts_per_gene?.max)}`}
                    />
                    <StatTile
                        isLight={isLight}
                        label="Exons / transcript"
                        value={(counts.exons_per_transcript?.mean ?? 0).toFixed(2)}
                        sub={`max ${formatInt(counts.exons_per_transcript?.max)}`}
                    />
                </div>
            </Section>

            <Section title="Gene classes" isLight={isLight}>
                <MajorClassTable
                    geneClasses={classification.gene_major_classes}
                    transcriptClasses={classification.transcript_major_classes}
                    geneTotal={counts.genes}
                    transcriptTotal={counts.transcripts}
                    isLight={isLight}
                />
                {/* The full vocabulary runs to dozens of biotypes. It answers a
                    question you have to already be asking, so it waits behind a
                    disclosure rather than burying the counts everybody wants. */}
                <Disclosure label="every biotype" isLight={isLight}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <CountTable
                            title="Gene biotypes (resolved)"
                            rows={classification.gene_biotypes}
                            total={counts.genes}
                            isLight={isLight}
                        />
                        <CountTable
                            title="Transcript biotypes (resolved)"
                            rows={classification.transcript_biotypes}
                            total={counts.transcripts}
                            isLight={isLight}
                        />
                        <CountTable
                            title="Biotypes as provided"
                            rows={classification.source_transcript_biotypes}
                            total={counts.transcripts}
                            isLight={isLight}
                        />
                        <CountTable
                            title="Feature types in file"
                            rows={counts.feature_types}
                            isLight={isLight}
                        />
                    </div>
                </Disclosure>
            </Section>

            <Section title="Sequence regions" isLight={isLight}>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <StatTile isLight={isLight} label="Regions used" value={formatInt(regions.count)} />
                    <StatTile
                        isLight={isLight}
                        label="Missing from FASTA"
                        value={regions.fasta_checked ? formatInt((regions.missing_from_fasta || []).length) : 'not checked'}
                    />
                    <StatTile
                        isLight={isLight}
                        label="FASTA regions unannotated"
                        value={regions.fasta_checked ? formatInt(regions.fasta_regions_without_annotation) : 'not checked'}
                    />
                </div>
                {regions.naming_style_suggestion ? (
                    <div className={`rounded-lg px-3 py-2 text-xs ${isLight
                        ? 'bg-amber-50 text-amber-800 border border-amber-200'
                        : 'bg-amber-900/20 text-amber-300 border border-amber-800/40'
                        }`}>
                        {regions.naming_style_suggestion}
                    </div>
                ) : null}
                {!regions.fasta_checked ? (
                    <p className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                        Select a FASTA to cross-check sequence names — a mismatch there is the
                        most common reason a custom genome renders nothing.
                    </p>
                ) : null}
            </Section>

            <Section title="Identifiers" isLight={isLight}>
                <ul className={`text-xs space-y-1 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                    <li>Duplicate identifiers: {formatInt(identifiers.duplicate_ids)}</li>
                    <li>Duplicates across regions: {formatInt(identifiers.duplicate_ids_across_regions)}</li>
                    <li>Unresolved parent references: {formatInt(identifiers.orphan_parents)}</li>
                </ul>
                {identifiers.generation_recommended ? (
                    <div className={`rounded-lg px-3 py-2 text-xs ${isLight
                        ? 'bg-amber-50 text-amber-800 border border-amber-200'
                        : 'bg-amber-900/20 text-amber-300 border border-amber-800/40'
                        }`}>
                        These identifiers cannot be used as they are. Choose “Generate
                        identifiers” and supply a prefix when importing.
                    </div>
                ) : null}
            </Section>

            <Section title="Issues" isLight={isLight}>
                <IssueList issues={report.issues} isLight={isLight} />
            </Section>
        </div>
    )
}

export default function ValidationReportPanel({
    kind,
    report,
    status,
    progress,
    stage = '',
    message = '',
    counters = {},
    error,
    theme,
    onClose,
    analysedAt = '',
    // Set when the panel is dropped inside something that already names it and
    // draws its own frame. It then contributes content only: a card inside a
    // card, under a heading repeating the heading above it, reads as clutter
    // rather than as structure.
    embedded = false,
}) {
    const isLight = theme === 'light'
    const busy = status === 'queued' || status === 'running'
    const analysedDate = analysedAt && !Number.isNaN(Date.parse(analysedAt))
        ? new Date(analysedAt).toLocaleString()
        : ''
    const counterOrder = stage === 'building_gene_models' || stage === 'summarising_annotation'
        ? [['genes', 'genes'], ['transcripts', 'transcripts'], ['features', 'features']]
        : stage === 'reading_fasta'
            ? [['sequences', 'sequences']]
            : [['features', 'features'], ['genes', 'genes'], ['transcripts', 'transcripts']]
    const progressCounts = counterOrder
        .filter(([key]) => Number(counters?.[key] || 0) > 0)
        .slice(0, 2)
        .map(([key, label]) => `${Number(counters[key]).toLocaleString()} ${label}`)
        .join(' · ')

    return (
        <div className={embedded ? '' : `rounded-xl border ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-900/50 border-gray-700'}`}>
            {embedded ? null : (
            <div className={`flex items-center justify-between px-3 py-2 border-b ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <div>
                    <h3 className={`text-sm font-bold ${isLight ? 'text-gray-800' : 'text-gray-100'}`}>
                        {kind === 'genome' ? 'Genome analysis' : 'Annotation analysis'}
                    </h3>
                    {analysedDate ? (
                        <div className={`text-[10px] mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Analysed {analysedDate}
                        </div>
                    ) : null}
                </div>
                {onClose ? (
                    <button
                        type="button"
                        onClick={onClose}
                        className={`text-xs ${isLight ? 'text-gray-500 hover:text-gray-800' : 'text-gray-400 hover:text-gray-100'}`}
                    >
                        Close
                    </button>
                ) : null}
            </div>
            )}

            <div className={embedded ? '' : 'p-3'}>
                {busy ? (
                    <div
                        className={`text-xs ${isLight ? 'text-gray-600' : 'text-gray-300'}`}
                        role="status"
                        aria-live="polite"
                    >
                        <div className="flex items-center gap-2">
                            <span
                                className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-blue-500 border-t-transparent animate-spin"
                                aria-hidden="true"
                            />
                            <span>
                                {message || (status === 'queued' ? 'Queued…' : 'Scanning…')}
                                {status === 'running' && Number(progress || 0) > 0
                                    ? ` — ${Number(progress).toFixed(0)}%`
                                    : ''}
                            </span>
                        </div>
                        {progressCounts ? (
                            <div className={`mt-1 ml-[22px] tabular-nums ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                {progressCounts}
                            </div>
                        ) : null}
                        {Number(progress || 0) > 0 ? (
                            <div className={`mt-2 h-1.5 overflow-hidden rounded-full ${isLight ? 'bg-gray-200' : 'bg-gray-700'}`}>
                                <div
                                    className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
                                    style={{ width: `${Math.min(100, Number(progress))}%` }}
                                />
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {status === 'failed' ? (
                    <div className={`rounded-lg px-3 py-2 text-xs ${isLight
                        ? 'bg-red-50 text-red-800 border border-red-200'
                        : 'bg-red-900/20 text-red-300 border border-red-800/40'
                        }`}>
                        {error || 'Analysis failed.'}
                    </div>
                ) : null}

                {status === 'success' && report ? (
                    kind === 'genome'
                        ? <GenomeReport report={report} isLight={isLight} />
                        : <AnnotationReport report={report} isLight={isLight} />
                ) : null}
            </div>
        </div>
    )
}
