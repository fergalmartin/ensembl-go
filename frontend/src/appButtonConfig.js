// Every data view the organiser can offer, in the order inactive ones are listed back
// to the user. The ones that are not in the default set sit at the end, so the list
// reads as "the standard bar, then the extras you can add".
export const DATA_VIEW_BUTTON_IDS = [
  'home',
  'genome_selector',
  'genome_browser',
  'download',
  'sequence',
  'feature_explorer',
  'track_manager',
  'alignment',
  'alignment_explorer',
  'neighbourhood',
  'stats',
  'notes',
  'tutorials',
  'help',
  'configuration',
  'structural_variation',
  'homology',
]

export const ACTION_BUTTON_IDS = ['genome_playlist', 'theme_toggle', 'screenshot_toggle']

export const APP_BUTTON_IDS = [...DATA_VIEW_BUTTON_IDS, ...ACTION_BUTTON_IDS]

export const NON_DEACTIVATABLE_APP_BUTTON_IDS = ['configuration']
const DATA_VIEW_BUTTON_ID_SET = new Set(DATA_VIEW_BUTTON_IDS)
const ACTION_BUTTON_ID_SET = new Set(ACTION_BUTTON_IDS)

// The bar a fresh installation starts with, and what "Reset App Buttons to Default"
// restores. Written out rather than derived, because it is a curated arrangement: the
// order is the order it appears in, and Structural Variation and Homology are
// deliberately left out. A view added to DATA_VIEW_BUTTON_IDS is therefore *not*
// switched on for new users until it is named here as well.
export const DEFAULT_ACTIVE_APP_BUTTONS = [
  'home',
  'genome_selector',
  'genome_browser',
  'download',
  'sequence',
  'feature_explorer',
  'track_manager',
  'alignment',
  'alignment_explorer',
  'neighbourhood',
  'stats',
  'notes',
  'tutorials',
  'help',
  'configuration',
  'genome_playlist',
  'theme_toggle',
  'screenshot_toggle',
]

export const APP_BUTTON_META = {
  home: { id: 'home', label: 'Home', shortLabel: 'Home', kind: 'data_view', viewId: 'home' },
  genome_selector: { id: 'genome_selector', label: 'Genome Selector', shortLabel: 'Genomes', kind: 'data_view', viewId: 'genome_selector' },
  genome_browser: { id: 'genome_browser', label: 'Genome Browser', shortLabel: 'Browser', kind: 'data_view', viewId: 'genome_browser' },
  track_manager: { id: 'track_manager', label: 'Track Manager', shortLabel: 'Tracks', kind: 'data_view', viewId: 'track_manager' },
  feature_explorer: { id: 'feature_explorer', label: 'Feature Explorer', shortLabel: 'Features', kind: 'data_view', viewId: 'feature_explorer' },
  sequence: { id: 'sequence', label: 'Sequence', shortLabel: 'Sequence', kind: 'data_view', viewId: 'sequence' },
  alignment: { id: 'alignment', label: 'Alignment', shortLabel: 'Align', kind: 'data_view', viewId: 'alignment' },
  alignment_explorer: { id: 'alignment_explorer', label: 'Alignment Explorer', shortLabel: 'Explorer', kind: 'data_view', viewId: 'alignment_explorer' },
  neighbourhood: { id: 'neighbourhood', label: 'Neighbourhood', shortLabel: 'Neighbour', kind: 'data_view', viewId: 'neighbourhood' },
  structural_variation: { id: 'structural_variation', label: 'Structural Variation', shortLabel: 'SV', kind: 'data_view', viewId: 'structural_variation' },
  homology: { id: 'homology', label: 'Homology', shortLabel: 'Homology', kind: 'data_view', viewId: 'homology' },
  stats: { id: 'stats', label: 'Statistics', shortLabel: 'Statistics', kind: 'data_view', viewId: 'stats' },
  notes: { id: 'notes', label: 'Notes', shortLabel: 'Notes', kind: 'data_view', viewId: 'notes' },
  download: { id: 'download', label: 'Download', shortLabel: 'Download', kind: 'data_view', viewId: 'download' },
  configuration: { id: 'configuration', label: 'Configuration', shortLabel: 'Config', kind: 'data_view', viewId: 'configuration' },
  tutorials: { id: 'tutorials', label: 'Tutorials', shortLabel: 'Tutorials', kind: 'data_view', viewId: 'tutorials' },
  help: { id: 'help', label: 'Help', shortLabel: 'Help', kind: 'data_view', viewId: 'help' },
  genome_playlist: { id: 'genome_playlist', label: 'Genome Playlist', shortLabel: 'Playlist', kind: 'action' },
  theme_toggle: { id: 'theme_toggle', label: 'Theme Toggle', shortLabel: 'Theme', kind: 'action' },
  screenshot_toggle: { id: 'screenshot_toggle', label: 'Screenshot', shortLabel: 'Screenshot', kind: 'action' },
}

