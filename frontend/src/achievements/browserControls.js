// Control freak counts the different Genome Browser controls someone has used: the
// general control bar above the panels and each genome's own toolbar both count.
//
// A control is identified by its `data-browser-control`, or failing that its tutorial
// anchor, never by its label, which changes as a toggle flips. Keyed by the control
// rather than the panel, so the same button pressed on two genomes counts once. The four
// gene-class checkboxes are one control. Text fields do not count by being clicked
// into; a search counts as the search button whether it was clicked or Enter was pressed.

const CONTROL_SELECTOR = 'button, select, input[type="checkbox"]'

export function browserControlKey(target) {
  const control = target?.closest?.(CONTROL_SELECTOR)
  if (!control || control.disabled) return ''
  const key = control.dataset?.browserControl || control.dataset?.tourId || ''
  if (!key) return ''
  return key.startsWith('browser-biotype') ? 'browser-biotype' : key
}
