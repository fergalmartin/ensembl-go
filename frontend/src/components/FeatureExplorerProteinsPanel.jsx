import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE } from '../backendRuntime'

const AA_CELL_WIDTH = 14          // px per amino acid cell
const MIN_AAS_PER_WINDOW = 40
const MAX_AAS_PER_WINDOW = 260
const ROW_HEIGHT_PX = 42
const ROW_LEAD_INSET_PX = 30 // copy button (24) + gap (6)
const MENU_EXPANDED_WIDTH = 280
const MENU_COLLAPSED_WIDTH = 36

// ClustalX-inspired amino acid color scheme grouped by chemical property
const AA_COLORS = {
  // Hydrophobic — blue
  A: '#80a0f0', V: '#80a0f0', I: '#80a0f0', L: '#80a0f0',
  M: '#80a0f0', F: '#80a0f0', W: '#80a0f0',
  // Proline — yellow-green (structural)
  P: '#c0c000',
  // Glycine — orange (tiny / flexible)
  G: '#f09048',
  // Cysteine — yellow (unique chemistry)
  C: '#f0c000',
  // Polar uncharged — green
  S: '#20c020', T: '#20c020', N: '#20c020', Q: '#20c020',
  // Tyrosine — teal (aromatic + polar)
  Y: '#15c4c4',
  // Histidine — cyan
  H: '#15a4a4',
  // Positively charged — red
  K: '#f01505', R: '#f01505',
  // Negatively charged — magenta
  D: '#c048c8', E: '#c048c8',
  // Stop codon
  '*': '#404040',
  // Unknown / gap
  X: '#909090',
}
const DEFAULT_AA_COLOR = '#606060'

function aaColor(residue) {
  return AA_COLORS[String(residue || '').toUpperCase()] || DEFAULT_AA_COLOR
}

function hexLuminance(hexColor) {
  const hex = String(hexColor || '').replace('#', '')
  if (hex.length !== 6) return 0
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function displayId(rawId) {
  const text = String(rawId || '')
  if (text.length <= 26) return text
  return `${text.slice(0, 23)}...`
}

// ── Protein property computation ──────────────────────────────────────────────

// Average amino acid molecular weights (monoisotopic, Da)
const AA_MW = {
  A: 71.03711, R: 156.10111, N: 114.04293, D: 115.02694, C: 103.00919,
  E: 129.04259, Q: 128.05858, G: 57.02146, H: 137.05891, I: 113.08406,
  L: 113.08406, K: 128.09496, M: 131.04049, F: 147.06841, P: 97.05276,
  S: 87.03203, T: 101.04768, W: 186.07931, Y: 163.06333, V: 99.06841,
}
const WATER_MW = 18.01056

// Kyte-Doolittle hydropathy values
const KD_HYDROPATHY = {
  A: 1.8, R: -4.5, N: -3.5, D: -3.5, C: 2.5, E: -3.5, Q: -3.5,
  G: -0.4, H: -3.2, I: 4.5, L: 3.8, K: -3.9, M: 1.9, F: 2.8,
  P: -1.6, S: -0.8, T: -0.7, W: -0.9, Y: -1.3, V: 4.2,
}

// Guruprasad instability dipeptide weights (DIWV table, 1990)
const DIWV = {
  WW: 1, WC: 1, WM: 24.68, WH: 24.68, WY: 1, WF: 1, WQ: 1, WN: 13.34, WE: 1, WD: -14.03,
  WK: 1, WR: 1, WS: 1, WT: -14.03, WG: -9.37, WA: -14.03, WV: -7.49, WI: 1, WL: 13.34, WP: 1,
  CW: 24.68, CC: 1, CM: 33.6, CH: 33.6, CY: 1, CF: 1, CQ: -6.54, CN: 1, CE: 1, CD: 20.26,
  CK: 1, CR: 1, CS: 1, CT: 33.6, CG: 1, CA: 1, CV: -6.54, CI: 1, CL: 20.26, CP: 20.26,
  MW: 1, MC: -1.88, MM: -1.88, MH: 58.28, MY: 24.68, MF: 1, MQ: -6.54, MN: 1, ME: 1, MD: 1,
  MK: 1, MR: -6.54, MS: 44.94, MT: -1.88, MG: 1, MA: 13.34, MV: 1, MI: 1, ML: 1, MP: 44.94,
  HW: -1.88, HC: 1, HM: 1, HH: 1, HY: 44.94, HF: -9.37, HQ: 1, HN: 24.68, HE: 1, HD: 1,
  HK: 24.68, HR: 1, HS: 1, HT: -6.54, HG: -9.37, HA: 1, HV: -6.54, HI: 44.94, HL: 1, HP: -1.88,
  YW: -9.37, YC: 1, YM: 44.94, YH: 13.34, YY: 13.34, YF: 1, YQ: 1, YN: 1, YE: -6.54, YD: 24.68,
  YK: 1, YR: -15.91, YS: 1, YT: -7.49, YG: -7.49, YA: 24.68, YV: 1, YI: 1, YL: 1, YP: 13.34,
  FW: 1, FC: 1, FM: 1, FH: 1, FY: 33.6, FF: 1, FQ: 1, FN: 1, FE: 1, FD: 13.34,
  FK: -14.03, FR: 1, FS: 1, FT: 1, FG: 1, FA: 1, FV: 1, FI: 1, FL: 1, FP: 20.26,
  QW: 1, QC: -6.54, QM: 1, QH: 1, QY: -6.54, QF: -6.54, QQ: 20.26, QN: 1, QE: 20.26, QD: 20.26,
  QK: 1, QR: 1, QS: 44.94, QT: 1, QG: 1, QA: 1, QV: -6.54, QI: 1, QL: 1, QP: 20.26,
  NW: -9.37, NC: -1.88, NM: 1, NH: 1, NY: 1, NF: -14.03, NQ: -6.54, NN: 1, NE: 1, ND: 1,
  NK: 24.68, NR: 1, NS: 1, NT: -7.49, NG: -14.03, NA: 1, NV: 1, NI: 44.94, NL: 1, NP: -1.88,
  EW: -14.03, EC: 44.94, EM: 1, EH: -6.54, EY: 1, EF: 1, EQ: 20.26, EN: 1, EE: 33.6, ED: 20.26,
  EK: 1, ER: 1, ES: 20.26, ET: 1, EG: 1, EA: -7.49, EV: 1, EI: 20.26, EL: 1, EP: 20.26,
  DW: 1, DC: 1, DM: 1, DH: 1, DY: 1, DF: -6.54, DQ: 1, DN: 1, DE: 1, DD: 1,
  DK: -7.49, DR: -6.54, DS: 20.26, DT: -14.03, DG: 1, DA: 1, DV: 1, DI: 1, DL: 1, DP: 1,
  KW: 1, KC: 1, KM: 33.6, KH: 1, KY: 1, KF: 1, KQ: 24.68, KN: 1, KE: -7.49, KD: 1,
  KK: 1, KR: 33.6, KS: 1, KT: 1, KG: -7.49, KA: 1, KV: -7.49, KI: -7.49, KL: -7.49, KP: -7.49,
  RW: 58.28, RC: 1, RM: 1, RH: 20.26, RY: -6.54, RF: 1, RQ: 20.26, RN: 13.34, RE: 1, RD: 1,
  RK: 1, RR: 58.28, RS: 44.94, RT: 1, RG: -7.49, RA: 1, RV: 1, RI: 1, RL: 1, RP: 20.26,
  SW: 1, SC: 33.6, SM: 1, SH: 1, SY: 1, SF: 1, SQ: 20.26, SN: 1, SE: 20.26, SD: 1,
  SK: 1, SR: 20.26, SS: 20.26, ST: 1, SG: 1, SA: 1, SV: 1, SI: 1, SL: 1, SP: 44.94,
  TW: -14.03, TC: 1, TM: 1, TH: 1, TY: 1, TF: 13.34, TQ: -6.54, TN: -14.03, TE: 20.26, TD: 1,
  TK: 1, TR: 1, TS: 1, TT: 1, TG: -7.49, TA: 1, TV: 1, TI: 1, TL: 1, TP: 1,
  GW: 13.34, GC: 1, GM: 1, GH: 1, GY: -7.49, GF: 1, GQ: 1, GN: -7.49, GE: -6.54, GD: 1,
  GK: -7.49, GR: 1, GS: 1, GT: -7.49, GG: 13.34, GA: -7.49, GV: 1, GI: -7.49, GL: 1, GP: 1,
  AW: 1, AC: 44.94, AM: 1, AH: -7.49, AY: 1, AF: 1, AQ: 1, AN: 1, AE: 1, AD: -7.49,
  AK: 1, AR: 1, AS: 1, AT: 1, AG: 1, AA: 1, AV: 1, AI: 1, AL: 1, AP: 20.26,
  VW: 1, VC: 1, VM: 1, VH: 1, VY: -6.54, VF: 1, VQ: 1, VN: 1, VE: 1, VD: -14.03,
  VK: -1.88, VR: 1, VS: 1, VT: -7.49, VG: -7.49, VA: 1, VV: 1, VI: 1, VL: 1, VP: 20.26,
  IW: 1, IC: 1, IM: 1, IH: 13.34, IY: 1, IF: 1, IQ: 1, IN: 1, IE: 44.94, ID: 1,
  IK: -7.49, IR: 1, IS: 1, IT: 1, IG: 1, IA: 1, IV: -7.49, II: 1, IL: 20.26, IP: -1.88,
  LW: 24.68, LC: 1, LM: 1, LH: 1, LY: 1, LF: 1, LQ: 33.6, LN: 1, LE: 1, LD: 1,
  LK: -7.49, LR: 1, LS: 1, LT: 1, LG: 1, LA: 1, LV: 1, LI: 1, LL: 1, LP: 20.26,
  PW: -1.88, PC: 1, PM: -6.54, PH: 1, PY: 1, PF: 20.26, PQ: 20.26, PN: 1, PE: 18.38, PD: -6.54,
  PK: 1, PR: -6.54, PS: 20.26, PT: 1, PG: 1, PA: 20.26, PV: 20.26, PI: 1, PL: 1, PP: 20.26,
}

// pKa values for isoelectric point calculation (IPC2 protein scale)
const PK_CTERM = 2.383
const PK_NTERM = 9.562
const PK_SIDE = { C: 8.297, D: 3.887, E: 4.317, H: 6.018, K: 10.745, R: 12.503, Y: 10.071 }

function computeProteinMW(seq) {
  let mw = 0
  for (const ch of seq) {
    mw += AA_MW[ch] || 0
  }
  return mw > 0 ? mw - (seq.length - 1) * WATER_MW : 0
}

function computeGRAVY(seq) {
  if (!seq.length) return 0
  let sum = 0
  for (const ch of seq) sum += KD_HYDROPATHY[ch] || 0
  return sum / seq.length
}

function computeInstabilityIndex(seq) {
  if (seq.length < 2) return 0
  let sum = 0
  for (let i = 0; i < seq.length - 1; i++) {
    const key = seq[i] + seq[i + 1]
    sum += DIWV[key] || 0
  }
  return (10.0 / seq.length) * sum
}

function computeAromaticity(seq) {
  if (!seq.length) return 0
  let count = 0
  for (const ch of seq) {
    if (ch === 'F' || ch === 'W' || ch === 'Y') count++
  }
  return count / seq.length
}

function computeExtinctionCoeff(seq) {
  // Assumes all cysteines are reduced (no disulfide bonds)
  let nW = 0, nY = 0, nC = 0
  for (const ch of seq) {
    if (ch === 'W') nW++
    else if (ch === 'Y') nY++
    else if (ch === 'C') nC++
  }
  return nW * 5500 + nY * 1490 + nC * 125
}

function computePI(seq) {
  // Count charged residues
  const counts = {}
  for (const ch of seq) counts[ch] = (counts[ch] || 0) + 1

  function chargeAtPH(pH) {
    let charge = 0
    // N-terminus
    charge += 1.0 / (1.0 + Math.pow(10, pH - PK_NTERM))
    // C-terminus
    charge -= 1.0 / (1.0 + Math.pow(10, PK_CTERM - pH))
    // Side chains
    for (const [aa, pKa] of Object.entries(PK_SIDE)) {
      const n = counts[aa] || 0
      if (!n) continue
      if (aa === 'K' || aa === 'R' || aa === 'H') {
        charge += n / (1.0 + Math.pow(10, pH - pKa))
      } else {
        charge -= n / (1.0 + Math.pow(10, pKa - pH))
      }
    }
    return charge
  }

  let lo = 0, hi = 14
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (chargeAtPH(mid) > 0) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function computeAAComposition(seq) {
  const counts = {}
  const aas = 'ACDEFGHIKLMNPQRSTVWY'
  for (const ch of aas) counts[ch] = 0
  for (const ch of seq) {
    if (counts[ch] !== undefined) counts[ch]++
  }
  return counts
}

function formatNumber(n, decimals = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// ── Per-residue property track computations ───────────────────────────────────

const TRACK_HEIGHT = 9 // px per sub-track bar

// Disorder-promoting residues (Dunker / Uversky-style heuristic)
const DISORDER_PROMOTING = new Set('AQSGPEKRD'.split(''))

// Sliding-window Kyte-Doolittle hydropathy profile.
// Returns array matching seq length (values ≈ −4.5…+4.5).
function computeHydropathyProfile(seq, windowSize = 7) {
  const n = seq.length
  if (!n) return []
  const halfW = Math.floor(windowSize / 2)
  const values = new Array(n).fill(0)
  // prefix sum
  const prefix = new Array(n + 1).fill(0)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (KD_HYDROPATHY[seq[i]] || 0)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfW)
    const hi = Math.min(n, i + halfW + 1)
    values[i] = (prefix[hi] - prefix[lo]) / (hi - lo)
  }
  return values
}

// Sliding-window average formal charge profile:
// K,R=+1; H=+0.5; D,E=−1; others=0.
function computeChargeProfile(seq, windowSize = 9) {
  const n = seq.length
  if (!n) return []
  const halfW = Math.floor(windowSize / 2)
  const values = new Array(n).fill(0)
  const chargeAt = (ch) => {
    if (ch === 'K' || ch === 'R') return 1
    if (ch === 'H') return 0.5
    if (ch === 'D' || ch === 'E') return -1
    return 0
  }
  const prefix = new Array(n + 1).fill(0)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + chargeAt(seq[i])
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfW)
    const hi = Math.min(n, i + halfW + 1)
    values[i] = (prefix[hi] - prefix[lo]) / (hi - lo)
  }
  return values
}

