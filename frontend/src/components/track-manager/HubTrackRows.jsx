import { useState } from 'react'
import { HUB_TRACK_OVERSCAN, HUB_TRACK_ROW_HEIGHT, HUB_TRACK_VIRTUALIZED_MAX_HEIGHT, HUB_TRACK_VIRTUALIZE_THRESHOLD } from './trackManagerModel.js'

export function HubTrackRows({ rows, renderRow, isLight }) {
    const [scrollTop, setScrollTop] = useState(0)
    if (!Array.isArray(rows) || rows.length === 0) return null

    if (rows.length <= HUB_TRACK_VIRTUALIZE_THRESHOLD) {
        return (
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
                {rows.map((row, idx) => renderRow(row, idx))}
            </div>
        )
    }

    const viewportHeight = HUB_TRACK_VIRTUALIZED_MAX_HEIGHT
    const totalHeight = rows.length * HUB_TRACK_ROW_HEIGHT
    const visibleCount = Math.ceil(viewportHeight / HUB_TRACK_ROW_HEIGHT) + HUB_TRACK_OVERSCAN * 2
    const startIndex = Math.max(0, Math.floor(scrollTop / HUB_TRACK_ROW_HEIGHT) - HUB_TRACK_OVERSCAN)
    const endIndex = Math.min(rows.length, startIndex + visibleCount)
    const topPad = startIndex * HUB_TRACK_ROW_HEIGHT
    const bottomPad = Math.max(0, totalHeight - (endIndex * HUB_TRACK_ROW_HEIGHT))
    const windowRows = rows.slice(startIndex, endIndex)

    return (
        <div
            className={`overflow-y-auto ${isLight ? 'bg-white' : 'bg-transparent'}`}
            style={{ maxHeight: viewportHeight }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
            <div style={{ height: topPad }} />
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
                {windowRows.map((row, idx) => renderRow(row, startIndex + idx))}
            </div>
            <div style={{ height: bottomPad }} />
        </div>
    )
}
