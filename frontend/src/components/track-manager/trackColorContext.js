import { createContext } from 'react'

// The app's palette (built-in plus the user's own colours), provided once by the view so
// every track colour field offers the same choices as the Genome Selector.
export const TrackColorPaletteContext = createContext(null)
