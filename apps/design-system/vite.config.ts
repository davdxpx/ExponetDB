import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'

// A static site (OD-31: built, not deployed). Workspace packages resolve to
// their sources through the `@exponetdb/source` condition, as in the tests.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['@exponetdb/source', ...defaultClientConditions] },
  build: { sourcemap: false, assetsDir: 'assets' },
})
