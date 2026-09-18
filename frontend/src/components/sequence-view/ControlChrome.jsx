import { createPortal } from 'react-dom'

/**
 * The three pieces every control on the bar is made of.
 *
 * The same shapes the alignment explorer's bar uses, drawn against this view's
 * own tokens: a label over the applied value, one chevron mark where there is a
 * menu behind the control, and the menu itself drawn over the page and pinned
 * to the button it belongs to.
 *
 * The positioning and dismissal are the explorer's own `menuAnchor`, imported
 * rather than copied. It is a pure module, and sharing it means the two bars
 * cannot drift about where a menu lands, when it closes, or that only one of
 * them is open at a time -- which is true across the whole app, not within one
 * view.
 */

/** Persistent applied values. A menu's draft must never be passed here: the bar
 * says what the view is doing, not what a menu is about to do. */
export function ControlLabel({ label, value, active = false }) {
    return (
        <span className="sv-control-label">
            <span className="sv-control-name">
                {label}
                {active ? <span className="sv-control-active">✓ On</span> : null}
            </span>
            <strong className="sv-control-value">{value}</strong>
        </span>
    )
}

/** The one drop-down mark on the bar. Drawn rather than typed, for the reason
 * the explorer's is: at the size ▾ is legible it is already too tall for the
 * row, and every fallback font draws it at a different weight. */
export function ControlChevron() {
    return (
        <svg className="sv-control-chevron" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" focusable="false">
            <path d="M3.2 5.1 L6.5 8.4 L9.8 5.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

/**
 * A menu hanging off a control.
 *
 * Portalled into the view's root rather than into the body: the root carries the
 * light/dark tokens, so a menu outside it would be drawn in whichever theme the
 * stylesheet happened to declare first. The outer frame keeps the connector
 * aimed at the button while long menu contents scroll inside it.
 */
export function ControlMenu({ id, root, anchor, title, children, className = '' }) {
    if (!anchor || !root) return null
    return createPortal(
        <div className="sv-anchored-menu" style={anchor}>
            <div id={id} className={`sv-menu ${className}`} role="dialog" aria-label={`${title} options`}>
                <div className="sv-menu-heading"><strong>{title}</strong></div>
                {children}
            </div>
        </div>,
        root,
    )
}
