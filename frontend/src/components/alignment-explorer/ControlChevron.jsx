/** The one drop-down mark in the bar. A drawn chevron rather than the ▾ glyph:
 * at the size the glyph is legible it is already too tall for the row, and it
 * is drawn at a different weight in every fallback font. This one is the same
 * stroke as the rest of the bar's line work at every size. */
export default function ControlChevron() {
  return <svg className="al-control-chevron" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
    <path d="M3.2 5.1 L6.5 8.4 L9.8 5.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
}