// Sliding-window disorder propensity (fraction of disorder-promoting residues in window).
function computeDisorderProfile(seq, windowSize = 21) {
  const n = seq.length
  if (!n) return []
  const halfW = Math.floor(windowSize / 2)
  const values = new Array(n).fill(0)
  const prefix = new Array(n + 1).fill(0)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (DISORDER_PROMOTING.has(seq[i]) ? 1 : 0)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfW)
    const hi = Math.min(n, i + halfW + 1)
    values[i] = (prefix[hi] - prefix[lo]) / (hi - lo)
  }
  return values
}

/** Map a normalised value (−1..+1) to an rgb colour on a blue→grey→red gradient.
 *  Used for hydrophobicity and charge tracks. */
function divergingColor(value, negR, negG, negB, posR, posG, posB) {
  const t = clamp(value, -1, 1)
  if (t >= 0) {
    const r = Math.round(180 + t * (posR - 180))
    const g = Math.round(180 + t * (posG - 180))
    const b = Math.round(180 + t * (posB - 180))
    return `rgb(${r},${g},${b})`
  }
  const at = -t
  const r = Math.round(180 + at * (negR - 180))
  const g = Math.round(180 + at * (negG - 180))
  const b = Math.round(180 + at * (negB - 180))
  return `rgb(${r},${g},${b})`
}

function hydroColor(v) {
  // Normalise Kyte-Doolittle range (~-4.5..+4.5) to -1..+1.
  // hydrophilic (negative): blue/cyan, hydrophobic (positive): amber
  return divergingColor(v / 4.5, 37, 99, 235, 245, 158, 11)
}

function chargeColor(v) {
  // -1..+1 — negative=magenta/red, neutral=grey, positive=green
  return divergingColor(v, 220, 38, 127, 22, 163, 74)
}

function disorderColor(v) {
  // 0..1 — ordered=deep cool blue, disordered=warm red/orange
  const t = clamp(v, 0, 1)
  const r = Math.round(30 + t * (245 - 30))
  const g = Math.round(64 + t * (94 - 64))
  const b = Math.round(175 + t * (35 - 175))
  const a = (0.2 + (t * 0.75)).toFixed(2)
  return `rgba(${r},${g},${b},${a})`
}

// Exon track colour: single blue, boundaries are indicated by separator lines.
const EXON_PHASE_COLORS = [
  'rgba(96,165,250,0.72)',
]

// Returns per-residue exon index (0-based segment index) for exon-phase colouring.
// Also returns boundary positions (1-based AA indices where exon changes).
function computeExonPhaseInfo(cdsSegments, seqLen) {
  const exonIndex = new Array(seqLen).fill(0)
  const boundaries = []
  const boundaryFractions = []
  if (!cdsSegments?.length || seqLen === 0) return { exonIndex, boundaries, boundaryFractions }

  for (let segIdx = 0; segIdx < cdsSegments.length; segIdx++) {
    const seg = cdsSegments[segIdx]
    const coordStart = Number(seg?.coord_start || 0)
    const coordEnd = Number(seg?.coord_end || 0)
    if (!Number.isFinite(coordStart) || !Number.isFinite(coordEnd)) continue
    const firstNt = Math.min(coordStart, coordEnd)
    const lastNt = Math.max(coordStart, coordEnd)
    const firstAA = Math.floor((firstNt - 1) / 3) + 1
    const lastAA = Math.floor((lastNt - 1) / 3) + 1
    for (let aa = firstAA; aa <= Math.min(lastAA, seqLen); aa++) {
      exonIndex[aa - 1] = segIdx
    }
    if (segIdx < (cdsSegments.length - 1)) {
      boundaryFractions.push(lastNt / 3)
    }
  }

  // Detect boundaries: positions where exon index changes
  for (let i = 1; i < seqLen; i++) {
    if (exonIndex[i] !== exonIndex[i - 1]) {
      boundaries.push(i) // 0-based index where the new exon starts
    }
  }

  return { exonIndex, boundaries, boundaryFractions }
}

// ── Genomic-alignment helpers ─────────────────────────────────────────────────
// Returns the genomic position of the 5' nucleotide of amino acid aaIdx (1-based).
// Segments are in 5'→3' CDS order: for + strand genomic_start is the 5' end of
// the segment; for - strand genomic_end is the 5' end (coords go right-to-left).
function getGenomicAnchor(segments, strand, aaIdx) {
  const cdsNt = (aaIdx - 1) * 3 + 1  // 1-based CDS nucleotide of first base of this codon
  for (const seg of segments) {
    if (cdsNt >= seg.coord_start && cdsNt <= seg.coord_end) {
      const offset = cdsNt - seg.coord_start
      return strand === '-' ? seg.genomic_end - offset : seg.genomic_start + offset
    }
  }
  return null
}

