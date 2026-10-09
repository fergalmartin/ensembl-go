import { isDemoGenomeItem } from '../../tutorials/demoGenome.js'
import { IconDownload, IconDownloaded, IconTrash } from './downloadIcons'
import { missingSelectedDownloadTypes, selectedDownloadTypeList, withImplicitMetadataTypes } from './downloadModel.js'
import { FileAvailabilityDropdown } from './FileAvailabilityDropdown'

export function GenomeRowActions({
    item,
    selectedTypes,
    localTypes = [],
    localFileInfo = null,
    tasksByItemKey,
    downloading,
    demoProgress = null,
    isLight,
    onDownload,
    onDownloadFiles,
    onCancelFiles,
    onDeleteFile,
    onDelete = null,
    deleteDisabled = false,
    deleteTitle = 'Remove downloaded files',
}) {
    const itemTasks = tasksByItemKey?.[item.id] || []
    // The demo genome is copied from disk rather than queued, so it has no tasks to read
    // progress from and none of the machinery below sees it as running. Its progress is
    // driven from above instead, and the button is otherwise treated exactly the same.
    const isDemo = isDemoGenomeItem(item)
    const demoRunning = isDemo && demoProgress != null
    const desiredTypes = selectedDownloadTypeList(selectedTypes)
    const desiredTypesWithMetadata = withImplicitMetadataTypes(desiredTypes)
    const activeTypeSet = new Set(itemTasks
        .filter((task) => ['pending', 'downloading'].includes(String(task.status || '')))
        .map((task) => String(task.file_type || ''))
        .filter(Boolean))
    const pendingTypes = missingSelectedDownloadTypes(selectedTypes, localTypes)
    const downloadTypes = pendingTypes.filter((type) => !activeTypeSet.has(type))
    const complete = desiredTypes.length > 0 && pendingTypes.length === 0
    const activeTasks = itemTasks.filter((task) => (
        ['pending', 'downloading'].includes(String(task.status || ''))
        && desiredTypesWithMetadata.includes(String(task.file_type || ''))
    ))
    const active = demoRunning || (desiredTypes.length > 0 && activeTasks.length > 0 && downloadTypes.length === 0)
    const activeProgress = demoRunning
        ? demoProgress
        : itemTasks
            .filter((task) => activeTasks.includes(task))
            .reduce((best, task) => Math.max(best, Number(task.progress || 0)), 0)
    // A tutorial step the user cannot repeat is a step they cannot go back to, so the demo
    // genome stays downloadable after it has been downloaded. Re-fetching it just
    // overwrites the same handful of files.
    const replayable = isDemo && !demoRunning
    const disabled = replayable
        ? false
        : (downloading || desiredTypes.length === 0 || active || downloadTypes.length === 0)
    const title = desiredTypes.length === 0
        ? 'Select data to download'
        : active
            ? `Downloading ${Math.round(activeProgress * 100)}%`
        : complete
            ? 'Selected data is already downloaded'
            : downloadTypes.length > 0
                ? 'Download selected data'
                : 'Selected data is already queued'

    const buttonClass = active
        ? (isLight ? 'text-blue-700 border-blue-200 cursor-progress' : 'text-blue-300 border-blue-900/50 cursor-progress')
        : complete
            // The green tick means "already here", which is normally the end of it — except
            // for the demo genome, which stays re-fetchable so the tutorial step can be
            // replayed, and so must still look like something you can press.
            ? `${isLight ? 'text-green-600 bg-green-50 border-green-100' : 'text-green-300 bg-green-900/20 border-green-900/40'} ${replayable ? 'cursor-pointer' : 'cursor-default'}`
            : disabled
                ? 'opacity-40 border-transparent cursor-not-allowed'
                // cursor-pointer is not the browser default on a button, and a control the
                // tutorial is asking someone to click should look like one.
                : (isLight ? 'cursor-pointer text-blue-700 border-blue-100 hover:bg-blue-50' : 'cursor-pointer text-blue-300 border-blue-900/40 hover:bg-blue-900/20')
    const Icon = complete && !active ? IconDownloaded : IconDownload
    const downloadNow = replayable && downloadTypes.length === 0 ? desiredTypes : downloadTypes

    return (
        <div className="flex items-center justify-end gap-1">
            <FileAvailabilityDropdown
                item={item}
                selectedTypes={selectedTypes}
                localTypes={localTypes}
                localFileInfo={localFileInfo}
                itemTasks={itemTasks}
                onDownloadFiles={(files, options) => onDownloadFiles(item, files, options)}
                onCancelFiles={(files) => onCancelFiles?.(item, files)}
                onDeleteFile={onDeleteFile}
                isLight={isLight}
            />
            <button
                data-tour-id={`download-start-${item.species_key}`}
                type="button"
                disabled={disabled}
                title={title}
                onClick={(e) => {
                    e.stopPropagation()
                    if (downloadNow.length === 0) return
                    onDownload(item, { selectedTypes: downloadNow })
                }}
                className={`w-8 h-8 inline-flex items-center justify-center rounded-md border transition-colors ${buttonClass}`}
            >
                <Icon size={15} progress={active ? activeProgress : null} />
            </button>
            {onDelete && (
                <button
                    type="button"
                    disabled={deleteDisabled}
                    title={deleteTitle}
                    onClick={(e) => {
                        e.stopPropagation()
                        if (!deleteDisabled) onDelete(item)
                    }}
                    className={`w-8 h-8 inline-flex items-center justify-center rounded-md transition-colors ${deleteDisabled
                        ? 'opacity-35 cursor-not-allowed'
                        : (isLight ? 'text-gray-400 hover:text-red-600 hover:bg-red-50' : 'text-gray-500 hover:text-red-400 hover:bg-red-900/20')}`}
                >
                    <IconTrash size={14} />
                </button>
            )}
        </div>
    )
}
