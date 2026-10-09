import { formatSvGenomeOptionLabel } from '../../utils/svCatalog.js'
import { SV_GENOME_GROUP_LABELS } from './svConstants.js'
import { getSvOptionTooltip } from './svFormat.js'

/** Render genome options grouped by whether they can be used.
 *
 * Genomes with no local data are listed rather than hidden, so a config naming a
 * genome that has not been downloaded explains itself instead of quietly producing
 * a shorter list than the file suggests.
 */
export function renderSvGenomeOptionGroups(options, slot) {
  return ['selected', 'add', 'missing'].map((state) => {
    const group = (options || []).filter((option) => option.state === state)
    if (!group.length) return null
    return (
      <optgroup key={`${slot}-${state}`} label={SV_GENOME_GROUP_LABELS[state]}>
        {group.map((option) => (
          <option
            key={`${slot}-${option.value}`}
            value={option.value}
            disabled={option.disabled}
            title={getSvOptionTooltip(option)}
          >
            {formatSvGenomeOptionLabel(option)}
          </option>
        ))}
      </optgroup>
    )
  })
}
