import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installApiFetchShim } from './backendRuntime.js'
import { NoteStoreProvider } from './hooks/useNoteStore.jsx'

installApiFetchShim()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Above App, because the genome browser's drawer and the Notes view both
        read from it and there must be exactly one — see useNoteStore.jsx. */}
    <NoteStoreProvider>
      <App />
    </NoteStoreProvider>
  </StrictMode>,
)
