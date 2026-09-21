/**
 * Hand a piece of text to the browser as a file to save.
 *
 * Its own module because two callers use it -- the bar over the sequence and the
 * bar over a selection -- and neither is a good home for the other: a helper
 * exported from a component file is a helper that cannot be moved without
 * touching what draws.
 */
export function saveTextFile({ text = '', file = 'download.txt', type = 'text/plain;charset=utf-8' } = {}) {
    if (!text) return
    const url = URL.createObjectURL(new Blob([text], { type }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Given back on the next turn of the loop rather than immediately: a revoked
    // URL is a cancelled download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0)
}
