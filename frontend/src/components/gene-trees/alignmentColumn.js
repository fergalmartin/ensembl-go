/**
 * The aligned-transcript data columns: each linked leaf's transcript, drawn in the columns
 * of one multiple alignment so homologous exons line up down the tree.
 *
 * Structure draws transcripts as the genome browser does — uniform exon boxes, coding
 * filled and non-coding outlined, a line with strand chevrons for introns, a dotted line
 * for the flanks — but along the alignment: a gap inside an exon (sequence other rows
 * have) is a thin line through it. Where intron sequence was left out of the alignment the
 * track makes room again: as many columns as the bases left out, up to `INTRON_CAP_BP`, so
 * short introns are drawn to scale and long ones read "exon ── 5,432 bp ── exon".
 * Splice boundaries that fall on the same aligned column in other rows are marked, as the
 * browser marks junction boundaries, and hovering an exon lights it and every exon sharing
 * one of its aligned boundaries, as the Feature Explorer does.
 *
 * Sequence draws the aligned bases as the MSA view does — its cells, font, feature colours
 * and red gaps, a CDS striped codon by codon with aligned codons always in the same shade
 * (utils/codonStripes.js) — optionally dimming every base that agrees with the consensus
 * so differences stand out. Too far out for letters it draws the colours alone, and
 * further out a pixel's commonest colour, as the MSA view's block view does.
 *
 * Either can instead be coloured by conservation (`colour: 'conservation'`): each base by
 * how many of the genes share it in its column (`columnConservation`), a stretch by its
 * bases' mean, in the app's heat map colours (the Feature Explorer's exon coverage ramp) —
 * Sequence's cells, and Structure's exon boxes, so conserved exons, and the genes that
 * differ where others agree, show at a glance.
 *
 * Both work in *track* units: alignment columns with the left-out introns' room inserted
 * (see `buildTrack`). The strip lies on the tree's plane, starting at the tips: panning the
 * view left and right — anywhere, by any gesture — moves along it with the tree, as a
 * genome browser's tracks move together. Its one gesture of its own is zoom: over the
 * strip the scheme's zoom stretches or shrinks it about the cursor (`view.ppu`, screen
 * pixels per unit), from the whole alignment in the Width option's width to a few dozen
 * pixels a base. Zoomed in as far as it goes, it stops; zoomed out to the whole alignment,
 * zooming out goes on as the tree's zoom, so the tree can be brought back out from over the
 * data too. The
 * view is a plain object shared by the alignment columns, so switching between them keeps
 * the place under the middle of the screen — Sequence closing in until bases read,
 * Structure opening out on the whole alignment.
 */
import { CDS_STRIPE_COLORS, FEATURE_COLORS, hexLuminance } from '../../utils/featureColors.js'
import { alignedCodonStripes } from '../../utils/codonStripes.js'
import { heatColorFromFraction } from '../../utils/heatColour.js'
import { monoFont, sansFont } from '../../utils/typography.js'
import { alignXOf, sideOf } from './treeLayout.js'
import { toScreen } from './paintTree.js'

// Column widths on screen, by the Width option.
export const ALIGNMENT_WIDTHS = Object.freeze({ s: 480, m: 720, l: 1080 })
export const ALIGNMENT_ROW_PITCH = 30
/** Introns this long or longer are drawn this many columns wide, and labelled with their length. */
export const INTRON_CAP_BP = 500
/** Aligned splice boundaries this many columns apart or closer count as the same boundary. */
export const BOUNDARY_TOLERANCE = 2
const SEQUENCE_SITE_UNITS = 10 // a left-out intron's room while bases are drawn: enough for its label
const SITE_MERGE_COLS = 3      // cuts this close in different rows share one gap in the track
const PAD = 12
const MAX_PX_PER_UNIT = 48
const LETTER_PX = 7            // a column's width on screen from which bases are written
const CELL_PX = 1.5            // …and from which each column is its own coloured cell
const CELL_H = 20              // the MSA view's cell height (its 24px rows less 2px either side)
// The MSA view's sequence colours: bases with no feature, gaps, and its letters.
const MSA_FLANK = '#2d3748', MSA_GAP = '#ef4444', MSA_TEXT_LIGHT = '#e2e8f0', MSA_TEXT_DARK = '#1f2937'
// A CDS seen from further out than a codon a pixel: its two shades as the eye mixes them.
const CDS_BLEND = '#90c0fc'
const EXON_H = 12              // the genome browser's exon height
const CHEVRON_GAP_PX = 36
const BREAK_ROOM_PX = 18       // the least room for an intron's break mark
const BOUNDARY_ROOM_PX = 5     // an exon narrower than this on screen gets no boundary marks
const DIM_ALPHA = 0.36
const PICKED = '#edc263'

// A column's class in a row, most specific last.
export const NONE = 0, FLANK = 1, INTRON = 2, GAP = 3, EXON = 4, UTR = 5, CDS = 6, SPLICE = 7, START = 8, STOP = 9
const FEATURE_CLASS = { intron: INTRON, exon: EXON, utr5: UTR, utr3: UTR, cds: CDS, donor: SPLICE, acceptor: SPLICE,
  start_codon: START, stop_codon: STOP }

/**
 * Each alignment column's class in a row: `Uint8Array(length)`. Residues outside every
 * feature are flank; gaps between the row's first and last residue are GAP.
 */
export function rowClasses(row, length) {
  const out = new Uint8Array(length)
  const seq = row.aligned || ''
  let first = -1, last = -1
  for (let c = 0; c < seq.length && c < length; c++) {
    if (seq.charCodeAt(c) !== 45) { if (first < 0) first = c; last = c; out[c] = FLANK }
  }
  for (const f of row.features || []) {
    const cls = FEATURE_CLASS[f.type]
    if (!cls) continue
    const lo = Math.max(0, f.start), hi = Math.min(length - 1, f.end)
    for (let c = lo; c <= hi; c++) if (cls > out[c] && seq.charCodeAt(c) !== 45) out[c] = cls
  }
  for (let c = Math.max(0, first); c <= last; c++) if (seq.charCodeAt(c) === 45) out[c] = GAP
  return { classes: out, first, last }
}

const upperBound = (sorted, value) => {
  let lo = 0, hi = sorted.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= value) lo = mid + 1; else hi = mid }
  return lo
}

/**
 * The track the rows are drawn along: alignment columns, with room inserted wherever a row
 * had intron sequence left out. `rows` are the aligned rows; cuts in different rows a few
 * columns apart share one gap (their intron edges either side are drawn as intron anyway).
 *
 * Structure gives each gap the columns its longest intron left out, up to `INTRON_CAP_BP`;
 * Sequence a fixed few. Returns `{sites, total, dispOf(col), siteStart(i), locate(d),
 * toCol(d), fromCol(x), cutsOf(row)}`; `sites[i]` is `{col, width, cuts: Map(row → cut)}`,
 * inserted just before alignment column `col`.
 */
