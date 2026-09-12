import { firstMotifSpan } from './motifs.js'

export function paintMotifSpan(ctx, { spans, start, end, x, scale, fragmentStart, y, height }) {
  for (let i = firstMotifSpan(spans, start); i < spans.length && spans[i][0] < end; i++) {
    const [a, z, color] = spans[i], left = Math.max(a, start), right = Math.min(z, end)
    ctx.fillStyle = color
    ctx.fillRect(x + (left - fragmentStart) * scale, y, (right - left) * scale, height)
  }
}
