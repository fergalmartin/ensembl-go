export default function ScreenshotModeButton({
  active = false,
  disabled = false,
  isLight = false,
  onClick,
  buttonRef = null,
  title = '',
  activeTitle = '',
  inactiveTitle = '',
  size = 30,
}) {
  const resolvedTitle = title || (active ? activeTitle : inactiveTitle)

  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      disabled={disabled}
      aria-label={resolvedTitle}
      className="flex-shrink-0 flex items-center justify-center text-xs rounded-md transition-colors"
      style={{
        backgroundColor: active ? (isLight ? '#ffffff' : '#1E2938') : (isLight ? '#0099ff' : '#0077cc'),
        color: active ? (isLight ? '#4b5563' : '#9ca3af') : '#ffffff',
        border: `1px solid ${active ? (isLight ? '#d1d5db' : '#4b5563') : 'transparent'}`,
        width: `${size}px`,
        minWidth: `${size}px`,
        height: `${size}px`,
        minHeight: `${size}px`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
      title={resolvedTitle}
    >
      <svg
        width="23"
        height="23"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3.2 8V5.4A2.2 2.2 0 0 1 5.4 3.2H8" />
        <path d="M20.8 8V5.4A2.2 2.2 0 0 0 18.6 3.2H16" />
        <path d="M3.2 16v2.6a2.2 2.2 0 0 0 2.2 2.2H8" />
        <path d="M20.8 16v2.6a2.2 2.2 0 0 1-2.2 2.2H16" />
        <rect x="6.35" y="6.75" width="11.3" height="10.5" rx="2.7" />
        <circle cx="12" cy="12" r="2.35" />
        {!active && <path d="M16.6 8l1.45-1.45" />}
        {active && (
          <>
            <path d="M7.2 7.2l9.6 9.6" />
            <path d="M16.8 7.2l-9.6 9.6" />
          </>
        )}
      </svg>
    </button>
  )
}
