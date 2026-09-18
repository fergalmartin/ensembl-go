// The measurements and colours the genome browser's focus drawers share.
//
// Kept apart from the glyphs next door so that neither file mixes components
// with plain values, which is what fast refresh wants. FocusGeneDrawer and
// FocusLocationDrawer still carry their own copies of both; they predate this
// module and moving them is a separate change.

export const FOCUS_DRAWER_HEADER_BUTTON = { width: 26, height: 22 }

/** Every colour the drawer chrome uses, in one place. */
export function focusDrawerPalette(isLight, accent = '') {
    return {
        surface: {
            backgroundColor: isLight ? '#ffffff' : '#1E2938',
            borderColor: isLight ? '#dee2e6' : '#373a40',
        },
        band: {
            backgroundColor: isLight ? '#dbe4ff' : '#2b3a55',
            color: isLight ? '#1e293b' : '#ffffff',
            borderLeft: `1px solid ${isLight ? '#b1c2ff' : '#1e293b'}`,
            boxSizing: 'border-box',
        },
        accent: accent || (isLight ? '#0099ff' : '#0077cc'),
        divider: isLight ? '#e5e7eb' : '#374151',
        textClass: isLight ? 'text-gray-800' : 'text-gray-200',
        subTextClass: isLight ? 'text-gray-500' : 'text-gray-400',
        rowHoverClass: isLight ? 'hover:bg-gray-100' : 'hover:bg-[#273449]',
        selectedRow: isLight ? '#dbe4ff' : '#2b3a55',
    }
}
