import { useMemo } from 'react'
import { resolveBrowsingControls } from '../../utils/browsingControls.js'
import { SV_BROWSING_TUNING } from './svConstants.js'

/**
 * Depends on the scheme id alone, never on `config` — that object gets a fresh
 * identity on every 250ms autosave, and a new controls object would re-register
 * the wheel listeners mid-gesture.
 */
export function useBrowsingControls(config) {
  const schemeId = config?.browsing_control_scheme
  return useMemo(
    () => resolveBrowsingControls({ browsing_control_scheme: schemeId }, SV_BROWSING_TUNING),
    [schemeId]
  )
}
