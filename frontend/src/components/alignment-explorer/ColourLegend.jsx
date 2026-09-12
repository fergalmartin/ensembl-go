/** A colour key, as data rather than a hand-written diagram: each scheme
 * describes its own, so adding one never means editing this.
 *
 * Two shapes, told apart by `kind`. A ramp is one ordered bar with its ends
 * labelled; a set of swatches is unordered and labels each one. Everything else
 * - the note, the cohort line, where it is drawn - is the same for both.
 *
 * `inline` is the copy inside the Colour menu, which is always there. Without
 * it this is the overlay on the alignment itself, which the reader can turn off
 * from the menu or dismiss with the cross that appears when they reach for it.
 */
export default function ColourLegend({ legend, cohort, inline = false, onDismiss }) {
  if (!legend) return null
  const cohortLine = cohort
    ? ` ${cohort.ids.length} ${cohort.ids.length === 1 ? 'sequence' : 'sequences'}${cohort.picked ? ' picked' : ' in view'}.`
    : ''
  const described = legend.kind === 'swatches'
    ? `${legend.swatches.map(s => s.label).join(', ')}. ${legend.note}`
    : `${legend.across}, ${legend.low} to ${legend.high}. ${legend.down}. ${legend.note}`
  return <div className={`al-legend ${inline ? 'al-legend-inline' : 'al-legend-overlay'}`}
    role="img" aria-label={described}>
    {legend.kind === 'swatches'
      ? <div className="al-legend-swatches">{legend.swatches.map(swatch =>
        <span key={swatch.label}><i style={{ background: swatch.colour }} />{swatch.label}</span>)}</div>
      : <>
        <div className="al-legend-bar">{legend.bar.map((colour, i) => <span key={i} style={{ background: colour }} />)}</div>
        <div className="al-legend-ends"><small>{legend.low}</small><small>{legend.across}</small><small>{legend.high}</small></div>
        {!!legend.heights.length && <div className="al-legend-heights">
          <div>{legend.heights.map((h, i) => <span key={i}><i style={{ height: `${Math.round(h * 100)}%` }} /></span>)}</div>
          <small>{legend.down}</small>
        </div>}
      </>}
    <small className="al-legend-note">{legend.note}{cohortLine}</small>
    {!inline && !!onDismiss && <button className="al-legend-close" aria-label="Hide this colour key"
      title="Hide this key. Bring it back from the Colour menu." onClick={onDismiss}>×</button>}
  </div>
}