export const normalizeActiveAppButtons = (candidate) => {
  // A stored array is the user's own choice of active buttons, so a button it
  // leaves out stays out — that is exactly what deactivating one in the app
  // organiser means. Only a missing or malformed setting falls back to the
  // full default set.
  const hasStoredSelection = Array.isArray(candidate)
  const raw = hasStoredSelection ? candidate : DEFAULT_ACTIVE_APP_BUTTONS
  // Compatibility for configs saved before the Species Selector code name was
  // aligned with the Genome Selector UI name.
  const legacyAliases = { species_selector: 'genome_selector' }
  const allowed = new Set(APP_BUTTON_IDS)
  const seen = new Set()
  const normalized = []

  for (const rawId of raw) {
    const id = legacyAliases[rawId] || rawId
    if (allowed.has(id) && !seen.has(id)) {
      seen.add(id)
      normalized.push(id)
    }
  }

  const insertMissingDataViewsBeforeActions = (ids) => {
    let insertIndex = normalized.findIndex((id) => ACTION_BUTTON_ID_SET.has(id))
    if (insertIndex < 0) insertIndex = normalized.length
    for (const id of ids) {
      if (!allowed.has(id) || seen.has(id)) continue
      seen.add(id)
      normalized.splice(insertIndex, 0, id)
      insertIndex += 1
    }
  }

  const appendMissing = (ids) => {
    for (const id of ids) {
      if (!allowed.has(id) || seen.has(id)) continue
      seen.add(id)
      normalized.push(id)
    }
  }

  // No backfill for a missing selection: DEFAULT_ACTIVE_APP_BUTTONS is the whole answer
  // and is curated, so topping it up from the catalogue would switch on the very views
  // it deliberately leaves off.

  // Configuration is the only way back to the organiser, so it survives a
  // stored selection that has somehow lost it.
  insertMissingDataViewsBeforeActions(
    NON_DEACTIVATABLE_APP_BUTTON_IDS.filter((id) => DATA_VIEW_BUTTON_ID_SET.has(id))
  )
  appendMissing(
    NON_DEACTIVATABLE_APP_BUTTON_IDS.filter((id) => ACTION_BUTTON_ID_SET.has(id))
  )

  const firstActionIndex = normalized.findIndex((id) => ACTION_BUTTON_ID_SET.has(id))
  const hasDataViewAfterActions = firstActionIndex >= 0 && normalized
    .slice(firstActionIndex + 1)
    .some((id) => DATA_VIEW_BUTTON_ID_SET.has(id))
  // Tested against the whole catalogue rather than the default set. The default is a
  // curated subset now, and testing against that would make this regrouping fire for an
  // ordinary bar — undoing a data view the user had deliberately dragged past the
  // action buttons.
  if (hasDataViewAfterActions && APP_BUTTON_IDS.every((id) => seen.has(id))) {
    return [
      ...normalized.filter((id) => DATA_VIEW_BUTTON_ID_SET.has(id)),
      ...normalized.filter((id) => ACTION_BUTTON_ID_SET.has(id)),
    ]
  }

  return normalized
}

// ── Top app bar geometry ────────────────────────────────────────────────────────
//
// Shared with the app organiser, which draws the active buttons in this same
// arrangement so that what it shows is what the bar will look like.
//
// Nine across and two down are layout, not preference: nine 44px buttons and their 8px
// gaps are exactly the width the header can give the strip without squeezing the view
// title beside it, and a third row would push the header down over the view.
export const TOP_BAR_VISIBLE_COLUMNS = 9
export const TOP_BAR_MAX_ROWS = 2
export const TOP_BAR_BUTTON_PX = 44
export const TOP_BAR_GAP_PX = 8
export const TOP_BAR_COLUMN_STRIDE_PX = TOP_BAR_BUTTON_PX + TOP_BAR_GAP_PX
export const TOP_BAR_VIEWPORT_PX =
  TOP_BAR_VISIBLE_COLUMNS * TOP_BAR_BUTTON_PX + (TOP_BAR_VISIBLE_COLUMNS - 1) * TOP_BAR_GAP_PX

/** Split the active buttons into the rows the top bar draws, and say how wide they are.
 *
 * Up to eighteen buttons this is the layout the bar has always had — nine to a row, the
 * second row as short as it needs to be. Past eighteen the rows grow wider rather than
 * multiplying, and the strip scrolls sideways within its nine-column window.
 */
export const buildAppButtonLayout = (buttonIds) => {
  const all = (Array.isArray(buttonIds) ? buttonIds : []).filter((id) => Boolean(APP_BUTTON_META[id]))
  if (all.length <= TOP_BAR_VISIBLE_COLUMNS) {
    return { rows: all.length ? [all] : [], columns: TOP_BAR_VISIBLE_COLUMNS, overflows: false }
  }
  const columns = Math.max(TOP_BAR_VISIBLE_COLUMNS, Math.ceil(all.length / TOP_BAR_MAX_ROWS))
  const rows = []
  for (let i = 0; i < all.length; i += columns) {
    rows.push(all.slice(i, i + columns))
  }
  return { rows, columns, overflows: columns > TOP_BAR_VISIBLE_COLUMNS }
}
