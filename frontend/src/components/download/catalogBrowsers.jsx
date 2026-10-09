import { useState } from 'react'
import { IconUpDown } from './downloadIcons'
import { VERTEBRATE_GROUPS } from './downloadModel.js'

// ---------------------------------------------------------------------------
// Group sidebar
// ---------------------------------------------------------------------------
export function GroupBrowser({ groups, totalAssemblies, activeGroup, activeSubGroup, onSelectGroup, onSelectSubGroup, isLight }) {
    const [expandedGroups, setExpandedGroups] = useState({})
    const toggleGroup = (name) => setExpandedGroups(prev => ({ ...prev, [name]: !prev[name] }))
    const totalSpecies = groups
        .filter(g => g.name !== 'Models' && g.name !== 'Local genomes' && g.name !== 'Projects')
        .reduce((s, g) => s + g.count, 0)

    // Split groups into vertebrates vs others
    const vertebrateGroups = groups.filter(g => VERTEBRATE_GROUPS.has(g.name))
    const projectGroup = groups.find(g => g.name === 'Projects')
    const otherGroups = groups.filter(g => !VERTEBRATE_GROUPS.has(g.name) && g.name !== 'Models' && g.name !== 'Local genomes' && g.name !== 'Projects')
    const localGenomesGroup = groups.find(g => g.name === 'Local genomes')
    const vertebrateCount = vertebrateGroups.reduce((s, g) => s + g.count, 0)

    const itemBase = `flex items-center justify-between px-3 py-1.5 rounded-md cursor-pointer text-sm transition-colors`
    const activeStyle = isLight ? 'bg-blue-100 text-blue-800 font-semibold' : 'bg-blue-900/40 text-blue-300 font-semibold'
    const inactiveStyle = isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-700/50'

    const isVertActive = activeGroup === 'Vertebrates' || (VERTEBRATE_GROUPS.has(activeGroup) && !activeSubGroup)
    const isModelsActive = activeGroup === 'Models'

    // Renders a single group row (with optional indent and expandable subgroups)
    const renderGroup = (group, indent = 0) => {
        const isActive = activeGroup === group.name && !activeSubGroup
        const hasSubGroups = group.sub_groups?.length > 0
        return (
            <div key={group.name}>
                <div
                    className={`${itemBase} ${isActive ? activeStyle : inactiveStyle}`}
                    style={indent ? { paddingLeft: `${indent}rem` } : undefined}
                    onClick={() => {
                        onSelectGroup(group.name)
                        onSelectSubGroup(null)
                        if (hasSubGroups) toggleGroup(group.name)
                    }}
                >
                    <span>{group.name}</span>
                    <span className="flex items-center">
                        <span className={`text-xs tabular-nums w-10 text-right ${isActive ? '' : 'opacity-50'}`}>{group.count}</span>
                        <span className="w-4 flex justify-center">
                            {hasSubGroups && (
                                <span className="opacity-50"><IconUpDown open={expandedGroups[group.name]} /></span>
                            )}
                        </span>
                    </span>
                </div>

                {expandedGroups[group.name] && group.sub_groups?.map(sg => (
                    <div
                        key={sg.name}
                        onClick={() => { onSelectGroup(group.name); onSelectSubGroup(sg.name) }}
                        className={`${itemBase} ${activeGroup === group.name && activeSubGroup === sg.name ? activeStyle : inactiveStyle}`}
                        style={{ paddingLeft: `${(indent || 0.75) + 1}rem` }}
                    >
                        <span>{sg.name}</span>
                        <span className="flex items-center">
                            <span className={`text-xs tabular-nums w-10 text-right ${activeSubGroup === sg.name ? '' : 'opacity-50'}`}>{sg.count}</span>
                            <span className="w-4" />
                        </span>
                    </div>
                ))}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-0.5 overflow-y-auto">
            {/* All Species */}
            <div
                onClick={() => { onSelectGroup('All'); onSelectSubGroup(null) }}
                className={`${itemBase} ${activeGroup === 'All' ? activeStyle : inactiveStyle}`}
            >
                <span>All Species</span>
                <span className="flex items-center">
                    <span className={`text-xs tabular-nums w-10 text-right ${activeGroup === 'All' ? '' : 'opacity-50'}`}>{totalSpecies}</span>
                    <span className="w-4" />
                </span>
            </div>

            {/* All Assemblies */}
            <div className={`${itemBase} pointer-events-none`}>
                <span className={`text-xs ${isLight ? 'text-gray-400' : 'text-gray-500'}`}>All Assemblies</span>
                <span className="flex items-center">
                    <span className={`text-xs tabular-nums w-10 text-right opacity-50`}>{totalAssemblies}</span>
                    <span className="w-4" />
                </span>
            </div>

            <div className={`my-1 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`} />

            {localGenomesGroup && (
                <>
                    <div
                        onClick={() => { onSelectGroup('Local genomes'); onSelectSubGroup(null) }}
                        className={`${itemBase} ${activeGroup === 'Local genomes' ? activeStyle : inactiveStyle}`}
                    >
                        <span>Local genomes</span>
                        <span className="flex items-center">
                            <span className={`text-xs tabular-nums w-10 text-right ${activeGroup === 'Local genomes' ? '' : 'opacity-50'}`}>
                                {localGenomesGroup.count}
                            </span>
                            <span className="w-4" />
                        </span>
                    </div>
                    <div className={`my-1 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`} />
                </>
            )}

            {/* Models group */}
            {groups.find(g => g.name === 'Models') && (
                <div
                    onClick={() => { onSelectGroup('Models'); onSelectSubGroup(null) }}
                    className={`${itemBase} ${isModelsActive ? activeStyle : inactiveStyle}`}
                >
                    <span>Models</span>
                    <span className="flex items-center">
                        <span className={`text-xs tabular-nums w-10 text-right ${isModelsActive ? '' : 'opacity-50'}`}>
                            {groups.find(g => g.name === 'Models')?.count || 0}
                        </span>
                        <span className="w-4" />
                    </span>
                </div>
            )}

            {/* Vertebrates super-group */}
            {vertebrateGroups.length > 0 && (
                <div>
                    <div
                        className={`${itemBase} ${activeGroup === 'Vertebrates' && !activeSubGroup ? activeStyle : inactiveStyle}`}
                        onClick={() => {
                            onSelectGroup('Vertebrates')
                            onSelectSubGroup(null)
                            toggleGroup('Vertebrates')
                        }}
                    >
                        <span>Vertebrates</span>
                        <span className="flex items-center">
                            <span className={`text-xs tabular-nums w-10 text-right ${isVertActive ? '' : 'opacity-50'}`}>{vertebrateCount}</span>
                            <span className="w-4 flex justify-center">
                                <span className="opacity-50"><IconUpDown open={expandedGroups['Vertebrates']} /></span>
                            </span>
                        </span>
                    </div>

                    {expandedGroups['Vertebrates'] && vertebrateGroups.map(g => renderGroup(g, 1.25))}
                </div>
            )}

            {/* Non-vertebrate groups */}
            {otherGroups.map(g => renderGroup(g))}

            {/* Project membership group */}
            {projectGroup && (
                <>
                    <div className={`my-1 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`} />
                    {renderGroup(projectGroup)}
                </>
            )}

        </div>
    )
}

// ---------------------------------------------------------------------------
// RefSeqGroupBrowser — sidebar group browser for the RefSeq tab
// ---------------------------------------------------------------------------

export function RefSeqGroupBrowser({ groups, activeGroup, activeSubGroup, onSelectGroup, onSelectSubGroup, isLight, loading }) {
    const [expandedGroups, setExpandedGroups] = useState({ Vertebrates: true })
    const toggleGroup = (name) => setExpandedGroups(prev => ({ ...prev, [name]: !prev[name] }))

    const itemBase = `flex items-center justify-between px-3 py-1.5 rounded-md cursor-pointer text-sm transition-colors`
    const activeStyle = isLight ? 'bg-blue-100 text-blue-800 font-semibold' : 'bg-blue-900/40 text-blue-300 font-semibold'
    const inactiveStyle = isLight ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-700/50'

    const countFor = (name) => {
        const g = groups.find(g => g.name === name)
        return g ? g.count : null
    }
    const subCountFor = (parentName, childName) => {
        const g = groups.find(g => g.name === parentName)
        const sg = g?.sub_groups?.find(s => s.name === childName)
        return sg != null ? sg.count : null
    }

    const countBadge = (count, isActive) => (
        <span className={`text-xs tabular-nums min-w-[3.5rem] pr-1 text-right shrink-0 ${isActive ? '' : 'opacity-50'}`}>
            {loading ? '…' : (count === null ? '…' : count)}
        </span>
    )

    const renderLeaf = (name, indent = 0) => {
        const isActive = activeGroup === name && !activeSubGroup
        return (
            <div
                key={name}
                className={`${itemBase} ${isActive ? activeStyle : inactiveStyle}`}
                style={indent ? { paddingLeft: `${indent}rem` } : undefined}
                onClick={() => { onSelectGroup(name); onSelectSubGroup(null) }}
            >
                <span>{name}</span>
                <span className="flex items-center">
                    {countBadge(countFor(name), isActive)}
                    <span className="w-4" />
                </span>
            </div>
        )
    }

    const renderSuperGroup = (superName, childNames, getChildCount) => {
        const isExpanded = expandedGroups[superName]
        // If the backend doesn't return a parent group by this name, derive the total from children
        const parentGroup = groups.find(g => g.name === superName)
        const totalCount = loading ? null : (
            parentGroup ? parentGroup.count : childNames.reduce((sum, n) => sum + (getChildCount(n) ?? 0), 0) || null
        )
        const childActive = childNames.includes(activeGroup) && !activeSubGroup
        const superIsActive = (activeGroup === superName && !activeSubGroup) || childActive

        return (
            <div key={superName}>
                <div
                    className={`${itemBase} ${superIsActive ? activeStyle : inactiveStyle}`}
                    onClick={() => { onSelectGroup(superName); onSelectSubGroup(null); toggleGroup(superName) }}
                >
                    <span>{superName}</span>
                    <span className="flex items-center">
                        {countBadge(totalCount, superIsActive)}
                        <span className="w-4 flex justify-center">
                            <span className="opacity-50"><IconUpDown open={isExpanded} /></span>
                        </span>
                    </span>
                </div>
                {isExpanded && childNames.map(childName => {
                    const isChildActive = activeGroup === childName && !activeSubGroup
                    return (
                        <div
                            key={childName}
                            className={`${itemBase} ${isChildActive ? activeStyle : inactiveStyle}`}
                            style={{ paddingLeft: '1.25rem' }}
                            onClick={() => { onSelectGroup(childName); onSelectSubGroup(null) }}
                        >
                            <span>{childName}</span>
                            <span className="flex items-center">
                                {countBadge(getChildCount(childName), isChildActive)}
                                <span className="w-4" />
                            </span>
                        </div>
                    )
                })}
            </div>
        )
    }

    const allGenomesActive = activeGroup === 'All genomes'
    const featuredActive = activeGroup === 'Featured'

    return (
        <div className="flex flex-col gap-0.5 overflow-y-auto">
            <div
                className={`${itemBase} ${allGenomesActive ? activeStyle : inactiveStyle}`}
                onClick={() => { onSelectGroup('All genomes'); onSelectSubGroup(null) }}
            >
                <span>All genomes</span>
                <span className="flex items-center">
                    {countBadge(countFor('All genomes'), allGenomesActive)}
                    <span className="w-4" />
                </span>
            </div>
            <div
                className={`${itemBase} ${featuredActive ? activeStyle : inactiveStyle}`}
                onClick={() => { onSelectGroup('Featured'); onSelectSubGroup(null) }}
            >
                <span>Featured</span>
                <span className="flex items-center">
                    {countBadge(countFor('Featured'), featuredActive)}
                    <span className="w-4" />
                </span>
            </div>

            <div className={`my-1 border-t ${isLight ? 'border-gray-200' : 'border-gray-700'}`} />

            {renderSuperGroup('Vertebrates', ['Mammals', 'Fish', 'Birds', 'Reptiles', 'Amphibians'],
                (n) => subCountFor('Vertebrates', n))}
            {renderSuperGroup('Invertebrates', ['Insects', 'Nematodes'],
                (n) => subCountFor('Invertebrates', n))}
            {renderLeaf('Plants')}
            {renderLeaf('Fungi')}
            {renderSuperGroup('Microbes', ['Bacteria', 'Archaea'],
                (n) => countFor(n))}
        </div>
    )
}