export function buildTrack(rows, length, { mode = 'structure', intronEdge = 0 } = {}) {
  const cuts = []
  for (const row of rows) {
    for (const f of row.features || []) {
      if (f.type === 'intron_cut') cuts.push({ row, at: f.end, removed: f.removed_bp || 0, start: f.original_start, end: f.original_end,
        bp: (f.removed_bp || 0) + 2 * intronEdge, from: f.start })
    }
  }
  cuts.sort((a, b) => a.at - b.at)
  const sites = []
  for (const cut of cuts) {
    const site = sites[sites.length - 1]
    if (site && cut.at - site.maxAt <= SITE_MERGE_COLS && !site.cuts.has(cut.row)) {
      site.maxAt = cut.at
      site.cuts.set(cut.row, cut)
      site.removed = Math.max(site.removed, cut.removed)
    } else {
      sites.push({ col: cut.at, maxAt: cut.at, removed: cut.removed, cuts: new Map([[cut.row, cut]]) })
    }
  }
  for (const site of sites) site.width = mode === 'sequence' ? SEQUENCE_SITE_UNITS : Math.max(1, Math.min(site.removed, INTRON_CAP_BP))
  const cols = sites.map(s => s.col)
  const prefix = [0]
  for (const site of sites) prefix.push(prefix[prefix.length - 1] + site.width)
  const starts = sites.map((s, i) => s.col + prefix[i])
  const byRow = new Map()
  sites.forEach((site, i) => {
    for (const [row, cut] of site.cuts) {
      if (!byRow.has(row)) byRow.set(row, new Map())
      byRow.get(row).set(i, cut)
    }
  })
  const dispOf = col => col + prefix[upperBound(cols, col)]
  const locate = d => {
    const i = upperBound(starts, d)
    if (i > 0 && d < starts[i - 1] + sites[i - 1].width) return { site: i - 1, col: sites[i - 1].col }
    return { site: -1, col: Math.floor(d - prefix[i]) }
  }
  return {
    sites, total: length + prefix[prefix.length - 1], dispOf, locate,
    siteStart: i => starts[i],
    // Fractional alignment column at a track position (a gap maps to the column after it)…
    toCol: d => { const at = locate(d); return at.site >= 0 ? at.col : d - prefix[upperBound(starts, d)] },
    // …and back.
    fromCol: x => { const col = Math.floor(x); return dispOf(col) + (x - col) },
    cutsOf: row => byRow.get(row) || null,
  }
}

const EXONIC = kind => kind === 'cds' || kind === 'nc'

/** Each column of a row from `first` to `last` as a drawing kind, gaps taking their surroundings'. */
function columnKinds(classes, first, last) {
  const n = last - first + 1
  const kinds = new Array(n)
  for (let i = 0; i < n; i++) {
    const cls = classes[first + i]
    kinds[i] = cls === NONE ? 'none' : cls === FLANK ? 'flank' : cls === INTRON || cls === SPLICE ? 'intron' : cls === GAP ? 'gap'
      : cls === CDS || cls === START || cls === STOP ? 'cds' : 'nc'
  }
  for (let i = 0; i < n;) {
    if (kinds[i] !== 'gap') { i++; continue }
    let j = i
    while (j < n && kinds[j] === 'gap') j++
    const prev = i > 0 ? kinds[i - 1] : 'none', next = j < n ? kinds[j] : 'none'
    const kind = (EXONIC(prev) || prev === 'none') && (EXONIC(next) || next === 'none') ? 'gap'
      : prev === 'intron' || next === 'intron' ? 'intron' : 'flank'
    for (let k = i; k < j; k++) kinds[k] = kind
    i = j
  }
  return kinds
}

/**
 * A row as runs along the track: `{d0, d1, kind, exon, site?, cut?}` with `kind` one of
 * 'cds', 'nc' (non-coding exon), 'gap' (inside an exon: sequence other rows have),
 * 'intron', 'flank' or 'cut' (intron sequence left out, at `site`). Also the row's exons,
 * in track order: `{index, start, end}` in alignment columns.
 */
export function rowRuns(row, track, length) {
  const { classes, first, last } = rowClasses(row, length)
  const exons = (row.features || []).filter(f => f.type === 'exon').map(f => ({ start: f.start, end: f.end }))
    .sort((a, b) => a.start - b.start)
  exons.forEach((e, i) => { e.index = i })
  if (first < 0) return { runs: [], exons, first, last, classes }
  const exonAt = new Int16Array(length).fill(-1)
  for (const e of exons) for (let c = Math.max(0, e.start); c <= Math.min(length - 1, e.end); c++) exonAt[c] = e.index
  const kinds = columnKinds(classes, first, last)
  const cuts = track.cutsOf(row)
  const runs = []
  const push = (d0, d1, kind, exon, extra = null) => {
    const prev = runs[runs.length - 1]
    if (!extra && prev && !prev.site && prev.kind === kind && prev.exon === exon && Math.abs(prev.d1 - d0) < 1e-9) { prev.d1 = d1; return }
    runs.push({ d0, d1, kind, exon, ...(extra || {}) })
  }
  let lastExon = -1
  let j = upperBound(track.sites.map(s => s.col), first)
  for (let c = first; c <= last; c++) {
    for (; j < track.sites.length && track.sites[j].col === c; j++) {
      const cut = cuts?.get(j)
      const prev = kinds[c - 1 - first], next = kinds[c - first]
      let kind = null
      if (cut) kind = 'cut'
      else if (prev === 'none' || next === 'none') kind = null
      else if ((EXONIC(prev) || prev === 'gap') && (EXONIC(next) || next === 'gap')) kind = 'gap'
      else kind = prev === 'intron' || next === 'intron' ? 'intron' : 'flank'
      if (kind) push(track.siteStart(j), track.siteStart(j) + track.sites[j].width, kind, kind === 'gap' ? lastExon : -1, { site: j, cut })
    }
    const kind = kinds[c - first]
    if (kind === 'none') continue
    if (EXONIC(kind)) lastExon = exonAt[c]
    const d = track.dispOf(c)
    push(d, d + 1, kind, EXONIC(kind) || kind === 'gap' ? (EXONIC(kind) ? exonAt[c] : lastExon) : -1)
  }
  return { runs, exons, first, last, classes }
}

/**
 * How many other rows share each row's splice boundaries on the alignment (within
 * `tolerance` columns): `Map(row → {start: counts by exon, end: counts by exon})`. A
 * transcript's own ends (its first exon's start, last exon's end) are not splice
 * boundaries and count 0.
 */
