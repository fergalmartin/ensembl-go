import { useCallback, useId, useRef, useState } from 'react'
import ControlLabel from './ControlLabel'
import ControlChevron from './ControlChevron'
import ControlMenu from './ControlMenu'
import { menuPosition, useMenuDismiss } from './menuAnchor'
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

/** Menu edits are a draft. Only Apply can publish a new colour configuration. */
export default function ColourTool({ scheme, palette, shading, legendOverlay, cohort, scale, light, root,
  findOn = false, onApply, disabled }) {
  const [anchor, setAnchor] = useState(null), [draft, setDraft] = useState(null)
  const button = useRef(null), menuId = useId()
  const close = useCallback(() => { setAnchor(null); setDraft(null) }, [])
  useMenuDismiss(!!anchor, close, button, 'al-tool-menu')
  const open = () => {
    if (anchor) { close(); return }
    setDraft({ scheme, palette: { ...palette }, shading, legendOverlay })
    setAnchor(menuPosition(button.current))
  }
  const edit = value => setDraft(current => ({ ...current, ...value }))
  const active = schemeById(draft?.scheme ?? scheme)
  const chosen = active.palettes ? (draft?.palette ?? palette)?.[active.id] || defaultPalette(active.palettes) : null
  const legend = active.legend?.(light, scale, chosen, draft?.shading ?? shading)
  return <>
    <button ref={button} className={`al-control al-control-colour ${anchor ? 'menu-open' : ''}`} disabled={disabled}
      aria-label={`Colour: ${schemeById(scheme).label}. Colour options`} aria-haspopup="dialog" aria-expanded={!!anchor} aria-controls={anchor ? menuId : undefined}
      title="Choose how the alignment is coloured" onClick={open}>
      <ControlLabel label="Colour" value={schemeById(scheme).label}/><ControlChevron/>
    </button>
    {draft && <ControlMenu id={menuId} root={root} anchor={draft ? anchor : null} title="Colour" current={schemeById(scheme).label} className="al-colour-menu">
      <div className="al-menu-tabs" role="tablist" aria-label="Colour scheme">
        {COLOUR_SCHEMES.map(option => <button key={option.id} type="button" role="tab"
          aria-selected={option.id === active.id} className={option.id === active.id ? 'selected' : ''}
          onClick={() => edit({ scheme: option.id })}>{option.label}</button>)}
      </div>
      <div className="al-menu-tab" role="tabpanel">
        <small className="al-menu-hint">{active.hint}</small>
        {/* Said here rather than by disabling the menu: the reader may well be
            choosing what to come back to, and that is still theirs to set. */}
        {findOn && <small className="al-menu-hint al-menu-note" role="status">While Find is open, matches use the search colours. Close Find to restore the colour scheme selected here.</small>}
        {!!active.shading && <div className="al-shading-row" role="group" aria-label="Shading when zoomed out">
          {SHADING_MODES.map(option => <button key={option.id} type="button"
            className={`al-shading ${option.id === (draft.shading || SHADING_MODES[0].id) ? 'selected' : ''}`}
            aria-pressed={option.id === (draft.shading || SHADING_MODES[0].id)} title={option.hint}
            onClick={() => edit({ shading: option.id })}>
            <strong>{option.label}</strong><small>{option.hint}</small></button>)}
        </div>}
        {/* The palettes go unnamed. A swatch is the thing itself, where a name
            is a word about it, and four words across a row read as choices to
            be understood before one can be picked. */}
        {active.palettes && <div className="al-palette-row" role="group" aria-label="Palette">
          {palettesOfKind(active.palettes).map(option => <button key={option.id} type="button"
            className={`al-palette ${option.id === chosen ? 'selected' : ''}`}
            aria-pressed={option.id === chosen} aria-label={option.label} title={`${option.label} - ${option.note}`}
            onClick={() => edit({ palette: { ...draft.palette, [active.id]: option.id } })}>
            <Swatch kind={active.palettes} id={option.id} light={light} /></button>)}
        </div>}
        <ColourLegend legend={legend} cohort={active.cohort ? cohort : null} inline />
        <label className="al-menu-check"><input type="checkbox" checked={!!draft.legendOverlay}
          onChange={event => edit({ legendOverlay: event.target.checked })} />Show colour key on the alignment</label>
      </div>
      <small>Click Apply to save these settings.</small>
      <div className="al-menu-actions"><button onClick={close}>Cancel</button><button className="primary" onClick={() => { onApply(draft); close() }}>Apply</button></div>
    </ControlMenu>}
  </>
}
