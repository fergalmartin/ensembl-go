import { getAssemblyAccession } from '../../utils/genomeIdentity.js'
import { IconDownload, IconDownloaded, IconUpDown } from './downloadIcons'
import { itemFromSpeciesAssembly, missingSelectedDownloadTypes, selectedDownloadTypeList } from './downloadModel.js'
import { GenomeRowActions } from './GenomeRowActions'

// ---------------------------------------------------------------------------
// Species table row
// ---------------------------------------------------------------------------
export function SpeciesRow({ species, expanded, onToggleExpand, onDownload, onDownloadAll, onDownloadFiles, onCancelFiles, onDeleteFile, selectedTypes, localTypeByKey, localFileInfoByKey = new Map(), tasksByItemKey, downloading, demoProgress = null, isLight }) {
    const hasMany = species.assemblies.length > 1
    const firstAsm = species.assemblies[0]

    const gridCols = 'minmax(0, 2fr) 155px minmax(0, 1fr) 140px 92px'
    const rowBase = `grid items-center border-b text-sm transition-colors ${isLight ? 'border-gray-100 hover:bg-gray-50' : 'border-gray-700/50 hover:bg-gray-700/30'}`

    const renderActions = (asm) => {
        const item = itemFromSpeciesAssembly(species, asm)
        const localTypes = localTypeByKey.get(item.id) || []
        const localFileInfo = localFileInfoByKey.get(item.id) || null
        return (
            <GenomeRowActions
                item={item}
                selectedTypes={selectedTypes}
                localTypes={localTypes}
                localFileInfo={localFileInfo}
                tasksByItemKey={tasksByItemKey}
                downloading={downloading}
                demoProgress={demoProgress}
                isLight={isLight}
                onDownload={onDownload}
                onDownloadFiles={onDownloadFiles}
                onCancelFiles={onCancelFiles}
                onDeleteFile={onDeleteFile}
            />
        )
    }

    // Single assembly — standard row with direct download actions
    if (!hasMany) {
        return (
            <div data-tour-id={`download-species-${species.key}`} className={rowBase} style={{ gridTemplateColumns: gridCols }}>
                <div className={`px-3 py-2.5 overflow-hidden ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                    <div className="font-medium leading-tight truncate" title={species.scientific_name}>{species.scientific_name}</div>
                    {species.common_name && (
                        <div className={`text-xs mt-0.5 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={species.common_name}>{species.common_name}</div>
                    )}
                </div>
                <div className={`px-3 py-2.5 font-mono text-xs truncate ${isLight ? 'text-gray-600' : 'text-gray-400'}`} title={getAssemblyAccession(firstAsm)}>
                    {getAssemblyAccession(firstAsm)}
                </div>
                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`} title={firstAsm?.name}>
                    {firstAsm?.name}
                </div>
                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                    {firstAsm?.source_database || firstAsm?.level}
                </div>
                <div className="px-3 py-2.5">
                    {renderActions(firstAsm)}
                </div>
            </div>
        )
    }

    // Multi-assembly — collapsible header row + individual assembly rows
    const selectedTypesByItem = {}
    let pendingAssemblyCount = 0
    for (const asm of species.assemblies) {
        const item = itemFromSpeciesAssembly(species, asm)
        const localTypes = localTypeByKey.get(item.id) || []
        const itemTasks = tasksByItemKey?.[item.id] || []
        const activeTypeSet = new Set(itemTasks
            .filter((task) => ['pending', 'downloading'].includes(String(task.status || '')))
            .map((task) => String(task.file_type || ''))
            .filter(Boolean))
        const pendingTypes = missingSelectedDownloadTypes(selectedTypes, localTypes).filter((type) => !activeTypeSet.has(type))
        selectedTypesByItem[item.id] = pendingTypes
        if (pendingTypes.length > 0) pendingAssemblyCount++
    }
    const selectedTypeCount = selectedDownloadTypeList(selectedTypes).length
    const allSelectedDataDownloaded = selectedTypeCount > 0 && pendingAssemblyCount === 0

    return (
        <div>
            {/* Header row — click anywhere to expand/collapse; flex layout so name spans full width */}
            <div
                className={`flex items-center border-b text-sm transition-colors cursor-pointer ${isLight ? 'border-gray-100 hover:bg-gray-50' : 'border-gray-700/50 hover:bg-gray-700/30'}`}
                onClick={() => onToggleExpand(species.key)}
            >
                <div className="flex-1 min-w-0 px-3 py-2.5">
                    <div className={`font-medium leading-tight ${isLight ? 'text-blue-700' : 'text-blue-400'}`}>
                        {species.scientific_name}
                        <span className={`ml-2 text-xs font-normal ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>
                            ({species.assemblies.length} assemblies)
                        </span>
                    </div>
                    {species.common_name && (
                        <div className={`text-xs mt-0.5 ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>{species.common_name}</div>
                    )}
                </div>
                <div className="px-3 py-2.5 shrink-0 flex items-center gap-1">
                    <button
                        type="button"
                        title={expanded ? 'Collapse assemblies' : 'Expand assemblies'}
                        aria-label={expanded ? 'Collapse assemblies' : 'Expand assemblies'}
                        onClick={(e) => {
                            e.stopPropagation()
                            onToggleExpand(species.key)
                        }}
                        className={`w-8 h-8 inline-flex items-center justify-center rounded-md border transition-colors ${isLight
                            ? 'text-gray-500 border-gray-200 hover:text-gray-800 hover:bg-gray-50'
                            : 'text-gray-400 border-gray-700 hover:text-gray-100 hover:bg-gray-700'}`}
                    >
                        <IconUpDown open={expanded} size={14} />
                    </button>
                    <button
                        type="button"
                        disabled={downloading || selectedTypeCount === 0 || pendingAssemblyCount === 0}
                        title={allSelectedDataDownloaded ? 'Selected data is already downloaded for all assemblies' : 'Download selected files for all assemblies sequentially'}
                        onClick={(e) => {
                            e.stopPropagation()
                            onDownloadAll(species, { selectedTypesByItem })
                        }}
                        // Asymmetric padding on purpose. The icon-only download button in
                        // single-assembly rows insets its icon by centring it in a w-8 box,
                        // which works out at 7.5px from the edge; matching that here puts
                        // both icons' centres on the same vertical axis.
                        className={`${allSelectedDataDownloaded ? 'w-8 h-8 justify-center' : 'gap-1.5 pl-2.5 pr-[7.5px] py-1.5'} inline-flex items-center rounded-md text-xs font-semibold transition-colors ${downloading || selectedTypeCount === 0 || pendingAssemblyCount === 0
                            ? (allSelectedDataDownloaded
                                ? (isLight ? 'text-green-700 bg-green-50 border border-green-100 cursor-default' : 'text-green-300 bg-green-900/20 border border-green-900/40 cursor-default')
                                : 'opacity-40 cursor-not-allowed border border-transparent')
                            : (isLight ? 'text-blue-700 bg-white border border-blue-100 hover:bg-blue-50' : 'text-blue-300 bg-gray-800 border border-blue-900/40 hover:bg-blue-900/20')}`}
                    >
                        {!allSelectedDataDownloaded && <span>Download all</span>}
                        {allSelectedDataDownloaded ? <IconDownloaded size={15} /> : <IconDownload size={15} />}
                    </button>
                </div>
            </div>

            {/* Expanded assembly rows — same grid layout as single-assembly rows, but with a visual spine in the first column */}
            {expanded && (
                <div className="relative">
                    {/* The Clickable Spine Area: entire left margin area acts as collapse target */}
                    <div
                        className="absolute top-0 bottom-0 left-0 w-8 cursor-pointer z-10"
                        title="Collapse"
                        onClick={() => onToggleExpand(species.key)}
                    />

                    {species.assemblies.map((asm, index) => {
                        const isLast = index === species.assemblies.length - 1

                        return (
                            <div
                                key={getAssemblyAccession(asm)}
                                className={`relative grid items-center text-sm transition-colors ${isLast ? 'border-b' : ''
                                    } ${isLight ? 'border-gray-100' : 'border-gray-700/50 hover:bg-gray-700/10'}`}
                                style={{ gridTemplateColumns: gridCols }}
                            >
                                {/* Column 1: Species name with visual spine offset */}
                                <div className={`px-3 py-2.5 overflow-hidden flex items-stretch ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>
                                    {/* Visual tree connecting lines */}
                                    <div className="relative w-8 shrink-0 mr-2 flex items-center cursor-pointer pointer-events-auto" onClick={() => onToggleExpand(species.key)}>
                                        {/* Vertical line: goes all the way down unless it's the last item (then only goes halfway) */}
                                        <div
                                            className={`absolute left-4 top-0 ${isLast ? 'bottom-1/2' : 'bottom-0'} border-l-2 ${isLight ? 'border-gray-300' : 'border-gray-600'}`}
                                        />
                                        {/* Horizontal connecting line: from the vertical line to the text */}
                                        <div
                                            className={`absolute left-4 w-4 border-b-2 ${isLight ? 'border-gray-300' : 'border-gray-600'}`}
                                        />
                                    </div>

                                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                                        <div className="font-medium leading-tight truncate" title={species.scientific_name}>{species.scientific_name}</div>
                                        {species.common_name && (
                                            <div className={`text-xs mt-0.5 truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`} title={species.common_name}>{species.common_name}</div>
                                        )}
                                    </div>
                                </div>

                                {/* Remaining columns match grid alignment perfectly */}
                                <div className={`px-3 py-2.5 font-mono text-xs truncate ${isLight ? 'text-gray-600' : 'text-gray-400'}`} title={getAssemblyAccession(asm)}>
                                    {getAssemblyAccession(asm)}
                                </div>
                                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`} title={asm.name}>
                                    {asm.name}
                                </div>
                                <div className={`px-3 py-2.5 text-xs truncate ${isLight ? 'text-gray-500' : 'text-gray-400'}`}>
                                    {asm.source_database || asm.level}
                                </div>
                                <div className="px-3 py-2.5">
                                    {renderActions(asm)}
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
