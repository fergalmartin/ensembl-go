export function ExonInfoPopup({ exonInfo, counts, resolvedGene, popupRef = null }) {
  const { exonState, typeLabel, arrowTargetX, arrowTargetY } = exonInfo
  const { sameBoundary, sameState, total } = counts
  const popupW = 260
  const arrowSize = 8
  const gap = 4
  const safeArrowX = Number.isFinite(Number(arrowTargetX)) ? Number(arrowTargetX) : 24
  const safeArrowY = Number.isFinite(Number(arrowTargetY)) ? Number(arrowTargetY) : 24
  const spaceLeft = safeArrowX - arrowSize - gap
  const goLeft = spaceLeft >= popupW
  const left = goLeft
    ? safeArrowX - popupW - arrowSize - gap
    : safeArrowX + arrowSize + gap
  const chrom = String(resolvedGene?.chrom || exonState.chrom || '')
  const coordLabel = chrom
    ? `${chrom}:${Math.min(exonState.start, exonState.end).toLocaleString()}–${Math.max(exonState.start, exonState.end).toLocaleString()}`
    : `${Math.min(exonState.start, exonState.end).toLocaleString()}–${Math.max(exonState.start, exonState.end).toLocaleString()}`

  return (
    <div
      ref={popupRef}
      className="fixed z-40 rounded-lg shadow-xl text-[12px] leading-relaxed"
      style={{
        left,
        top: safeArrowY,
        transform: 'translateY(-50%)',
        width: popupW,
        backgroundColor: 'rgba(17, 24, 39, 0.97)',
        color: '#f1f5f9',
        padding: '10px 14px',
        border: '1px solid rgba(255,255,255,0.1)',
        pointerEvents: 'none',
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
        zIndex: 60,
      }}
    >
      <div style={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        [goLeft ? 'right' : 'left']: -arrowSize,
        width: 0,
        height: 0,
        borderTop: `${arrowSize}px solid transparent`,
        borderBottom: `${arrowSize}px solid transparent`,
        [goLeft ? 'borderLeft' : 'borderRight']: `${arrowSize}px solid rgba(17,24,39,0.97)`,
      }}>
      </div>
      <div>Exon <span style={{ fontWeight: 700 }}>{coordLabel}</span></div>
      <div>Type <span style={{ fontWeight: 700 }}>{typeLabel}</span></div>
      <div>Length <span style={{ fontWeight: 700 }}>{(exonState.length ?? Math.abs(exonState.end - exonState.start)).toLocaleString()} bp</span></div>
      <div>
        Transcripts <span style={{ fontWeight: 700 }}>{sameBoundary} of {total}</span>
        {sameState !== sameBoundary ? <span> ({sameState} same state)</span> : null}
      </div>
    </div>
  )
}
