// Who the chromosome-1 slice is, and the handful of its genes the browser tutorial names.
//
// Pure, so the tutorial definition and its tests can read it without dragging in the
// backend client — the fetching lives in demoGenomeApi.js.
//
// These identifiers have to agree with backend/demo_genome.py, where the same genome is
// described as a BundledGenome; a test asserts it.

export const SLICE_GENOME_ID = 'grch38_reg4'
export const SLICE_SPECIES_KEY = 'homo_sapiens_demo_slice'
export const SLICE_ASSEMBLY = 'GCA_000000000.2'
export const SLICE_SCIENTIFIC_NAME = 'Homo sapiens (demo slice)'
export const SLICE_DISPLAY_NAME = 'Human chr1 slice (demo)'

// The window the slice covers, at its true GRCh38 coordinates — the FASTA record is
// chromosome 1 with N in front of it, so everything below is the real thing and can be
// checked against the Ensembl website. The genome declares this window as its browsable
// range, so the browser will not pan or zoom out past it into the padding.
export const SLICE_CHROM = '1'
export const SLICE_START = 118_440_000
export const SLICE_END = 120_120_000

/** `chr:start-end`, formatted the way the browser's search box wants it. */
export function locus(start, end) {
  return `${SLICE_CHROM}:${start.toLocaleString('en-GB')}-${end.toLocaleString('en-GB')}`
}

/** The whole slice, end to end. */
export const SLICE_WHOLE_REGION = locus(SLICE_START, SLICE_END)

/** Where the tutorial opens: the middle of the slice, close enough in to read the genes. */
export const OPENING_REGION = locus(118_800_000, 119_800_000)

// The genes the tutorial actually points at. Everything here is checked against the
// bundled annotation by backend/tests/test_grch38_slice.py, so a re-slice that moved or
// dropped one of them fails a test rather than a step.

/** TBX15: a hundred kilobases of protein-coding gene in the upstream half, far enough
 *  from the opening view that travelling to it reads as travelling.
 *
 *  Three transcripts, which is why the per-gene transcript steps happen here rather than
 *  on one of the deep genes: two extra rows appear and are still all on screen together,
 *  so what the pill did can be seen in one glance. The id is the pill's anchor. */
export const TBX15 = Object.freeze({
  symbol: 'TBX15',
  id: 'ENSG00000092607',
  start: 118_883_046,
  end: 118_989_556,
  strand: '-',
  transcripts: 3,
})
export const TBX15_WIDE_REGION = locus(118_470_000, 119_400_000)
export const TBX15_REGION = locus(118_860_000, 119_015_000)

/** HAO2: twenty-six kilobases of protein-coding gene with thirty-six transcripts, near
 *  the middle of the slice. Where the search step lands, because a step that pastes in a
 *  region wants to arrive somewhere worth looking at — and because arriving zoomed in is
 *  what gives the pan-and-zoom step after it something to zoom out from. */
export const HAO2 = Object.freeze({
  symbol: 'HAO2',
  start: 119_368_727,
  end: 119_394_258,
  strand: '+',
  transcripts: 36,
})

export const HAO2_REGION = locus(119_368_000, 119_395_000)

/** HSD3B1: a compact forward-strand gene with five transcripts.
 *
 *  Unused by the tutorial since Flatten moved onto TBX15, where it now follows the pill
 *  that expanded that gene's transcripts rather than arriving on a gene of its own.
 *  Kept because the backend test pins it, and because it is the obvious second small gene
 *  if another step ever needs one. */
export const HSD3B1 = Object.freeze({
  symbol: 'HSD3B1',
  start: 119_507_198,
  end: 119_515_054,
  strand: '+',
  transcripts: 5,
})

export const HSD3B1_REGION = locus(HSD3B1.start - 5_000, HSD3B1.end + 5_000)

/** A hundred-and-two base coding exon of TBX15's canonical transcript, near the middle of
 *  the gene. Where the zooming step ends up. */
export const TBX15_EXON = Object.freeze({ start: 118_926_510, end: 118_926_611 })

const TBX15_EXON_CENTRE = Math.round((TBX15_EXON.start + TBX15_EXON.end) / 2)

/** A window of `span` bases centred on that exon. Centring every stage on the same point
 *  makes the zoom a zoom: a sequence that also drifts sideways reads as being dragged
 *  somewhere rather than as going in. */
function aroundExon(span) {
  const half = Math.round(span / 2)
  return locus(TBX15_EXON_CENTRE - half, TBX15_EXON_CENTRE + half)
}

/** Where the zooming step starts — the gene, at the zoom the step before it used, but
 *  centred on the exon so the zoom goes straight in. */
export const TBX15_EXON_VIEW = aroundExon(155_000)

/** Where that zoom ends: fifty bases, which is upwards of twenty pixels each. */
export const TBX15_SEQUENCE_REGION = aroundExon(50)

export const REG4 = Object.freeze({
  symbol: 'REG4',
  id: 'ENSG00000134193',
  start: 119_794_017,
  end: 119_811_580,
  strand: '-',
  transcripts: 5,
  // The MANE Select, and the browser's canonical: the one the drawer pins.
  canonicalTranscript: 'ENST00000256585',
  canonicalName: 'REG4-201',
  // Transcript support level 5, which is exactly the sort of thing you would hide.
  hideableTranscript: 'ENST00000530654',
  hideableName: 'REG4-204',
})

/** A window around REG4 with room to see it whole. */
export const REG4_REGION = locus(REG4.start - 4_000, REG4.end + 4_000)

/** The gene's exact bounds, used to tell whether the focus control has framed it. */
export const REG4_GENE_REGION = locus(REG4.start, REG4.end)

/** PHGDH and HMGCS2 together: thirty-eight transcripts and twenty-two, at a zoom where
 *  their symbols are still readable. */
export const DEEP_GENES_REGION = locus(119_635_000, 119_785_000)

/** The window the location half of the tutorial focuses: a hundred and fifteen kilobases
 *  ending just past REG4, so the reader travels out from the gene they have been working
 *  on rather than to somewhere new.
 *
 *  Chosen for what it contains. With long non-coding genes filtered out — which is where
 *  the tutorial's own filter section leaves the browser — it holds exactly four genes:
 *  HMGCS2 and REG4, and the pseudogenes NBPF7P and PFN1P9. All four sit wholly inside it,
 *  so the drawer's list is the same whether the region is read as overlapping or as
 *  containing. It starts 773 bases after PHGDH ends, which is deliberate: PHGDH's tail is
 *  on screen once the region is framed but outside its boundary lines, so the card about
 *  the gene list has something true to say about what a region does and does not hold. */
export const LOCATION_REGION = locus(119_745_000, 119_860_000)

/** Where the browser sits once that window is the location of focus.
 *
 *  Pressing "Focus this window" keeps the region at BOX_SELECT_FILL_FRACTION of the view,
 *  so the boundary lines land inside the track rather than on its edges where they cannot
 *  be seen. This is that padded window, which is what every step after the press declares
 *  — the alternative is each of them pulling the view back to the unpadded region and the
 *  boundary lines disappearing off both sides. */
export const LOCATION_FOCUS_VIEW = locus(119_741_000, 119_864_000)

/** HMGCS2, the other protein-coding gene inside that window. Named here because the
 *  location drawer lists it above REG4 and a card counts them. */
export const HMGCS2 = Object.freeze({
  symbol: 'HMGCS2',
  id: 'ENSG00000134240',
  start: 119_747_979,
  end: 119_769_092,
  strand: '-',
  transcripts: 22,
})
