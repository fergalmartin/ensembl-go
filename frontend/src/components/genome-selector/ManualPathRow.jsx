// The three ids are passed in rather than derived from one, because the anchor check in
// tutorials.test.js reads this source as text: an id assembled at runtime from a prop is
// invisible to it. Each call site writes its own three out in full.
export function ManualPathRow({
    label, value, onBrowse, placeholder, isLight, onValidate, validating, hint,
    tourId, analyseTourId, browseTourId,
}) {
    return (
        <div data-tour-id={tourId}>
            <label className={`block text-xs font-semibold mb-1.5 uppercase tracking-wide ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                {label}
            </label>
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={value || ''}
                    readOnly
                    placeholder={placeholder}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs border font-mono ${isLight
                        ? 'bg-gray-50 border-gray-300 text-gray-800 placeholder-gray-400'
                        : 'bg-gray-900 border-gray-600 text-gray-200 placeholder-gray-500'
                        }`}
                />
                {onValidate ? (
                    <button
                        type="button"
                        data-tour-id={analyseTourId}
                        onClick={onValidate}
                        disabled={!value || validating}
                        className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${isLight
                            ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:border-gray-200'
                            : 'bg-blue-900/30 text-blue-300 hover:bg-blue-900/50 border border-blue-700/40 disabled:bg-gray-800 disabled:text-gray-500 disabled:border-gray-700'
                            }`}
                    >
                        {validating ? 'Analysing…' : 'Analyse'}
                    </button>
                ) : null}
                <button
                    type="button"
                    data-tour-id={browseTourId}
                    onClick={onBrowse}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${isLight
                        ? 'bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-300'
                        : 'bg-gray-700 text-gray-200 hover:bg-gray-600 border border-gray-500'
                        }`}
                >
                    Browse
                </button>
            </div>
            {hint ? (
                <p className={`mt-1 text-xs ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{hint}</p>
            ) : null}
        </div>
    )
}