// Builds an alignment from whatever sequences are currently cached.
// Returns { alignedSeqs: {txId: string}, totalColumns: number, strand } or null.
function computeAlignmentFromCache(geneId, txIds, cacheRef) {
  if (!geneId || txIds.length === 0) return null

  const txData = []
  let strand = '+'

  for (const txId of txIds) {
    const cached = cacheRef.current.get(`${geneId}|${txId}`)
    if (!cached || cached.status !== 'ok' || !cached.cdsSegments?.length) continue
    strand = cached.strand || '+'
    const seq = cached.fullSequence || ''
    const residues = []
    for (let i = 1; i <= seq.length; i++) {
      const anchor = getGenomicAnchor(cached.cdsSegments, cached.strand || '+', i)
      if (anchor !== null) residues.push({ anchor, char: seq[i - 1] })
    }
    txData.push({ txId, residues })
  }

  if (txData.length === 0) return null

  // Union of all genomic anchors across all transcripts
  const allAnchors = new Set()
  for (const tx of txData) for (const r of tx.residues) allAnchors.add(r.anchor)

  // Sort so left = 5' end: ascending for +, descending for -
  const sortedAnchors = [...allAnchors].sort((a, b) => strand === '-' ? b - a : a - b)
  const totalColumns = sortedAnchors.length

  // Pre-build position → column index for O(n) alignment construction
  const anchorToCol = new Map(sortedAnchors.map((a, i) => [a, i]))

  const alignedSeqs = {}
  for (const tx of txData) {
    const chars = new Array(totalColumns).fill('-')
    for (const r of tx.residues) {
      const col = anchorToCol.get(r.anchor)
      if (col !== undefined) chars[col] = r.char
    }
    alignedSeqs[tx.txId] = chars.join('')
  }

  return { alignedSeqs, totalColumns, strand }
}

// Build a map from 1-based protein position → 0-based alignment column index.
// In aligned mode, the aligned sequence has gaps ('-') interspersed; this map
// lets us project protein-coordinate features (domains, exon boundaries) into
// the alignment column space.
function buildProteinToAlignmentMap(alignedSeq) {
  if (!alignedSeq) return null
  const map = {} // {proteinPos (1-based) -> alignmentCol (0-based)}
  let proteinPos = 0
  for (let col = 0; col < alignedSeq.length; col++) {
    if (alignedSeq[col] !== '-') {
      proteinPos++
      map[proteinPos] = col
    }
  }
  return map
}

function GradientLegend({ isLight, title, leftLabel, rightLabel, gradient }) {
  return (
    <div
      className={`grid items-center gap-2 text-[10px] w-[420px] ${isLight ? 'text-gray-600' : 'text-gray-300'}`}
      style={{ gridTemplateColumns: '56px 122px 96px 122px' }}
    >
      <span className="font-semibold">{title}</span>
      <span className="text-right">{leftLabel}</span>
      <span
        className="inline-block h-2.5 w-24 rounded border"
        style={{
          borderColor: isLight ? '#cbd5e1' : '#475569',
          background: gradient,
        }}
      />
      <span>{rightLabel}</span>
    </div>
  )
}

