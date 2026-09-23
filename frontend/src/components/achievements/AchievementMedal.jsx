import AppButtonIcon from '../AppButtonIcon'
import { achievementIcon } from '../../achievements/icons.js'

// The badge every achievement wears: its view's icon on the same blue tile as the app
// buttons in the top bar. Locked, the tile is grey with a small lock; hidden and
// locked, it shows a question mark instead of the icon.

export default function AchievementMedal({ achievement, unlocked, concealed = false, size = 48, isLight }) {
  const tileClass = unlocked
    ? 'bg-[#0099ff] text-white'
    : (isLight ? 'bg-gray-200 text-gray-400' : 'bg-gray-700 text-gray-500')

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <div className={`flex h-full w-full items-center justify-center rounded-lg ${tileClass}`}>
        {concealed ? (
          <span className="font-bold" style={{ fontSize: Math.round(size * 0.42), lineHeight: 1 }}>?</span>
        ) : (
          <AppButtonIcon buttonId={achievementIcon(achievement)} isLight={isLight} compact={size < 44} />
        )}
      </div>
      {!unlocked && !concealed && (
        <div
          className={`absolute flex items-center justify-center rounded-full border ${
            isLight ? 'border-gray-300 bg-white text-gray-500' : 'border-gray-600 bg-gray-800 text-gray-400'
          }`}
          style={{ right: -4, bottom: -4, width: Math.round(size * 0.4), height: Math.round(size * 0.4) }}
        >
          <svg width="60%" height="60%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
      )}
    </div>
  )
}
