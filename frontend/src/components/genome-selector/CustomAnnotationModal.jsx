import ValidationReportPanel from '../ValidationReportPanel'
import { CONVERSION_REQUIRED_EXTENSIONS, defaultCustomAnnotationLabel } from './genomeSelectorModel.js'

export function CustomAnnotationModal({
    isOpen,
    theme,
    item,
    label,
    path,
    importing,
    validation,
    idMode,
    idPrefix,
    onLabelChange,
    onPathChange,
    onBrowse,
    onCancel,
    onImport,
    onValidate,
    onCloseValidation,
    onIdModeChange,
    onIdPrefixChange,
}) {
    if (!isOpen || !item) return null
    const isLight = theme === 'light'
    const panelClass = isLight ? 'bg-white border-gray-200 text-gray-900' : 'bg-gray-800 border-gray-700 text-gray-100'
    const inputClass = isLight
        ? 'bg-white border-gray-300 text-gray-800 placeholder-gray-400 focus:border-[#0099ff] focus:ring-[#0099ff]/30'
        : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500 focus:border-blue-500 focus:ring-blue-500/30'
    const secondaryBtn = isLight
        ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300'
        : 'bg-gray-700 text-gray-200 hover:bg-gray-600 border border-gray-500'

    const trimmedPath = String(path || '').trim()
    const lowerPath = trimmedPath.toLowerCase()
    // GTF cannot be indexed directly, so conversion is not optional for it.
    const requiresConversion = CONVERSION_REQUIRED_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))
    const report = validation?.status === 'success' ? validation.report : null
    const generationRecommended = Boolean(report?.identifiers?.generation_recommended)
    const validating = validation?.status === 'queued' || validation?.status === 'running'
    const prefixValid = idMode !== 'generate' || /^[A-Za-z][A-Za-z0-9]{2,9}$/.test(String(idPrefix || '').trim())

    const canImport = Boolean(trimmedPath)
        && Boolean(String(label || '').trim())
        && prefixValid
        && !importing

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
            <div className={`w-full max-w-2xl rounded-xl border shadow-2xl ${panelClass}`}>
                <div className={`px-5 py-4 border-b flex items-start justify-between gap-4 ${isLight ? 'border-gray-200' : 'border-gray-700'}`}>
                    <div className="min-w-0">
                        <h3 className="text-lg font-bold">Add custom annotation</h3>
                        <div className={`text-xs mt-1 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            {item.scientific_name || item.species_key} - {item.assembly_name || item.assembly}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onCancel}
                        className={`p-1 rounded transition-colors ${isLight ? 'text-gray-400 hover:text-gray-700 hover:bg-gray-100' : 'text-gray-500 hover:text-gray-200 hover:bg-gray-700'}`}
                        aria-label="Close custom annotation dialog"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                <div className="p-5 space-y-4">
                    <div>
                        <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Dataset label
                        </label>
                        <input
                            type="text"
                            value={label || ''}
                            onChange={(event) => onLabelChange(event.target.value)}
                            placeholder={defaultCustomAnnotationLabel()}
                            className={`w-full px-3 py-2 rounded-lg text-sm border ${inputClass}`}
                        />
                    </div>
                    <div>
                        <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Annotation file
                        </label>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={path || ''}
                                onChange={(event) => onPathChange(event.target.value)}
                                placeholder="/path/to/annotation.gff3.gz"
                                className={`flex-1 px-3 py-2 rounded-lg text-xs border font-mono ${inputClass}`}
                            />
                            <button
                                type="button"
                                onClick={onBrowse}
                                className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${secondaryBtn}`}
                            >
                                Browse
                            </button>
                            <button
                                type="button"
                                onClick={onValidate}
                                disabled={!trimmedPath || validating}
                                className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${isLight
                                    ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200'
                                    : 'bg-blue-900/30 text-blue-300 hover:bg-blue-900/50 border border-blue-700/40 disabled:bg-gray-800 disabled:text-gray-500 disabled:border-gray-700'
                                    }`}
                            >
                                {validating ? 'Analysing…' : 'Analyse'}
                            </button>
                        </div>
                        <p className={`mt-1 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            GFF3, GFF or GTF. Output from StringTie, Scallop, BRAKER, AUGUSTUS,
                            Tiberius, Helixer, egapx and similar tools is converted into Ensembl-style
                            GFF3 on import.
                        </p>
                    </div>

                    {requiresConversion ? (
                        <div className={`rounded-lg px-3 py-2 text-xs ${isLight
                            ? 'bg-blue-50 text-blue-800 border border-blue-200'
                            : 'bg-blue-900/20 text-blue-300 border border-blue-800/40'
                            }`}>
                            GTF cannot be indexed directly, so this file will be converted into
                            canonical GFF3. The original is kept alongside it.
                        </div>
                    ) : null}

                    <div>
                        <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                            Identifiers
                        </label>
                        <div className="space-y-1.5">
                            <label className={`flex items-start gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                <input
                                    type="radio"
                                    name="custom-annotation-id-mode"
                                    checked={idMode !== 'generate'}
                                    onChange={() => onIdModeChange('keep')}
                                    className="mt-0.5"
                                />
                                <span>
                                    Use the identifiers in the file
                                    {generationRecommended ? (
                                        <span className={isLight ? ' text-amber-700' : ' text-amber-400'}>
                                            {' '}— not possible for this file
                                        </span>
                                    ) : null}
                                </span>
                            </label>
                            <label className={`flex items-start gap-2 text-xs ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>
                                <input
                                    type="radio"
                                    name="custom-annotation-id-mode"
                                    checked={idMode === 'generate'}
                                    onChange={() => onIdModeChange('generate')}
                                    className="mt-0.5"
                                />
                                <span>Generate Ensembl-style identifiers</span>
                            </label>
                            {idMode === 'generate' ? (
                                <div className="pl-6 space-y-1">
                                    <input
                                        type="text"
                                        value={idPrefix || ''}
                                        onChange={(event) => onIdPrefixChange(event.target.value.toUpperCase())}
                                        placeholder="ENSXYZ"
                                        className={`w-40 px-3 py-1.5 rounded-lg text-xs border font-mono ${inputClass}`}
                                    />
                                    <p className={`text-xs ${prefixValid
                                        ? (isLight ? 'text-gray-500' : 'text-gray-400')
                                        : (isLight ? 'text-red-600' : 'text-red-400')
                                        }`}>
                                        {prefixValid
                                            ? `Produces ${(idPrefix || 'ENSXYZ')}G00000000001, ${(idPrefix || 'ENSXYZ')}T00000000001, …`
                                            : '3-10 characters, starting with a letter (letters and digits only).'}
                                    </p>
                                </div>
                            ) : null}
                        </div>
                    </div>

                    {validation ? (
                        <div className="max-h-96 overflow-y-auto">
                            <ValidationReportPanel
                                kind="annotation"
                                theme={theme}
                                status={validation.status}
                                progress={validation.progress}
                                stage={validation.stage}
                                message={validation.message}
                                counters={validation.counters}
                                report={validation.report}
                                error={validation.error}
                                analysedAt={validation.analysed_at}
                                onClose={onCloseValidation}
                            />
                        </div>
                    ) : null}
                </div>
                <div className={`px-5 py-4 border-t flex justify-end gap-2 ${isLight ? 'border-gray-200 bg-gray-50' : 'border-gray-700 bg-gray-900/30'}`}>
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={importing}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${secondaryBtn}`}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onImport}
                        disabled={!canImport}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${isLight
                            ? 'bg-[#0099ff] text-white hover:bg-[#0088ee] disabled:bg-gray-300 disabled:cursor-not-allowed'
                            : 'bg-blue-600 text-white hover:bg-blue-500 disabled:bg-gray-700 disabled:cursor-not-allowed'
                            }`}
                    >
                        {importing ? 'Importing...' : 'Import'}
                    </button>
                </div>
            </div>
        </div>
    )
}
