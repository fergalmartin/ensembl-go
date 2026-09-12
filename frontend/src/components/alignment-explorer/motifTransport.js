import { api } from './data'

export const motifTransport = {
  start: (settings, dataset) => api(`/datasets/${dataset.id}/motif-jobs`, {
    motifs: settings.motifs.filter(m => m.enabled && m.pattern).map(({ id, pattern, kind }) => ({ id, pattern, kind })),
  }),
  status: (id, signal) => api(`/motif-jobs/${id}`, undefined, signal),
  cancel: id => api(`/motif-jobs/${id}/cancel`, {}),
  async finish(job, settings, signal) {
    if (!settings.hideUnmatched) return { blocks: null }
    const blocks = []
    let after = 0
    do {
      const page = await api(`/motif-jobs/${job.id}/blocks?after=${after}`, undefined, signal)
      blocks.push(...page.blocks); after = page.next
    } while (after != null)
    return { blocks }
  },
}
