// Running an export: asking for what a file needs, assembling it, and handing
// it to the browser.
//
// Kept out of the view because it is the one thing in this subsystem that is
// neither state nor drawing -- it is a job with steps, a progress line and a
// failure the reader has to be told about. The view holds what is on screen;
// this holds what is being written.
//
// Three shapes of work, and which one runs is decided by what was asked for:
//
//   - **A plain FASTA of one whole span** goes straight from the backend to a
//     file, as it always has. Nothing is held in this process, so a location
//     focus on a whole chromosome is still a download and not a crash.
//   - **Bases, otherwise** -- several records, or the collapsed shape -- are
//     read as FASTA per record and joined, which is bounded because a record is
//     a bounded thing.
//   - **Anything coloured** is laid out here, because the colours are the
//     reader's own and the layout is a client-side idea. It is *streamed*: a
//     block of rows is fetched, painted, written and thrown away before the
//     next is read, so what an export costs in memory is one block rather than
//     one file. The pieces go to a Blob rather than being joined, because a
//     single JavaScript string cannot exceed about 512 MB and a chromosome of
//     RTF is larger than that.

import { useCallback, useEffect, useRef, useState } from 'react'

import { sequenceApi, sequenceFasta, sequenceFastaUrl, drawnSegments } from './api'
import {
    EXPORT_ROW_BLOCK,
    ORIENTATION_FORWARD,
    ORIENTATION_REVERSE,
    ORIENTATION_VIEW,
    SHAPE_SHOWN,
    documentMeta,
    entryLayout,
    entryRequests,
    exportFormat,
    formatIsColoured,
    intervalsForRows,
    mergeClassAnswers,
    paintRows,
    paletteColours,
    readsForIntervals,
    readsReverse,
    resolveFileName,
    sequenceStore,
    splicedExportRows,
} from '../../utils/sequenceViewExport'
import { genomicExtentOf, splicedRunsFor } from '../../utils/transcriptSequenceView'
import { wrapSequence } from '../../utils/locationFocus'
import { rtfWriter } from '../../utils/sequenceViewRtf'
import { htmlWriter } from '../../utils/sequenceViewHtml'

/**
 * How much text is gathered before a piece is handed to the file.
 *
 * Four megabytes: large enough that a chromosome is a couple of hundred pieces
 * rather than millions of them, small enough that nothing here goes anywhere
 * near the limit on a single string.
 */
const FLUSH_BYTES = 4_000_000

