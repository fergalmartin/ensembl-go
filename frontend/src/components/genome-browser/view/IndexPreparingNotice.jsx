export const IndexPreparingNotice = ({ isLight, state, detail, onRetry }) => {
    const isError = state === 'error'
    const title = isError ? 'Index Not Ready' : 'Building Index'
    const message = isError
        ? (detail || 'The index is not ready for display. Please finish indexing, then try again.')
        : 'Preparing regions for display. This view will refresh automatically when the index is ready.'

    return (
        <div className={`h-full w-full flex flex-col items-center justify-center p-6 ${isLight ? 'bg-blue-50/50' : 'bg-blue-900/10'}`}>
            {!isError ? (
                <div className={`w-8 h-8 border-4 border-t-transparent rounded-full animate-spin mb-3 ${isLight ? 'border-blue-500' : 'border-blue-400'}`} />
            ) : (
                <svg className={`w-12 h-12 mb-3 ${isLight ? 'text-amber-500' : 'text-amber-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
            )}
            <p className={`text-sm font-semibold ${isLight ? (isError ? 'text-amber-800' : 'text-blue-800') : (isError ? 'text-amber-300' : 'text-blue-300')}`}>
                {title}
            </p>
            <p className={`text-xs text-center max-w-sm mt-1 ${isLight ? (isError ? 'text-amber-700/80' : 'text-blue-700/80') : (isError ? 'text-amber-300/90' : 'text-blue-300/80')}`}>
                {message}
            </p>
            {/* A build that failed is remembered, so polling alone will never
                clear it — without a way to ask again the only way out was to
                restart the backend. */}
            {isError && onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className={`mt-3 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${isLight
                        ? 'border-amber-300 bg-white text-amber-800 hover:bg-amber-50'
                        : 'border-amber-400/40 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20'}`}
                >
                    Build the index again
                </button>
            )}
        </div>
    )
}
