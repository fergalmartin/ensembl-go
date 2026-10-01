/** What the pointer does on the canvas: the choices behind the control bar's Cursor button. */
export const TOOLS = [
  { id: 'explore', label: 'Regular', key: 'V', hint: 'Click a gene to focus on it, or a clade to fold or open it. Drag to move around.' },
  { id: 'select', label: 'Free select', key: 'S', hint: 'Drag a box to select what it touches, or click a node to select or deselect it. Then drag the selection onto a layer, or use Copy to layer, to build a subtree of your own.' },
  { id: 'clade', label: 'Clade select', key: 'C', hint: 'Click a node to select it and everything below it. Then drag it onto a layer, or use Copy to layer, to work on it as a subtree.' },
  { id: 'flip', label: 'Flip', key: 'R', hint: 'Click a node to flip everything below it upside down.' },
  { id: 'fold', label: 'Fold', key: 'O', hint: 'Click a node to fold away everything that doesn’t lead to it.' },
  { id: 'expand', label: 'Expand', key: 'E', hint: 'Click a node to open everything below it.' },
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
  { id: 'rename', label: 'Rename', hint: 'Click a subtree to rename it' },
  { id: 'compare', label: 'Compare', hint: 'Compare two subtrees: set them facing each other, with lines between matching genes',
    radialNote: 'Subtrees can only be compared in the linear layout' },
]

/**
 * Ways to fold the tree: the states behind the control bar's Nodes button. One is applied only
 * when chosen or when the button is pressed — a tree opens as it always does. `local` ones
 * work from the genes in the user's local genomes (in the top bar or not); Highlight local
 * also fades the rest, on the tree it was applied to.
 */
export const NODE_MODES = [
  { id: 'expand-all', label: 'Expand all', hint: 'Every clade open' },
  { id: 'collapse-all', label: 'Collapse all', hint: 'Every clade folded: opening one shows the clades inside it' },
  { id: 'expand-local', label: 'Expand to local', hint: 'Any fold over a gene in your local genomes opened; other folds stay', local: true },
  { id: 'collapse-local', label: 'Collapse to local', hint: 'Only the genes in your local genomes, and the branches to them, open', local: true },
  { id: 'highlight-local', label: 'Highlight local', hint: 'Opened to your local genes, with everything off the branches to them faded', local: true },
  { id: 'select-local', label: 'Select all local', hint: 'Opened to your local genes and all of them selected, with the branches joining them, ready to copy into a layer', local: true },
]
