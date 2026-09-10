// The little stretch of genome drawn above the colour swatches.
//
// A colour reads differently as a 32px disc and as the exon blocks of a gene
// track, and it is the second one the user is actually choosing. So the picker
// shows a miniature of the real thing — a ruler, forward and reverse genes,
// exons joined by intron lines — rather than a bigger swatch.
//
// The region is invented rather than fetched: the picker has to answer
// instantly, has to look the same for every genome, and has nothing to say
// about any particular locus. The layout is pure so it can be checked without a
// renderer.

/** The pretend locus, in the units the browser would show. */
export const PREVIEW_REGION = Object.freeze({ chrom: '1', start: 1_240_600, end: 1_261_600 })

/** Five genes over two rows per strand, shaped like real ones: a long gene with
 *  many small exons, a compact one, a single-exon gene. */
export const PREVIEW_GENES = Object.freeze([
  {
    id: 'preview-gene-1', name: 'SLC2A1', strand: 1, row: 0,
    exons: [[1_241_200, 1_241_900], [1_243_100, 1_243_450], [1_245_000, 1_245_380], [1_247_200, 1_248_600]],
  },
  {
    id: 'preview-gene-2', name: 'RAB11', strand: 1, row: 1,
    exons: [[1_250_600, 1_251_100], [1_252_400, 1_252_800], [1_254_100, 1_255_600]],
  },
  {
    id: 'preview-gene-3', name: 'MT-CO1', strand: 1, row: 0,
    exons: [[1_258_400, 1_260_900]],
  },
  {
    id: 'preview-gene-4', name: 'BRD2', strand: -1, row: 0,
    exons: [[1_242_600, 1_243_000], [1_244_200, 1_244_700], [1_246_100, 1_247_500], [1_249_000, 1_249_600]],
  },
  {
    id: 'preview-gene-5', name: 'PAX7', strand: -1, row: 1,
    exons: [[1_253_000, 1_253_500], [1_255_200, 1_256_400], [1_258_000, 1_259_100]],
  },
])

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

/** Where every part of the preview lands, in the co-ordinates of a viewBox of
 *  `width` x `height`.
 *
 *  Returned rather than drawn so the shape of the picture is checkable: the
 *  renderer only turns these numbers into `<rect>`s. */
export function previewGeneLayout({
  width = 320,
  height = 132,
  padding = 10,
  rulerHeight = 14,
  rowHeight = 22,
  exonHeight = 10,
  tickCount = 5,
  region = PREVIEW_REGION,
  genes = PREVIEW_GENES,
} = {}) {
  const start = Number(region?.start) || 0
  const end = Number(region?.end) || start + 1
  const span = Math.max(1, end - start)
  const left = padding
  const right = Math.max(left + 1, width - padding)
  const trackWidth = right - left

  const positionOf = (coordinate) => left + clamp((coordinate - start) / span, 0, 1) * trackWidth

  const ticks = Array.from({ length: Math.max(2, tickCount) }, (_, index) => {
    const fraction = index / (Math.max(2, tickCount) - 1)
    return { x: left + fraction * trackWidth, coordinate: Math.round(start + fraction * span) }
  })

  // Forward genes sit above the ruler and reverse below, which is how the
  // browser stacks them — the preview would otherwise teach the wrong shape.
  const rulerY = padding + rulerHeight + 2 * rowHeight
  const laid = (Array.isArray(genes) ? genes : []).map((gene) => {
    const exons = (Array.isArray(gene.exons) ? gene.exons : [])
      .map(([exonStart, exonEnd]) => {
        const x = positionOf(Math.min(exonStart, exonEnd))
        const exonRight = positionOf(Math.max(exonStart, exonEnd))
        return { x, width: Math.max(1.5, exonRight - x) }
      })
      .sort((left_, right_) => left_.x - right_.x)
    if (exons.length === 0) return null
    const first = exons[0]
    const last = exons[exons.length - 1]
    const forward = Number(gene.strand) >= 0
    const rowIndex = Math.max(0, Number(gene.row) || 0)
    // Rows run outward from the ruler in both directions: the innermost row of
    // each strand is the one nearest the line it belongs to.
    const bandTop = forward
      ? rulerY - rulerHeight / 2 - (rowIndex + 1) * rowHeight
      : rulerY + rulerHeight / 2 + rowIndex * rowHeight
    return {
      id: gene.id,
      name: gene.name,
      strand: forward ? 1 : -1,
      x: first.x,
      width: Math.max(1.5, last.x + last.width - first.x),
      exons,
      exonHeight,
      // The intron line runs through the middle of the exon blocks.
      y: bandTop + (rowHeight - exonHeight) / 2,
      centerY: bandTop + rowHeight / 2,
      labelY: bandTop + (rowHeight - exonHeight) / 2 - 2,
    }
  }).filter(Boolean)

  return {
    width,
    height,
    region: { chrom: String(region?.chrom || ''), start, end },
    track: { left, right, width: trackWidth },
    ruler: { y: rulerY, left, right, ticks, height: rulerHeight },
    genes: laid,
  }
}

/** How the region reads under the preview, in the browser's own wording. */
export function previewRegionLabel(region = PREVIEW_REGION) {
  const chrom = String(region?.chrom || '')
  const start = Number(region?.start) || 0
  const end = Number(region?.end) || 0
  return `${chrom}:${start.toLocaleString()}-${end.toLocaleString()}`
}
