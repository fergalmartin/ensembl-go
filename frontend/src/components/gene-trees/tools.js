/** The canvas tools, in the control bar's tool button. */
export const TOOLS = [
  { id: 'explore', label: 'Explore', key: 'V', hint: 'Click a clade to fold or open it; drag to move the view' },
  { id: 'select', label: 'Select', key: 'S', hint: 'Drag a box: every node, branch or label it touches is picked. Click to pick or unpick one node' },
  { id: 'clade', label: 'Pick clade', key: 'C', hint: 'Click a node to pick its whole clade' },
]

/**
 * A subtree layer's own tools, on the bar over the layer. Each acts on whole fragments or
 * on the node or branch under the pointer, and shows what it will do before it does it.
 */
export const LAYER_TOOLS = [
  { id: 'move', label: 'Move', hint: 'Move subtrees to arrange the layer', radialNote: 'Subtrees can only be moved in the linear layout' },
  { id: 'merge', label: 'Merge', hint: 'Merge two subtrees from the same original tree' },
  { id: 'graft', label: 'Graft', hint: 'Graft a subtree onto a branch or a root' },
  { id: 'cut', label: 'Cut', hint: 'Cut a subtree in two at a branch' },
  { id: 'remove', label: 'Remove', hint: 'Remove a node and everything below it' },
]
