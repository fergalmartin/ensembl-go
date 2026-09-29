import { useRef, useState } from 'react'
import AnchoredMenu from './menus.jsx'
import { menuPlacement } from './menuPlacement.js'

/**
 * The focus bar's list of every tree the focus gene is in, as one control rather than a
 * row of chips: the one showing on its face, the rest a click away. `choices` arrive in
 * the order they are listed — copies in this layer, then the original tree, then the other
 * trees in the library — each with the `group` it is listed under.
 */
export default function TreePicker({ choices, onPick, isLight }) {
  const anchor = useRef(null)
  const [menu, setMenu] = useState(null)
  const active = choices.find(c => c.active) || choices[0]
  const groups = []
  for (const choice of choices) {
    const last = groups[groups.length - 1]
    if (last && last.name === choice.group) last.items.push(choice)
    else groups.push({ name: choice.group, items: [choice] })
  }
  return (
    <span ref={anchor} className="gt-tree-picker">
      <button type="button" className={`gt-tree-picker-button${menu ? ' menu-open' : ''}`} aria-expanded={Boolean(menu)} aria-haspopup="dialog"
        title="Trees with this gene" onClick={() => setMenu(menu ? null : menuPlacement(anchor.current, 320))}>
        <strong>{active.label}</strong>
        <span>{active.group}</span>
        <em>{choices.length} trees</em>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <AnchoredMenu isLight={isLight} anchorRef={anchor} position={menu} onClose={() => setMenu(null)} title="Trees with this gene">
        {groups.map(group => (
          <div key={group.name} className="gt-tree-picker-group">
            <div className="gt-tree-picker-heading">{group.name}</div>
            {group.items.map(choice => (
              <button key={choice.key} type="button" className={`gt-menu-option${choice.active ? ' selected' : ''}`}
                aria-current={choice.active || undefined} onClick={() => { setMenu(null); onPick(choice) }}>
                <strong>{choice.label}</strong>
                <span>{choice.detail}</span>
              </button>
            ))}
          </div>
        ))}
      </AnchoredMenu>
    </span>
  )
}
