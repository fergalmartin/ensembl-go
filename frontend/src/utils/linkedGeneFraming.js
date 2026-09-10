// Preserve the usual five-prime placement where there is room. Small genome slices
// may need a centred placement to keep every panel from clamping independently.
export function linkedGeneFraming(entries, anchorStrand) {
  const frame = (ratio) => {
    const required = Math.max(...entries.map(({ gene }) => Math.max(1, Math.abs(gene.end - gene.start)) / (gene.strand === '+' ? 1 - ratio : ratio)))
    return { ratio, span: Math.max(2000, required * 1.12) }
  }
  const fits = ({ ratio, span }) => entries.every(({ gene, bounds, frameRange }) => {
    if (!bounds) return true
    const fivePrime = Number(gene.strand === '-' ? gene.end : gene.start)
    const start = fivePrime - ratio * span, end = start + span
    const actual = frameRange?.(start, end) || { start, end }
    return actual.start >= bounds.start && actual.end <= bounds.end
  })
  const preferred = frame(anchorStrand === '-' ? 0.75 : 0.25)
  if (fits(preferred)) return preferred
  const centred = frame(0.5)
  return fits(centred) ? centred : preferred
}
