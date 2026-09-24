// Achievements about which gene is in focus, checked from the Genome Browser's focus
// effect. Pure, so the tests can ask the same question.

const text = (value) => String(value || '').trim().toLowerCase()

/** Gotta go fast!: SHH in focus in any European hedgehog (Erinaceus europaeus) genome. */
export function isHedgehogShh(species, gene) {
  const symbol = text(gene?.name || gene?.symbol || gene?.gene_name)
  if (symbol !== 'shh') return false
  const names = [species?.scientific_name, species?.species_key, species?.key]
    .map((value) => text(value).replace(/_/g, ' '))
  return names.some((name) => name.startsWith('erinaceus europaeus'))
}