export function boundaryShares(entries, tolerance = BOUNDARY_TOLERANCE) {
  const out = new Map()
  for (const { row, exons } of entries) out.set(row, { start: new Array(exons.length).fill(0), end: new Array(exons.length).fill(0) })
  for (const side of ['start', 'end']) {
    const all = []
    for (const { row, exons } of entries) {
      exons.forEach((e, i) => {
        if (side === 'start' ? i > 0 : i < exons.length - 1) all.push({ row, i, col: side === 'start' ? e.start : e.end })
      })
    }
    all.sort((a, b) => a.col - b.col)
    let lo = 0
    for (let k = 0; k < all.length; k++) {
      while (all[lo].col < all[k].col - tolerance) lo++
      const others = new Set()
      for (let m = lo; m < all.length && all[m].col <= all[k].col + tolerance; m++) if (all[m].row !== all[k].row) others.add(all[m].row)
      out.get(all[k].row)[side][all[k].i] = others.size
    }
  }
  return out
}

/** Where a row's strip is on screen. */
export function stripBox(layout, t, item, widthPx) {
  const column = toScreen(t, alignXOf(layout, item), item.y)[0]
  const width = widthPx - PAD * 2
  return { left: sideOf(layout, item).flipHorizontal ? column - PAD - width : column + PAD, width }
}

function themeColours(isLight) {
  return {
    // The genome browser's transcript colours (its palette's exonProteinCoding, intronLine).
    exon: isLight ? '#3366cc' : '#5b8def', intron: isLight ? '#868e96' : '#7c8594',
    // The Feature Explorer's hover highlight, and the browser's boundary marks.
    highlight: isLight ? '#0ea5e9' : '#7dd3fc', boundary: isLight ? '15,23,42' : '255,255,255',
    cellLine: FEATURE_COLORS.intron.bg, cellFlank: isLight ? '#94a3b8' : '#2d3748',
    utr: FEATURE_COLORS.utr5.bg, splice: FEATURE_COLORS.donor.bg, start: FEATURE_COLORS.start_codon.bg, stop: FEATURE_COLORS.stop_codon.bg,
    gap: isLight ? '#cbd5e1' : '#4b5563', label: isLight ? '#475569' : '#cbd5e1',
    guide: isLight ? 'rgba(15,23,42,0.35)' : 'rgba(226,232,240,0.4)',
    header: isLight ? 'rgba(255,255,255,0.92)' : 'rgba(17,24,39,0.9)', window: isLight ? 'rgba(0,153,255,0.18)' : 'rgba(96,165,250,0.22)',
    windowEdge: isLight ? '#0099ff' : '#60a5fa', text: isLight ? '#334155' : '#cbd5e1', focusBand: isLight ? 'rgba(249,115,22,0.10)' : 'rgba(251,146,60,0.12)',
  }
}

/** What the pointer is over, as the column's hover key carries it. */
function parseHover(key) {
  if (!key) return null
  const parts = String(key).split(':')
  if (parts[0] === 'e') return { kind: 'exon', leaf: Number(parts[1]), exon: Number(parts[2]), start: Number(parts[3]), end: Number(parts[4]), col: Number(parts[5]) }
  if (parts[0] === 'c') return { kind: 'column', leaf: Number(parts[1]), col: Number(parts[2]) }
  if (parts[0] === 's') return { kind: 'site', leaf: Number(parts[1]), site: Number(parts[2]) }
  return null
}

// Conservation: bases by code (A C G T, either case); anything else (N, a gap) is not counted.
const BASE_CODE = new Int8Array(128).fill(-1)
for (const [i, b] of ['A', 'C', 'G', 'T'].entries()) { BASE_CODE[b.charCodeAt(0)] = i; BASE_CODE[b.toLowerCase().charCodeAt(0)] = i }
// A stretch is coloured over at least this many pixels' worth of columns (centred on it): a
// pixel's own columns alone flicker from one pixel to the next. Close up, that is a column.
const HEAT_SMOOTH_PX = 4
const smoothCols = px => Math.max(1, Math.ceil(HEAT_SMOOTH_PX / Math.max(px, 1e-6)))
export const HEAT_STEPS = 32
const HEAT_RAMP = Array.from({ length: HEAT_STEPS }, (_, i) => heatColorFromFraction(i / (HEAT_STEPS - 1)))
/** The heat step for a share (0..1): a fixed scale, so a colour always means the same share. */
export const heatStep = share => Math.max(0, Math.min(HEAT_STEPS - 1, Math.round(share * (HEAT_STEPS - 1))))

/**
 * Conservation base by base, as Jalview's percentage identity colours it: each base by the
 * share of the column's bases that are the same base. Six genes, five with A and one with
 * G: each A is 5/6, the G 1/6 — the column's agreement shows in the bases that agree, and
 * the one that differs stands out, rather than the whole column taking one colour. Only
 * columns where two or more genes have a base count (a lone base has nothing to agree or
 * disagree with).
 *
 * A stretch of a row (a pixel's worth far out, an exon) is the mean of its bases' shares, so
 * a gene that differs from the others through a region reads cooler there than those that
 * agree. Kept as per-row prefix sums, made for a row when it is first asked for.
 *
 * Returns `{shareAt(row, c), baseAt(row, c), rowShare(row, a, b), identity(a, b)}`:
 * a base's share (0..1), its `{count, present}`, a row's mean share over columns [a, b),
 * and the column-wide share of the commonest base there — each null where nothing compares.
 */
export function columnConservation(rows, length) {
  const counts = new Uint16Array(length * 4), present = new Uint16Array(length)
  for (const row of rows) {
    const seq = row.aligned || ''
    for (let c = 0; c < length; c++) {
      const code = BASE_CODE[seq.charCodeAt(c)]
      if (code >= 0) { counts[c * 4 + code]++; present[c]++ }
    }
  }
  const baseAt = (row, c) => {
    const code = BASE_CODE[(row.aligned || '').charCodeAt(c)]
    const n = present[c]
    return code >= 0 && n >= 2 ? { count: counts[c * 4 + code], present: n } : null
  }
  const shareAt = (row, c) => { const at = baseAt(row, c); return at ? at.count / at.present : null }
  const prefixes = new Map()
  const prefixOf = row => {
    let hit = prefixes.get(row)
    if (!hit) {
      const sum = new Float64Array(length + 1), n = new Uint32Array(length + 1)
      for (let c = 0; c < length; c++) {
        const share = shareAt(row, c)
        sum[c + 1] = sum[c] + (share ?? 0)
        n[c + 1] = n[c] + (share === null ? 0 : 1)
      }
      prefixes.set(row, hit = { sum, n })
    }
    return hit
  }
  const clampRange = (a, b) => [Math.max(0, Math.floor(a)), Math.min(length, Math.ceil(b))]
  const rowShare = (row, a, b) => {
    [a, b] = clampRange(a, b)
    if (b <= a) return null
    const { sum, n } = prefixOf(row)
    const k = n[b] - n[a]
    return k > 0 ? (sum[b] - sum[a]) / k : null
  }
  const identity = (a, b) => {
    [a, b] = clampRange(a, b)
    let top = 0, all = 0
    for (let c = a; c < b; c++) {
      if (present[c] < 2) continue
      top += Math.max(counts[c * 4], counts[c * 4 + 1], counts[c * 4 + 2], counts[c * 4 + 3])
      all += present[c]
    }
    return all ? top / all : null
  }
  return { shareAt, baseAt, rowShare, identity }
}

