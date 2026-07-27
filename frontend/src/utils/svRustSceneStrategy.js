export const SV_RUST_TRANSCRIPT_DETAIL_MAX_SPAN = 2_000_000
export const SV_RUST_ALIGNMENT_MIN_PAD = 200_000

function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function genomicWindowSpan(window) {
  return Math.max(1, finite(window?.end) - finite(window?.start))
}

export function shouldLoadCanonicalTranscripts(
  window,
) {
  return Boolean(window?.chrom)
}

export function shouldIncludeTranscriptExons(
  window,
  maxSpan = SV_RUST_TRANSCRIPT_DETAIL_MAX_SPAN,
) {
  return Boolean(window?.chrom) && genomicWindowSpan(window) <= maxSpan
}

export function alignmentRequestWindow(window, {
  padRatio = 0.5,
  minPad = SV_RUST_ALIGNMENT_MIN_PAD,
} = {}) {
  const span = genomicWindowSpan(window)
  const pad = Math.max(minPad, span * padRatio)
  const tileSpan = 2 ** Math.ceil(Math.log2(Math.max(minPad, span)))
  const rawStart = Math.max(1, finite(window?.start, 1) - pad)
  const rawEnd = finite(window?.end, 2) + pad
  return {
    ...window,
    start: Math.max(1, Math.floor(rawStart / tileSpan) * tileSpan),
    end: Math.min(
      finite(window?.chrom_length, Infinity) || Infinity,
      Math.ceil(rawEnd / tileSpan) * tileSpan,
    ),
  }
}

export function transcriptRequestWindow(window) {
  const span = genomicWindowSpan(window)
  const chromLength = finite(window?.chrom_length)
  // Broad views are stable chromosome-level cache entries. This prevents a fast
  // pan from exposing a succession of partially populated feature windows.
  if (span > 5_000_000 && chromLength > 1) {
    return { ...window, start: 1, end: chromLength }
  }
  return alignmentRequestWindow(window)
}

export function shouldNormalizeInitialTargetWindow(
  referenceWindow,
  targetWindow,
  { minRatio = 0.5, maxRatio = 2 } = {},
) {
  if (!referenceWindow?.chrom || !targetWindow?.chrom) return false
  const ratio = genomicWindowSpan(targetWindow) / genomicWindowSpan(referenceWindow)
  return ratio < minRatio || ratio > maxRatio
}

export function alignedInitialTargetCandidate(
  viewData,
  referenceWindow,
  targetWindow,
  options = {},
) {
  if (!shouldNormalizeInitialTargetWindow(referenceWindow, targetWindow, options)) {
    return targetWindow
  }

  const blocks = Array.isArray(viewData?.blocks) && viewData.blocks.length
    ? viewData.blocks
    : (viewData?.segments || [])
  let minTarget = Infinity
  let maxTarget = -Infinity
  for (const block of blocks) {
    const refStart = Math.min(finite(block?.ref_start), finite(block?.ref_end))
    const refEnd = Math.max(finite(block?.ref_start), finite(block?.ref_end))
    if (refEnd < referenceWindow.start || refStart > referenceWindow.end) continue
    minTarget = Math.min(minTarget, finite(block?.tgt_start), finite(block?.tgt_end))
    maxTarget = Math.max(maxTarget, finite(block?.tgt_start), finite(block?.tgt_end))
  }

  const mappedCenter = Number.isFinite(minTarget) && Number.isFinite(maxTarget) && maxTarget > minTarget
    ? (minTarget + maxTarget) / 2
    : (finite(targetWindow.start) + finite(targetWindow.end)) / 2
  const span = genomicWindowSpan(referenceWindow)
  return {
    ...targetWindow,
    chrom: String(viewData?.tgt_chrom || targetWindow.chrom),
    chrom_length: finite(viewData?.tgt_chrom_length, targetWindow.chrom_length),
    start: mappedCenter - span / 2,
    end: mappedCenter + span / 2,
  }
}
