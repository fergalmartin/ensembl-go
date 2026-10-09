import { DownloadMark } from '../appIconMarks'
import ProgressGlyph from '../ProgressGlyph'

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
export const IconUpDown = ({ open, size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
        <polyline points="6 9 12 15 18 9" />
    </svg>
)

export const IconDownload = ({ size = 16, progress = null }) => (
    <ProgressGlyph size={size} progress={progress} renderGlyph={(props) => <DownloadMark {...props} />} />
)

export const IconDownloaded = ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10.4" />
        <path d="M7 12.4l3.1 3.1L17.4 8.2" />
    </svg>
)

export const IconFiles = ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8M8 17h5" />
    </svg>
)

export const IconTrash = ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
    </svg>
)

export const IconSearch = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
)