/** The heat colours, low to high, for a legend. */
export const conservationRamp = () => HEAT_RAMP.slice()

/**
 * An alignment column (`mode` 'structure' or 'sequence'). `data` is `{id, length, rows:
 * Map(leafId → row)}` with each row's `aligned`/`features`/`region`; `pending` is a set
 * of leaf ids still coming and `failed` a map of leaf id → reason.
 */
/** The leaf row nearest screen height `sy` (within a row's pitch) among `shown`, or null. */
function rowNear(layout, t, sy, shown = null, plan = null) {
  const pitch = layout.pitch * t.k
  const hidden = plan?.folds?.hidden, folded = plan?.folds?.folded
  let best = null, gap = Math.max(6, pitch)
  for (const item of layout.items || []) {
    if (item.kind !== 'leaf' || hidden?.has(item.id) || folded?.has(item.id) || (shown && !shown(item.id))) continue
    const d = Math.abs(toScreen(t, 0, item.y)[1] - sy)
    if (d < gap) { gap = d; best = item }
  }
  return best
}

export function alignmentColumn({ data, pending = null, failed = null, view, widthPx, isLight, mode = 'structure',
  differences = false, boundaries = true, colour = 'features' }) {
  const colours = themeColours(isLight)
  const length = data?.length || 0
  const consensus = data?.consensus || ''
  const distinctRows = [...new Set(data?.rows?.values() || [])]
  const intronEdge = Number(data?.params?.intron_edge || 0)
  const track = buildTrack(distinctRows, length, { mode, intronEdge })
  const total = track.total
  const info = new Map() // row → rowRuns (and CDS stripes), made on first need
  const infoOf = row => {
    let hit = info.get(row)
    if (!hit) { hit = rowRuns(row, track, length); info.set(row, hit) }
    return hit
  }
  let shares = null
  const sharesOf = row => {
    if (!shares) shares = boundaryShares(distinctRows.map(r => ({ row: r, exons: infoOf(r).exons })))
    return shares.get(row)
  }
  // Codon shades by alignment column, from every row's reading frame at once.
  let stripes = null
  const stripesAll = () => {
    if (!stripes) {
      stripes = alignedCodonStripes(distinctRows.map(row => {
        const { classes } = infoOf(row)
        const coding = new Uint8Array(length)
        let first = -1
        for (let c = 0; c < length; c++) {
          if (classes[c] === CDS || classes[c] === START || classes[c] === STOP) { coding[c] = 1; if (first < 0) first = c }
        }
        const start = (row.features || []).find(f => f.type === 'start_codon')
        return { sequence: row.aligned || '', coding, anchor: start && coding[start.start] ? start.start : Math.max(0, first) }
      }), length)
    }
    return stripes
  }
  // Conservation, over every row the alignment holds (not only those on screen, so a
  // column's colour stays put as the tree is scrolled).
  const heat = colour === 'conservation'
  let conservation = null
  const consOf = () => conservation || (conservation = columnConservation(distinctRows, length))
  const heatAt = (row, a, b, least = 1) => {
    if (b - a < least) { const mid = (a + b) / 2; a = Math.round(mid - least / 2); b = a + least }
    const share = b - a === 1 ? consOf().shareAt(row, a) : consOf().rowShare(row, a, b)
    return share === null ? null : HEAT_RAMP[heatStep(share)]
  }
  /**
   * A row's heat along a stretch of screen, [xa, xb): a column at a time close up, a pixel
   * at a time (its columns taken together) further out, runs of one colour drawn once.
   * Stretches with nothing to compare get `none`.
   */
  function fillHeat(ctx, row, xa, xb, top, h, v, box, px, none) {
    let runX = xa, runFill = null
    const flush = x => {
      if (runFill && x > runX) { ctx.fillStyle = runFill; ctx.fillRect(runX, top, x - runX, h) }
    }
    const step = (x, fill) => { if (fill !== runFill) { flush(x); runX = x; runFill = fill } }
    const least = smoothCols(px)
    if (px >= 1) {
      const c0 = Math.max(0, Math.floor(track.toCol(v.c0 + (xa - box.left) / px)))
      const c1 = Math.min(length - 1, Math.ceil(track.toCol(v.c0 + (xb - box.left) / px)))
      for (let c = c0; c <= c1; c++) {
        const x = Math.max(xa, box.left + (track.dispOf(c) - v.c0) * px)
        if (x >= xb) break
        step(x, heatAt(row, c, c + 1, least) || none)
      }
    } else {
      for (let x = Math.floor(xa); x < xb; x++) {
        const d0 = v.c0 + (x - box.left) / px, d1 = v.c0 + (x + 1 - box.left) / px
        const a = Math.floor(track.toCol(d0)), b = Math.max(a + 1, Math.ceil(track.toCol(d1) - 1e-9))
        step(Math.max(xa, x), heatAt(row, a, b, least) || none)
      }
    }
    flush(xb)
  }
  // A base's cell colour, as the MSA view colours it (getColorAt there).
  const cellColour = (cls, stripe) => (cls === CDS ? CDS_STRIPE_COLORS[stripe < 0 ? 0 : stripe] : cls === UTR ? colours.utr
    : cls === EXON ? FEATURE_COLORS.exon.bg : cls === SPLICE ? colours.splice : cls === START ? colours.start : cls === STOP ? colours.stop
      : cls === INTRON ? colours.cellLine : MSA_FLANK)
  const letterOn = new Map()
  const letterColour = fill => {
    let out = letterOn.get(fill)
    if (!out) { out = hexLuminance(fill) < 0.46 ? MSA_TEXT_LIGHT : MSA_TEXT_DARK; letterOn.set(fill, out) }
    return out
  }

  // The shared view: `ppu` (pixels a track unit), and where along the alignment the middle
  // of the screen was (`anchor`: an alignment column and its screen x), so a column drawn
  // along another track (Sequence's, say) can open on the same place.
  const trackKey = `${data?.id || ''}|${mode}`
  const baseWidth = widthPx - PAD * 2
  const fitPpu = total ? baseWidth / total : 1
  const clampPpu = ppu => Math.max(fitPpu, Math.min(MAX_PX_PER_UNIT, ppu))
  const current = () => {
    if (view.key !== trackKey) {
      const same = view.dataId === data?.id && Number.isFinite(view.ppu)
      let ppu = same ? view.ppu : fitPpu
      if (mode === 'structure' && view.mode === 'sequence') ppu = fitPpu        // out of a few bases: everything
      if (mode === 'sequence' && ppu < LETTER_PX + 3) ppu = LETTER_PX + 3        // in until bases read
      view.ppu = ppu
      view.pendingAnchor = same && view.anchor ? view.anchor : null
      view.key = trackKey
      view.dataId = data?.id
      view.mode = mode
    }
    view.ppu = clampPpu(view.ppu || fitPpu)
    return view.ppu
  }
  /** The whole strip for a row (or, without one, at the tips' column): left edge and width on screen. */
  const stripOf = (layout, t, item = null) => {
    const ppu = current()
    const column = toScreen(t, item ? alignXOf(layout, item) : layout.alignX, item ? item.y : 0)[0]
    const width = total * ppu
    return { left: sideOf(layout, item).flipHorizontal ? column - PAD - width : column + PAD, width, ppu }
  }
  /** What of a strip is on screen: the box the painters clip to, the track window `v` and pixels a unit. */
  const visibleOf = (strip, screenWidth) => {
    const left = Math.max(strip.left, -2), right = Math.min(strip.left + strip.width, screenWidth + 2)
    if (right <= left) return null
    return { box: { left, width: right - left }, v: { c0: (left - strip.left) / strip.ppu, c1: (right - strip.left) / strip.ppu }, px: strip.ppu }
  }

  /** A run's screen span, clipped to the strip; null if off it. */
  const spanOf = (run, box, v, px) => {
    const x0 = box.left + (run.d0 - v.c0) * px, x1 = box.left + (run.d1 - v.c0) * px
    if (x1 < box.left || x0 > box.left + box.width) return null
    return { x0, x1, cx0: Math.max(box.left, x0), cx1: Math.min(box.left + box.width, x1) }
  }

  function chevrons(ctx, x0, x1, sy, skip) {
    if (x1 - x0 < 16) return
    ctx.strokeStyle = colours.intron
    ctx.lineWidth = 1.2
    const size = 3
    for (let x = x0 + (((x1 - x0) % CHEVRON_GAP_PX) / 2 || CHEVRON_GAP_PX / 2); x < x1 - 4; x += CHEVRON_GAP_PX) {
      if (skip && x > skip[0] - 6 && x < skip[1] + 6) continue
      ctx.beginPath()
      ctx.moveTo(x - size, sy - size); ctx.lineTo(x, sy); ctx.lineTo(x - size, sy + size)
      ctx.stroke()
    }
  }

  /** An intron left out: its line, and "5,432 bp" on it where that fits and matters. */
  function paintCut(ctx, span, sy, run, pitch, bg) {
    ctx.fillStyle = colours.intron
    ctx.fillRect(span.cx0, sy - 1, span.cx1 - span.cx0, 2)
    const cut = run.cut
    const width = run.d1 - run.d0
    // Long introns, and short ones stretched to share a longer one's room, say how long they
    // are — and every one does between bases, where none is drawn to scale.
    const say = mode === 'sequence' || cut.bp >= INTRON_CAP_BP || width > cut.removed * 1.25 + 2
    const text = `${cut.bp.toLocaleString()} bp`
    ctx.font = sansFont(10, 600)
    const tw = ctx.measureText(text).width
    const room = span.cx1 - span.cx0
    // Centred on the intron, or on what shows of it when its middle is off the strip.
    const whole = (span.x0 + span.x1) / 2
    const mid = whole - tw / 2 - 4 >= span.cx0 && whole + tw / 2 + 4 <= span.cx1 ? whole : (span.cx0 + span.cx1) / 2
    if (say && pitch >= 16 && room >= tw + 14) {
      ctx.fillStyle = bg
      ctx.fillRect(mid - tw / 2 - 4, sy - 7, tw + 8, 14)
      ctx.fillStyle = colours.label
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, mid, sy + 0.5)
      chevrons(ctx, span.cx0, span.cx1, sy, [mid - tw / 2 - 4, mid + tw / 2 + 4])
      return
    }
    // No room to say it: a break mark on a line drawn shorter than its intron, where there
    // is room for that (far out, every exon's would run together).
    if (cut.removed > width && room >= BREAK_ROOM_PX) {
      ctx.fillStyle = bg
      ctx.fillRect(mid - 3, sy - 5, 6, 10)
      ctx.strokeStyle = colours.intron
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(mid - 4, sy + 4); ctx.lineTo(mid - 1, sy - 4)
      ctx.moveTo(mid + 1, sy + 4); ctx.lineTo(mid + 4, sy - 4)
      ctx.stroke()
      chevrons(ctx, span.cx0, span.cx1, sy, [mid - 4, mid + 4])
      return
    }
    chevrons(ctx, span.cx0, span.cx1, sy)
  }

  /** The lines between and beside the exons: introns, flanks, gaps and left-out introns. */
  function paintLines(ctx, box, sy, runs, v, px, pitch, bg, onlySites = false) {
    for (const run of runs) {
      if (onlySites && run.site === undefined) continue
      if (EXONIC(run.kind)) continue
      const span = spanOf(run, box, v, px)
      if (!span) continue
      if (run.kind === 'cut') { paintCut(ctx, span, sy, run, pitch, bg); continue }
      if (run.kind === 'intron') {
        ctx.fillStyle = colours.intron
        ctx.fillRect(span.cx0, sy - 1, span.cx1 - span.cx0, 2)
        chevrons(ctx, span.cx0, span.cx1, sy)
      } else if (run.kind === 'flank') {
        // As the browser trails a gene's extent beyond a transcript: dotted.
        ctx.save()
        ctx.strokeStyle = colours.exon
        ctx.globalAlpha *= 0.65
        ctx.lineWidth = 1
        ctx.setLineDash([2, 3])
        ctx.beginPath(); ctx.moveTo(span.cx0, sy + 0.5); ctx.lineTo(span.cx1, sy + 0.5); ctx.stroke()
        ctx.restore()
      }
    }
  }

  /**
   * Exon boxes as the browser draws them: one height, coding filled, non-coding outlined.
   * Where the row has a gap inside an exon (sequence other rows have) the box carries on
   * as a dashed outline, so it still reads as the one exon with bases missing.
   */
  function paintExons(ctx, box, sy, h, runs, v, px, bg, lit, row) {
    const stroke = h >= 8 ? 1.5 : 1
    const top = sy - h / 2
    const gapIn = (i, exon) => runs[i]?.kind === 'gap' && runs[i].exon === exon
    for (const run of runs) {
      if (run.kind !== 'gap' || run.exon < 0) continue
      const span = spanOf(run, box, v, px)
      if (!span || span.cx1 - span.cx0 < 1) continue
      ctx.save()
      ctx.strokeStyle = lit?.whole?.has(run.exon) ? colours.highlight : colours.exon
      ctx.globalAlpha *= 0.8
      ctx.lineWidth = 1
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      ctx.moveTo(span.cx0, top + 0.5); ctx.lineTo(span.cx1, top + 0.5)
      ctx.moveTo(span.cx0, top + h - 0.5); ctx.lineTo(span.cx1, top + h - 0.5)
      ctx.stroke()
      ctx.restore()
    }
    runs.forEach((run, i) => {
      if (!EXONIC(run.kind)) return
      const span = spanOf(run, box, v, px)
      if (!span) return
      const w = span.cx1 - span.cx0
      const whole = lit?.whole?.has(run.exon)
      const colour = whole ? colours.highlight : colours.exon
      if (heat) {
        // Filled by conservation, coding and non-coding alike (non-coding a little lighter);
        // only a hovered exon keeps an outline.
        ctx.save()
        if (run.kind !== 'cds') ctx.globalAlpha *= 0.6
        fillHeat(ctx, row, span.cx0, Math.max(span.cx1, span.cx0 + 0.75), top, h, v, box, px, colours.gap)
        ctx.restore()
        if (whole) {
          ctx.strokeStyle = colours.highlight
          ctx.lineWidth = stroke + 0.8
          ctx.strokeRect(span.cx0 + 0.9, top + 0.9, Math.max(0, w - 1.8), h - 1.8)
        }
        return
      }
      if (w < 3) {
        ctx.fillStyle = colour
        ctx.globalAlpha *= run.kind === 'cds' ? 1 : 0.6
        ctx.fillRect(span.cx0, top, Math.max(0.75, w), h)
        ctx.globalAlpha /= run.kind === 'cds' ? 1 : 0.6
        return
      }
      ctx.fillStyle = run.kind === 'cds' ? colours.exon : bg
      ctx.fillRect(span.cx0, top, w, h)
      if (whole) {
        ctx.save()
        ctx.globalAlpha *= 0.22
        ctx.fillStyle = colours.highlight
        ctx.fillRect(span.cx0, top, w, h)
        ctx.restore()
      }
      ctx.strokeStyle = colour
      ctx.lineWidth = whole ? stroke + 0.8 : stroke
      // Only the edges the run really has: none where the strip's edge cuts it off, nor
      // where it carries on into a gap in the same exon.
      const inset = ctx.lineWidth / 2
      ctx.beginPath()
      ctx.moveTo(span.cx0, top + inset); ctx.lineTo(span.cx1, top + inset)
      ctx.moveTo(span.cx0, top + h - inset); ctx.lineTo(span.cx1, top + h - inset)
      if (span.x0 >= box.left && !gapIn(i - 1, run.exon)) { ctx.moveTo(span.x0 + inset, top); ctx.lineTo(span.x0 + inset, top + h) }
      if (span.x1 <= box.left + box.width && !gapIn(i + 1, run.exon)) { ctx.moveTo(span.x1 - inset, top); ctx.lineTo(span.x1 - inset, top + h) }
      ctx.stroke()
    })
  }

  /** Marks on exon edges: splice boundaries other rows share, and those of a hovered exon. */
  function paintBoundaries(ctx, box, sy, h, row, v, px, lit, rowsTotal) {
    const { exons } = infoOf(row)
    const shared = boundaries ? sharesOf(row) : null
    const edge = (col, side) => box.left + (track.dispOf(col) + (side === 'end' ? 1 : 0) - v.c0) * px
    for (const e of exons) {
      const narrow = (track.dispOf(e.end) + 1 - track.dispOf(e.start)) * px < BOUNDARY_ROOM_PX
      for (const side of ['start', 'end']) {
        if (narrow && !lit?.edges?.get(e.index)?.[side]) continue
        const x = edge(side === 'start' ? e.start : e.end, side)
        if (x < box.left - 1 || x > box.left + box.width + 1) continue
        const litEdge = lit?.edges?.get(e.index)?.[side]
        const count = shared?.[side]?.[e.index] || 0
        if (!litEdge && !count) continue
        const weight = litEdge ? 1 : Math.min(1, count / Math.max(1, rowsTotal - 1))
        ctx.strokeStyle = litEdge ? colours.highlight : `rgba(${colours.boundary},${0.45 + weight * 0.4})`
        ctx.lineWidth = litEdge ? 1.6 : 1 + weight * 0.7
        ctx.beginPath(); ctx.moveTo(x, sy - h / 2 - 1.5); ctx.lineTo(x, sy + h / 2 + 1.5); ctx.stroke()
      }
    }
  }

  /**
   * A row's bases as the MSA view draws them: a cell per column on its feature's colour
   * and the base on it, a gap a red "-". Without room for letters, the cells alone; with
   * less than a pixel and a half a column, each pixel its columns' commonest colour, a
   * gap a red bar (the MSA view's block view). The introns left out go between.
   */
  function paintBases(ctx, box, sy, pitch, row, v, px, bg) {
    const { classes: cls, first, last, runs } = infoOf(row)
    const shade = stripesAll()
    const seq = row.aligned || ''
    const h = Math.max(2, Math.min(pitch - 4, CELL_H))
    const top = sy - h / 2
    // Conservation: a base's own column once letters are written, else its stretch.
    const least = px >= LETTER_PX ? 1 : smoothCols(px)
    const colourOf = heat ? c => heatAt(row, c, c + 1, least) || MSA_FLANK : c => cellColour(cls[c], shade[c])
    // Conservation's red is its top: a gap there is a quiet grey, not the MSA view's red.
    const gapColour = heat ? colours.gap : MSA_GAP
    const gapBar = (x, w) => {
      ctx.fillStyle = gapColour
      ctx.fillRect(x, sy - 1, w, 2)
    }
    if (px >= CELL_PX) {
      const letters = px >= LETTER_PX && h >= 10
      if (letters) {
        ctx.font = monoFont(12)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
      }
      const from = Math.max(first, Math.floor(track.toCol(v.c0))), to = Math.min(last, Math.ceil(track.toCol(v.c1)))
      for (let c = from; c <= to; c++) {
        const x = box.left + (track.dispOf(c) - v.c0) * px
        if (x + px < box.left || x > box.left + box.width) continue
        const base = seq[c]
        if (base === '-') {
          if (letters) {
            ctx.fillStyle = gapColour
            ctx.fillText('-', x + px / 2, sy)
          } else gapBar(x, px)
          continue
        }
        const fill = colourOf(c)
        ctx.globalAlpha = differences && base === consensus[c] ? 0.28 : 1
        ctx.fillStyle = fill
        ctx.fillRect(x, top, px, h)
        if (letters) {
          ctx.fillStyle = letterColour(fill)
          ctx.fillText(base, x + px / 2, sy)
        }
        ctx.globalAlpha = 1
      }
    } else {
      // Far out: each pixel its columns' commonest colour, runs of one colour drawn once.
      const x0 = Math.max(box.left, Math.floor(box.left + (track.dispOf(first) - v.c0) * px))
      const x1 = Math.min(box.left + box.width, Math.ceil(box.left + (track.dispOf(last) + 1 - v.c0) * px))
      let runStart = x0, runColour = null
      const flush = x => {
        if (runColour && x > runStart) {
          if (runColour === 'gap') gapBar(runStart, x - runStart)
          else {
            // "Differences only": a stretch that agrees with the consensus throughout fades.
            const [fill, same] = runColour.split('|')
            ctx.globalAlpha = same ? 0.28 : 1
            ctx.fillStyle = fill
            ctx.fillRect(runStart, top, x - runStart, h)
            ctx.globalAlpha = 1
          }
        }
      }
      for (let x = x0; x < x1; x++) {
        const d0 = v.c0 + (x - box.left) / px, d1 = v.c0 + (x + 1 - box.left) / px
        const a = Math.max(first, Math.ceil(track.toCol(d0) - 1e-9)), b = Math.min(last + 1, Math.ceil(track.toCol(d1) - 1e-9))
        let colour = null
        if (b > a && heat) {
          // Conservation: the pixel's columns' agreement, unless this row is mostly gap there.
          let gaps = 0, n = 0
          const step = Math.max(1, Math.floor((b - a) / 12))
          for (let c = a; c < b; c += step) { n++; if (seq.charCodeAt(c) === 45) gaps++ }
          colour = gaps * 2 > n ? 'gap' : heatAt(row, a, b, least) || MSA_FLANK
          if (differences && colour !== 'gap') {
            let same = true
            for (let c = a; c < b && same; c++) same = seq[c] === consensus[c]
            if (same) colour += '|same'
          }
        } else if (b > a) {
          const counts = new Map()
          const step = Math.max(1, Math.floor((b - a) / 12))
          const wholeCodons = b - a >= 3
          for (let c = a; c < b; c += step) {
            const coding = cls[c] === CDS || cls[c] === START || cls[c] === STOP
            const key = seq.charCodeAt(c) === 45 ? 'gap' : wholeCodons && coding ? CDS_BLEND : colourOf(c)
            counts.set(key, (counts.get(key) || 0) + 1)
          }
          let best = 0
          for (const [key, n] of counts) if (n > best) { best = n; colour = key }
          if (differences && colour && colour !== 'gap') {
            let same = true
            for (let c = a; c < b && same; c++) same = seq[c] === consensus[c]
            if (same) colour += '|same'
          }
        }
        if (colour !== runColour) { flush(x); runStart = x; runColour = colour }
      }
      flush(x1)
    }
    // The introns left out, between the bases.
    paintLines(ctx, box, sy, runs, v, px, pitch, bg, true)
  }

  /** What a hover lights: the hovered exon whole, and edges (or wholes) sharing its boundaries. */
  function litFor(hover, row, leafId, rowOf) {
    if (hover?.kind !== 'exon') return null
    const hoveredRow = rowOf(hover.leaf)
    const whole = new Set()
    const edges = new Map()
    for (const e of infoOf(row).exons) {
      if (row === hoveredRow && e.index === hover.exon) { whole.add(e.index); continue }
      const start = Math.abs(e.start - hover.start) <= BOUNDARY_TOLERANCE
      const end = Math.abs(e.end - hover.end) <= BOUNDARY_TOLERANCE
      if (start && end) whole.add(e.index)
      else if (start || end) edges.set(e.index, { start, end })
    }
    return whole.size || edges.size ? { whole, edges } : null
  }

  return {
    kind: 'alignment',
    mode,
    get view() { return current() },
    paint(ctx, env) {
      const { layout, t, hidden, folded, height, anyPicked, isPicked, isFocus, palette, shown: inPass = null } = env
      const bg = palette?.bg || (isLight ? '#f6f8fb' : '#152032')
      const pitch = layout.pitch * t.k
      const h = Math.max(3, Math.min(EXON_H, pitch * 0.5))
      if (length) current()
      const hover = parseHover(env.hover)
      // Where along the alignment the middle of the screen is, for the next column drawn
      // (after a switch, the plane is moved so that place is back under it: `takePan`).
      if (length && layout.alignX !== undefined && !env.lifted) {
        const strip = stripOf(layout, t)
        if (view.pendingAnchor) {
          const x = strip.left + track.fromCol(view.pendingAnchor.col) * strip.ppu
          view.pendingPan = view.pendingAnchor.sx - x
          view.pendingAnchor = null
        } else if (!view.pendingPan) {
          const shown = visibleOf(strip, env.width)
          if (shown) {
            const sx = shown.box.left + shown.box.width / 2
            view.anchor = { col: track.toCol((sx - strip.left) / strip.ppu), sx }
          }
        }
      }
      const rows = []
      for (const item of layout.items) {
        if (item.kind !== 'leaf' || hidden?.has(item.id) || folded?.has(item.id) || (inPass && !inPass(item.id))) continue
        const sy = toScreen(t, 0, item.y)[1]
        if (sy < -20 || sy > height + 20) continue
        rows.push({ item, sy, row: data?.rows?.get(item.id) || null })
      }
      const rowOf = leafId => data?.rows?.get(leafId) || null
      ctx.save()
      for (const { item, sy, row } of rows) {
        const shown = length ? visibleOf(stripOf(layout, t, item), env.width) : null
        const box = shown?.box || stripBox(layout, t, item, widthPx)
        const v = shown?.v || null
        const px = shown?.px || 0
        if (length && !shown) continue
        ctx.globalAlpha = anyPicked && !isPicked(item.id) ? DIM_ALPHA : 1
        if (isFocus(item.id)) {
          ctx.fillStyle = colours.focusBand
          ctx.fillRect(box.left - 4, sy - pitch / 2 + 1, box.width + 8, pitch - 2)
        }
        if (row && v) {
          const alpha = ctx.globalAlpha
          ctx.save()
          ctx.beginPath(); ctx.rect(box.left - 2, sy - pitch / 2, box.width + 4, pitch); ctx.clip()
          if (mode === 'sequence') paintBases(ctx, box, sy, pitch, row, v, px, bg)
          else {
            const { runs } = infoOf(row)
            const lit = litFor(hover, row, item.id, rowOf)
            paintLines(ctx, box, sy, runs, v, px, pitch, bg)
            paintExons(ctx, box, sy, h, runs, v, px, bg, lit, row)
            if (h >= 6) paintBoundaries(ctx, box, sy, h, row, v, px, lit, distinctRows.length)
          }
          ctx.restore()
          ctx.globalAlpha = alpha
          if (anyPicked && isPicked(item.id)) {
            ctx.strokeStyle = PICKED
            ctx.lineWidth = 1
            ctx.strokeRect(box.left - 2.5, sy - h / 2 - 2.5, box.width + 5, h + 5)
          }
        } else if (pending?.has(item.id)) {
          ctx.save()
          ctx.setLineDash([3, 4])
          ctx.strokeStyle = colours.gap
          ctx.beginPath(); ctx.moveTo(box.left, sy); ctx.lineTo(box.left + box.width, sy); ctx.stroke()
          ctx.restore()
        } else if (failed?.has(item.id) && pitch >= 14) {
          ctx.font = sansFont(10, 500)
          ctx.textBaseline = 'middle'
          ctx.textAlign = 'left'
          ctx.fillStyle = colours.intron
          ctx.fillText('—', box.left + 2, sy)
        }
      }
      ctx.globalAlpha = 1
      // Guides down every row: a hovered exon's two edges, or the hovered column.
      const guideStrip = length && rows.length ? stripOf(layout, t, rows[0].item) : null
      const guideShown = guideStrip ? visibleOf(guideStrip, env.width) : null
      if (guideShown && hover) {
        const { box, v, px } = guideShown
        const guides = hover.kind === 'exon' && mode !== 'sequence'
          ? [track.dispOf(hover.start), track.dispOf(hover.end) + 1]
          : hover.kind === 'exon' || hover.kind === 'column' ? [track.dispOf(hover.col) + 0.5] : []
        ctx.strokeStyle = hover.kind === 'exon' && mode !== 'sequence' ? colours.highlight : colours.guide
        ctx.lineWidth = 1
        ctx.setLineDash(hover.kind === 'exon' && mode !== 'sequence' ? [3, 3] : [])
        ctx.globalAlpha = hover.kind === 'exon' && mode !== 'sequence' ? 0.55 : 1
        for (const d of guides) {
          const x = box.left + (d - v.c0) * px
          if (x < box.left || x > box.left + box.width) continue
          ctx.beginPath(); ctx.moveTo(x, rows[0].sy - pitch); ctx.lineTo(x, rows[rows.length - 1].sy + pitch); ctx.stroke()
        }
        ctx.setLineDash([])
        ctx.globalAlpha = 1
      }
      ctx.restore()
    },
    leaderEnd(layout, t, item) {
      return length ? stripOf(layout, t, item).left : stripBox(layout, t, item, widthPx).left
    },
    /** How well the genes agree over alignment columns [a, b) (0..1), or null where none compare. */
    agreement(a, b) { return length ? consOf().identity(a, b) : null },
    /** A row's base at column `c`: how many genes share it, of how many with a base there; or null. */
    baseShare(row, c) { return length && row ? consOf().baseAt(row, c) : null },
    /** A row's mean base share over columns [a, b) (0..1), or null. */
    rowShare(row, a, b) { return length && row ? consOf().rowShare(row, a, b) : null },
    /** The conservation colours, while they are shown; else null. */
    get conservation() { return heat && length ? { ramp: HEAT_RAMP } : null },
    /** How far labels sit past the tips: the whole strip as it is stretched now. */
    labelOffset() {
      return length ? total * current() + PAD * 2 : widthPx
    },
    /** A pan of the plane the column wants (to keep its place across a switch), once. */
    takePan() {
      const dx = view.pendingPan || 0
      view.pendingPan = 0
      return dx
    },
    // `inPass`: the rows this column draws (a subtree layer's subtrees can each show their own view).
    hit(layout, t, sx, sy, plan, inPass = null) {
      if (!length || layout.alignX === undefined) return null
      const pitch = layout.pitch * t.k
      const hidden = plan?.folds?.hidden, folded = plan?.folds?.folded
      for (const item of layout.items) {
        if (item.kind !== 'leaf' || hidden?.has(item.id) || folded?.has(item.id) || (inPass && !inPass(item.id))) continue
        const iy = toScreen(t, 0, item.y)[1]
        if (Math.abs(iy - sy) > Math.max(4, pitch / 2)) continue
        const row = data.rows.get(item.id)
        if (!row) return null
        const strip = stripOf(layout, t, item)
        if (sx < strip.left || sx > strip.left + strip.width) return null
        const d = (sx - strip.left) / strip.ppu
        const { runs, exons } = infoOf(row)
        const run = runs.find(r => r.d0 <= d && d < r.d1) || null
        const at = track.locate(d)
        const base = { item, part: 'alignment', row, run, exonCount: exons.length }
        if (at.site >= 0) {
          return run?.cut ? { ...base, column: null, cut: run.cut, hoverKey: `s:${item.id}:${at.site}` } : null
        }
        const exon = run && (EXONIC(run.kind) || run.kind === 'gap') ? exons[run.exon] : null
        if (exon) {
          const shared = sharesOf(row)
          return { ...base, column: at.col, exon, rows: distinctRows.length,
            shared: { start: shared.start[exon.index], end: shared.end[exon.index] },
            hoverKey: `e:${item.id}:${exon.index}:${exon.start}:${exon.end}:${at.col}` }
        }
        return { ...base, column: at.col, hoverKey: `c:${item.id}:${at.col}` }
      }
      return null
    },
    // Over the strip the scheme's zoom stretches it about the cursor (the plane moving so the
    // base under the cursor stays put). Zooming in, it stops at its end; zooming out past the
    // whole alignment, the gesture is handed on to the tree (null), so zooming out over the
    // data keeps zooming out. Everything else — panning either way, zooming off the strip —
    // is the tree's. Returns null when not the column's gesture, else `{panX}`: how far to
    // move the plane.
    wheel(env, intent, wheel, sx, sy) {
      if (!total || intent.type !== 'zoom' || env.layout.alignX === undefined) return null
      // The strip of the row under the pointer (in a layer each subtree's starts at its own
      // tips), among the rows this column draws (`env.shown`); none near, not the column's.
      const row = rowNear(env.layout, env.t, sy, env.shown, env.plan)
      if (env.shown && !row) return null
      const strip = stripOf(env.layout, env.t, row)
      if (sx < strip.left || sx > strip.left + strip.width || sy < (env.insetTop || 0)) return null
      const shown = visibleOf(strip, env.width)
      const x = intent.anchor === 'center' && shown ? shown.box.left + shown.box.width / 2 : sx
      const unit = (x - strip.left) / strip.ppu
      const ppu = clampPpu(strip.ppu / intent.factor)
      if (Math.abs(ppu - strip.ppu) < 1e-9) return intent.factor > 1 ? null : { panX: 0 }  // out: the tree's; in: nothing more
      view.ppu = ppu
      const width = total * ppu
      // The plane moves so that `unit` stays under the cursor.
      const panX = sideOf(env.layout, row).flipHorizontal
        ? (x - unit * ppu + PAD + width) - (strip.left + PAD + strip.width)
        : (x - unit * ppu) - strip.left
      return { panX }
    },
  }
}

/** Seen from a hover: the genomic position of alignment column `column` in a row, or null (a gap). */
export function genomicAt(row, column) {
  const seq = row?.aligned || ''
  if (column == null || column < 0 || column >= seq.length || seq[column] === '-') return null
  let index = 0
  for (let c = 0; c < column; c++) if (seq.charCodeAt(c) !== 45) index++
  const region = row.region
  if (!region) return null
  for (const seg of region.segments) {
    if (index >= seg.offset && index < seg.offset + seg.length) {
      const step = index - seg.offset
      return { chrom: row.chrom, position: region.strand === '-' ? seg.end - step : seg.start + step, kind: seg.kind, base: seq[column] }
    }
  }
  return null
}

/** The features covering an alignment column in a row, most specific last. */
export function featuresAt(row, column) {
  return (row?.features || []).filter(f => f.type !== 'intron_cut' && f.start <= column && column <= f.end)
}

