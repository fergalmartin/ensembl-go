// Who the demo genome is. Pure, so the tutorial definitions and their tests can read it
// without dragging in the backend client — the fetching lives in demoGenomeApi.js.
//
// These identifiers have to agree with backend/demo_genome.py.

export const DEMO_SPECIES_KEY = 'ensemblus_welcomus'
export const DEMO_ASSEMBLY = 'GCA_000000000.1'
export const DEMO_SCIENTIFIC_NAME = 'Ensemblus welcomus'
export const DEMO_GENE_NAMES = Object.freeze(['Welcome', 'To', 'Ensembl', 'Go', 'Have', 'Fun'])

/** Whether a download-view row is the demo genome rather than something real. */
export function isDemoGenomeItem(item) {
  return String(item?.species_key || '') === DEMO_SPECIES_KEY
}
