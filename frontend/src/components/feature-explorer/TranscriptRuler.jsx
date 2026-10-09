import { FONT_MONO } from '../../utils/typography.js'
import { formatCoord, transcriptLength } from './featureExplorerModel.js'

export function TranscriptRuler({
  longestTranscript,
  isLight,
  viewBoxWidth,
  palette,
  leftMargin,
  rightMargin,
  reverseOrientation,
}) {
  if (!longestTranscript) {
    return (
      <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
        No active transcript available for ruler coordinates.
      </div>
    )
  }

  const axisLeft = leftMargin
  const axisRight = viewBoxWidth - rightMargin
  const axisWidth = Math.max(1, axisRight - axisLeft)
  const start = Number(longestTranscript.start)
  const end = Number(longestTranscript.end)
  const length = transcriptLength(longestTranscript)
  const fractions = [0, 0.25, 0.5, 0.75, 1]
  const axisY = 34

  const xForFraction = (fraction) => axisLeft + (axisWidth * fraction)
  const topCoordForFraction = (fraction) => (
    reverseOrientation
      ? Math.round(end - ((end - start) * fraction))
      : Math.round(start + ((end - start) * fraction))
  )
  const offsetForFraction = (fraction) => Math.max(1, Math.round(1 + ((length - 1) * fraction)))

  return (
    <svg className="w-full h-[74px]" viewBox={`0 0 ${viewBoxWidth} 74`} preserveAspectRatio="xMinYMid meet">
      <line
        x1={axisLeft}
        y1={axisY}
        x2={axisRight}
        y2={axisY}
        stroke={palette.rulerLine}
        strokeWidth="1"
      />

      {fractions.map((fraction) => {
        const x = xForFraction(fraction)
        return (
          <g key={`marker-${fraction}`}>
            <line
              x1={x}
              y1={axisY}
              x2={x}
              y2={axisY - 9}
              stroke={palette.tickMajor}
              strokeWidth="1"
            />
            <line
              x1={x}
              y1={axisY}
              x2={x}
              y2={axisY + 9}
              stroke={palette.tickMajor}
              strokeWidth="1"
            />
            <text
              x={x}
              y={14}
              textAnchor="middle"
              fontSize="12"
              fontFamily={FONT_MONO}
              fill={palette.rulerText}
            >
              {formatCoord(topCoordForFraction(fraction))}
            </text>
            <text
              x={x}
              y={66}
              textAnchor="middle"
              fontSize="12"
              fontFamily={FONT_MONO}
              fill={palette.rulerText}
            >
              {formatCoord(offsetForFraction(fraction))}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
