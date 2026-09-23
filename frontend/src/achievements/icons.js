// Which icon an achievement's badge shows: its own, or its category's. Shared by the
// medal and the unlock toast.

import { ACHIEVEMENT_CATEGORIES } from './catalogue.js'

const CATEGORY_ICON = new Map(ACHIEVEMENT_CATEGORIES.map((category) => [category.id, category.icon]))

export function achievementIcon(achievement) {
  return achievement?.icon || CATEGORY_ICON.get(achievement?.category) || 'home'
}
