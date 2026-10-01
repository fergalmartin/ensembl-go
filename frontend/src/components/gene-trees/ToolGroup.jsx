import { useRef, useState } from 'react'
import { menuPosition } from '../alignment-explorer/menuAnchor.js'
import { VerticalChevronGlyph } from '../focusDrawerChrome.jsx'
import AnchoredMenu from './menus.jsx'
import { NODE_MODES, TOOLS } from './tools.js'

/** The drop-down mark, drawn as the Alignment Explorer's bar draws it. */
function Chevron() {
  return (
    <svg className="gt-control-chevron" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
      <path d="M3.2 5.1 L6.5 8.4 L9.8 5.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * What the pointer does, in the Alignment Explorer's Cursor control shape: the face names
 * the mode in hand; pressing it on Regular opens the list of modes, and on any other mode
 * goes back to Regular. The arrow lists every mode.
 */
export function ToolButton({ tool, onTool, inLayer, isLight }) {
  const anchor = useRef(null)
  const [menu, setMenu] = useState(null)
  const available = TOOLS.filter(t => inLayer || !t.layerOnly)
  // A layer tool (from the bar over a layer) is not one of these: the face shows
  // Regular, unlit, and pressing it goes back to that.
  const own = TOOLS.find(t => t.id === tool)
  const current = own || TOOLS[0]
  const regular = tool === 'explore'
  const selecting = Boolean(own) && !regular
  const toggleMenu = () => setMenu(menu ? null : menuPosition(anchor.current, 340, 'gt'))
  return (
    <span ref={anchor} className={`gt-split gt-control-cursor${selecting ? ' selected' : ''}${menu ? ' menu-open' : ''}`}>
      <button type="button" className="gt-split-main" aria-pressed={selecting} onClick={() => (regular ? toggleMenu() : onTool(TOOLS[0].id))}
        title={`${current.hint} ${regular ? 'Click to choose another mode.' : `Click for ${TOOLS[0].label}.`}`}>
        <span className="gt-control-label"><span>Cursor</span><strong>{current.label}</strong></span>
      </button>
      <button type="button" className="gt-split-arrow" aria-label="Cursor options" aria-expanded={Boolean(menu)}
        title="Choose what the pointer does" onClick={toggleMenu}><Chevron /></button>
      <AnchoredMenu isLight={isLight} anchorRef={anchor} position={menu} onClose={() => setMenu(null)} title="Cursor">
        {available.map(t => (
          <button key={t.id} type="button" className={`gt-menu-option gt-tool-option${t.id === current.id ? ' selected' : ''}`}
            aria-pressed={t.id === current.id} onClick={() => { onTool(t.id); setMenu(null) }}>
            <strong>{t.label}</strong>
            <span>{t.hint}</span>
          </button>
        ))}
      </AnchoredMenu>
    </span>
  )
}

/**
 * One of a data view's settings, in the app's menu style (the Alignment Explorer's): a
 * checkbox for on/off (`kind: 'check'`, with `checked`), otherwise a row of separate
 * buttons. Choices with a `hint` are cards that say what they do under their name; a
 * choice's `swatch` (colours) shows what it paints with.
 */
function DataOption({ option }) {
  if (option.kind === 'check') {
    return (
      <label className="gt-menu-check">
        <input type="checkbox" checked={option.checked} onChange={event => option.onChange(event.target.checked)} />
        <span><strong>{option.label}</strong>{option.hint ? <small>{option.hint}</small> : null}</span>
      </label>
    )
  }
  const cards = option.choices.some(choice => choice.hint)
  return (
    <div className="gt-data-option" role="group" aria-label={option.label}>
      <strong>{option.label}</strong>
      <div className={cards ? 'gt-choice-cards' : 'gt-choice-row'} style={{ '--gt-choices': option.choices.length }}>
        {option.choices.map(choice => (
          <button key={choice.id} type="button" className={`${cards ? 'gt-choice-card' : ''}${choice.id === option.value ? ' selected' : ''}`}
            aria-pressed={choice.id === option.value} disabled={choice.disabled} onClick={() => option.onChange(choice.id)}>
            {choice.swatch ? <span className="gt-swatch">{choice.swatch.map((colour, i) => <i key={i} style={{ background: colour }} />)}</span> : null}
            {cards ? <strong>{choice.label}</strong> : choice.label}
            {choice.hint ? <small>{choice.hint}</small> : null}
          </button>
        ))}
      </div>
      {option.note ? <small>{option.note}</small> : null}
    </div>
  )
}

/**
 * Data views: extra data from the user's local genomes, drawn in a column beside the
 * leaves. `views` are `{id, label, hint, disabled, note, options}`; `value` is the one
 * showing, 'off', or 'mixed' — in a subtree layer the subtrees it acts on can differ, and
 * `scope` (a line at the top of the list) says which those are. In the Cursor control's shape: the face, lit while a view shows, turns
 * it off when pressed — and, when off, brings back the view used last (or, with none yet,
 * opens the list); the arrow opens the list. In the list each view is one button: pressing it shows the view with its settings
 * as they are (and closes the menu); the blue chevron on its right edge opens its `options` (see
 * `DataOption`) under it instead, in place, so they can be seen and set before (or without)
 * switching to it. The view showing opens with its settings out.
 */
export function DataViewMenu({ value, views, onChange, scope = '', isLight }) {
  const anchor = useRef(null)
  const [menu, setMenu] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  const current = views.find(v => v.id === value)
  // 'mixed': the subtrees it acts on show different views (a subtree layer; `scope` says which).
  const mixed = value === 'mixed'
  // The view shown last, for the face to bring back once it has been turned off.
  const [last, setLast] = useState(value !== 'off' ? value : '')
  if (current && last !== current.id) setLast(current.id)
  const again = views.find(v => v.id === last && !v.disabled)
  const choose = id => { setMenu(null); onChange(id) }
  const open = () => {
    if (current?.options?.length) setExpanded(prev => new Set(prev).add(current.id))
    setMenu(menuPosition(anchor.current, 400, 'gt'))
  }
  const toggle = id => setExpanded(prev => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    return next
  })
  return (
    <span ref={anchor} className={`gt-split gt-control-data${current || mixed ? ' selected' : ''}${menu ? ' menu-open' : ''}`}>
      <button type="button" className="gt-split-main" aria-pressed={Boolean(current || mixed)}
        title={current ? `Showing ${current.label}. Click to turn it off.` : mixed ? 'Different views on these subtrees. Click to turn them all off.'
          : again ? `Click to show ${again.label} again.` : 'Show data from your local genomes beside the tree'}
        onClick={() => (current || mixed ? choose('off') : again ? choose(again.id) : open())}>
        <span className="gt-control-label"><span>Data view</span><strong>{current ? current.label : mixed ? 'Mixed' : 'Off'}</strong></span>
      </button>
      <button type="button" className="gt-split-arrow" aria-label="Data views" aria-expanded={Boolean(menu)}
        title="Choose a data view and its settings" onClick={() => (menu ? setMenu(null) : open())}><Chevron /></button>
      <AnchoredMenu isLight={isLight} anchorRef={anchor} position={menu} onClose={() => setMenu(null)} title="Data views">
        {scope ? <p className="gt-menu-scope">{scope}</p> : null}
        <button type="button" className={`gt-menu-option${value === 'off' ? ' selected' : ''}`} onClick={() => choose('off')}>
          <strong>Off</strong>
          <span>The tree alone</span>
        </button>
        {views.map(view => {
          const hasOptions = Boolean(view.options?.length)
          const isOpen = hasOptions && expanded.has(view.id)
          return (
            <div key={view.id} className={`gt-view${isOpen ? ' open' : ''}`}>
              {/* Two buttons drawn as one: the view, and the chevron that opens its settings, set into the right edge — the drawers' section toggle. */}
              <div className={`gt-view-row${view.id === value ? ' selected' : ''}${view.disabled ? ' disabled' : ''}`}>
                <button type="button" className="gt-menu-option gt-view-pick" disabled={view.disabled}
                  aria-pressed={view.id === value} title={view.disabled ? view.note : `Show ${view.label}`} onClick={() => choose(view.id)}>
                  <strong>{view.label}</strong>
                  <span>{view.disabled ? view.note : view.hint}</span>
                </button>
                {hasOptions ? (
                  <button type="button" className="gt-view-toggle" aria-expanded={isOpen}
                    aria-controls={`gt-view-settings-${view.id}`} aria-label={`${view.label} settings`}
                    title={`${isOpen ? 'Hide' : 'Show'} the ${view.label} settings`} onClick={() => toggle(view.id)}>
                    <VerticalChevronGlyph pointsDown={!isOpen} size={17} />
                  </button>
                ) : null}
              </div>
              {isOpen ? (
                <div id={`gt-view-settings-${view.id}`} className="gt-data-options gt-view-settings">
                  {view.options.map(option => <DataOption key={option.id} option={option} />)}
                </div>
              ) : null}
            </div>
          )
        })}
      </AnchoredMenu>
    </span>
  )
}

/**
 * How to fold the tree, as a state (tools.js NODE_MODES) in the Cursor control's shape: the
 * face names the state selected and pressing it (`onPress`) applies that state to the tree
 * showing (again, so whatever was folded or opened by hand since goes back to it); the arrow
 * lists every state, and choosing one selects and applies it (`onMode`). Only Highlight local
 * lasts, so only it lights the face (`highlighting`), and pressing the face then turns it off.
 * `hasLocal` false greys out the states that work from local genes.
 */
export function NodesButton({ mode, highlighting, onMode, onPress, hasLocal, isLight }) {
  const anchor = useRef(null)
  const [menu, setMenu] = useState(null)
  const current = NODE_MODES.find(m => m.id === mode) || NODE_MODES[0]
  return (
    <span ref={anchor} className={`gt-split gt-control-nodes${highlighting ? ' selected' : ''}${menu ? ' menu-open' : ''}`}>
      <button type="button" className="gt-split-main" aria-pressed={highlighting} disabled={current.local && !hasLocal && !highlighting}
        onClick={onPress} title={highlighting ? 'Highlighting your local genes. Click to turn it off.' : `${current.hint}. Click to apply it to this tree.`}>
        <span className="gt-control-label"><span>Nodes</span><strong>{current.label}</strong></span>
      </button>
      <button type="button" className="gt-split-arrow" aria-label="Node options" aria-expanded={Boolean(menu)}
        title="Choose how the tree is folded" onClick={() => setMenu(menu ? null : menuPosition(anchor.current, 340, 'gt'))}><Chevron /></button>
      <AnchoredMenu isLight={isLight} anchorRef={anchor} position={menu} onClose={() => setMenu(null)} title="Nodes">
        {NODE_MODES.map(m => (
          <button key={m.id} type="button" className={`gt-menu-option gt-tool-option${m.id === current.id ? ' selected' : ''}`}
            aria-pressed={m.id === current.id} disabled={m.local && !hasLocal}
            title={m.local && !hasLocal ? 'No genes in this tree are in your local genomes' : undefined}
            onClick={() => { onMode(m.id); setMenu(null) }}>
            <strong>{m.label}</strong>
            <span>{m.hint}</span>
          </button>
        ))}
      </AnchoredMenu>
    </span>
  )
}
