import { formatInt, genomeLabel } from './statsModel.js'

export function AnnotationDetails({ records, isLight }) {
  const ready = records.filter((r) => (r?.statuses || {}).annotation === 'ready' && r?.annotation)
  if (!ready.length) return null

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {ready.map((record) => {
        const ann = record.annotation || {}
        const biotypes = Object.entries(ann.gene_biotype_counts || {}).slice(0, 4)
        return (
          <div
            key={`ann-${record.genome_key}`}
            className={`rounded-lg border p-3 ${isLight ? 'border-gray-200 bg-white' : 'border-gray-700 bg-gray-900/40'}`}
          >
            <div className={`text-xs font-semibold mb-2 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>{genomeLabel(record)}</div>
            <div className={`grid grid-cols-3 gap-2 text-xs ${isLight ? 'text-gray-600' : 'text-gray-300'}`}>
              <div>
                <div className={isLight ? 'text-gray-500' : 'text-gray-400'}>Genes</div>
                <div className="font-semibold">{formatInt(ann.gene_total)}</div>
              </div>
              <div>
                <div className={isLight ? 'text-gray-500' : 'text-gray-400'}>Transcripts</div>
                <div className="font-semibold">{formatInt(ann.transcript_total)}</div>
              </div>
              <div>
                <div className={isLight ? 'text-gray-500' : 'text-gray-400'}>Single exon genes</div>
                <div className="font-semibold">{formatInt(ann.single_exon_genes)}</div>
              </div>
            </div>
            <div className={`mt-3 text-[11px] ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Top gene biotypes</div>
            <div className="mt-1 space-y-0.5">
              {biotypes.length === 0 && <div className={`text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>No biotype detail</div>}
              {biotypes.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-xs">
                  <span className={isLight ? 'text-gray-600' : 'text-gray-300'}>{name}</span>
                  <span className={isLight ? 'text-gray-700' : 'text-gray-200'}>{formatInt(count)}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
