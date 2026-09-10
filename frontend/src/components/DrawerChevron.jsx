/** The same collapse arrow used by the browser's focus-gene drawer. */
export default function DrawerChevron({ pointsRight, size = 20 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points={pointsRight ? '9 6 15 12 9 18' : '15 6 9 12 15 18'} /></svg>
}
