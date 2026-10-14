// First: no schema may be built before zod is jitless (zod-jitless.ts).
import './zod-jitless.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'
import './styles.css'

const root = document.getElementById('root')
if (root === null) {
  throw new Error('the page has no #root element')
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
