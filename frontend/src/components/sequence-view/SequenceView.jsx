import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { API_BASE, apiFetch } from '../../backendRuntime'
import { FOCUS_DRAWER_RAIL_WIDTH, FOCUS_DRAWER_WIDTH } from '../FocusGeneDrawer'
import { getGenomeKey } from '../../utils/genomeIdentity'
import { classesForLevel, defaultHighlights, LEVELS } from '../../utils/sequenceViewPalette'
import { readPrefs, writePrefs } from '../../utils/sequenceViewPrefs'
import { DEFAULT_COLOURS, buildPalette } from '../../utils/sequenceViewColours'
import { buildDocument } from '../../utils/sequenceViewDocument'
import { parseSearchQuery, withinOpenRegion } from '../../utils/sequenceViewSearch'
import { exportFileName, exportTargets, targetBases } from '../../utils/sequenceViewExport'
import {
    EMPTY_PICKS,
    clearPicks,
    pickScope,
    picksFor,
    togglePick,
} from '../../utils/sequenceViewPicks'
import {
    LEVEL_CUSTOM,
    LEVEL_FEATURE,
    LEVEL_GENE,
    LEVEL_LOCATION,
    LEVEL_TRANSCRIPT,
    emptyFocus,
    flankPair,
    focusReducer,
    focusFromStart,
    focusWindow,
} from '../../utils/sequenceViewFocus'
import SequenceCanvas from './SequenceCanvas'
import SequenceBasePopup from './SequenceBasePopup'
import SequenceControlBar from './SequenceControlBar'
import SequenceFocusDrawer from './SequenceFocusDrawer'
import SequenceDownloadDialog from './SequenceDownloadDialog'
import SequenceDownloadPanel from './SequenceDownloadPanel'
import SequenceFocusSettings from './SequenceFocusSettings'
import SequenceLegend from './SequenceLegend'
import useDisplayLayout from './useDisplayLayout'
import useSequenceExport from './useSequenceExport'
import useRecordViews from './useRecordViews'
import useSequenceBuffer from './useSequenceBuffer'
import useSequenceClasses from './useSequenceClasses'
import {
    EMPTY_HIDDEN,
    hiddenParam,
    hideAll,
    showAll,
    toggleHidden,
} from '../../utils/sequenceViewHidden'
import { drawnSegments, sequenceApi, sequenceFasta } from './api'
import { genomeColorResolver } from '../../genomeColorSchemes'
import { genomePillLabels } from '../GenomePill'
import { SELECT_DRAG, selectionRange } from '../../utils/sequenceViewSelect'
import { PROTEIN_LANE_PX, rowHeightFor } from './sequenceViewLayout'
import { ZOOM_FULL, clampZoom } from '../../utils/sequenceViewZoom'
import { proteinRowRuns } from '../../utils/sequenceViewProtein'
import './controls.css'

// One frozen empty list rather than a fresh one per render: it is a memo
// dependency, and a new array every render would repaint every row.
const EMPTY_OVERLAPS = Object.freeze([])

// The same measurements the browser's focus drawers use, so the two panels are
// the same object in two places rather than two panels that resemble each other.
const DRAWER_WIDTH = FOCUS_DRAWER_WIDTH
const RAIL_WIDTH = FOCUS_DRAWER_RAIL_WIDTH
// Narrower than the browser's 540, which is sized to fit a 60-character FASTA
// line. Nothing in here is sequence.
const SETTINGS_WIDTH = 260
// The download panel asks five questions with an answer list apiece. It is wide
// enough to set them out in two columns rather than one long scroll, which it
// can afford to be because the wide slot hangs over the sequence instead of
// squeezing it.
const DOWNLOAD_WIDTH = 560
const WIDE_SLOT_WIDTH = { settings: SETTINGS_WIDTH, download: DOWNLOAD_WIDTH }

/** Where a genome would open, in as few characters as say it. */
function startingPointLabel(point) {
    const gene = point?.gene
    if (gene?.name || gene?.id) return gene.name || gene.id
    const location = point?.location
    if (!location?.chrom) return ''
    const from = Number(location.start)
    const to = Number(location.end)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return ''
    return `${location.chrom}:${Math.min(from, to).toLocaleString()}`
}

