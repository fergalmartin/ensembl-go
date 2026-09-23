import { useSyncExternalStore } from 'react'
import { getAchievementsSnapshot, subscribeAchievements } from './tracker.js'

/**
 * The tracker's current state, for the Achievements view. The snapshot object changes
 * whenever anything the view could show changes, so memoise on it rather than on the
 * facts inside it.
 */
export default function useAchievements() {
  return useSyncExternalStore(subscribeAchievements, getAchievementsSnapshot, getAchievementsSnapshot)
}
