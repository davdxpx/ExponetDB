import { cspPrimitives } from '@exponetdb/ui/vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'

/**
 * The Wave 8 Web App build (ADR-0031): `index.html` plus `assets/app.js` and
 * `assets/app.css` with fixed names (served no-store), content-hashed
 * chunks in `assets/chunks/` and other files (styles of lazy routes, fonts,
 * images, workers) in `assets/files/` (served immutable). No source maps,
 * no module-preload polyfill. Workspace packages resolve to their sources.
 * Until the parity switch (Phase 8) the output goes to `dist-app/`; the
 * Wave 3A build still writes `dist/`.
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
  ],
  resolve: { conditions: ['@exponetdb/source', ...defaultClientConditions] },
  build: {
    outDir: process.env['EXDB_WEB_OUT_DIR'] ?? 'dist-app',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { app: 'index.html' },
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/chunks/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.includes('app.css')
            ? 'assets/app.css'
            : 'assets/files/[name]-[hash][extname]',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: { output: { entryFileNames: 'assets/chunks/[name]-[hash].js' } },
  },
})
