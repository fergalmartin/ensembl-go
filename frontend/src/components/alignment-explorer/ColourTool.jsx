import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { menuPosition, toastPosition, useMenuDismiss } from './menuAnchor'
import ToolToast from './ToolToast'
import { COLOUR_SCHEMES, SHADING_MODES, schemeById } from './colourSchemes'
import { palettesOfKind, basePalette, defaultPalette } from './palettes'
import { buildRamp } from './conservation'
import ColourLegend from './ColourLegend'

/** A swatch of what a palette looks like, built from the palette itself rather
 * than drawn by hand, so a palette can never be advertised in colours it does
 * not paint in. */
function Swatch({ kind, id, light }) {
  if (kind === 'base') {
    const colours = basePalette(id, light)
    return <span className="al-swatch">{['baseA', 'baseC', 'baseG', 'baseT'].map(key =>
      <i key={key} style={{ background: colours[key] }} />)}</span>
  }
  const ramp = buildRamp(light, id)
  return <span className="al-swatch" style={{ background: `linear-gradient(90deg, ${ramp.join(',')})` }} />
}

/** The Colour menu: one tab per scheme, and on each tab the things that belong
 * to that scheme - what it means, what it can be painted in, and its key.
 *
 * The tab *is* the choice. A tab strip that only previewed a scheme, with a
 * separate control to apply it, would be two ways of saying one thing.
 *
 * The button itself cycles. Comparing schemes means going back and forth
 * between two of them, and doing that through a menu is three actions each way;
 * the arrow is still there for choosing one directly, or for anything on the
 * tab. Since the button carries no mode, the scheme it lands on flashes above
 * it - the sheet recolouring behind the reader's eye is not an answer.
 */
export default function ColourTool({ scheme, palette, shading, legendOverlay, cohort, scale, light, root,
  onScheme, onPalette, onShading, onOverlay }) {
  const [anchor, setAnchor] = useState(null)
  const [toast, setToast] = useState(null)
  const button = useRef(null)
  const close = useCallback(() => setAnchor(null), [])
  useMenuDismiss(!!anchor, close, button, 'al-tool-menu')
  const active = schemeById(scheme)
  const chosen = palette?.[active.id] || defaultPalette(active.palettes)
  const legend = active.legend?.(light, scale, chosen, shading)
  const cycle = () => {
    const next = COLOUR_SCHEMES[(COLOUR_SCHEMES.findIndex(s => s.id === active.id) + 1) % COLOUR_SCHEMES.length]
    onScheme(next.id)
    setToast({ label: next.label, at: toastPosition(button.current), key: Date.now() })
  }
  return <>
    <div className="al-split" ref={button}>
      <button className="al-split-main" aria-label={`Colour: ${active.label}. Click for the next scheme.`}
        title={`Colour: ${active.label}. ${active.hint} Click for the next scheme.`}
        onClick={cycle}>Colour</button>
      <button className="al-split-arrow" aria-label="Colour options" aria-expanded={!!anchor}
        title="Choose a scheme, its palette and its key"
        onClick={() => setAnchor(open => open ? null : menuPosition(button.current))}>▾</button>
    </div>
    {anchor && root && createPortal(<div className="al-tool-menu al-colour-menu" role="dialog" aria-label="Colour" style={anchor}>
      <div className="al-menu-tabs" role="tablist" aria-label="What a cell's colour means">
        {COLOUR_SCHEMES.map(option => <button key={option.id} type="button" role="tab"
          aria-selected={option.id === active.id} className={option.id === active.id ? 'selected' : ''}
          onClick={() => onScheme(option.id)}>{option.label}</button>)}
      </div>
      <div className="al-menu-tab" role="tabpanel">
        <small className="al-menu-hint">{active.hint}</small>
        {!!active.shading && <div className="al-shading-row" role="group" aria-label="Shading below base resolution">
          {SHADING_MODES.map(option => <button key={option.id} type="button"
            className={`al-shading ${option.id === (shading || SHADING_MODES[0].id) ? 'selected' : ''}`}
            aria-pressed={option.id === (shading || SHADING_MODES[0].id)} title={option.hint}
            onClick={() => onShading(option.id)}>
            <strong>{option.label}</strong><small>{option.hint}</small></button>)}
        </div>}
        {/* The palettes go unnamed. A swatch is the thing itself, where a name
            is a word about it, and four words across a row read as choices to
            be understood before one can be picked. */}
        <div className="al-palette-row" role="group" aria-label="Palette">
          {palettesOfKind(active.palettes).map(option => <button key={option.id} type="button"
            className={`al-palette ${option.id === chosen ? 'selected' : ''}`}
            aria-pressed={option.id === chosen} aria-label={option.label} title={`${option.label} - ${option.note}`}
            onClick={() => onPalette(active.id, option.id)}>
            <Swatch kind={active.palettes} id={option.id} light={light} /></button>)}
        </div>
        <ColourLegend legend={legend} cohort={active.cohort ? cohort : null} inline />
        <label className="al-menu-check"><input type="checkbox" checked={!!legendOverlay}
          onChange={event => onOverlay(event.target.checked)} />Show this key on the alignment</label>
      </div>
    </div>, root)}
    <ToolToast toast={toast} root={root} onDone={() => setToast(null)} />
  </>
}
