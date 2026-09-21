import { useState } from 'react'
import GenomeColorPicker from '../GenomeColorPicker'
import { genomeColorPalette } from '../../genomeColorSchemes'
import { readableTextOn } from '../../utils/genomePillColors'
import { MAX_MOTIFS, moveMotif } from './motifs'

export default function MotifEditor({ motifs, onChange, light, config, errors, saved, onPicker,
  hideUnmatched, onHideUnmatched }) {
  const [dragged, setDragged] = useState(null), [over, setOver] = useState(null), [colorId, setColorId] = useState(null)
  const palette = [...new Set([...genomeColorPalette(config), ...motifs.map(m=>m.color)])], chosen = motifs.find(m => m.id === colorId)
  const patch = (id, value) => onChange(motifs.map(m => m.id === id ? { ...m, ...value } : m))
  const closePicker = () => { setColorId(null); onPicker(false) }
  return <div className="al-motifs">
    <small>Highest priority at the top: where two patterns cover a base, the upper one is drawn. Drag the grip to reorder, or focus it and use ↑ / ↓.</small>
    <div className="al-motif-list" aria-label="Patterns in priority order">
      {motifs.map((motif, index) => <div key={motif.id}
        className={`al-motif-row ${!motif.enabled ? 'disabled' : ''} ${over === motif.id ? 'drop-target' : ''}`}
        onDragOver={event => { if (dragged) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(motif.id) } }}
        onDrop={event => { event.preventDefault(); onChange(moveMotif(motifs, dragged, motif.id)); setDragged(null); setOver(null) }}>
        <div className="al-motif-controls">
          <button type="button" className="al-motif-grip" draggable aria-label={`Move pattern ${index + 1}`} title="Drag to reorder; arrow keys also move this one"
            onDragStart={event => { setDragged(motif.id); event.dataTransfer.setData('text/plain', motif.id); event.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => { setDragged(null); setOver(null) }}
            onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const target = motifs[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (target) onChange(moveMotif(motifs, motif.id, target.id)) } }}>⠿</button>
          <span className="al-motif-order">{index + 1}</span>
          <input type="checkbox" checked={motif.enabled} aria-label={`Search for pattern ${index + 1}`} onChange={event => patch(motif.id, { enabled: event.target.checked })} />
          <button type="button" className="al-motif-color" aria-label={`Colour for pattern ${index + 1}`} title="Change this pattern's colour"
            style={{ background: motif.color }} onClick={() => { setColorId(motif.id); onPicker(true) }} />
          <select aria-label={`How to read pattern ${index + 1}`} value={motif.kind} onChange={event => patch(motif.id, { kind: event.target.value })}>
            <option value="literal">String</option><option value="regex">Regex</option>
          </select>
          <button type="button" className="al-motif-delete" aria-label={`Delete pattern ${index + 1}`} title="Delete this pattern" onClick={() => onChange(motifs.filter(m => m.id !== motif.id))}>×</button>
        </div>
        <input className="al-motif-pattern" aria-label={`Pattern ${index + 1}`} value={motif.pattern} maxLength={500} spellCheck={false}
          placeholder={motif.kind === 'regex' ? 'e.g. ATG[ACGT]{3}' : 'e.g. ATG'} aria-invalid={!!errors?.[motif.id]}
          aria-describedby={errors?.[motif.id] ? `motif-error-${motif.id}` : undefined}
          onChange={event => patch(motif.id, { pattern: event.target.value })} />
        {!!errors?.[motif.id] && <small className="al-motif-error" id={`motif-error-${motif.id}`} role="alert">{errors[motif.id]}</small>}
      </div>)}
    </div>
    <button type="button" disabled={motifs.length >= MAX_MOTIFS} onClick={() => {
      const color = palette.find(c => !motifs.some(m => m.color === c)) || palette[motifs.length % palette.length]
      onChange([...motifs, { id: crypto.randomUUID(), pattern: '', kind: 'literal', enabled: true, color }])
    }}>+ Add a pattern</button>
    <small className={!saved ? 'al-motif-error' : ''} role="status">{!saved ? 'Could not remember these patterns on this device.' : 'Edits take effect when you Apply. Patterns are remembered on this device.'}</small>
    <label className="al-menu-check"><input type="checkbox" checked={hideUnmatched} onChange={event=>onHideUnmatched(event.target.checked)} />Hide blocks with no match</label>
    {hideUnmatched && <small role="status" >A match to any enabled pattern in any sequence keeps the block.</small>}
    <small>Case is ignored, on the displayed strand with gaps left out. Each source block is searched separately. Regex: e.g. ATG[ACGT]{'{3}'}, without / delimiters. A pattern that can match nothing highlights nothing.</small>
    <GenomeColorPicker isOpen={!!chosen} theme={light ? 'light' : 'dark'} title="Find colour" subtitle={chosen?.pattern || 'New pattern'}
      paletteHint="Choose a palette colour or mix your own. Colours your other patterns use are also available here."
      currentColor={chosen?.color} palette={palette} defaultColor={palette[0]}
      renderPreview={color => <div className="al-motif-preview" style={{ background: color, color: readableTextOn(color) }}>{chosen?.pattern || 'ATG'}</div>}
      onApply={color => patch(colorId, { color })} onClose={closePicker} />
  </div>
}
