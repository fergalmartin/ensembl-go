import { heatColorFromFraction } from '../TranscriptSplicingHeatmap'
import { formatCoord, formatPercent } from './featureExplorerModel.js'

/**
 * A small bar chart of exon coverage along the gene, 5' on the left as the
 * transcript rows draw it. Each bar is one slice of the span; its height is
 * the mean coverage of that slice's exonic bases, in the heatmap's colours.
 */
export function ExonCoverageProfileChart({ cell, stats, strand, chrom, isLight }) {
  const bins = Array.isArray(cell?.bins) ? cell.bins : []
  const chartHeight = 40
  const muted = isLight ? 'text-gray-500' : 'text-gray-400'
  const guide = isLight ? '#d1d5db' : '#4b5563'
  const chromLabel = String(chrom || '').trim()
  const fivePrime = strand === '-' ? stats?.spanEnd : stats?.spanStart
  const threePrime = strand === '-' ? stats?.spanStart : stats?.spanEnd
  return (
    <div className="col-span-2 flex flex-col" style={{ height: `${cell.height}px` }}>
      <div className="h-5 truncate" title={cell.hint}>{cell.label}</div>
      <div className="flex items-stretch gap-1.5">
        <div className={`w-8 shrink-0 flex flex-col justify-between text-right text-[9px] leading-none ${muted}`} style={{ height: `${chartHeight + 4}px` }}>
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <svg
          className="flex-1 min-w-0"
          style={{ height: `${chartHeight + 4}px` }}
          viewBox={`0 -2 ${bins.length} ${chartHeight + 4}`}
          preserveAspectRatio="none"
        >
          {[0, chartHeight / 2].map((y) => (
            <line key={`guide-${y}`} x1={0} x2={bins.length} y1={y} y2={y} stroke={guide} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1={0} x2={bins.length} y1={chartHeight} y2={chartHeight} stroke={guide} vectorEffect="non-scaling-stroke" />
          {bins.map((bin, index) => {
            const hasExon = bin.meanCoverageFraction !== null && bin.meanCoverageFraction !== undefined
            const barHeight = hasExon ? Math.max(1.5, bin.meanCoverageFraction * chartHeight) : 0
            const range = `${chromLabel ? `${chromLabel}:` : ''}${formatCoord(Math.min(bin.start, bin.end))}–${formatCoord(Math.max(bin.start, bin.end))}`
            return (
              <g key={`profile-${bin.start}`}>
                {hasExon && (
                  <rect
                    x={index + 0.1}
                    y={chartHeight - barHeight}
                    width={0.8}
                    height={barHeight}
                    fill={heatColorFromFraction(bin.meanCoverageFraction)}
                    pointerEvents="none"
                  />
                )}
                <rect x={index} y={-2} width={1} height={chartHeight + 4} fill="transparent">
                  <title>
                    {hasExon
                      ? `${range} · ${formatCoord(bin.exonicBases)} of ${formatCoord(bin.length)} bp exonic · ${formatPercent(bin.meanCoverageFraction)} avg coverage`
                      : `${range} · no exonic bases`}
                  </title>
                </rect>
              </g>
            )
          })}
        </svg>
      </div>
      <div className={`flex justify-between pl-[38px] text-[9px] leading-4 ${muted}`}>
        <span>5′ · {formatCoord(fivePrime)}</span>
        <span>{formatCoord(threePrime)} · 3′</span>
      </div>
    </div>
  )
}
