import { DOWNLOAD_FILE_DEFS, fileTypeTooltip } from '../../utils/genomeFileTypes.js'
import { ENSEMBL_DOWNLOAD_FILE_TYPES, REFSEQ_DOWNLOAD_FILE_TYPES } from './downloadModel.js'

export function DownloadTypeToolbar({ activeProvider, selectedTypes, onToggleType, isLight }) {
    const allowedTypes = activeProvider === 'ncbi' ? REFSEQ_DOWNLOAD_FILE_TYPES : ENSEMBL_DOWNLOAD_FILE_TYPES
    return (
        <div data-tour-id="download-file-types" className={`px-4 py-3 border-b flex items-center gap-2 flex-wrap ${isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-750 border-gray-700'}`}>
            <span className={`text-xs font-bold uppercase tracking-widest mr-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>Download</span>
            {allowedTypes.map((type) => {
                const active = selectedTypes.has(type)
                return (
                    <button
                        key={type}
                        type="button"
                        title={fileTypeTooltip(type)}
                        onClick={() => onToggleType(type)}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors ${active
                            ? 'bg-blue-600 text-white border-blue-600'
                            : (isLight ? 'bg-white text-gray-700 border-gray-200 hover:border-blue-300' : 'bg-gray-800 text-gray-300 border-gray-600 hover:border-blue-500')}`}
                    >
                        {DOWNLOAD_FILE_DEFS[type]?.label || type}
                    </button>
                )
            })}
            {activeProvider === 'ncbi' && (
                <span className={`text-xs ml-1 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>RefSeq supports genome and annotation downloads here.</span>
            )}
        </div>
    )
}
