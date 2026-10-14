import { cspPrimitives } from '@exponetdb/ui/vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'
import { thirdPartyNotices } from './scripts/notices-plugin.ts'

/**
 * A file name the server serves: every path segment starts with a letter
 * or a digit (`SEGMENT` in `apps/server/src/composition/web-assets.ts`).
 * Chunks of pathless route files (`_app.tsx`, `_session.tsx`) would start
 * with `_` and be refused, so leading characters other than letters and
 * digits are dropped.
 */
function servedName(name: string): string {
  return name.replace(/^[^A-Za-z0-9]+/, '') || 'chunk'
}

/**
 * The Wave 8 Web App build (ADR-0031): `index.html` plus `assets/app.js` and
 * `assets/app.css` with fixed names (served no-store), content-hashed
 * chunks in `assets/chunks/` and other files (styles of lazy routes, fonts,
 * images, workers) in `assets/files/` (served immutable). No source maps,
 * no module-preload polyfill. Workspace packages resolve to their sources.
 * The output goes to `dist/` (what `serve` loads and the server bundle
 * copies), or to `EXDB_WEB_OUT_DIR` for a build beside it; `bun run build`
 * then runs `scripts/postbuild.ts` on it.
 */
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      quoteStyle: 'single',
      semicolons: false,
    }),
    cspPrimitives(),
    react(),
    tailwindcss(),
    thirdPartyNotices(),
  ],
  resolve: { conditions: ['@exponetdb/source', ...defaultClientConditions] },
  build: {
    outDir: process.env['EXDB_WEB_OUT_DIR'] ?? 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { app: 'index.html' },
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: (chunk) => `assets/chunks/${servedName(chunk.name)}-[hash].js`,
        assetFileNames: (asset) =>
          asset.names.includes('app.css')
            ? 'assets/app.css'
            : `assets/files/${servedName((asset.names[0] ?? '').replace(/\.[^.]*$/, ''))}-[hash][extname]`,
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: (chunk) => `assets/chunks/${servedName(chunk.name)}-[hash].js`,
      },
    },
  },
})
