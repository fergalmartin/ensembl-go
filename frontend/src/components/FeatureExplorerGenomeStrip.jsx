import useHorizontalPillScroll from './useHorizontalPillScroll'
import { getGenomeKey } from '../utils/genomeIdentity'

function formatScientificName(species) {
  if (species?.display_name) return species.display_name
  if (species?.common_name) return species.common_name
  const name = String(species?.scientific_name || '').trim()
  if (!name) return ''
  const parts = name.split(/\s+/)
  if (parts.length < 2) return name
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`
}

function formatAssembly(assemblyName) {
  const text = String(assemblyName || '').trim()
  if (!text) return ''
  if (text.length <= 10) return text
  return `${text.slice(0, 7)}...`
}

function speciesItemKey(species) {
  return getGenomeKey(species)
}

function buildGenomeLabel(species) {
  if (!species) return ''
  const displayName = formatScientificName(species)
  const assembly = formatAssembly(species?.assembly_name || species?.assembly || '')
  return assembly ? `${displayName} - ${assembly}` : displayName
}

function focusGeneLabel(gene) {
  const label = String(gene?.name || gene?.id || '').trim()
  return label || 'No gene selected'
}

function focusGeneTooltip(gene) {
  const name = String(gene?.name || '').trim()
  const id = String(gene?.id || '').trim()
  if (name && id && name.toLowerCase() !== id.toLowerCase()) return `${name} (${id})`
  return name || id || 'No gene selected'
}

function GenomeCard({ species, gene, isLight, onClick = null, suppressClickRef = null }) {
  const pillLabel = buildGenomeLabel(species)
  const subtitle = focusGeneLabel(gene)
  const subtitleMuted = !gene
  const title = `${species?.scientific_name || species?.common_name || species?.species_key || 'Genome'} | ${species?.assembly_name || species?.assembly || ''}`

  const baseClass = isLight
    ? 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
    : 'bg-[#1E2938] text-gray-200 border-gray-600 hover:bg-gray-700'

  return (
    <div className="w-[180px]">
      <button
        type="button"
        onClick={() => {
          if (suppressClickRef?.current) return
          onClick(species)
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className={`w-full text-xs px-3 py-1.5 rounded-full transition-all duration-200 border font-medium text-left ${baseClass}`}
        title={title}
      >
        <span className="block truncate">{pillLabel || 'Genome'}</span>
      </button>
      <div
        className={`mt-1 px-1 truncate text-[11px] leading-4 text-left ${subtitleMuted
          ? (isLight ? 'text-gray-400' : 'text-gray-500')
          : (isLight ? 'text-gray-600' : 'text-gray-300')
          }`}
        title={focusGeneTooltip(gene)}
      >
        {subtitle}
      </div>
    </div>
  )
}

export default function FeatureExplorerGenomeStrip({
  theme = 'dark',
  otherGenomes = [],
  focusGeneByGenome = {},
  onSelectGenome = null,
  embedded = false,
}) {
  const isLight = theme === 'light'
  const {
    scrollRef,
    suppressClickRef,
    handleScroll,
    onMouseDown,
    onMouseMove,
    onMouseUp,
  } = useHorizontalPillScroll({ scrollAmount: 220 })

  if (otherGenomes.length === 0) return null

  return (
    <div
      className={`border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`}
      style={embedded ? {
        marginTop: '0.75rem',
        paddingTop: '0.75rem',
      } : {
        backgroundColor: isLight ? '#f1f3f5' : '#1E2938',
        borderRadius: '0.5rem',
        paddingLeft: '0.5rem',
        paddingRight: '0.5rem',
        paddingTop: '0.5rem',
        paddingBottom: '0.5rem',
      }}
    >
      <div className="flex items-center min-w-0 overflow-visible">
        <button
          type="button"
          onClick={() => handleScroll('left')}
          className={`flex-shrink-0 p-1 rounded transition-colors ${isLight ? 'text-gray-500 hover:bg-gray-200 hover:text-gray-900' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-100'}`}
          title="Scroll left"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>

        <div
          ref={scrollRef}
          className="hide-scrollbar flex items-start gap-2 flex-1 px-1 py-1 overflow-x-auto overflow-y-visible cursor-grab select-none"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        >
          {otherGenomes.map((species) => {
            const key = speciesItemKey(species)
            return (
              <div key={`feature-explorer-genome-${key}`} className="flex-shrink-0">
                <GenomeCard
                  species={species}
                  gene={focusGeneByGenome?.[key] || null}
                  isLight={isLight}
                  onClick={onSelectGenome}
                  suppressClickRef={suppressClickRef}
                />
              </div>
            )
          })}
        </div>

        <button
          type="button"
          onClick={() => handleScroll('right')}
          className={`flex-shrink-0 p-1 rounded transition-colors ${isLight ? 'text-gray-500 hover:bg-gray-200 hover:text-gray-900' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-100'}`}
          title="Scroll right"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
    </div>
  )
}
