import { useLayoutEffect, useRef } from 'react'

export default function useRowFocus(genomeKey, navigation, detail) {
    const rowsRef = useRef(null)
    const positionedRef = useRef('')

    useLayoutEffect(() => {
        const rows = rowsRef.current
        if (!rows || !navigation || detail?.status !== 'ready') {
            positionedRef.current = ''
            return
        }
        const identity = `${genomeKey}/${navigation.id}/${detail.data.source_token}`
        if (positionedRef.current === identity) return
        positionedRef.current = identity
        const root = rows.closest('[data-homology-workspace]')
        if (root) root.scrollTop += rows.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop
        const rowId = detail.data.focus_row_id
        const target = rowId == null ? null : [...rows.querySelectorAll('[data-homology-row-id]')].find(row => row.dataset.homologyRowId === String(rowId))
        // Keep the column headings visible above the selected row. Near the end
        // of a short page the browser naturally clamps to the nearest position.
        const headerHeight = rows.querySelector('thead')?.getBoundingClientRect().height || 0
        rows.scrollTop = target ? rows.scrollTop + target.getBoundingClientRect().top - rows.getBoundingClientRect().top - headerHeight : 0
        rows.focus({ preventScroll: true })
    }, [genomeKey, navigation, detail])

    return rowsRef
}
