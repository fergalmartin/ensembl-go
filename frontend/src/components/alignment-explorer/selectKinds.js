/** The two ways of drawing a selection, which used to be two buttons in the bar.
 *
 * They are one act with a setting, not two tools: both drag a rectangle, and
 * the only difference is whether the rows it touched matter or only the columns
 * it crossed. Kept apart in the bar they cost two slots and still did not say
 * that they were alternatives.
 */
export const SELECT_KINDS = [
  { mode: 'rectangle', label: 'Free select',
    hint: 'Drag a rectangle over the cells it should cover. Over the names it picks the sequences inside it.' },
  { mode: 'columns', label: 'Columns',
    hint: 'Drag sideways to take whole columns, through every sequence in view. Over the names it takes every name on screen.' },
]

export const isSelectMode = mode => SELECT_KINDS.some(kind => kind.mode === mode)
export const selectKind = (mode, fallback) =>
  SELECT_KINDS.find(kind => kind.mode === mode) || SELECT_KINDS.find(kind => kind.mode === fallback) || SELECT_KINDS[0]

/** Move view, and the two ways of drawing a selection, as one list.
 *
 * They were two controls in the bar: Pan, which had no settings at all, and
 * Select, which carried the shape. But the reader is choosing one thing - what
 * the pointer does - and a press on one of them silently turned the other off,
 * which is the definition of a single choice among three. As two buttons it
 * cost two slots to say that, and neither of them said it.
 */
export const PAN_MODE = {
  mode: 'pan', label: 'Move view',
  hint: 'Drag to move the sheet. Space does this from any mode, whichever is chosen here.',
}
export const CURSOR_MODES = [PAN_MODE, ...SELECT_KINDS]
export const cursorMode = mode => CURSOR_MODES.find(item => item.mode === mode) || PAN_MODE
