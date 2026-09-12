/** Sorted, disjoint [start, end, colour] layers in source-sequence coordinates. */
export function firstMotifSpan(spans, column) {
  let low = 0, high = spans.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (spans[mid][1] <= column) low = mid + 1
    else high = mid
  }
  return low
}

/** Paint only the visible part of a prepared colour layer on any sequence canvas. */
export function paintMotifSpan(ctx, { spans, start, end, x, scale, fragmentStart, y, height }) {
  for (let i = firstMotifSpan(spans, start); i < spans.length && spans[i][0] < end; i++) {
    const [a, z, color] = spans[i], left = Math.max(a, start), right = Math.min(z, end)
    ctx.fillStyle = color
    ctx.fillRect(x + (left - fragmentStart) * scale, y, (right - left) * scale, height)
  }
}
