// The sequence view as a standalone web page.
//
// The same row model the RTF writer takes, said in the other language every
// document tool understands: pasting this into a mail client, a wiki or a
// Google Doc keeps the colours, where a .rtf attachment has to be opened first.
//
// One file with nothing linked from it -- the styles are inline and the colours
// are on the cells -- so it survives being mailed, dropped in a folder or
// opened from a USB stick, which a page that fetched a stylesheet would not.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

export function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"]/g, (character) => ESCAPES[character])
}

/** A cell's inline style, or '' where it wears nothing. */
function cellStyle(cell) {
    const parts = []
    if (cell.bg) parts.push(`background:${cell.bg}`)
    // An outlined class is a rule over and under the run rather than a fill, as
    // it is on screen: it marks sequence *of* a kind rather than the feature
    // itself, and filling it here would say the stronger thing.
    const shadows = []
    if (cell.outline) {
        shadows.push(`inset 0 1px 0 0 ${cell.outline}`, `inset 0 -1px 0 0 ${cell.outline}`)
    }
    // The overlap rule, over whatever the base already wears -- a base two genes
    // share is still coding or still intronic, so this goes on top rather than
    // instead.
    if (cell.underline) shadows.push(`inset 0 -2px 0 0 ${cell.underline}`)
    if (shadows.length) parts.push(`box-shadow:${shadows.join(',')}`)
    parts.push(`color:${cell.outline || cell.fg}`)
    return parts.join(';')
}

function writeCells(cells) {
    let out = ''
    let open = null
    let run = ''
    const flush = () => {
        if (!run) return
        out += open ? `<span style="${open}">${escapeHtml(run)}</span>` : escapeHtml(run)
        run = ''
    }
    for (const cell of cells) {
        const style = cellStyle(cell)
        if (style !== open) {
            flush()
            open = style
        }
        run += cell.ch === ' ' ? '\u00a0' : cell.ch
    }
    flush()
    return out
}

const PAGE_CSS = `
:root { color-scheme: light; }
body { margin: 24px; background: #ffffff; color: #0f172a;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; }
.meta { font-size: 12px; color: #64748b; margin: 0 0 20px; }
section { margin: 0 0 28px; }
h2 { font-size: 14px; margin: 0 0 2px; }
.detail { font-size: 12px; color: #64748b; margin: 0 0 8px; }
pre { margin: 0; font: 12px/1.35 "SFMono-Regular", Menlo, Consolas, "Courier New", monospace;
  white-space: pre; overflow-x: auto; }
.gutter { color: #94a3b8; }
.amino { color: #475569; }
@media print { body { margin: 0; } pre { font-size: 10px; } }
`.trim()

const GUTTER_PAD = 12
/** The space between a coordinate and the first base of its row. */
const GUTTER_GAP = '\u00a0\u00a0'

function gutter(value, align) {
    const text = value === null || value === undefined ? '' : String(value)
    return align === 'right' ? text.padStart(GUTTER_PAD, '\u00a0') : text.padEnd(GUTTER_PAD, '\u00a0')
}

/**
 * A streamed export, in the same shape as the RTF writer.
 *
 * Nothing here has to be declared up front -- the colours are on the cells --
 * but it follows the same contract so the runner drives both the same way.
 */
export function htmlWriter({
    title = 'Sequence',
    subtitle = '',
    headings = true,
    gutters = true,
} = {}) {
    return {
        head: () => [
            '<!doctype html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="utf-8">',
            `<title>${escapeHtml(title)}</title>`,
            `<style>${PAGE_CSS}</style>`,
            '</head>',
            '<body>',
            `<h1>${escapeHtml(title)}</h1>`,
            subtitle ? `<p class="meta">${escapeHtml(subtitle)}</p>` : '',
            '',
        ].filter(Boolean).join('\n'),
        recordHead(meta) {
            const detail = [
                meta.detail,
                `${meta.chrom}:${meta.start}-${meta.end}`,
                meta.strand === '-' ? 'reverse strand' : 'forward strand',
                meta.collapsed ? `${meta.hidden.toLocaleString()} bp collapsed` : '',
            ].filter(Boolean).join(' \u00b7 ')
            return [
                '<section>',
                headings ? `<h2>${escapeHtml(meta.label || meta.chrom)}</h2>` : '',
                headings ? `<p class="detail">${escapeHtml(detail)}</p>` : '',
                '<pre>',
            ].filter(Boolean).join('\n')
        },
        rows(rows) {
            const lines = []
            for (const row of rows || []) {
                if (row.amino && row.amino.trim()) {
                    const pad = gutters ? gutter('', 'right') + GUTTER_GAP : ''
                    lines.push(`<span class="amino">${escapeHtml(pad)}${escapeHtml(row.amino).replace(/ /g, '\u00a0')}</span>`)
                }
                const left = gutters
                    ? `<span class="gutter">${escapeHtml(gutter(row.left, 'right'))}</span>${GUTTER_GAP}`
                    : ''
                const right = gutters && row.right !== null
                    ? `${GUTTER_GAP}<span class="gutter">${escapeHtml(String(row.right))}</span>`
                    : ''
                lines.push(`${left}${writeCells(row.cells)}${right}`)
            }
            return lines.length ? `${lines.join('\n')}\n` : ''
        },
        recordTail: () => '</pre>\n</section>\n',
        tail: () => '</body>\n</html>\n',
    }
}

/** The whole export in one string; the streamed writer driven to the end. */
export function htmlDocument(documents, options = {}) {
    const writer = htmlWriter(options)
    const parts = [writer.head()]
    for (const document_ of documents || []) {
        parts.push(writer.recordHead(document_))
        parts.push(writer.rows(document_.rows))
        parts.push(writer.recordTail())
    }
    parts.push(writer.tail())
    return parts.join('')
}
