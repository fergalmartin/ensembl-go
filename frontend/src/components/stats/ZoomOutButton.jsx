export function ZoomOutButton({ active, onClick, isLight, title = 'Zoom out', className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!active}
      title={title}
      className={`rounded-md border transition-colors w-8 h-8 flex items-center justify-center ${active
        ? (isLight
          ? 'bg-[#0099ff] text-white border-[#0088ee] hover:bg-[#0088ee] shadow-sm shadow-blue-200'
          : 'bg-blue-600 text-white border-blue-500 hover:bg-blue-500 shadow-sm shadow-blue-950/50')
        : (isLight
          ? 'bg-gray-100 text-gray-400 border-gray-300'
          : 'bg-gray-800 text-gray-500 border-gray-700')
        } ${className}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.35" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" />
        <line x1="7.7" y1="11" x2="14.3" y2="11" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" />
      </svg>
    </button>
  )
}
