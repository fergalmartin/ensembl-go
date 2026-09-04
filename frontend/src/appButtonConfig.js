export const DATA_VIEW_BUTTON_IDS = [
  'home',
  'genome_selector',
  'genome_browser',
  'track_manager',
  'feature_explorer',
  'alignment',
  'neighbourhood',
  'structural_variation',
  'homology',
  'stats',
  'notes',
  'download',
  'configuration',
  'tutorials',
  'help',
]

export const ACTION_BUTTON_IDS = ['genome_playlist', 'theme_toggle', 'screenshot_toggle']

export const APP_BUTTON_IDS = [...DATA_VIEW_BUTTON_IDS, ...ACTION_BUTTON_IDS]
export const IN_PROGRESS_VIEW_BUTTON_IDS = []

export const NON_DEACTIVATABLE_APP_BUTTON_IDS = ['configuration']
const DATA_VIEW_BUTTON_ID_SET = new Set(DATA_VIEW_BUTTON_IDS)
const ACTION_BUTTON_ID_SET = new Set(ACTION_BUTTON_IDS)

export const DEFAULT_ACTIVE_APP_BUTTONS = [
  ...DATA_VIEW_BUTTON_IDS.filter((id) => !IN_PROGRESS_VIEW_BUTTON_IDS.includes(id)),
  ...ACTION_BUTTON_IDS,
]

export const APP_BUTTON_META = {
  home: { id: 'home', label: 'Home', shortLabel: 'Home', kind: 'data_view', viewId: 'home' },
  genome_selector: { id: 'genome_selector', label: 'Genome Selector', shortLabel: 'Genomes', kind: 'data_view', viewId: 'genome_selector' },
  genome_browser: { id: 'genome_browser', label: 'Genome Browser', shortLabel: 'Browser', kind: 'data_view', viewId: 'genome_browser' },
  track_manager: { id: 'track_manager', label: 'Track Manager', shortLabel: 'Tracks', kind: 'data_view', viewId: 'track_manager' },
  feature_explorer: { id: 'feature_explorer', label: 'Feature Explorer', shortLabel: 'Features', kind: 'data_view', viewId: 'feature_explorer' },
  alignment: { id: 'alignment', label: 'Alignment', shortLabel: 'Align', kind: 'data_view', viewId: 'alignment' },
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
  const raw = Array.isArray(candidate) ? candidate : DEFAULT_ACTIVE_APP_BUTTONS
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

  const insertMissingDataViewsBeforeActions = () => {
    let insertIndex = normalized.findIndex((id) => ACTION_BUTTON_ID_SET.has(id))
    if (insertIndex < 0) insertIndex = normalized.length
    for (const id of DATA_VIEW_BUTTON_IDS) {
      if (!allowed.has(id) || seen.has(id) || IN_PROGRESS_VIEW_BUTTON_IDS.includes(id)) continue
      seen.add(id)
      normalized.splice(insertIndex, 0, id)
      insertIndex += 1
    }
  }

  const appendMissing = (ids) => {
    for (const id of ids) {
      if (!allowed.has(id) || seen.has(id) || IN_PROGRESS_VIEW_BUTTON_IDS.includes(id)) continue
      seen.add(id)
      normalized.push(id)
    }
  }

  insertMissingDataViewsBeforeActions()
  appendMissing(ACTION_BUTTON_IDS)

  const firstActionIndex = normalized.findIndex((id) => ACTION_BUTTON_ID_SET.has(id))
  const hasDataViewAfterActions = firstActionIndex >= 0 && normalized
    .slice(firstActionIndex + 1)
    .some((id) => DATA_VIEW_BUTTON_ID_SET.has(id))
  if (hasDataViewAfterActions && DEFAULT_ACTIVE_APP_BUTTONS.every((id) => seen.has(id))) {
    return [
      ...normalized.filter((id) => DATA_VIEW_BUTTON_ID_SET.has(id)),
      ...normalized.filter((id) => ACTION_BUTTON_ID_SET.has(id)),
    ]
  }

  return normalized
}
