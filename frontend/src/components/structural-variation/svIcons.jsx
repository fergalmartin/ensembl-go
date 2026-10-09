export const IconUpDown = ({ open, size = 12 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

export function CopyGlyph({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="5" width="14" height="16" rx="2.2" />
      <path d="M9 3h6v4H9z" />
    </svg>
  )
}

export function CenterAlignmentIcon({ className = '' }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <path d="M1.6 1.6h12.8" />
      <path d="M1.6 3.7h12.8" />
      <path d="M1.6 5.8h12.8" />
      <path d="M1.6 8h12.8" />
      <path d="M1.6 10.2h12.8" />
      <path d="M1.6 12.3h12.8" />
      <path d="M1.6 14.4h12.8" />
    </svg>
  )
}

export function SelectionZoomIcon({ className = '' }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="16" height="16" rx="2.2" strokeWidth="2.2" strokeDasharray="3.2 2.2" />
      <path d="M21 16.8v5.2M18.4 19.4h5.2" strokeWidth="2.2" />
    </svg>
  )
}
