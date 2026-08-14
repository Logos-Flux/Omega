import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// PERF-11/10 — self-host fonts (latin subset) instead of the render-blocking
// Google Fonts <link>. Family names + weights match what the old <link> served
// (Space Grotesk 400–700, Inter 400–600, JetBrains Mono 400/500, Playfair
// Display 400/600 + italic).
import '@fontsource/space-grotesk/latin-400.css'
import '@fontsource/space-grotesk/latin-500.css'
import '@fontsource/space-grotesk/latin-600.css'
import '@fontsource/space-grotesk/latin-700.css'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/playfair-display/latin-400.css'
import '@fontsource/playfair-display/latin-600.css'
import '@fontsource/playfair-display/latin-400-italic.css'
import '@fontsource/playfair-display/latin-600-italic.css'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