export default function SequenceView({
    theme,
    config = null,
    genomes = [],
    // Where each genome is being read elsewhere in the app, keyed by genome:
    // `{ location, gene }`. What switching genomes here opens on.
    startingPoints = null,
    // Which genome is being read, for the top bar: the view chooses its own,
    // and the strip has to light the same pill.
    onGenomeChange = null,
    incoming = null,
    onIncomingConsumed = null,
    onFocusLocationSelect = null,
    onNavigateToBrowser = null,
}) {
    const isLight = theme === 'light'
    const [chosenGenome, setGenomeKey] = useState('')
    const [focus, dispatch] = useReducer(focusReducer, emptyFocus())
    // How the reader likes to read, kept across visits. What was stored is read
    // field by field against the defaults as they are now -- see
    // utils/sequenceViewPrefs.js, which also reads an older shape forward.
    const [prefs, setPrefs] = useState(readPrefs)
    // What the reader has silenced. Held for the session rather than saved: a
    // gene that is not drawn and cannot be seen to be hidden is a bug report
    // waiting to happen, and the bar says how many there are while it lasts.
    const [hidden, setHidden] = useState(EMPTY_HIDDEN)
    const hide = useMemo(() => hiddenParam(hidden), [hidden])

    // The feature the pointer is resting on in the list. Nothing is fetched for
    // it and no layout changes: it is a mark on the rows already drawn, which is
    // why it can follow the pointer without costing anything.
    const [preview, setPreview] = useState(null)
    // The feature whose highlight is being held, if any: `{ key, span }`. Held
    // beside the hover rather than instead of it, so letting go of the lock
    // leaves the pointer in charge again with nothing to put back.
    const [previewLock, setPreviewLock] = useState(null)

    // The element menus are drawn into, held as state rather than as a ref so
    // that the first render after mount hands it on. A ref would still be null
    // in whatever render a menu was opened from.
    const [viewRoot, setViewRoot] = useState(null)
    const [wideSlot, setWideSlot] = useState(null)
    const [drawerOpen, setDrawerOpen] = useState(true)
    const [viewport, setViewport] = useState({ start: 0, end: 0, anchor: 0, intervals: [] })
    // What the reader has ticked off the lists, and what it was ticked from.
    // Held whole rather than by id, because the list only offers what is near
    // the rows on screen and a record has to outlive its row scrolling away.
    const [picks, setPicks] = useState(EMPTY_PICKS)
    const [scrollTo, setScrollTo] = useState(null)
    const [searchError, setSearchError] = useState('')
    const [searching, setSearching] = useState(false)
    // A tool in hand, not a preference: it is put down when the reader leaves,
    // the way the browser's and the alignment view's rectangles are.
    const [selectMode, setSelectMode] = useState(false)
    // How a selection is drawn: dragged end to end, or clicked at each end.
    // A preference rather than a tool, since it survives putting the tool down.
    const [selectStyle, setSelectStyle] = useState(SELECT_DRAG)
    // How far out the reader is standing. Full size is the readable view; short
    // of it the rows are drawn as one canvas -- see utils/sequenceViewZoom.js.
    // A tool in hand rather than a preference: it is put down on the way out,
    // the way the selection rectangle is.
    const [zoom, setZoom] = useState(ZOOM_FULL)
    const [toast, setToast] = useState('')
    const [loadError, setLoadError] = useState('')
    const toastTimer = useRef(null)

    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])
    const say = useCallback((message, ms = 1600) => {
        setToast(message)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        // Something the reader has to act on stays up long enough to read.
        toastTimer.current = setTimeout(() => setToast(''), ms)
    }, [])

    useEffect(() => { writePrefs(prefs) }, [prefs])

    // Whatever the reader picked, or the first genome they have active. Derived
    // rather than set from an effect, so the first render already has one.
    const resolveGenomeColour = useMemo(() => genomeColorResolver(config), [config])
    const options = useMemo(
        () => (Array.isArray(genomes) ? genomes : []).map((item) => {
            const key = getGenomeKey(item)
            const name = item?.display_name || item?.species || key
            const start = startingPoints?.[key] || null
            return {
                key,
                label: name,
                // What a FASTA header should say. The selection key identifies a
                // genome to the backend but reads as machinery in a header someone
                // pastes into a paper or a search box.
                assembly: item?.assembly_name || item?.assembly_accession || item?.display_name || '',
                // How the genome is worn: the same pill the top bar and the
                // browser draw, in the same colour.
                pill: {
                    name,
                    assembly: item?.assembly_name || item?.assembly || '',
                    colour: resolveGenomeColour(item),
                    tooltip: genomePillLabels(item).pillTooltip,
                },
                // Where it would open, said in the list so that the switch does
                // not arrive somewhere unexplained.
                at: startingPointLabel(start),
            }
        }).filter((item) => item.key),
        [genomes, startingPoints, resolveGenomeColour],
    )
    const genomeKey = chosenGenome || options[0]?.key || ''

    // Including the one nobody chose: opening the view with no genome named
    // settles on the first, and the strip should say so as plainly as if it had
    // been picked from the list.
    useEffect(() => {
        if (genomeKey) onGenomeChange?.(genomeKey)
    }, [genomeKey, onGenomeChange])

    // An opening region, so that arriving at the view without coming from
    // anywhere still shows sequence rather than an empty frame.
    //
    // The guard is on having arrived, not on having asked. An effect that
    // recorded the attempt and then had its request cancelled -- which is what
    // happens on every mount under StrictMode, and on any re-run -- would never
    // ask again, and the view would sit on an empty frame for good. So a
    // cancelled attempt leaves nothing behind and the next run retries; only a
    // reply, or a refusal, settles it.
    const seeded = useRef({ key: '', settled: false })
    useEffect(() => {
        if (!genomeKey || incoming) return undefined
        if (focus.location && focus.genomeKey === genomeKey) return undefined
        if (seeded.current.key === genomeKey && seeded.current.settled) return undefined

        const controller = new AbortController()
        seeded.current = { key: genomeKey, settled: false }
        apiFetch(`${API_BASE}/api/browse/default_locus?genome=${encodeURIComponent(genomeKey)}`,
            { signal: controller.signal })
            .then((response) => (response.ok ? response.json() : null))
            .then((locus) => {
                seeded.current = { key: genomeKey, settled: true }
                if (!locus?.chrom) return
                dispatch({
                    type: 'reset',
                    genomeKey,
                    chrom: locus.chrom,
                    // default_locus answers 0-based half-open; everything in this
                    // view is 1-based inclusive.
                    focus: {
                        level: LEVEL_LOCATION,
                        location: { start: locus.start + 1, end: locus.end },
                    },
                })
            })
            .catch((error) => {
                if (error.name === 'AbortError') return
                seeded.current = { key: genomeKey, settled: true }
                setLoadError(error.message)
            })
        return () => controller.abort()
    }, [genomeKey, incoming, focus.location, focus.genomeKey])

    // Arriving from the genome browser with something already in focus. A
    // one-shot prop being consumed is exactly the external-system synchronising
    // an effect is for, and it reports back so the sender can clear it.
    useEffect(() => {
        if (!incoming?.chrom) return
        const key = incoming.genomeKey || genomeKey
        // Arriving with a region already chosen settles the seeding above: the
        // same shape it uses, or its guard reads an undefined field and asks
        // the backend for a starting region nobody needs.
        seeded.current = { key, settled: true }
        setGenomeKey(key)
        dispatch({
            type: 'reset',
            genomeKey: key,
            chrom: incoming.chrom,
            focus: {
                level: incoming.level || LEVEL_LOCATION,
                location: incoming.location || null,
                gene: incoming.gene || null,
                transcript: incoming.transcript || null,
            },
        })
        onIncomingConsumed?.()
    }, [incoming, genomeKey, onIncomingConsumed])

    // ---- the window on screen ------------------------------------------

    const estimate = useMemo(() => focusWindow(focus, prefs.flanks), [focus, prefs.flanks])

    const classesFocus = useMemo(() => {
        if (!focus.chrom || !genomeKey) return null
        const level = focus.level === LEVEL_CUSTOM ? LEVEL_LOCATION : focus.level
        const flank = flankPair(prefs.flanks[focus.level])
        return {
            genomeKey,
            chrom: focus.chrom,
            level,
            start: estimate?.start || 0,
            end: estimate?.end || 0,
            flank5: flank.five,
            flank3: flank.three,
            geneId: focus.gene?.id || '',
            transcriptId: focus.transcript?.id || '',
            featureStart: focus.feature?.s ?? focus.feature?.start,
            featureEnd: focus.feature?.e ?? focus.feature?.end,
        }
    }, [focus, genomeKey, estimate, prefs.flanks])

    const handleToggleHidden = useCallback((id) => {
        setHidden((open) => toggleHidden(open, id))
    }, [])
    const handleHideAll = useCallback((ids) => setHidden((open) => hideAll(open, ids)), [])
    const handleShowAll = useCallback((ids) => setHidden((open) => showAll(open, ids)), [])

    // Both halves of one act. "Show only this isoform" shows it and its gene and
    // hides its siblings, and doing that as two calls would repaint an
    // in-between state nobody asked for -- and, worse, would fetch the tiles
    // for it.
    const handleHiddenChange = useCallback(({ show = [], hide: off = [] } = {}) => {
        setHidden((open) => hideAll(showAll(open, show), off))
    }, [])
    const handleShowEverything = useCallback(() => setHidden(EMPTY_HIDDEN), [])

    const annotations = useSequenceClasses({
        focus: classesFocus,
        visibleStart: viewport.start,
        visibleEnd: viewport.end,
        intervals: viewport.intervals,
        hide,
        enabled: Boolean(classesFocus),
    })

    // The backend clips a window to the contig and reports what it used. That is
    // what the rows are laid out over, so a focus near the end of a chromosome
    // does not show rows of sequence that are not there. Before the reply lands,
    // the client's own estimate stands in; the two differ only at a contig edge.
    //
    // Built from its two numbers rather than handed on as an object, so that it
    // keeps its identity while they do not change. Everything downstream is
    // memoised on the region -- the layout above all -- and the layout changing
    // is what puts the reader back at their anchor coordinate, which snaps the
    // scroll to a row boundary. Dragging a selection changes `focus` on every
    // pointer move, so a region rebuilt from `focus` handed the view a new
    // layout sixty times a second and jerked the sequence under the pointer.
    const regionStart = focus.level === LEVEL_CUSTOM && focus.custom
        ? focus.custom.start
        : (annotations.windowStart || estimate?.start)
    const regionEnd = focus.level === LEVEL_CUSTOM && focus.custom
        ? focus.custom.end
        : (annotations.windowStart ? annotations.windowEnd : estimate?.end)
    const region = useMemo(
        () => (Number.isFinite(regionStart) && Number.isFinite(regionEnd)
            ? { start: regionStart, end: regionEnd }
            : null),
        [regionStart, regionEnd],
    )

    // Which way the rows read. A gene, a transcript or one of their features is
    // read in its own direction, which on the minus strand means from the far
    // end; a location is a stretch of chromosome and is read forward. The
    // reader's switch then reverses whatever that came to, so it means "the
    // other way round from what I am looking at" on both strands rather than
    // meaning nothing on one of them.
    const naturalReverse = annotations.strand === '-' && focus.level !== LEVEL_LOCATION
    const reverse = naturalReverse !== Boolean(prefs.reverse)

    // What the rows show, and in what order. In full mode this is arithmetic on
    // the region; collapsed, it is the region with its dull stretches replaced
    // by markers, which changes how many rows there are and what each one holds.
    const display = useDisplayLayout({
        genomeKey,
        chrom: focus.chrom,
        region,
        level: focus.level,
        geneId: focus.gene?.id || '',
        transcriptId: focus.transcript?.id || '',
        reverse,
        collapse: prefs.collapse,
    })

    // ---- the collection --------------------------------------------------

    // The parent whose children are on offer. Picks carry the scope they were
    // made in, so a set made under one gene is recognised as stale under the
    // next rather than quietly shown against it.
    const scope = useMemo(() => pickScope({ ...focus, genomeKey }), [focus, genomeKey])
    const records = useMemo(() => picksFor(picks, scope), [picks, scope])
    const pickedKeys = useMemo(() => new Set(records.map((item) => item.key)), [records])

    const handleTogglePick = useCallback((record) => {
        setPicks((previous) => togglePick(previous, scope, record))
    }, [scope])

    const handleClearPicks = useCallback(() => setPicks(clearPicks()), [])

    // Everything a picked record needs in order to be drawn. Empty while nothing
    // is ticked, which costs nothing.
    const collection = useRecordViews({
        genomeKey,
        chrom: focus.chrom,
        records,
        collapse: prefs.collapse,
        flip: prefs.reverse,
        hide,
        enabled: records.length > 0,
    })

    // Whether there is a reading frame to translate. A frame belongs to one
    // transcript -- a gene has as many as it has isoforms, and a location as
    // many as it has genes -- so the lane appears where exactly one is being
    // read, and the menu says so where it is not.
    const frameAvailable = records.length > 0
        ? [...collection.views.values()].some((view) => view.cdsFrame?.length > 0)
        : annotations.cdsFrame.length > 0
    const protein = Boolean(prefs.protein) && frameAvailable

    /**
     * One document either way: the ticked records, or the plain region as a
     * single unnamed record. Everything below this point draws a document, so
     * there is no second path for the ordinary case to drift away from.
     *
     * Each entry brings the rows that want a protein lane, which is what decides
     * how tall they are. Those are worked out from the annotation rather than
     * from the bases, because a row's height has to be settled before it can be
     * placed and the sequence arrives afterwards -- a row that grew when its
     * chunk landed would reflow the document under the reader.
     *
     * Everything this is memoised on has to hold its identity between renders.
     * The document decides the geometry, the geometry decides the viewport, and
     * the viewport is reported back up -- so a dependency that is a new object
     * each render is not a wasted memo but a loop.
     */
    const doc = useMemo(() => {
        const laneRowsFor = (layout, frame, strand) => (
            protein && layout && frame?.length
                ? proteinRowRuns({ layout, cdsFrame: frame, strand })
                : null
        )
        return buildDocument(records.length > 0
            ? records.map((record) => {
                const view = collection.views.get(record.key)
                const layout = view?.layout || null
                return {
                    key: record.key,
                    record,
                    layout,
                    laneRows: laneRowsFor(layout, view?.cdsFrame, view?.strand),
                }
            })
            : [{
                key: 'region',
                record: null,
                layout: display.layout,
                laneRows: laneRowsFor(display.layout, annotations.cdsFrame, annotations.strand),
            }])
    }, [records, collection.views, display.layout, protein,
        annotations.cdsFrame, annotations.strand])

    // The level the rows on screen are being read at, which is the records' own
    // level while there are records. Picks all come from one parent, so they are
    // all the same kind of thing: genes off a location, transcripts off a gene,
    // exons and introns off a transcript.
    const drawnLevel = records[0]?.level || focus.level

    /**
     * The classes each level draws, as the reader has them switched on.
     *
     * By level rather than by focus, because a record is read at its own level:
     * a gene ticked off a location is drawn as a gene, so it is the gene
     * switches -- coding, UTR, non-coding, intronic -- that decide its colours.
     * Filtering it through the location vocabulary instead would let nothing
     * through at all, since 'coding' is not a word that vocabulary has, and the
     * record would read as bare sequence.
     */
    const allowedByLevel = useMemo(() => {
        const table = new Map()
        for (const level of LEVELS) {
            const on = prefs.highlights[level] || defaultHighlights(level)
            const codes = new Set()
            for (const [code, group] of classesForLevel(level)) {
                if (on[group]) codes.add(code)
            }
            table.set(level, codes)
        }
        return table
    }, [prefs.highlights])

    // Everything a section is drawn with, resolved together: its runs, its frame,
    // its strand, and the switches those runs are read through. Together because
    // a set of runs is only meaningful against the vocabulary it was computed in
    // -- passing the annotation down one way and the switches another is exactly
    // how a record came to be drawn with a location's switches over a gene's
    // classes, and so with no colour at all.
    // Where genes lie on one another, when the reader wants to see it. Only the
    // plain view of a location has any: a record is one gene, one transcript or
    // one exon, drawn as itself, and what else happens to lie there is not what
    // it is being read for.
    const overlaps = useMemo(() => (
        focus.level === LEVEL_LOCATION && prefs.highlights[LEVEL_LOCATION]?.overlap
            ? annotations.overlaps
            : EMPTY_OVERLAPS
    ), [focus.level, prefs.highlights, annotations.overlaps])

    const viewFor = useCallback((key) => {
        if (key === 'region') {
            return {
                runs: annotations.runs,
                cdsFrame: annotations.cdsFrame,
                strand: annotations.strand,
                allowed: allowedByLevel.get(focus.level) || null,
                overlaps,
            }
        }
        const view = collection.views.get(key)
        return view ? {
            runs: view.runs,
            cdsFrame: view.cdsFrame,
            strand: view.strand,
            allowed: allowedByLevel.get(view.record.level) || null,
        } : null
    }, [annotations.runs, annotations.cdsFrame, annotations.strand,
        collection.views, allowedByLevel, focus.level, overlaps])

    /**
     * The stretch of chromosome the sequence buffer is allowed to read.
     *
     * The focus region while there is no collection, and the whole extent of the
     * records when there is. A record is not obliged to sit inside the window it
     * was ticked from -- a gene listed at a location usually runs off both ends
     * of the screen, and one of those ends can be outside the location itself --
     * and the planner refuses chunks outside the region it is given, so a record
     * reaching past the focus would draw as placeholders for ever.
     *
     * Widening it is not the same as fetching all of it: the planner asks only
     * for what is on screen, and rows from two distant records arrive as
     * separate stretches, which the interval planner keeps separate.
     */
    const recordExtent = useMemo(() => {
        if (records.length === 0) return null
        let low = Infinity
        let high = -Infinity
        for (const record of records) {
            low = Math.min(low, record.start)
            high = Math.max(high, record.end)
        }
        return Number.isFinite(low) && Number.isFinite(high) ? { start: low, end: high } : null
    }, [records])

    const buffer = useSequenceBuffer({
        genomeKey,
        chrom: focus.chrom,
        region: recordExtent || region,
        visibleStart: viewport.start,
        visibleEnd: viewport.end,
        intervals: viewport.intervals,
        anchorCoord: viewport.anchor,
        softmask: Boolean(prefs.highlights[drawnLevel]?.softmask),
        // Nothing zoomed out reads a base, so nothing zoomed out fetches one.
        // The annotation still arrives -- the colours are the whole point of
        // the far view -- and the sequence is asked for again on the way back.
        enabled: Boolean((recordExtent || region) && focus.chrom) && zoom === ZOOM_FULL,
        onError: setLoadError,
    })

    // ---- actions ---------------------------------------------------------

    const genomeLabel = options.find((item) => item.key === genomeKey)?.assembly || genomeKey


    // ---- one base, in full -----------------------------------------------
    //
    // The colours answer one question per base, and where genes overlap or
    // isoforms disagree that answer is "mixed" -- true, and not what the reader
    // wanted to know. Clicking asks the long question, and the answer arrives in
    // the same box the genome browser opens over a transcript.
    const [basePopup, setBasePopup] = useState(null)
    const baseRequest = useRef(0)

    const closeBasePopup = useCallback(() => {
        baseRequest.current += 1
        setBasePopup(null)
    }, [])

    const handleBaseClick = useCallback(({ coord, anchor }) => {
        const nonce = baseRequest.current + 1
        baseRequest.current = nonce
        setBasePopup((open) => ({
            coord,
            anchor,
            pending: true,
            // Kept while the answer is refreshed, so that silencing a gene from
            // inside the box does not empty the box it was silenced from.
            detail: open && open.coord === coord ? open.detail : null,
            error: '',
        }))
        sequenceApi('/base', {
            genome: genomeKey,
            chrom: focus.chrom,
            coord,
            // What the view is drawing, so the answer describes that rather than
            // everything the annotation happens to know.
            level: focus.level === LEVEL_CUSTOM ? LEVEL_LOCATION : focus.level,
            ...(focus.gene?.id ? { gene_id: focus.gene.id } : {}),
            ...(focus.transcript?.id ? { transcript_id: focus.transcript.id } : {}),
            ...(hide ? { hide } : {}),
        })
            .then((detail) => {
                // Only the latest question is worth answering: clicking about
                // one base while another is in flight must not be told about the
                // first one.
                if (baseRequest.current !== nonce) return
                setBasePopup((open) => (open && open.coord === coord
                    ? { ...open, pending: false, detail } : open))
            })
            .catch((error) => {
                if (baseRequest.current !== nonce) return
                setBasePopup((open) => (open && open.coord === coord
                    ? { ...open, pending: false, error: error?.message || 'Could not read this base' }
                    : open))
            })
    }, [genomeKey, focus.chrom, focus.level, focus.gene?.id, focus.transcript?.id, hide])

    // Silencing something from inside the box changes the box's own answer --
    // which gene is contesting the base, and what it is drawn as -- so the
    // question is asked again with the same anchor.
    useEffect(() => {
        const open = basePopup
        if (!open || open.pending) return
        handleBaseClick({ coord: open.coord, anchor: open.anchor })
        // Only when the hidden set changes. Depending on the popup itself would
        // re-ask forever, since asking replaces it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hide])

    // Reading into something the box mentioned. Two dispatches for a transcript,
    // because the chain is gene then transcript: entering the transcript alone
    // would leave the drawer showing the gene the reader came from.
    const focusGeneFromBox = useCallback((gene) => {
        dispatch({
            type: 'enterGene',
            gene: {
                id: gene.id,
                name: gene.name,
                start: gene.s,
                end: gene.e,
                strand: gene.strand,
                biotype: gene.biotype,
            },
        })
    }, [])

    const focusTranscriptFromBox = useCallback((gene, transcript) => {
        focusGeneFromBox(gene)
        dispatch({
            type: 'enterTranscript',
            transcript: {
                id: transcript.id,
                start: transcript.s,
                end: transcript.e,
                strand: transcript.strand,
                biotype: transcript.biotype,
            },
        })
    }, [focusGeneFromBox])

    // The box is anchored to a cell on screen, so anything that moves the cell
    // takes it with it -- which nothing can, since the arrow would then point at
    // a different base. It closes instead, on a scroll, on a new focus, and on a
    // press anywhere outside it.
    useEffect(() => {
        closeBasePopup()
    }, [focus, prefs.collapse, prefs.reverse, prefs.protein, viewport.anchor, closeBasePopup])

    // A list row can go out from under the pointer when the focus changes, and
    // then its mouseleave never arrives -- leaving bases underlined for a
    // feature nobody is pointing at. Not on a scroll, though: the underline is
    // about a feature rather than about a position, and it should still be there
    // when the reader has scrolled to the part of it they were looking for.
    useEffect(() => { setPreview(null); setPreviewLock(null) }, [focus])

    useEffect(() => {
        if (!basePopup) return undefined
        const away = (event) => {
            if (event.target?.closest?.('[data-sequence-base-popup]')) return
            closeBasePopup()
        }
        // Captured, because the canvas stops some of these on their way up.
        document.addEventListener('pointerdown', away, true)
        return () => document.removeEventListener('pointerdown', away, true)
    }, [basePopup, closeBasePopup])

    /**
     * A press anywhere the tool could not be used puts it down.
     *
     * An armed tool changes what a press on the sequence means, so leaving it
     * armed after the reader has gone off to do something else -- opened a
     * menu, ticked a record, pressed a gene in the drawer -- means their next
     * press on the bases draws a selection they did not ask for. The sequence
     * itself is exempt, obviously; so is the control, which has its own switch;
     * and so are the menus drawn over the page, since choosing how to select is
     * not leaving.
     */
    useEffect(() => {
        if (!selectMode) return undefined
        const away = (event) => {
            const target = event.target
            if (!target?.closest) return
            if (target.closest('[data-sequence-view-scroller]')) return
            if (target.closest('[data-sequence-select]')) return
            if (target.closest('.sv-menu')) return
            setSelectMode(false)
        }
        // Captured, for the same reason the base box watches this way: the
        // canvas stops some presses on their way up.
        document.addEventListener('pointerdown', away, true)
        return () => document.removeEventListener('pointerdown', away, true)
    }, [selectMode])

    /**
     * Read another genome, starting where that genome is already being read.
     *
     * A reader switching here has nearly always been looking at this genome in
     * the browser or one of the panels, and the app knows where. Only when it
     * does not does the view fall back to asking the backend for a starting
     * region, which is what the seeding effect above is for.
     */
    const chooseGenome = useCallback((key) => {
        if (!key || key === genomeKey) return
        setGenomeKey(key)
        const start = focusFromStart(key, startingPoints?.[key])
        if (!start) return
        // Settled, or the seeding effect reads the focus it has just been given
        // as an empty frame and asks for a starting region nobody needs.
        seeded.current = { key, settled: true }
        dispatch({ type: 'reset', ...start })
    }, [genomeKey, startingPoints])

    const jumpToCoord = useCallback((coord) => {
        setScrollTo({ coord, nonce: Date.now() })
    }, [])

    const rangeFor = useCallback(() => {
        if (focus.level === LEVEL_CUSTOM && focus.custom) return focus.custom
        return region
    }, [focus.level, focus.custom, region])

    /**
     * What a copy or a download should contain.
     *
     * A collection is a record apiece, in the order they were ticked, and each
     * carries the stretches actually drawn -- so a collapsed record copies as
     * the sequence with its introns taken out, which is what is on screen.
     */
    const fastaParts = useCallback(async (download) => {
        if (records.length === 0) {
            const range = rangeFor()
            if (!range) return []
            return [await sequenceFasta({
                genome: genomeKey,
                chrom: focus.chrom,
                start: range.start,
                end: range.end,
                strand: reverse ? '-' : '+',
                label: genomeLabel,
                seg: drawnSegments(display.layout),
                download,
            })]
        }
        const out = []
        for (const record of records) {
            const view = collection.views.get(record.key)
            out.push(await sequenceFasta({
                genome: genomeKey,
                chrom: record.chrom,
                start: record.start,
                end: record.end,
                strand: record.strand,
                label: record.label,
                seg: drawnSegments(view?.layout),
                download,
            }))
        }
        return out
    }, [records, rangeFor, genomeKey, genomeLabel, focus.chrom, reverse,
        display.layout, collection.views])

    const handleCopy = useCallback(async () => {
        let text = ''
        try {
            text = (await fastaParts(false)).join('')
        } catch (error) {
            // The backend's own words. When the region is past what the
            // clipboard should be given, they say so and say what to do
            // instead, which is more use than anything this end could invent.
            say(error?.message || 'Could not read the sequence', error?.tooLarge ? 6000 : 1600)
            return
        }
        if (!text) return
        // Writing to the clipboard fails for reasons that mean nothing to a
        // reader, so it gets the same short answer the rest of the app gives.
        try {
            if (!navigator?.clipboard?.writeText) {
                say('Clipboard unavailable')
                return
            }
            await navigator.clipboard.writeText(text)
            say(records.length > 1
                ? `Copied ${records.length} records as FASTA`
                : 'Copied as FASTA')
        } catch {
            say('Copy failed')
        }
    }, [fastaParts, records.length, say])

    /**
     * A symbol, an identifier, or coordinates.
     *
     * Coordinates are answered here; anything else is a question for the
     * annotation, and a match moves the focus onto the thing found -- which is
     * what shows its annotation, rather than leaving the reader on a stretch of
     * genome to find it themselves. Its edges are marked too, so it is still
     * visible if they step back up to the location.
     */
    const handleSearch = useCallback(async (text) => {
        const query = String(text || '').trim()
        if (!query) return
        setSearchError('')

        const parsed = parseSearchQuery(query, focus.chrom)
        if (parsed?.kind === 'range' || parsed?.kind === 'coordinate') {
            if (withinOpenRegion(parsed, focus.chrom, focus.location)) {
                // A bare coordinate inside what is already open moves the page
                // there and leaves the region alone. Only ever a coordinate --
                // see utils/sequenceViewSearch.js for why that matters.
                jumpToCoord(parsed.start)
                return
            }
            dispatch({
                type: 'enterLocation',
                chrom: parsed.chrom,
                location: { start: parsed.start, end: parsed.end },
            })
            return
        }

        setSearching(true)
        try {
            const answer = await sequenceApi('/search', { genome: genomeKey, query, chrom: focus.chrom })
            if (!answer?.found) {
                setSearchError(answer?.reason || `Nothing here is called “${query}”.`)
                return
            }
            const gene = answer.gene
            if (gene.chrom !== focus.chrom) {
                dispatch({
                    type: 'enterLocation',
                    chrom: gene.chrom,
                    location: { start: gene.s, end: gene.e },
                })
            }
            dispatch({
                type: 'enterGene',
                gene: {
                    id: gene.id, name: gene.name, start: gene.s, end: gene.e,
                    strand: gene.strand, biotype: gene.biotype,
                },
            })
            if (answer.transcript) {
                dispatch({
                    type: 'enterTranscript',
                    transcript: {
                        id: answer.transcript.id,
                        start: answer.transcript.s,
                        end: answer.transcript.e,
                        strand: answer.transcript.strand,
                        biotype: answer.transcript.biotype,
                    },
                })
            }
            // Say what was found. The view moving is the real answer, but a
            // reader who searched for a gene and landed in the middle of a
            // chromosome deserves to be told that is where the gene is.
            say(`Showing ${answer.transcript ? answer.transcript.id : (gene.name || gene.id)}`)
        } catch (error) {
            setSearchError(error?.message || 'Could not search')
        } finally {
            setSearching(false)
        }
    }, [genomeKey, focus.chrom, focus.location, jumpToCoord, say])

    const handleJump = useCallback(() => {
        const range = rangeFor()
        if (!range || !focus.chrom) return
        // A fresh object every time, so asking for the same region twice still
        // reaches the browser as a new request. Same contract the notes view and
        // the alignment explorer use.
        onFocusLocationSelect?.(genomeKey, { chrom: focus.chrom, start: range.start, end: range.end })
        onNavigateToBrowser?.(genomeKey)
    }, [rangeFor, focus.chrom, genomeKey, onFocusLocationSelect, onNavigateToBrowser])

    const handleSelection = useCallback((range) => {
        dispatch({ type: 'setCustom', custom: range })
    }, [])

    // ---- what to do with a selection ------------------------------------
    //
    // The bar that offers these is drawn over the selection's first row, inside
    // the scroller, and follows the reader down a selection longer than the
    // screen. See SelectionBar.jsx.

    // Drawn and done with: the tool goes back in the drawer, because a reader
    // who has just selected something wants to do something with it, not
    // select it again. Both ways of drawing one end the same way.
    const handleSelectionDone = useCallback(() => setSelectMode(false), [])

    // Read as a location rather than as a selection: the reader has chosen
    // where they want to be, so this is a jump like any other, and the
    // highlight has done its job. Keeping it would leave the whole window
    // outlined and everything outside it dimmed -- which is nothing, since the
    // window is now all there is. Whatever the drawer was holding below the
    // location survives only if it is still under the new one.
    const focusSelection = useCallback(() => {
        const range = selectionRange(focus.custom)
        if (!range) return
        dispatch({
            type: 'enterLocation',
            chrom: focus.chrom,
            location: { start: range.start, end: range.end },
        })
    }, [focus.custom, focus.chrom])

    const clearSelection = useCallback(() => {
        dispatch({ type: 'clearCustom' })
    }, [])

    // The panel offers every level that is set, the selection among them, so
    // this only says which one to open on. Focusing the selection first would
    // have done that too, but at the price of reframing the whole view around
    // it -- a download is a thing to take away, not a place to stand.
    const downloadSelection = useCallback(() => {
        setPreferSelection(true)
        setWideSlot('download')
    }, [])

    const browseSelection = useCallback(() => {
        const range = selectionRange(focus.custom)
        if (!range || !focus.chrom) return
        onFocusLocationSelect?.(genomeKey, { chrom: focus.chrom, start: range.start, end: range.end })
        onNavigateToBrowser?.(genomeKey)
    }, [focus.custom, focus.chrom, genomeKey, onFocusLocationSelect, onNavigateToBrowser])

    const copySelection = useCallback(async () => {
        const range = selectionRange(focus.custom)
        if (!range || !focus.chrom) return
        let text = ''
        try {
            // The stretch itself, end to end. Not the drawn segments: a
            // collapse hides sequence the reader has nonetheless selected
            // across, and a range that says where it starts and ends should
            // hand back everything between.
            text = await sequenceFasta({
                genome: genomeKey,
                chrom: focus.chrom,
                start: range.start,
                end: range.end,
                strand: reverse ? '-' : '+',
                label: genomeLabel,
                download: false,
            })
        } catch (error) {
            say(error?.message || 'Could not read the sequence', error?.tooLarge ? 6000 : 1600)
            return
        }
        if (!text) return
        try {
            if (!navigator?.clipboard?.writeText) {
                say('Clipboard unavailable')
                return
            }
            await navigator.clipboard.writeText(text)
            say(`Copied ${(range.end - range.start + 1).toLocaleString()} bases as FASTA`)
        } catch {
            say('Copy failed')
        }
    }, [focus.custom, focus.chrom, genomeKey, genomeLabel, reverse, say])

    // Against the level being drawn, which is the records' while a collection is
    // on screen -- the panel offers that level's switches, so it must save them
    // under it too, or ticking a gene's classes would rewrite a location's.
    const setHighlights = useCallback((next) => {
        setPrefs((previous) => ({
            ...previous,
            highlights: { ...previous.highlights, [drawnLevel]: next },
        }))
    }, [drawnLevel])

    // Everything the Feature menu holds, published in one go. One call rather
    // than four, because the menu's Apply is one act: applying them separately
    // would paint -- and fetch for -- three states nobody asked for on the way
    // to the one that was.
    const applyFeature = useCallback(({ collapse, flanks, reverse: flip, protein }) => {
        setPrefs((previous) => ({
            ...previous,
            collapse,
            flanks: { ...previous.flanks, ...flanks },
            reverse: Boolean(flip),
            protein: Boolean(protein),
        }))
    }, [])

    /**
     * How every class is drawn, with the reader's colours in it.
     *
     * Built once and handed down rather than each drawing component importing
     * the palette: a row is memoised on what it is given, so this has to keep
     * its identity while the colours do.
     */
    const palette = useMemo(() => buildPalette(prefs.colours), [prefs.colours])

    const wideWidth = WIDE_SLOT_WIDTH[wideSlot] || SETTINGS_WIDTH

    // ---- downloading -----------------------------------------------------
    //
    // What the panel offers is built from where the reader is standing rather
    // than from a fixed list: the ticked records while there are any, and then
    // every level of the chain that is actually set, from the location down to
    // the exon in focus.
    const downloadTargets = useMemo(
        () => exportTargets({ focus, records }),
        [focus, records],
    )

// Whether the panel was opened from the bar over a selection, and so should
    // open on it rather than on the level in focus.
    const [preferSelection, setPreferSelection] = useState(false)

    // What the panel offers before the reader chooses. A collection is what the
    // rows are showing, so it wins; otherwise it is the level in focus, which is
    // the thing the reader pressed Download while looking at. Defaulting to the
    // location instead made every download of an exon two clicks.
    const preferredDownloadId = preferSelection && focus.custom
        ? `level:${LEVEL_CUSTOM}`
        : (records.length ? 'records' : `level:${focus.level}`)

    // What the save box is asking about, or null while it is shut. Held here
    // rather than in the panel because the panel closes with the drawer's wide
    // slot, and a file half written is not something to throw away with it.
    const [downloadRequest, setDownloadRequest] = useState(null)


    const exporting = useSequenceExport({
        genomeKey,
        genomeLabel,
        palette,
        // A record is coloured by its own level's switches, exactly as it is on
        // screen -- see `allowedByLevel`.
        allowedFor: useCallback((level) => allowedByLevel.get(level) || null, [allowedByLevel]),
        // The overlap rule is drawn where the reader has it switched on, and
        // only over a location: a record is one gene or one exon, drawn as
        // itself, and what else lies there is not what it is being read for.
        // The same rule the canvas follows -- see `overlaps` above.
        overlapsFor: useCallback(
            (level) => level === LEVEL_LOCATION && Boolean(prefs.highlights[LEVEL_LOCATION]?.overlap),
            [prefs.highlights],
        ),
        collapse: prefs.collapse,
        flip: prefs.reverse,
        hide,
        softmask: Boolean(prefs.highlights[drawnLevel]?.softmask),
        protein: Boolean(prefs.protein),
        onMessage: say,
    })

    const setColour = useCallback((key, colour) => {
        setPrefs((previous) => ({
            ...previous,
            colours: { ...previous.colours, [key]: colour },
        }))
    }, [])

    const resetColours = useCallback(() => {
        setPrefs((previous) => ({ ...previous, colours: { ...DEFAULT_COLOURS } }))
    }, [])

    // The height every row has, before a lane is added to the ones that carry
    // one. Uniform again the moment the lane is off -- and at any zoom short of
    // full size, where there is no lane to add.
    //
    // How wide a cell ends up is the canvas's own measurement of the space it
    // has, so the zoomed geometry is worked out there rather than here; this
    // hands it the zoom and nothing else.
    const rowHeight = rowHeightFor({})
    const panel = isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'
    const muted = isLight ? 'text-gray-500' : 'text-gray-400'

    return (
        // The control tokens live here rather than on the bar: a control's menu
        // is portalled into this element so that it inherits them, and so that
        // the light switch reaches a menu drawn over the page.
        <div ref={setViewRoot} className={`flex h-full min-h-0 flex-col sv-controls ${isLight ? 'light' : ''}`}>
            <SequenceControlBar
                root={viewRoot}
                options={options}
                genomeKey={genomeKey}
                isLight={isLight}
                onGenomeChange={chooseGenome}
                focus={focus}
                region={region}
                viewport={viewport}
                onSearch={handleSearch}
                searchError={searchError}
                onClearSearchError={() => setSearchError('')}
                searching={searching}
                pending={buffer.pending || annotations.pending || collection.pending}
                indexBuilding={annotations.indexBuilding}
                selectMode={selectMode}
                onSelectModeChange={setSelectMode}
                selectStyle={selectStyle}
                onSelectStyleChange={setSelectStyle}
                zoom={zoom}
                onZoomChange={(next) => setZoom(clampZoom(next))}
                collapse={prefs.collapse}
                flanks={prefs.flanks}
                reverse={prefs.reverse}
                protein={prefs.protein}
                proteinAvailable={frameAvailable}
                readingReverse={reverse}
                collapseOffers={display.offers}
                collapseLimited={display.limited}
                onFeatureApply={applyFeature}
                colours={prefs.colours}
                palette={palette}
                theme={theme}
                onColourChange={setColour}
                onColourReset={resetColours}
                layout={display.layout}
                collapses={display.collapses}
                collapsePending={display.pending}
                collapseError={display.error}
                collapseGeneCount={display.geneCount}
                // The answer's own reason, not the absence of one. See the note
                // beside this message in the bar.
                introsPriced={Boolean(prefs.collapse?.intron?.on)
                    && display.limited === 'gene_count'}
                plainClasses={focus.level === LEVEL_LOCATION && annotations.detail === 'plain'}
                plainGeneCount={annotations.geneCount}
                hiddenCount={hidden.size}
                onShowEverything={handleShowEverything}
            />

            {loadError || annotations.error ? (
                <div className={`border-b px-4 py-2 text-xs ${panel} ${isLight ? 'text-red-700' : 'text-red-300'}`}>
                    {loadError || annotations.error}
                    <button
                        type="button"
                        className="ml-3 underline"
                        onClick={() => { setLoadError(''); buffer.retry(); annotations.retry() }}
                    >
                        Try again
                    </button>
                </div>
            ) : null}

            <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1 overflow-hidden">
                    {doc.totalRows ? (
                        <SequenceCanvas
                            doc={doc}
                            viewFor={viewFor}
                            chrom={focus.chrom}
                            rowHeight={rowHeight}
                            laneHeight={protein ? PROTEIN_LANE_PX : 0}
                            zoom={zoom}
                            palette={palette}
                            isLight={isLight}
                            buffer={buffer}
                            selection={focus.custom}
                            selectMode={selectMode}
                            selectStyle={selectStyle}
                            onSelectionDone={handleSelectionDone}
                            onSelectionFocus={focusSelection}
                            onSelectionCopy={copySelection}
                            onSelectionDownload={downloadSelection}
                            onSelectionBrowse={browseSelection}
                            onSelectionClear={clearSelection}
                            markedCoord={basePopup?.coord ?? null}
                            preview={previewLock?.span || preview}
                            scrollTo={scrollTo}
                            onSelectionChange={handleSelection}
                            onViewportChange={setViewport}
                            onBaseClick={handleBaseClick}
                        />
                    ) : (
                        <p className={`p-6 text-sm ${muted}`}>
                            {options.length === 0
                                ? 'Add a genome to read its sequence.'
                                : records.length > 0
                                    ? 'Gathering the records…'
                                    : 'Choosing a region…'}
                        </p>
                    )}
                </div>

                <SequenceFocusDrawer
                    focus={focus}
                    viewport={viewport}
                    isLight={isLight}
                    open={drawerOpen}
                    onToggle={() => setDrawerOpen((open) => !open)}
                    region={region}
                    // The drawer is the drawer, open or not: the wide slot hangs
                    // off its edge rather than widening it, so nothing beside it
                    // re-lays-out when a panel opens.
                    width={drawerOpen ? DRAWER_WIDTH : RAIL_WIDTH}
                    wideWidth={wideWidth}
                    bodyWidth={DRAWER_WIDTH}
                    wideSlot={wideSlot}
                    widePanel={wideSlot === 'download' ? (
                        <SequenceDownloadPanel
                            targets={downloadTargets}
                            preferredId={preferredDownloadId}
                            // Seeds the flank and says what "as the view reads
                            // it" amounts to; both are the reader's settings,
                            // which is where a download should start from.
                            flanks={prefs.flanks}
                            isLight={isLight}
                            proteinAvailable={frameAvailable}
                            onRequest={(request) => setDownloadRequest({
                                ...request,
                                targetLabel: request.target.label,
                                bases: targetBases(request.target),
                                suggestedName: exportFileName({
                                    target: request.target,
                                    format: request.format,
                                    chrom: focus.chrom,
                                }),
                            })}
                            onClose={() => { setWideSlot(null); setPreferSelection(false) }}
                        />
                    ) : wideSlot === 'settings' ? (
                        <SequenceFocusSettings
                            level={drawnLevel}
                            highlights={prefs.highlights[drawnLevel] || defaultHighlights(drawnLevel)}
                            onHighlightsChange={setHighlights}
                            palette={palette}
                            isLight={isLight}
                            onClose={() => setWideSlot(null)}
                        />
                    ) : null}
                    copyFeedback={toast}
                    annotationState={annotations.annotation}
                    hidden={hidden}
                    onPreview={setPreview}
                    previewLock={previewLock}
                    onTogglePreviewLock={(next) => {
                        setPreviewLock(next)
                        // Whatever the pointer was on goes with it, so releasing
                        // a lock does not leave the last row it passed marked.
                        setPreview(null)
                    }}
                    onHiddenChange={handleHiddenChange}
                    onToggleHidden={handleToggleHidden}
                    onHideAll={handleHideAll}
                    onShowAll={handleShowAll}
                    pickedKeys={pickedKeys}
                    onTogglePick={handleTogglePick}
                    onClearPicks={handleClearPicks}
                    onJumpToCoord={jumpToCoord}
                    onGoTo={(level) => {
                        if (level === LEVEL_CUSTOM) dispatch({ type: 'focusCustom' })
                        else dispatch({ type: 'goTo', level })
                    }}
                    onEnterGene={(gene) => dispatch({
                        type: 'enterGene',
                        gene: {
                            id: gene.id,
                            name: gene.name,
                            start: gene.s,
                            end: gene.e,
                            strand: gene.strand,
                            biotype: gene.biotype,
                        },
                    })}
                    onEnterTranscript={(transcript) => dispatch({
                        type: 'enterTranscript',
                        transcript: {
                            id: transcript.id,
                            start: transcript.s,
                            end: transcript.e,
                            strand: transcript.strand,
                            biotype: transcript.biotype,
                        },
                    })}
                    onEnterFeature={(feature) => dispatch({ type: 'enterFeature', feature })}
                    onSettings={() => setWideSlot((open) => (open === 'settings' ? null : 'settings'))}
                    onCopy={handleCopy}
                    onDownload={() => setWideSlot((open) => (open === 'download' ? null : 'download'))}
                    onJumpToBrowser={handleJump}
                    onClearCustom={() => dispatch({ type: 'clearCustom' })}
                />
            </div>

            {/* Keyed on the base, so a box about one base is never a box about
                another one that has not been measured in its new place yet. */}
            <SequenceBasePopup
                key={basePopup ? `${focus.chrom}:${basePopup.coord}` : 'none'}
                popup={basePopup}
                chrom={focus.chrom}
                palette={palette}
                onHiddenChange={handleHiddenChange}
                onFocusGene={focusGeneFromBox}
                onFocusTranscript={focusTranscriptFromBox}
                onClose={closeBasePopup}
            />

            {downloadRequest ? <SequenceDownloadDialog
                // Mounted fresh for each download, so the name field starts
                // from the suggestion rather than from the last one typed.
                key={`${downloadRequest.target.id}:${downloadRequest.format}`}
                request={downloadRequest}
                isLight={isLight}
                busy={exporting.busy}
                progress={exporting.progress}
                fraction={exporting.fraction}
                error={exporting.error}
                onSave={async (fileName) => {
                    if (await exporting.run({ ...downloadRequest, fileName })) setDownloadRequest(null)
                }}
                onCancel={() => {
                    // Stops a run in flight as well as shutting the box; a file
                    // nobody is waiting for should not go on being written.
                    exporting.cancel()
                    exporting.clearError()
                    setDownloadRequest(null)
                }}
            /> : null}

            <SequenceLegend
                level={drawnLevel}
                coarse={drawnLevel === LEVEL_LOCATION && annotations.detail === 'plain'}
                palette={palette}
                isLight={isLight}
            />

            {toast ? (
                <div className={`pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 rounded px-3 py-1.5 text-xs shadow-lg ${
                    isLight ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-900'
                }`}>
                    {toast}
                </div>
            ) : null}
        </div>
    )
}

export { LEVEL_FEATURE, LEVEL_GENE, LEVEL_TRANSCRIPT }
