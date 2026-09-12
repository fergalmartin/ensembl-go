import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { menuPosition, useMenuDismiss } from './menuAnchor'
import { COLOUR_SCHEMES, SHADING_MODES, schemeById } from './colourSchemes'
import { palettesOfKind, basePalette, defaultPalette } from './palettes'
import { buildRamp } from './conservation'
import ColourLegend from './ColourLegend'
import MotifEditor from './MotifEditor'
import { motifLegend } from './motifs'

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
  motifs, motifsSaved, config, hideUnmatched, onApply, disabled }) {
  const [anchor, setAnchor] = useState(null), [draft, setDraft] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const button = useRef(null)
  const close = useCallback(() => { setAnchor(null); setDraft(null) }, [])
  useMenuDismiss(!!anchor && !pickerOpen, close, button, 'al-tool-menu')
  const open = () => {
    if (anchor) { close(); return }
    setDraft({ scheme, palette: { ...palette }, shading, legendOverlay, motifs, hideUnmatched })
    setAnchor(menuPosition(button.current))
  }
  const edit = value => setDraft(current => ({ ...current, ...value }))
  const active = schemeById(draft?.scheme ?? scheme)
  const chosen = active.palettes ? (draft?.palette ?? palette)?.[active.id] || defaultPalette(active.palettes) : null
  const legend = active.id === 'motif' ? motifLegend(draft?.motifs ?? motifs) : active.legend?.(light, scale, chosen, draft?.shading ?? shading)
  return <>
    <div className="al-split" ref={button}>
      <button className="al-split-main" disabled={disabled} aria-label={`Colour: ${schemeById(scheme).label}. Open colour options.`}
        title="Choose colouring and apply changes" onClick={open}>Colour</button>
      <button className="al-split-arrow" disabled={disabled} aria-label="Colour options" aria-expanded={!!anchor}
        title="Choose a scheme, its palette and its key" onClick={open}>▾</button>
    </div>
    {anchor && draft && root && createPortal(<div className={`al-tool-menu al-colour-menu ${active.id === 'motif' ? 'al-motif-menu' : ''}`} role="dialog" aria-label="Colour" style={{...anchor, maxHeight: `calc(100vh - ${anchor.top + 12}px)`}}>
      <div className="al-menu-tabs" role="tablist" aria-label="What a cell's colour means">
        {COLOUR_SCHEMES.map(option => <button key={option.id} type="button" role="tab"
          aria-selected={option.id === active.id} className={option.id === active.id ? 'selected' : ''}
          onClick={() => edit({ scheme: option.id })}>{option.label}</button>)}
      </div>
      <div className="al-menu-tab" role="tabpanel">
        <small className="al-menu-hint">{active.hint}</small>
        {active.id === 'motif' && <MotifEditor motifs={draft.motifs} onChange={motifs => edit({ motifs })} light={light} config={config}
          saved={motifsSaved} onPicker={setPickerOpen}
          hideUnmatched={draft.hideUnmatched} onHideUnmatched={hideUnmatched => edit({ hideUnmatched })} />}
        {!!active.shading && <div className="al-shading-row" role="group" aria-label="Shading below base resolution">
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
          onChange={event => edit({ legendOverlay: event.target.checked })} />Show this key on the alignment</label>
      </div>
      <div className="al-menu-actions"><button onClick={close}>Cancel</button><button className="primary" onClick={() => { onApply(draft); close() }}>Apply</button></div>
    </div>, root)}
  </>
}
