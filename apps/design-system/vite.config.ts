import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { cspPrimitives } from '@exponetdb/ui/vite'
import mdx from '@mdx-js/rollup'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig, type Plugin } from 'vite'
import { buildMarkdownIndex } from './src/content/markdown-export.ts'

// A static site (OD-31: built, not deployed). Workspace packages resolve to
// their sources through the `@exponetdb/source` condition, as in the tests.
// Guidance and component pages are MDX, compiled at build time to React
// (no Markdown is parsed in the browser). The build also writes the
// agent-readable index: `llms.txt` and one Markdown file per page.

const contentDir = new URL('./src/content/', import.meta.url).pathname

function mdxSources(dir: string): { path: string; source: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return mdxSources(full)
    return name.endsWith('.mdx')
      ? [{ path: relative(contentDir, full), source: readFileSync(full, 'utf8') }]
      : []
  })
}

function markdownIndex(): Plugin {
  return {
    name: 'exdb-markdown-index',
    apply: 'build',
    generateBundle() {
      for (const file of buildMarkdownIndex(mdxSources(contentDir))) {
        this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source })
      }
    },
  }
}

export default defineConfig({
  plugins: [
    { enforce: 'pre', ...mdx({ providerImportSource: null }) },
    cspPrimitives(),
    react({ include: /\.(mdx|tsx?)$/ }),
    tailwindcss(),
    markdownIndex(),
  ],
  resolve: { conditions: ['@exponetdb/source', ...defaultClientConditions] },
  build: { sourcemap: false, assetsDir: 'assets' },
})