export default function FeatureExplorerProteinsPanel({
  theme = 'dark',
  resolvedGene = null,
  sequenceGenome = 'reference',
  orderedTranscripts = [],
  displayOrderIds = [],
  visibleDisplayIds = [],
  activeTranscriptIds = new Set(),
  transcriptById = new Map(),
  transcriptTagInfoById = {},
  allActive = false,
  activeActionButtonClass = '',
  setAllVisible,
  collapseInactiveRows = true,
  setCollapseInactiveRows,
  restoreDefaultOrdering,
  toggleTranscript,
  dragSourceId = '',
  insertTargetId = '',
  insertPosition = 'before',
  mouseDownId = '',
  onTranscriptMouseDown,
  onTranscriptMouseUp,
  onTranscriptDragStart,
  onTranscriptDragOver,
  onTranscriptDrop,
  onTranscriptDragEnd,
}) {
  const isLight = theme === 'light'
  const [collapsed, setCollapsed] = useState(false)
  const [menuCollapsed, setMenuCollapsed] = useState(false)
  const [lockPanAcrossRows, setLockPanAcrossRows] = useState(false)
  const [isAligned, setIsAligned] = useState(false)
  const [alignmentData, setAlignmentData] = useState(null)
  const [aasPerWindow, setAasPerWindow] = useState(120)
  const [panState, setPanState] = useState({ globalStart: null, rowStarts: {} })
  const [fetchError, setFetchError] = useState('')
  const [loadingRowIds, setLoadingRowIds] = useState(new Set())
  const [cacheVersion, setCacheVersion] = useState(0)
  const [showStats, setShowStats] = useState(false)
  const [showHydro, setShowHydro] = useState(false)
  const [showCharge, setShowCharge] = useState(false)
  const [showDisorder, setShowDisorder] = useState(false)
  const [showExonPhase, setShowExonPhase] = useState(false)
  const showDomains = false
  const [domainData, setDomainData] = useState({})  // {proteinId -> {status, uniprot_id, domains: [...]}}
  const [copyToast, setCopyToast] = useState('')

  // Number of enabled property sub-tracks — used to grow row height
  const trackCount = (showHydro ? 1 : 0) + (showCharge ? 1 : 0) + (showDisorder ? 1 : 0) + (showExonPhase ? 1 : 0)
  const effectiveRowHeight = ROW_HEIGHT_PX + trackCount * (TRACK_HEIGHT + 1)

  const measureRef = useRef(null)
  // Cache stores the FULL protein sequence per transcript:
  // key = `${geneId}|${txId}` → { status, proteinId, fullSequence, coordMax, message, cdsSegments, strand }
  const cacheRef = useRef(new Map())
  const fetchTokenRef = useRef(0)
  const wheelAccumulatorRef = useRef(0)
  const hoveredRowRef = useRef(null)

  // Only coding transcripts (have CDS) are shown in this panel
  const codingDisplayIds = useMemo(() => (
    displayOrderIds.filter((id) => {
      const tx = transcriptById.get(id)
      return tx && Array.isArray(tx.cds_list) && tx.cds_list.length > 0
    })
  ), [displayOrderIds, transcriptById])

  const codingVisibleIds = useMemo(() => (
    visibleDisplayIds.filter((id) => {
      const tx = transcriptById.get(id)
      return tx && Array.isArray(tx.cds_list) && tx.cds_list.length > 0
    })
  ), [visibleDisplayIds, transcriptById])

  const activeCodingIds = useMemo(() => (
    codingDisplayIds.filter((id) => activeTranscriptIds.has(id))
  ), [codingDisplayIds, activeTranscriptIds])

  const activeCount = activeCodingIds.length
  const inactiveCount = Math.max(0, codingDisplayIds.length - activeCount)

  // Reset when gene changes
  useEffect(() => {
    cacheRef.current.clear()
    setFetchError('')
    setLoadingRowIds(new Set())
    setCacheVersion((v) => v + 1)
    setPanState({ globalStart: null, rowStarts: {} })
    setIsAligned(false)
    setAlignmentData(null)
    setDomainData({})
  }, [resolvedGene?.id])

  // Resize observer
  useEffect(() => {
    const el = measureRef.current
    if (!el) return undefined
    const update = () => {
      const width = Math.max(320, el.clientWidth || 0)
      setAasPerWindow(clamp(Math.floor((width - 18) / AA_CELL_WIDTH), MIN_AAS_PER_WINDOW, MAX_AAS_PER_WINDOW))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Per-row window start (1-based position, either AA or alignment column)
  const rowWindowById = useMemo(() => {
    const out = {}
    for (const txId of activeCodingIds) {
      const start = lockPanAcrossRows
        ? (Number(panState.globalStart) > 0 ? Number(panState.globalStart) : 1)
        : (Number(panState.rowStarts?.[txId]) > 0 ? Number(panState.rowStarts?.[txId]) : 1)
      out[txId] = { start: Math.max(1, Math.round(start)) }
    }
    return out
  }, [panState, lockPanAcrossRows, activeCodingIds])

  const setStart = useCallback((txId, nextStartRaw) => {
    const nextStart = Math.max(1, Math.round(Number(nextStartRaw || 1)))
    setPanState((prev) => {
      if (lockPanAcrossRows) return { ...prev, globalStart: nextStart }
      return { ...prev, rowStarts: { ...prev.rowStarts, [txId]: nextStart } }
    })
  }, [lockPanAcrossRows])

  const setStartAll = useCallback((delta) => {
    setPanState((prev) => {
      if (lockPanAcrossRows) {
        const current = Number(prev.globalStart) > 0 ? Number(prev.globalStart) : 1
        return { ...prev, globalStart: Math.max(1, current + delta) }
      }
      const newRowStarts = {}
      for (const txId of activeCodingIds) {
        const current = Number(prev.rowStarts?.[txId]) > 0 ? Number(prev.rowStarts?.[txId]) : 1
        newRowStarts[txId] = Math.max(1, current + delta)
      }
      return { ...prev, rowStarts: { ...prev.rowStarts, ...newRowStarts } }
    })
  }, [lockPanAcrossRows, activeCodingIds])

  // Wheel handler
  useEffect(() => {
    const el = measureRef.current
    if (!el) return undefined
    const handleWheel = (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      e.preventDefault()
      wheelAccumulatorRef.current += e.deltaX
      const delta = Math.trunc(wheelAccumulatorRef.current / AA_CELL_WIDTH)
      if (delta === 0) return
      wheelAccumulatorRef.current -= delta * AA_CELL_WIDTH
      const hoveredId = hoveredRowRef.current
      if (!lockPanAcrossRows && hoveredId) {
        setStart(hoveredId, (rowWindowById[hoveredId]?.start || 1) + delta)
      } else {
        setStartAll(delta)
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', handleWheel)
      wheelAccumulatorRef.current = 0
    }
  }, [activeCodingIds, lockPanAcrossRows, rowWindowById, setStart, setStartAll])

  // Fetch FULL protein sequences for any active coding tx not yet in cache.
  // Panning never triggers a refetch — we slice the full cached sequence client-side.
  useEffect(() => {
    if (!resolvedGene?.id || activeCodingIds.length === 0) return

    const neededRows = []
    const loadingIds = []
    for (const txId of activeCodingIds) {
      const cacheKey = `${resolvedGene.id}|${txId}`
      if (cacheRef.current.has(cacheKey)) continue
      if (loadingRowIds.has(txId)) continue
      neededRows.push({ transcript_id: txId, window_start: 1, window_end: 999999 })
      loadingIds.push(txId)
    }
    if (neededRows.length === 0) return

    setFetchError('')
    setLoadingRowIds((prev) => {
      const next = new Set(prev)
      for (const id of loadingIds) next.add(id)
      return next
    })
    const token = ++fetchTokenRef.current

    const run = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/feature_explorer/proteins`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            genome: sequenceGenome || 'reference',
            rows: neededRows,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (token !== fetchTokenRef.current) return
        if (!res.ok) throw new Error(data?.detail || 'Failed to fetch protein sequences.')
        for (const row of (Array.isArray(data?.rows) ? data.rows : [])) {
          const txId = String(row?.transcript_id || '').trim()
          if (!txId) continue
          const cacheKey = `${resolvedGene.id}|${txId}`
          cacheRef.current.set(cacheKey, {
            status: String(row?.status || 'error'),
            message: String(row?.message || ''),
            proteinId: String(row?.protein_id || ''),
            coordMax: Number(row?.coord_max || 1),
            fullSequence: String(row?.sequence || ''),
            cdsSegments: Array.isArray(row?.cds_segments) ? row.cds_segments : [],
            strand: String(row?.strand || '+'),
          })
        }
        setCacheVersion((v) => v + 1)
      } catch (e) {
        if (token !== fetchTokenRef.current) return
        setFetchError(e?.message || 'Failed to fetch protein sequences.')
      } finally {
        if (token !== fetchTokenRef.current) return
        setLoadingRowIds((prev) => {
          const next = new Set(prev)
          for (const id of loadingIds) next.delete(id)
          return next
        })
      }
    }
    run()
    // Note: rowWindowById intentionally NOT a dependency — pan never re-fetches
  }, [resolvedGene?.id, sequenceGenome, activeCodingIds]) // eslint-disable-line react-hooks/exhaustive-deps

  // Recompute alignment whenever cache updates (new sequences arrive) or active set changes
  useEffect(() => {
    if (!isAligned || !resolvedGene?.id) return
    const data = computeAlignmentFromCache(resolvedGene.id, activeCodingIds, cacheRef)
    setAlignmentData(data)
  }, [isAligned, cacheVersion, activeCodingIds, resolvedGene?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch domain annotations when Domains toggle is enabled
  useEffect(() => {
    if (!showDomains || !resolvedGene?.id) return

    // Collect protein IDs that aren't already cached
    const neededPids = []
    for (const txId of activeCodingIds) {
      const cacheKey = `${resolvedGene.id}|${txId}`
      const cached = cacheRef.current.get(cacheKey)
      const pid = cached?.proteinId
      if (pid && !domainData[pid]) neededPids.push(pid)
    }
    if (neededPids.length === 0) return

    const controller = new AbortController()
    console.log('[Domains] Fetching for protein IDs:', neededPids)

    fetch(`${API_BASE}/api/feature_explorer/protein_domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protein_ids: neededPids, genome: sequenceGenome || 'reference' }),
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        setDomainData((prev) => {
          const next = { ...prev }
          for (const row of (data?.rows || [])) {
            console.log(`[Domains] ${row.protein_id} → UniProt:${row.uniprot_id || 'none'} status:${row.status} domains:${row.domains?.length ?? 0}`)
            next[row.protein_id] = row
          }
          return next
        })
      })
      .catch((e) => {
        if (e.name !== 'AbortError') {
          console.warn('Domain fetch failed:', e)
        }
      })
      .finally(() => {})

    return () => controller.abort()
  }, [showDomains, activeCodingIds, cacheVersion, resolvedGene?.id, sequenceGenome]) // eslint-disable-line react-hooks/exhaustive-deps

  // Toggle alignment on/off
  const handleAlignToggle = useCallback(() => {
    if (isAligned) {
      setIsAligned(false)
      setAlignmentData(null)
    } else {
      const data = computeAlignmentFromCache(resolvedGene?.id, activeCodingIds, cacheRef)
      setAlignmentData(data)
      setIsAligned(true)
      setLockPanAcrossRows(true)
      setPanState({ globalStart: 1, rowStarts: {} })
    }
  }, [isAligned, resolvedGene?.id, activeCodingIds])

  // Slice full cached sequence (or aligned sequence) to the current visible window
  const rowRenderData = useMemo(() => {
    const out = {}
    if (!resolvedGene?.id) return out
    for (const txId of activeCodingIds) {
      const win = rowWindowById[txId]
      if (!win) continue
      const cacheKey = `${resolvedGene.id}|${txId}`
      const cached = cacheRef.current.get(cacheKey)

      // Aligned mode: use alignment sequence if available for this transcript
      if (isAligned && alignmentData?.alignedSeqs?.[txId] !== undefined) {
        const alignedSeq = alignmentData.alignedSeqs[txId]
        const totalCols = alignmentData.totalColumns
        const sliceStart = win.start - 1
        const seqRaw = alignedSeq.slice(sliceStart, sliceStart + aasPerWindow)
        const sequence = seqRaw.padEnd(aasPerWindow, '-').slice(0, aasPerWindow)
        out[txId] = {
          status: 'ok',
          sequence,
          coordMax: totalCols,
          message: '',
          proteinId: cached?.proteinId || '',
          isAligned: true,
          winStart: win.start,
        }
        continue
      }

      // Normal (unaligned) mode
      if (!cached) {
        out[txId] = { status: 'loading', sequence: '', coordMax: 1, message: '', proteinId: '', isAligned: false, winStart: win.start }
        continue
      }
      if (cached.status !== 'ok') {
        out[txId] = { status: cached.status, sequence: '', coordMax: cached.coordMax, message: cached.message, proteinId: cached.proteinId, isAligned: false, winStart: win.start }
        continue
      }
      const sliceStart = win.start - 1
      const seqRaw = cached.fullSequence.slice(sliceStart, sliceStart + aasPerWindow)
      const sequence = seqRaw.padEnd(aasPerWindow, '-').slice(0, aasPerWindow)
      out[txId] = {
        status: 'ok',
        sequence,
        coordMax: cached.coordMax,
        message: '',
        proteinId: cached.proteinId,
        isAligned: false,
        winStart: win.start,
      }
    }
    return out
  }, [resolvedGene?.id, activeCodingIds, rowWindowById, aasPerWindow, cacheVersion, isAligned, alignmentData]) // eslint-disable-line react-hooks/exhaustive-deps

  // Protein ID for menu display — sourced from cache
  const proteinIdByTxId = useMemo(() => {
    const out = {}
    for (const txId of codingDisplayIds) {
      const cached = cacheRef.current.get(`${resolvedGene?.id || ''}|${txId}`)
      if (cached?.proteinId) out[txId] = cached.proteinId
    }
    return out
  }, [codingDisplayIds, resolvedGene?.id, cacheVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scrollbar model — uses alignment totalColumns when aligned
  const panScrollModel = useMemo(() => {
    const anchorId = activeCodingIds[0] || ''
    if (!anchorId) return { minStart: 1, maxStart: 1, currentStart: 1, disabled: true }
    let coordMax
    if (isAligned && alignmentData) {
      coordMax = alignmentData.totalColumns
    } else {
      const cached = cacheRef.current.get(`${resolvedGene?.id || ''}|${anchorId}`)
      coordMax = Number(cached?.coordMax || 1)
    }
    const maxStart = Math.max(1, coordMax - aasPerWindow + 1)
    const currentStart = clamp(rowWindowById[anchorId]?.start || 1, 1, maxStart)
    return { minStart: 1, maxStart, currentStart, disabled: maxStart <= 1 }
  }, [activeCodingIds, rowWindowById, aasPerWindow, resolvedGene?.id, cacheVersion, isAligned, alignmentData]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleBottomScrollbarPan = useCallback((nextStartRaw) => {
    const nextStart = Math.max(1, Math.round(Number(nextStartRaw || 1)))
    const anchorId = activeCodingIds[0] || ''
    if (!anchorId) return
    const delta = nextStart - (rowWindowById[anchorId]?.start || 1)
    setPanState((prev) => {
      if (lockPanAcrossRows) return { ...prev, globalStart: nextStart }
      const nextRows = { ...prev.rowStarts }
      for (const txId of activeCodingIds) {
        const current = Number(prev.rowStarts?.[txId]) > 0 ? Number(prev.rowStarts?.[txId]) : 1
        nextRows[txId] = Math.max(1, current + delta)
      }
      return { ...prev, rowStarts: nextRows }
    })
  }, [activeCodingIds, rowWindowById, lockPanAcrossRows])

  const handleRowPanMouseDown = useCallback((event, txId) => {
    if (event.button !== 0) return
    const win = rowWindowById[txId]
    if (!win) return
    event.preventDefault()
    const startX = event.clientX
    const startCoord = win.start
    const onMove = (e) => {
      const delta = Math.round((startX - e.clientX) / AA_CELL_WIDTH)
      setStart(txId, startCoord + delta)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [rowWindowById, setStart])

  const rowModels = useMemo(() => (
    codingVisibleIds.map((txId) => {
      const tx = transcriptById.get(txId)
      if (!tx) return null
      const isActive = activeTranscriptIds.has(txId)
      const rowData = rowRenderData[txId] || {
        status: isActive ? 'loading' : 'inactive',
        sequence: '', coordMax: 1, message: '', proteinId: '', isAligned: false, winStart: 1,
      }
      const loading = isActive && (loadingRowIds.has(txId) || rowData.status === 'loading')
      return { txId, tx, isActive, rowData, loading, height: effectiveRowHeight }
    }).filter(Boolean)
  ), [codingVisibleIds, transcriptById, activeTranscriptIds, rowRenderData, loadingRowIds])

  const rowInsertLineColor = isLight ? 'rgba(59, 130, 246, 0.75)' : 'rgba(125, 211, 252, 0.8)'

  useEffect(() => {
    if (!copyToast) return undefined
    const timer = setTimeout(() => setCopyToast(''), 1800)
    return () => clearTimeout(timer)
  }, [copyToast])

  const copyToClipboard = useCallback(async (text, label) => {
    const payload = String(text || '').trim()
    if (!payload) return
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload)
        setCopyToast(`Copied ${label}`)
      } else {
        setCopyToast('Clipboard unavailable')
      }
    } catch {
      setCopyToast('Copy failed')
    }
  }, [])

  const copyFullProteinSequence = useCallback(async (txId) => {
    const cacheKey = `${resolvedGene?.id || ''}|${txId}`
    let sequence = String(cacheRef.current.get(cacheKey)?.fullSequence || '')
    if (!sequence) {
      try {
        const res = await fetch(`${API_BASE}/api/feature_explorer/proteins`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            genome: sequenceGenome || 'reference',
            rows: [{ transcript_id: txId, window_start: 1, window_end: 999999 }],
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          setCopyToast(data?.detail || 'Failed to fetch full protein sequence')
          return
        }
        const row = Array.isArray(data?.rows) ? data.rows[0] : null
        const status = String(row?.status || 'error')
        if (status !== 'ok') {
          setCopyToast(String(row?.message || 'Protein sequence unavailable'))
          return
        }
        sequence = String(row?.sequence || '')
      } catch {
        setCopyToast('Failed to fetch full protein sequence')
        return
      }
    }
    if (!sequence) {
      setCopyToast('Protein sequence unavailable')
      return
    }
    await copyToClipboard(sequence, `protein sequence (${txId})`)
  }, [resolvedGene?.id, sequenceGenome, copyToClipboard])

  // ── Styling shorthands ────────────────────────────────────────────────────
  const panelBorderClass = isLight ? 'bg-white border-gray-200' : 'bg-gray-800/80 border-gray-700'
  const headerBorderClass = isLight ? 'border-gray-200' : 'border-gray-700'
  const titleClass = isLight ? 'text-gray-800' : 'text-gray-100'
  const emptyTextClass = isLight ? 'text-gray-500' : 'text-gray-400'
  const btnActive = isLight ? 'bg-[#63acd8] text-white border-[#559dc8]' : 'bg-sky-500/75 text-white border-sky-400/80'
  const btnInactive = isLight ? 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200' : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
  const collapseToggleClass = isLight
    ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
    : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
  const togglePanelCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  if (!resolvedGene) return null

  return (
    <div className={`rounded-xl border overflow-hidden ${panelBorderClass}`}>
      {/* ── Section header ──────────────────────────────────────────────── */}
      <div
        role="button"
        tabIndex={0}
        onClick={togglePanelCollapsed}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            togglePanelCollapsed()
          }
        }}
        className={`px-4 py-3 flex items-center justify-between border-b cursor-pointer select-none ${headerBorderClass}`}
      >
        <div className={`text-sm font-semibold ${titleClass}`}>Proteins</div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            togglePanelCollapsed()
          }}
          className={`w-7 h-7 rounded border flex items-center justify-center transition-colors ${collapseToggleClass}`}
          title={collapsed ? 'Expand proteins panel' : 'Collapse proteins panel'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            {collapsed ? <polyline points="6 9 12 15 18 9" /> : <polyline points="18 15 12 9 6 15" />}
          </svg>
        </button>
      </div>

      {!collapsed && (
        <div
          className="grid min-h-[180px] transition-[grid-template-columns] duration-300 ease-out"
          style={{ gridTemplateColumns: `minmax(0,1fr) ${menuCollapsed ? MENU_COLLAPSED_WIDTH : MENU_EXPANDED_WIDTH}px` }}
        >
          {/* ── Left sub-header ─────────────────────────────────────────── */}
          <div className={`px-3 py-3 border-b ${headerBorderClass}`}>
            <div className="flex flex-wrap items-center gap-2">
              {/* Lock-pan button */}
              <button
                type="button"
                onClick={() => setLockPanAcrossRows((prev) => !prev)}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border inline-flex items-center gap-1.5 ${lockPanAcrossRows ? btnActive : btnInactive}`}
                title="Lock panning across all active protein rows"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                Pan
              </button>

              {/* Align button */}
              <button
                type="button"
                onClick={handleAlignToggle}
                disabled={activeCodingIds.length === 0}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border inline-flex items-center gap-1.5 ${isAligned ? btnActive : btnInactive
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                title={isAligned
                  ? 'Disable genomic alignment'
                  : 'Align protein rows by underlying genomic codon coordinates'}
              >
                {/* Simple "align rows" icon: three horizontal lines of varying length */}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="15" y2="12" />
                  <line x1="3" y1="18" x2="18" y2="18" />
                </svg>
                Align
              </button>

              {/* Stats toggle */}
              <button
                type="button"
                onClick={() => setShowStats((prev) => !prev)}
                disabled={activeCodingIds.length === 0}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border inline-flex items-center gap-1.5 ${showStats ? btnActive : btnInactive
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                title={showStats ? 'Hide protein statistics' : 'Show protein statistics'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="12" width="4" height="9" rx="1" />
                  <rect x="10" y="7" width="4" height="14" rx="1" />
                  <rect x="17" y="3" width="4" height="18" rx="1" />
                </svg>
                Stats
              </button>

              {/* Property sub-track toggles */}
              <button
                type="button"
                onClick={() => setShowHydro((prev) => !prev)}
                disabled={activeCodingIds.length === 0}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border inline-flex items-center gap-1.5 ${showHydro ? btnActive : btnInactive
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                title="Toggle hydrophobicity sub-track (Kyte-Doolittle sliding window)"
              >
                Hydro
              </button>
              <button
                type="button"
                onClick={() => setShowCharge((prev) => !prev)}
                disabled={activeCodingIds.length === 0}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border inline-flex items-center gap-1.5 ${showCharge ? btnActive : btnInactive
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                title="Toggle charge sub-track (sliding-window average; K,R=+1 H=+0.5 D,E=−1)"
              >
                Charge
              </button>
              <button
                type="button"
                onClick={() => setShowDisorder((prev) => !prev)}
                disabled={activeCodingIds.length === 0}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border inline-flex items-center gap-1.5 ${showDisorder ? btnActive : btnInactive
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                title="Toggle disorder propensity sub-track"
              >
                Disorder
              </button>
              <button
                type="button"
                onClick={() => setShowExonPhase((prev) => !prev)}
                disabled={activeCodingIds.length === 0}
                className={`px-2.5 py-1 rounded text-[11px] font-semibold border inline-flex items-center gap-1.5 ${showExonPhase ? btnActive : btnInactive
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                title="Toggle exon phase sub-track (colour by encoding exon)"
              >
                Exons
              </button>
            </div>
            {fetchError && (
              <div className={`mt-2 text-xs ${isLight ? 'text-red-600' : 'text-red-300'}`}>
                {fetchError}
              </div>
            )}
            {(showHydro || showCharge || showDisorder || showExonPhase) && (
              <div className="mt-2 grid grid-cols-1 xl:grid-cols-2 gap-x-5 gap-y-1.5">
                {showHydro && (
                  <GradientLegend
                    isLight={isLight}
                    title="Hydro"
                    leftLabel="hydrophilic (-4.5)"
                    rightLabel="hydrophobic (+4.5)"
                    gradient="linear-gradient(90deg, rgb(37,99,235) 0%, rgb(180,180,180) 50%, rgb(245,158,11) 100%)"
                  />
                )}
                {showCharge && (
                  <GradientLegend
                    isLight={isLight}
                    title="Charge"
                    leftLabel="negative (-1)"
                    rightLabel="positive (+1)"
                    gradient="linear-gradient(90deg, rgb(220,38,127) 0%, rgb(180,180,180) 50%, rgb(22,163,74) 100%)"
                  />
                )}
                {showDisorder && (
                  <GradientLegend
                    isLight={isLight}
                    title="Disorder"
                    leftLabel="ordered (0)"
                    rightLabel="disordered (1)"
                    gradient="linear-gradient(90deg, rgba(30,64,175,0.25) 0%, rgba(245,94,35,0.95) 100%)"
                  />
                )}
              </div>
            )}
          </div>

          {/* ── Right sub-header: transcript activity ───────────────────── */}
          <div className={`px-2 py-3 border-b border-l ${headerBorderClass}`}>
            <div className={`flex items-start justify-between gap-1 ${menuCollapsed ? 'h-full' : ''}`}>
              {!menuCollapsed && (
                <div>
                  <div className={`text-xs font-semibold ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
                    Transcript activity
                  </div>
                  <div className={`text-[11px] mt-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                    Active: {activeCount} | Inactive: {inactiveCount}
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => setMenuCollapsed((prev) => !prev)}
                className={`w-6 h-6 rounded border flex items-center justify-center transition-colors ${collapseToggleClass} ${menuCollapsed ? 'mx-auto mt-1' : ''}`}
                title={menuCollapsed ? 'Expand transcript list' : 'Collapse transcript list'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  {menuCollapsed ? <polyline points="15 6 9 12 15 18" /> : <polyline points="9 6 15 12 9 18" />}
                </svg>
              </button>
            </div>
            {!menuCollapsed && (
              <div className="flex items-center gap-2 pt-2 pb-2">
                <button
                  type="button"
                  onClick={setAllVisible}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${activeActionButtonClass}`}
                  title={allActive ? 'Deactivate every transcript' : 'Activate every transcript'}
                >
                  {allActive ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  type="button"
                  onClick={() => setCollapseInactiveRows((prev) => !prev)}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${btnInactive}`}
                  title={collapseInactiveRows ? 'Show inactive transcripts' : 'Hide inactive transcripts'}
                >
                  {collapseInactiveRows ? 'Show inactive' : 'Hide inactive'}
                </button>
                <button
                  type="button"
                  onClick={restoreDefaultOrdering}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold border ${btnInactive}`}
                  title="Restore default transcript order and active set"
                >
                  Default
                </button>
              </div>
            )}
          </div>

          {/* ── Left content: protein sequence rows + scrollbar ─────────── */}
          <div ref={measureRef}>
            {rowModels.length === 0 ? (
              <div className={`h-[180px] flex items-center justify-center text-sm ${emptyTextClass}`}>
                {codingDisplayIds.length === 0
                  ? 'No coding transcripts — activate a transcript with CDS to view proteins.'
                  : 'Activate a coding transcript to render protein sequences.'}
              </div>
            ) : (
              rowModels.map(({ txId, isActive, rowData, loading, height }) => (
                <div
                  key={`prot-row-${txId}`}
                  className={`px-2 border-b select-none ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                  onMouseEnter={() => { hoveredRowRef.current = txId }}
                  onMouseLeave={() => { hoveredRowRef.current = null }}
                  onMouseDown={(event) => {
                    if (!isActive || loading || rowData.status !== 'ok') return
                    handleRowPanMouseDown(event, txId)
                  }}
                  style={{
                    minHeight: `${effectiveRowHeight}px`,
                    cursor: (isActive && !loading && rowData.status === 'ok') ? 'grab' : 'default',
                  }}
                >
                  {!isActive ? (
                    <div className={`h-full flex items-center text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                      Inactive
                    </div>
                  ) : loading ? (
                    <div className={`h-full flex items-center text-xs ${emptyTextClass}`}>
                      Translating CDS…
                    </div>
                  ) : isAligned && !rowData.isAligned ? (
                    // Active, loaded, but not yet in alignment (e.g. translation failed)
                    <div className={`h-full flex items-center text-xs ${isLight ? 'text-red-600' : 'text-red-300'}`}>
                      {rowData.message || 'Not available for alignment'}
                    </div>
                  ) : rowData.status === 'no_cds' ? (
                    <div className={`h-full flex items-center text-xs ${emptyTextClass}`}>
                      No CDS
                    </div>
                  ) : rowData.status !== 'ok' ? (
                    <div className={`h-full flex items-center text-xs ${isLight ? 'text-red-600' : 'text-red-300'}`}>
                      {rowData.message || 'Protein unavailable'}
                    </div>
                  ) : (
                    <div className="overflow-hidden">
                      <div className="flex items-center gap-1.5" style={{ position: 'relative' }}>
                        <button
                          type="button"
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation()
                            copyFullProteinSequence(txId)
                          }}
                          className={`w-6 h-6 shrink-0 rounded border flex items-center justify-center transition-colors ${isLight
                            ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                            : 'bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600'
                            }`}
                          title="Copy full protein sequence"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="5" y="5" width="14" height="16" rx="2.2" />
                            <path d="M9 3h6v4H9z" />
                          </svg>
                        </button>
                        <div className="flex items-center w-full overflow-hidden" style={{ position: 'relative' }}>
                          {(() => {
                            // Pre-compute exon boundary positions for boundary markers
                            const cacheKey = `${resolvedGene?.id || ''}|${txId}`
                            const cached = cacheRef.current.get(cacheKey)
                            const fullSeq = cached?.fullSequence || ''
                            const cdsSegs = cached?.cdsSegments || []
                            const { boundaries, boundaryFractions } = computeExonPhaseInfo(cdsSegs, fullSeq.length)
                            const winStart = (rowData.winStart || 1) - 1
                            const winEnd = winStart + (rowData.sequence?.length || 0)

                            // In aligned mode, project protein-space boundaries to alignment columns
                            let visibleBoundaries
                            if (rowData.isAligned && alignmentData?.alignedSeqs?.[txId]) {
                              const p2a = buildProteinToAlignmentMap(alignmentData.alignedSeqs[txId])
                              if (p2a) {
                                visibleBoundaries = boundaries
                                  .map((b) => {
                                    // b is 0-based protein index where new exon starts → 1-based protein pos = b+1
                                    // but boundary is between b-1 and b, we want the alignment column of protein pos b+1
                                    const alignCol = p2a[b + 1]  // 0-based alignment column
                                    if (alignCol === undefined) return -1
                                    return alignCol - winStart
                                  })
                                  .filter((relIdx) => relIdx >= 0 && relIdx < (winEnd - winStart))
                              } else {
                                visibleBoundaries = []
                              }
                            } else {
                              visibleBoundaries = boundaryFractions
                                .map((b) => b - winStart)
                                .filter((rel) => rel >= 0 && rel < (winEnd - winStart))
                            }

                            return (
                              <>
                                {Array.from(rowData.sequence).map((residue, idx) => {
                                  const isGap = residue === '-'
                                  const bg = isGap ? 'transparent' : aaColor(residue)
                                  const textColor = isGap
                                    ? (isLight ? '#9ca3af' : '#4b5563')
                                    : (hexLuminance(bg) > 0.55 ? '#0f172a' : '#ffffff')
                                  const colNum = (rowData.winStart || 1) + idx
                                  const tipLabel = rowData.isAligned
                                    ? (isGap ? `Col ${colNum}: gap` : `Col ${colNum}: ${residue}`)
                                    : `AA ${colNum}: ${residue}`
                                  return (
                                    <div
                                      key={`aa-${txId}-${idx}`}
                                      className={`h-[26px] flex items-center justify-center text-[10px] font-mono ${isLight ? 'border-r border-white/50' : 'border-r border-black/15'}`}
                                      style={{ width: `${AA_CELL_WIDTH}px`, backgroundColor: bg, color: textColor, position: 'relative', zIndex: 2 }}
                                      title={tipLabel}
                                    >
                                      <span style={{ position: 'relative', zIndex: 5 }}>{residue}</span>
                                    </div>
                                  )
                                })}
                                {/* Exon boundary marker lines */}
                                {showExonPhase && visibleBoundaries.map((bIdx) => (
                                  <div
                                    key={`exbound-${txId}-${bIdx}`}
                                    style={{
                                      position: 'absolute',
                                      left: `${bIdx * AA_CELL_WIDTH}px`,
                                      top: 0,
                                      bottom: 0,
                                      width: '2px',
                                      backgroundColor: isLight ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)',
                                      pointerEvents: 'none',
                                      zIndex: 4,
                                    }}
                                    title={`Exon boundary at AA ${(Number(rowData.winStart || 1) + Number(bIdx)).toFixed(Number.isInteger(bIdx) ? 0 : 2)}`}
                                  />
                                ))}
                              </>
                            )
                          })()}
                        </div>
                      </div>
                      {/* Property sub-tracks */}
                      {trackCount > 0 && (() => {
                        // Get full sequence from cache to compute profiles
                        const cacheKey = `${resolvedGene?.id || ''}|${txId}`
                        const cached = cacheRef.current.get(cacheKey)
                        const fullSeq = cached?.fullSequence || ''
                        if (!fullSeq) return null

                        // In aligned mode, the visible sequence has gaps '-'. Profile values
                        // are indexed by protein position, not alignment column. We need to
                        // build a per-cell array mapping each visible cell to its protein
                        // position (or null for gaps).
                        const visibleSeq = rowData.sequence || ''
                        let cellProteinPositions // 0-based protein positions for each cell, or -1 for gaps

                        if (rowData.isAligned && alignmentData?.alignedSeqs?.[txId]) {
                          // Count non-gap chars before the window start to get starting protein position
                          const fullAligned = alignmentData.alignedSeqs[txId]
                          const alignWinStart = (rowData.winStart || 1) - 1
                          let proteinPos = 0
                          for (let c = 0; c < alignWinStart && c < fullAligned.length; c++) {
                            if (fullAligned[c] !== '-') proteinPos++
                          }
                          cellProteinPositions = Array.from(visibleSeq, (ch) => {
                            if (ch === '-') return -1
                            return proteinPos++
                          })
                        } else {
                          // Unaligned: simple linear mapping
                          const winStart = (rowData.winStart || 1) - 1
                          cellProteinPositions = Array.from(visibleSeq, (_, i) => winStart + i)
                        }

                        // Compute profiles on full sequence (these are fast O(n) operations)
                        const profiles = {}
                        const exonInfo = showExonPhase
                          ? computeExonPhaseInfo(cached?.cdsSegments || [], fullSeq.length)
                          : null
                        if (showExonPhase) {
                          profiles.exon = exonInfo?.exonIndex || []
                        }
                        if (showHydro) {
                          profiles.hydro = computeHydropathyProfile(fullSeq)
                        }
                        if (showCharge) {
                          profiles.charge = computeChargeProfile(fullSeq)
                        }
                        if (showDisorder) {
                          profiles.disorder = computeDisorderProfile(fullSeq)
                        }

                        // Build tracks with per-cell values
                        const tracks = []
                        if (showExonPhase) {
                          const cellValues = cellProteinPositions.map((pp) =>
                            pp >= 0 && pp < profiles.exon.length ? profiles.exon[pp] : null
                          )
                          let boundaryRelPositions = []
                          if (rowData.isAligned && alignmentData?.alignedSeqs?.[txId]) {
                            const p2a = buildProteinToAlignmentMap(alignmentData.alignedSeqs[txId])
                            const alignWinStart = (rowData.winStart || 1) - 1
                            boundaryRelPositions = (exonInfo?.boundaries || [])
                              .map((b) => {
                                const alignCol = p2a?.[b + 1]
                                if (alignCol === undefined) return -1
                                return alignCol - alignWinStart
                              })
                              .filter((relIdx) => relIdx >= 0 && relIdx < visibleSeq.length)
                          } else {
                            const winStart = (rowData.winStart || 1) - 1
                            boundaryRelPositions = (exonInfo?.boundaryFractions || [])
                              .map((b) => b - winStart)
                              .filter((relIdx) => relIdx >= 0 && relIdx < visibleSeq.length)
                          }
                          tracks.push({ key: 'exon', cellValues, colorFn: () => EXON_PHASE_COLORS[0], boundaryRelPositions })
                        }
                        if (showHydro) {
                          const cellValues = cellProteinPositions.map((pp) =>
                            pp >= 0 && pp < profiles.hydro.length ? profiles.hydro[pp] : null
                          )
                          tracks.push({ key: 'hydro', cellValues, colorFn: hydroColor })
                        }
                        if (showCharge) {
                          const cellValues = cellProteinPositions.map((pp) =>
                            pp >= 0 && pp < profiles.charge.length ? profiles.charge[pp] : null
                          )
                          tracks.push({ key: 'charge', cellValues, colorFn: chargeColor })
                        }
                        if (showDisorder) {
                          const cellValues = cellProteinPositions.map((pp) =>
                            pp >= 0 && pp < profiles.disorder.length ? profiles.disorder[pp] : null
                          )
                          tracks.push({ key: 'disorder', cellValues, colorFn: disorderColor })
                        }

                        return (
                          <div style={{ marginLeft: `${ROW_LEAD_INSET_PX}px` }}>
                            {tracks.map(({ key, cellValues, colorFn, boundaryRelPositions = [] }) => (
                              <div
                                key={`track-${key}-${txId}`}
                                className="flex"
                                style={{ height: `${TRACK_HEIGHT}px`, marginTop: '1px', position: 'relative' }}
                              >
                                {cellValues.map((v, i) => (
                                  <div
                                    key={`${key}-${i}`}
                                    style={{
                                      width: `${AA_CELL_WIDTH}px`,
                                      backgroundColor: v === null ? 'transparent' : colorFn(v),
                                    }}
                                  />
                                ))}
                                {key === 'exon' && boundaryRelPositions.map((rel, idx) => (
                                  <div
                                    key={`exon-track-boundary-${txId}-${idx}`}
                                    style={{
                                      position: 'absolute',
                                      left: `${rel * AA_CELL_WIDTH}px`,
                                      top: 0,
                                      bottom: 0,
                                      width: '2px',
                                      backgroundColor: isLight ? 'rgba(15,23,42,0.68)' : 'rgba(226,232,240,0.84)',
                                      pointerEvents: 'none',
                                      zIndex: 3,
                                    }}
                                  />
                                ))}
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                      {/* Domain annotations track */}
                      {showDomains && (() => {
                        const cacheKey = `${resolvedGene?.id || ''}|${txId}`
                        const cached = cacheRef.current.get(cacheKey)
                        const pid = cached?.proteinId
                        const domRow = pid ? domainData[pid] : null
                        if (!domRow) {
                          // Not yet fetched — domainLoading shows the spinner in the button
                          return null
                        }
                        if (domRow.status !== 'ok') {
                          return (
                            <div className={`text-[10px] mt-1 px-0.5 ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                              {domRow.status === 'not_found'
                                ? `Domains: no UniProt mapping found for ${pid}`
                                : `Domains: ${domRow.message || domRow.status}`}
                            </div>
                          )
                        }
                        if (!domRow.domains?.length) {
                          return (
                            <div className={`text-[10px] mt-1 px-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                              Domains: none found in InterPro for {domRow.uniprot_id}
                            </div>
                          )
                        }

                        const proteinLen = cached?.coordMax || 1
                        const winStart = rowData.winStart || 1
                        const winEnd = winStart + (rowData.sequence?.length || 0) - 1
                        const totalPxWidth = (rowData.sequence?.length || 0) * AA_CELL_WIDTH

                        // In aligned mode, build protein→alignment column map
                        const p2a = (rowData.isAligned && alignmentData?.alignedSeqs?.[txId])
                          ? buildProteinToAlignmentMap(alignmentData.alignedSeqs[txId])
                          : null

                        // Palette cycling by database source
                        const DB_COLORS = [
                          '#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981',
                          '#ec4899', '#6366f1', '#14b8a6', '#f97316', '#84cc16',
                        ]
                        const dbColorMap = {}
                        let dbIdx = 0

                        return (
                          <div style={{ marginLeft: `${ROW_LEAD_INSET_PX}px` }}>
                            <div style={{ position: 'relative', height: '16px', marginTop: '2px', width: `${totalPxWidth}px` }}>
                            {domRow.domains.map((dom, di) => {
                              let renderStart, renderEnd
                              if (p2a) {
                                // Aligned mode: map protein coords → alignment columns
                                const alignStart = p2a[dom.start]
                                const alignEnd = p2a[dom.end]
                                if (alignStart === undefined || alignEnd === undefined) return null
                                // Convert to 1-based alignment column for comparison with winStart
                                renderStart = alignStart + 1
                                renderEnd = alignEnd + 1
                              } else {
                                renderStart = dom.start
                                renderEnd = dom.end
                              }
                              // Only render if domain overlaps the visible window
                              if (renderEnd < winStart || renderStart > winEnd) return null
                              const clippedStart = Math.max(renderStart, winStart)
                              const clippedEnd = Math.min(renderEnd, winEnd)
                              const leftPx = (clippedStart - winStart) * AA_CELL_WIDTH
                              const widthPx = Math.max(4, (clippedEnd - clippedStart + 1) * AA_CELL_WIDTH)
                              // Assign colour by database
                              if (!(dom.database in dbColorMap)) {
                                dbColorMap[dom.database] = DB_COLORS[dbIdx % DB_COLORS.length]
                                dbIdx++
                              }
                              const color = dbColorMap[dom.database]
                              const label = dom.name || dom.accession
                              const showLabel = widthPx > 40

                              return (
                                <div
                                  key={`dom-${txId}-${di}`}
                                  style={{
                                    position: 'absolute',
                                    left: `${leftPx}px`,
                                    top: '1px',
                                    width: `${widthPx}px`,
                                    height: '14px',
                                    backgroundColor: color,
                                    borderRadius: '3px',
                                    opacity: 0.85,
                                    overflow: 'hidden',
                                    cursor: 'default',
                                  }}
                                  title={`${label} (${dom.database})\n${dom.accession}: ${dom.start}-${dom.end}\n${dom.description || ''}`}
                                >
                                  {showLabel && (
                                    <span
                                      className="text-[8px] font-semibold text-white px-1 leading-[14px] truncate block"
                                      style={{ textShadow: '0 0 2px rgba(0,0,0,0.5)' }}
                                    >
                                      {label}
                                    </span>
                                  )}
                                </div>
                              )
                            })}
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  )}
                </div>
              ))
            )}

            {/* Scrollbar */}
            {activeCodingIds.length > 0 && (
              <div className={`px-2 py-2 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                <input
                  type="range"
                  min={panScrollModel.minStart}
                  max={panScrollModel.maxStart}
                  step={1}
                  value={clamp(panScrollModel.currentStart, panScrollModel.minStart, panScrollModel.maxStart)}
                  disabled={panScrollModel.disabled}
                  onChange={(e) => handleBottomScrollbarPan(e.target.value)}
                  className="w-full h-2 cursor-pointer"
                  title="Scroll protein sequence window"
                />
              </div>
            )}
          </div>

          {/* ── Right content: transcript / protein ID buttons ────────────── */}
          <div className={`border-l ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
            {!menuCollapsed && rowModels.map(({ txId, tx, isActive, height }) => {
              const tagInfo = transcriptTagInfoById[txId] || {}
              const showCanonical = Boolean(tagInfo.hasCanonical)
              const showMane = Boolean(tagInfo.hasManeSelect)
              const isDragSource = dragSourceId === txId || mouseDownId === txId
              const isInsertTarget = insertTargetId === txId && dragSourceId !== txId
              const proteinId = proteinIdByTxId[txId] || ''

              return (
                <div
                  key={`prot-menu-${txId}`}
                  className={`px-2 border-b flex items-start pt-0.5 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
                  draggable
                  onMouseDown={() => onTranscriptMouseDown?.(txId)}
                  onMouseUp={onTranscriptMouseUp}
                  onMouseLeave={onTranscriptMouseUp}
                  onDragStart={(event) => onTranscriptDragStart?.(event, txId)}
                  onDragOver={(event) => onTranscriptDragOver?.(event, txId)}
                  onDragEnter={(event) => onTranscriptDragOver?.(event, txId)}
                  onDrop={(event) => onTranscriptDrop?.(event, txId)}
                  onDragEnd={onTranscriptDragEnd}
                  style={{
                    boxShadow: isInsertTarget
                      ? (insertPosition === 'before' ? `inset 0 2px 0 ${rowInsertLineColor}` : `inset 0 -2px 0 ${rowInsertLineColor}`)
                      : 'none',
                    height: `${height}px`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggleTranscript?.(txId)}
                    className={`w-full h-[34px] mt-0 rounded px-2 text-left text-xs border transition-colors ${isActive
                      ? (isLight
                        ? 'bg-[#63acd8]/12 text-[#3f7696] border-[#559dc8] hover:bg-[#63acd8]/20'
                        : 'bg-sky-400/14 text-sky-100 border-sky-300/60 hover:bg-sky-400/22')
                      : (isLight
                        ? 'bg-gray-50 text-gray-700 border-gray-300 hover:bg-gray-100'
                        : 'bg-gray-900/50 text-gray-300 border-gray-600 hover:bg-gray-700')
                      }`}
                    style={{
                      boxShadow: isDragSource
                        ? (isLight ? '0 0 0 2px rgba(59,130,246,0.8) inset' : '0 0 0 2px rgba(125,211,252,0.8) inset')
                        : 'none',
                    }}
                    title={`${tx.id}${proteinId ? `\n${proteinId}` : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-col min-w-0">
                        <span className="font-mono truncate text-[10px] leading-tight">{displayId(tx.id)}</span>
                        {proteinId && (
                          <span className="font-mono truncate text-[9px] leading-tight opacity-70">{displayId(proteinId)}</span>
                        )}
                      </div>
                      {(showCanonical || showMane) && (
                        <span className="shrink-0 inline-flex flex-col items-start gap-0.5">
                          {showCanonical && (
                            <span className={`text-[9px] leading-[1.1] px-1.5 py-0.5 rounded-full whitespace-nowrap ${isLight ? 'bg-green-100 text-green-700' : 'bg-green-900/30 text-green-400'}`}>
                              canonical
                            </span>
                          )}
                          {showMane && (
                            <span className={`text-[9px] leading-[1.1] px-1.5 py-0.5 rounded-full whitespace-nowrap ${isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-900/30 text-emerald-400'}`}>
                              MANE select
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Collapsible stats section ──────────────────────────────────── */}
      {!collapsed && showStats && activeCodingIds.length > 0 && (() => {
        // Compute stats from cache for all active coding transcripts
        const statsRows = activeCodingIds.map((txId) => {
          const cacheKey = `${resolvedGene?.id || ''}|${txId}`
          const cached = cacheRef.current.get(cacheKey)
          if (!cached || cached.status !== 'ok' || !cached.fullSequence) return null
          const seq = cached.fullSequence.replace(/\*/g, '') // strip stop codon
          return {
            txId,
            proteinId: cached.proteinId || '',
            length: cached.coordMax,
            mw: computeProteinMW(seq),
            pi: computePI(seq),
            gravy: computeGRAVY(seq),
            instability: computeInstabilityIndex(seq),
            aromaticity: computeAromaticity(seq),
            extinction: computeExtinctionCoeff(seq),
            composition: computeAAComposition(seq),
          }
        }).filter(Boolean)

        if (!statsRows.length) return null

        const labelClass = isLight ? 'text-gray-500' : 'text-gray-400'
        const headerCellClass = isLight
          ? 'text-gray-600 bg-gray-50 border-gray-200'
          : 'text-gray-300 bg-gray-800/60 border-gray-700'
        const cellClass = isLight
          ? 'text-gray-700 border-gray-200'
          : 'text-gray-200 border-gray-700'

        // AA composition colors for the stacked bar
        const compAAs = 'ACDEFGHIKLMNPQRSTVWY'.split('')

        return (
          <div className={`border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
            <div className="overflow-x-auto">
              <table className={`w-full text-[11px] border-collapse ${isLight ? 'bg-white' : 'bg-gray-800/40'}`}>
                <thead>
                  <tr>
                    <th className={`px-2 py-1.5 text-left font-semibold border-b whitespace-nowrap ${headerCellClass}`}>Protein</th>
                    <th className={`px-2 py-1.5 text-right font-semibold border-b whitespace-nowrap ${headerCellClass}`}>Length</th>
                    <th className={`px-2 py-1.5 text-right font-semibold border-b whitespace-nowrap ${headerCellClass}`} title="Molecular weight (Da)">MW (Da)</th>
                    <th className={`px-2 py-1.5 text-right font-semibold border-b whitespace-nowrap ${headerCellClass}`} title="Isoelectric point">pI</th>
                    <th className={`px-2 py-1.5 text-right font-semibold border-b whitespace-nowrap ${headerCellClass}`} title="Grand average of hydropathy">GRAVY</th>
                    <th className={`px-2 py-1.5 text-right font-semibold border-b whitespace-nowrap ${headerCellClass}`} title="Instability index (>40 = unstable)">Instab.</th>
                    <th className={`px-2 py-1.5 text-right font-semibold border-b whitespace-nowrap ${headerCellClass}`} title="Aromaticity (F+W+Y fraction)">Arom.</th>
                    <th className={`px-2 py-1.5 text-right font-semibold border-b whitespace-nowrap ${headerCellClass}`} title="Extinction coefficient at 280nm (M⁻¹cm⁻¹, reduced)">ε₂₈₀</th>
                    <th className={`px-2 py-1.5 text-left font-semibold border-b whitespace-nowrap ${headerCellClass}`}>Composition</th>
                  </tr>
                </thead>
                <tbody>
                  {statsRows.map((row) => {
                    const instClass = row.instability > 40
                      ? (isLight ? 'text-red-600' : 'text-red-400')
                      : (isLight ? 'text-green-700' : 'text-green-400')
                    return (
                      <tr key={`stats-${row.txId}`} className={isLight ? 'hover:bg-gray-50' : 'hover:bg-gray-700/30'}>
                        <td className={`px-2 py-1.5 border-b font-mono whitespace-nowrap ${cellClass}`}>
                          <div className="leading-tight">{displayId(row.txId)}</div>
                          {row.proteinId && (
                            <div className={`leading-tight opacity-60 ${labelClass}`}>{displayId(row.proteinId)}</div>
                          )}
                        </td>
                        <td className={`px-2 py-1.5 border-b text-right tabular-nums ${cellClass}`}>{row.length.toLocaleString()}</td>
                        <td className={`px-2 py-1.5 border-b text-right tabular-nums ${cellClass}`}>{formatNumber(row.mw, 1)}</td>
                        <td className={`px-2 py-1.5 border-b text-right tabular-nums ${cellClass}`}>{formatNumber(row.pi)}</td>
                        <td className={`px-2 py-1.5 border-b text-right tabular-nums ${cellClass}`}>{formatNumber(row.gravy)}</td>
                        <td className={`px-2 py-1.5 border-b text-right tabular-nums ${instClass}`}>
                          {formatNumber(row.instability)}
                          <span className="ml-1 text-[9px] opacity-60">{row.instability > 40 ? 'unstable' : 'stable'}</span>
                        </td>
                        <td className={`px-2 py-1.5 border-b text-right tabular-nums ${cellClass}`}>{formatNumber(row.aromaticity * 100, 1)}%</td>
                        <td className={`px-2 py-1.5 border-b text-right tabular-nums ${cellClass}`}>{row.extinction.toLocaleString()}</td>
                        <td className={`px-2 py-1.5 border-b ${cellClass}`}>
                          {/* Stacked AA composition bar */}
                          <div className="flex h-[10px] rounded overflow-hidden" style={{ width: '140px' }} title={
                            compAAs.map((aa) => `${aa}: ${row.composition[aa]}`).join(', ')
                          }>
                            {compAAs.map((aa) => {
                              const frac = row.length > 0 ? row.composition[aa] / row.length : 0
                              if (frac < 0.003) return null
                              return (
                                <div
                                  key={aa}
                                  style={{
                                    width: `${frac * 100}%`,
                                    backgroundColor: AA_COLORS[aa] || DEFAULT_AA_COLOR,
                                  }}
                                  title={`${aa}: ${row.composition[aa]} (${(frac * 100).toFixed(1)}%)`}
                                />
                              )
                            })}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })()}
      {copyToast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[150] rounded-lg border px-3 py-1.5 text-xs font-semibold shadow-xl ${isLight
          ? 'bg-white border-sky-300 text-sky-800'
          : 'bg-gray-800 border-sky-500/70 text-sky-200'
          }`}>
          {copyToast}
        </div>
      )}
    </div>
  )
}
