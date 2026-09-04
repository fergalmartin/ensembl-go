import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installApiFetchShim } from './backendRuntime.js'
import { NoteStoreProvider } from './hooks/useNoteStore.jsx'
import { TutorialProvider } from './hooks/useTutorial.jsx'
import TutorialBuilderOverlay from './components/TutorialBuilderOverlay.jsx'

installApiFetchShim()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Above App, because the genome browser's drawer and the Notes view both
        read from it and there must be exactly one — see useNoteStore.jsx. */}
    <NoteStoreProvider>
      {/* Above App too, because it renders the tutorial overlay over every app and
          App reports which app is on screen into it. */}
      <TutorialProvider>
        <App />
        <TutorialBuilderOverlay />
      </TutorialProvider>
    </NoteStoreProvider>
  </StrictMode>,
)