/** Hand a list of pieces to the browser as one file. */
function save(parts, name, mime) {
    const blob = new Blob(parts, { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    // Revoked on the next turn rather than immediately: Safari reads the href
    // after the click handler returns, and a URL revoked in the same tick is
    // occasionally gone before it gets there.
    setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Everything but the header lines of a FASTA. */
function stripHeaders(text) {
    return String(text || '')
        .split('\n')
        .filter((line) => !line.startsWith('>'))
        .join('\n')
}

/** A sink that gathers text and flushes it to the file in pieces. */
function pieces() {
    const out = []
    let held = ''
    let total = 0
    return {
        write(text) {
            if (!text) return
            held += text
            total += text.length
            if (held.length >= FLUSH_BYTES) {
                out.push(held)
                held = ''
            }
        },
        get bytes() {
            return total
        },
        done() {
            if (held) out.push(held)
            held = ''
            return out
        },
    }
}

/** One frozen empty list rather than a fresh one per record. */
const EMPTY_OVERLAPS = Object.freeze([])

/** Let the browser draw the progress line before the next block of work. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0))

export default function useSequenceExport({
    genomeKey = '',
    genomeLabel = '',
    palette,
    allowedFor = () => null,
    overlapsFor = () => false,
    collapse,
    flip = false,
    hide = '',
    softmask = false,
    protein = false,
    onMessage = null,
} = {}) {
    const [busy, setBusy] = useState(false)
    const [progress, setProgress] = useState('')
    // How far along, where that is knowable: a record's rows are a known number
    // of blocks, so the bar can be a real one. Null while orientation, where the
    // number of requests is known but the time each takes is not.
    const [fraction, setFraction] = useState(null)
    const [error, setError] = useState('')
    // Bumped when the reader asks for something else, so a slow export that has
    // been superseded stops rather than saving a file nobody is waiting for.
    const generation = useRef(0)
    const alive = useRef(true)
    // Raised on the way in as well as lowered on the way out. A cleanup that
    // only ever lowered it stayed lowered: StrictMode mounts, cleans up and
    // mounts again, so every export after the first render found the component
    // "gone" and stopped without a word after "Starting…".
    useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
    }, [])

    const say = useRef(onMessage)
    say.current = onMessage

    const cancel = useCallback(() => {
        generation.current += 1
        setBusy(false)
        setProgress('')
        setFraction(null)
    }, [])

    /**
     * Write one file. Resolves true once it has been handed to the browser.
     *
     * The answer is what closes the save box: it stays up over the writing, and
     * a failure leaves it up with the reason rather than dropping the reader
     * back to a panel with no file and no explanation.
     */
    const run = useCallback(async ({
        target,
        shape = SHAPE_SHOWN,
        orientation = ORIENTATION_VIEW,
        format = 'fasta',
        gutters = true,
        headings = true,
        withProtein = false,
        fileName: asked = '',
    }) => {
        if (!target?.entries?.length || !genomeKey) return false
        const mine = (generation.current += 1)
        const running = () => alive.current && generation.current === mine
        const descriptor = exportFormat(format)
        const coloured = formatIsColoured(format)
        setError('')
        setBusy(true)
        setProgress('Starting…')
        setFraction(null)

        const entries = target.entries.map((entry) => ({ ...entry, genome: genomeKey }))
        // The reader's name, made safe and given the format's own extension.
        const fileName = resolveFileName(asked, format, entries[0].chrom || 'sequence')
        // A transcript read in its own coordinates answers neither the shape
        // question nor the orientation one -- nothing was collapsed, and it is
        // spelled 5' to 3' whichever strand it is on -- so the line does not
        // pretend to. The panel does not ask them for one either.
        const reading = entries.every((one) => one.reading)
        const subtitle = [
            genomeLabel,
            reading ? '' : shape === SHAPE_SHOWN ? 'as shown on screen' : 'whole span',
            reading ? '' : orientation === ORIENTATION_FORWARD ? 'forward strand'
                : orientation === ORIENTATION_REVERSE ? 'reverse complement'
                    : '',
            entries[0].flank && (entries[0].flank.five || entries[0].flank.three)
                ? `flank ${entries[0].flank.five}/${entries[0].flank.three} bp`
                : '',
        ].filter(Boolean).join(' · ')

        try {
            // The straight-through case: one whole span, read forward, no
            // colour and no joining. Only forward, because this hands the
            // backend a range and nothing else -- anything read the other way
            // round has to go the long way so the orientation is applied.
            const straightThrough = !coloured
                && !entries.some((one) => one.reading)
                && shape !== SHAPE_SHOWN
                && entries.length === 1
                && format === 'fasta'
                && !readsReverse(entries[0], { orientation, flip })
            if (straightThrough) {
                const link = document.createElement('a')
                link.href = sequenceFastaUrl({
                    genome: genomeKey,
                    chrom: entries[0].chrom,
                    start: entries[0].start,
                    end: entries[0].end,
                    strand: '+',
                    label: entries[0].named ? entries[0].label : genomeLabel,
                    download: true,
                })
                // Declared even though the backend's own Content-Disposition
                // usually wins here: the API is a separate origin in
                // development, and a same-origin build should still name the
                // file what the panel said it would.
                link.download = fileName
                link.rel = 'noopener'
                document.body.appendChild(link)
                link.click()
                link.remove()
                if (running()) say.current?.('Downloading…')
                return true
            }

            const sink = pieces()
            const writer = !coloured ? null : (format === 'rtf'
                ? rtfWriter({ title: target.label, subtitle, headings, gutters, colours: paletteColours(palette) })
                : htmlWriter({ title: target.label, subtitle, headings, gutters }))
            if (writer) sink.write(writer.head())

            for (let at = 0; at < entries.length; at += 1) {
                if (!running()) return false
                const entry = entries[at]
                const step = entries.length > 1 ? ` (${at + 1} of ${entries.length})` : ''
                setProgress(`Reading ${entry.label}${step}…`)
                setFraction(null)

                /**
                 * A transcript read in its own coordinates.
                 *
                 * None of the machinery below applies: there is nothing to lay
                 * out, no coordinates to read sequence at and no collapse to
                 * plan. The whole sequence arrives in one answer, and the rows
                 * are built from it -- the same rows the surface draws, from
                 * the same run list, so the file and the screen cannot
                 * disagree about what a base is.
                 */
                if (entry.reading) {
                    const answer = await sequenceApi('/transcript-sequence', {
                        genome: genomeKey,
                        transcript_id: entry.transcriptId,
                        kind: entry.reading,
                    })
                    if (!running()) return false
                    if (answer?.status !== 'ok') {
                        throw new Error(answer?.status === 'no_cds'
                            ? 'This transcript has no coding sequence'
                            : 'Could not read this transcript')
                    }
                    const extent = genomicExtentOf(answer)
                    const meta = {
                        key: entry.key,
                        label: entry.transcriptId,
                        detail: entry.detail || '',
                        chrom: entry.chrom,
                        // The reading's own genomic edges, not the
                        // transcript's: a CDS does not begin where its
                        // transcript does.
                        start: extent?.start ?? entry.start,
                        end: extent?.end ?? entry.end,
                        strand: entry.strand || '+',
                        reverse: false,
                        collapsed: false,
                        hidden: 0,
                        kept: answer.length || 0,
                        rows: Math.ceil((answer.length || 0) / 60),
                    }
                    if (!coloured) {
                        const header = `>${entry.transcriptId} ${entry.detail || entry.reading}`
                        const body = wrapSequence(answer.sequence || '', 60)
                        sink.write(format === 'text' ? `${body}\n` : `${header}\n${body}\n`)
                        continue
                    }
                    sink.write(writer.recordHead(meta))
                    sink.write(writer.rows(splicedExportRows({
                        sequence: answer.sequence,
                        runs: splicedRunsFor(entry.reading, answer),
                        cds: answer.cds,
                        palette,
                        // The panel's own box, and only where the reader is
                        // drawing the lane at all -- the same pair the genomic
                        // path asks. A protein reading already is the amino
                        // acids, so there is nothing to put over it.
                        protein: withProtein && protein && entry.reading !== 'protein',
                        gutters,
                    })))
                    sink.write(writer.recordTail())
                    continue
                }

                const requests = entryRequests(entry, { collapse, hide, shape })
                // A location asks a tile at a time, so there can be many class
                // answers and they are merged into one. Everything else asks
                // once and merging is the identity.
                const classAnswers = []
                let spans = null
                for (let i = 0; i < requests.length; i += 1) {
                    const request = requests[i]
                    if (request.kind === 'spans') {
                        spans = await sequenceApi(request.path, request.params)
                    } else if (coloured) {
                        // Classes are only needed where something is being
                        // coloured; a FASTA asks for the collapse spans alone.
                        if (requests.length > 2) {
                            setProgress(`Reading ${entry.label}${step}… annotation ${i + 1} of ${requests.length}`)
                        }
                        classAnswers.push(await sequenceApi(request.path, request.params))
                    }
                    if (!running()) return false
                }
                const classes = mergeClassAnswers(classAnswers)
                const strand = classes.strand || entry.strand || '+'
                const layout = entryLayout({
                    entry,
                    spans,
                    collapse,
                    flip,
                    shape,
                    orientation,
                    strand,
                })
                if (!layout) continue

                if (!coloured) {
                    const text = await sequenceFasta({
                        genome: genomeKey,
                        chrom: entry.chrom,
                        start: entry.start,
                        end: entry.end,
                        strand: layout.reverse ? '-' : '+',
                        label: entry.named ? entry.label : genomeLabel,
                        seg: drawnSegments(layout),
                        download: true,
                    })
                    if (!running()) return false
                    sink.write(format === 'text' ? stripHeaders(text) : text)
                    continue
                }

                const cdsFrame = classes.cdsFrame
                const translating = withProtein && protein && cdsFrame.length > 0
                sink.write(writer.recordHead(documentMeta(entry, layout, strand)))

                // A codon can straddle an intron, so a row's protein letters may
                // need bases the row itself does not draw. The coding sequence
                // is small -- a few kilobases -- so it is read once and put
                // beside each block rather than re-read with every one of them.
                const codonTiles = []
                if (translating) {
                    const frame = cdsFrame.map((piece) => ({ s: piece.s, e: piece.e }))
                    for (const read of readsForIntervals(frame)) {
                        if (!running()) return false
                        codonTiles.push(await sequenceApi('/sequence', {
                            genome: genomeKey, chrom: entry.chrom, start: read.start, end: read.end, softmask,
                        }))
                    }
                }

                const blocks = Math.ceil(layout.totalRows / EXPORT_ROW_BLOCK)
                for (let block = 0; block < blocks; block += 1) {
                    if (!running()) return false
                    const from = block * EXPORT_ROW_BLOCK
                    // A store per block, thrown away with it. This is the whole
                    // of why a chromosome need not fit in memory: there is no
                    // eviction rule to get wrong, because nothing outlives the
                    // rows it was read for.
                    const store = sequenceStore()
                    for (const tile of codonTiles) store.put(tile)
                    const reads = readsForIntervals(intervalsForRows(layout, from, EXPORT_ROW_BLOCK))
                    for (const read of reads) {
                        if (!running()) return false
                        store.put(await sequenceApi('/sequence', {
                            genome: genomeKey, chrom: entry.chrom, start: read.start, end: read.end, softmask,
                        }))
                    }
                    if (!running()) return false
                    sink.write(writer.rows(paintRows({
                        layout,
                        from,
                        count: EXPORT_ROW_BLOCK,
                        store,
                        runs: classes.runs,
                        cdsFrame,
                        strand,
                        allowed: allowedFor(entry.level),
                        // Only where the reader has the rule switched on, and
                        // only where it means anything: a record is one gene or
                        // one exon, and what else happens to lie there is not
                        // what it is being read for.
                        overlaps: overlapsFor(entry.level) ? classes.overlaps : EMPTY_OVERLAPS,
                        palette,
                        protein: translating,
                        gutters,
                    })))
                    if (blocks > 1) {
                        // Across the whole job, not this record's share of it,
                        // so a bar in front of several records goes forward once
                        // rather than restarting at each one.
                        setFraction((at + (block + 1) / blocks) / entries.length)
                        setProgress(
                            `Writing ${entry.label}${step}… ${Math.round(((block + 1) / blocks) * 100)}%`
                            + ` · ${Math.round(sink.bytes / 1e6)} MB`,
                        )
                        // A chromosome is thousands of blocks. Without yielding,
                        // the progress line never repaints and the app looks
                        // hung for as long as the export runs.
                        await breathe()
                    }
                }
                sink.write(writer.recordTail())
            }

            if (!running()) return false
            if (writer) sink.write(writer.tail())
            const parts = sink.done()
            if (!parts.length) throw new Error('There was nothing to write')

            setProgress('Saving…')
            setFraction(1)
            save(parts, fileName, descriptor.mime)
            say.current?.(`Downloaded ${fileName}`)
            return true
        } catch (failure) {
            if (!running()) return false
            // The backend's own words where it has any: it is the party that
            // knows why a read was refused, and "could not download" instead
            // would leave the reader with nothing to act on.
            setError(failure?.message || 'Could not build the file')
            return false
        } finally {
            if (running()) {
                setBusy(false)
                setProgress('')
                setFraction(null)
            }
        }
    }, [genomeKey, genomeLabel, palette, allowedFor, overlapsFor, collapse, flip, hide, softmask, protein])

    return { run, cancel, busy, progress, fraction, error, clearError: () => setError('') }
}
