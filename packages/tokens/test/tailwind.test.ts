import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { compileTokens, packageRoot, srcDir, stripComments, tokenCompiler } from './support/css.ts'

/** Tailwind v4 compiles the tokens exactly like an app compiles them. */
const requested = [
  'bg-production',
  'text-state-healthy',
  'dark:bg-background',
  'font-mono',
  'font-sans',
] as const

describe('compile with the Tailwind v4 compile API', () => {
  it('generates the requested utilities', async () => {
    const css = await compileTokens(requested)
    expect(css).toMatch(/\.bg-production\s*\{\s*background-color:\s*var\(--production\)/)
    expect(css).toMatch(/\.text-state-healthy\s*\{\s*color:\s*var\(--state-healthy\)/)
    expect(css).toMatch(/\.font-mono\s*\{\s*font-family:\s*var\(--font-mono\)/)
    expect(css).toMatch(/\.font-sans\s*\{\s*font-family:\s*var\(--font-sans\)/)
    const dark =
      /\.dark\\:bg-background:where\(\[data-theme\*=['"]dark['"]\] \*, \[data-theme\*=['"]dark['"]\]\)\s*\{\s*background-color:\s*var\(--background\)/
    expect(css).toMatch(dark)
  })

  it('emits the font stacks with Inter and Source Code Pro and no removed face', async () => {
    const css = await compileTokens(requested)
    expect(css).toMatch(/--font-sans:\s*['"]Inter['"],/)
    expect(css).toMatch(/--font-mono:\s*['"]Source Code Pro['"],/)
    expect(css).not.toMatch(/Circular|custom-font|CustomFont/i)
  })

  it('generates no .dark class selector and no brand utilities', async () => {
    const css = await compileTokens([
      ...requested,
      'dark:text-foreground',
      'bg-brand-500',
      'text-brand-600',
    ])
    expect(css).not.toMatch(/(^|[\s,{}])\.dark(?![\w\\-])/)
    expect(css).not.toMatch(/\.bg-brand|\.text-brand/)
    expect(css).not.toMatch(/--[\w-]*brand/)
  })

  it('generates the utilities the primitives and patterns rely on', async () => {
    const candidates = [
      // semantic colors
      'bg-background',
      'text-foreground',
      'bg-card',
      'bg-popover',
      'text-popover-foreground',
      'bg-primary',
      'text-primary-foreground',
      'bg-primary-solid',
      'text-primary-solid-foreground',
      'bg-primary-bright',
      'border-primary-bright',
      'bg-secondary',
      'bg-tertiary',
      'bg-muted',
      'text-muted-foreground',
      'bg-accent',
      'text-accent-foreground',
      'bg-field',
      'bg-control-raised',
      'bg-success',
      'text-success-foreground',
      'bg-warning',
      'text-warning-foreground',
      'bg-destructive',
      'text-destructive-foreground',
      'bg-info',
      'text-info-foreground',
      'border-border',
      'border-input',
      'ring-ring',
      'ring-offset-background',
      // production and states
      'bg-production',
      'text-production-foreground',
      'bg-production-muted',
      'border-production',
      'bg-state-healthy',
      'text-state-healthy-foreground',
      'bg-state-degraded',
      'bg-state-unhealthy',
      'bg-state-unknown',
      'bg-state-stale',
      'text-state-stale',
      'border-state-unhealthy',
      // stepped scales
      'bg-primary-200',
      'text-primary-600',
      'bg-warning-200',
      'border-warning-500',
      'text-warning-600',
      'bg-destructive-200',
      'border-destructive-400',
      'bg-destructive-600',
      'text-success-600',
      // chart slots
      ...Array.from({ length: 8 }, (_, i) => `bg-chart-${i + 1}`),
      'fill-chart-1',
      'stroke-chart-2',
      'bg-chart-3-fill',
      // names the primitives use
      'text-foreground-light',
      'text-foreground-lighter',
      'text-foreground-muted',
      'text-foreground-contrast',
      'bg-surface-75',
      'bg-surface-100',
      'bg-surface-200',
      'bg-surface-300',
      'bg-surface-400',
      'bg-overlay',
      'bg-overlay-hover',
      'bg-selection',
      'bg-control',
      'bg-alternative',
      'bg-dash-sidebar',
      'bg-dash-canvas',
      'bg-default',
      'bg-200',
      'bg-button',
      'bg-dialog',
      'text-background-overlay',
      'border-default',
      'border-muted',
      'border-overlay',
      'border-strong',
      'border-stronger',
      'border-control',
      'border-control-hover',
      'border-secondary',
      'border-alternative',
      'border-button',
      'border-background-surface-100',
      'ring-border-control',
      'bg-border-overlay',
      'bg-border-strong',
      'border-border-destructive',
      'bg-sidebar',
      'text-sidebar-foreground',
      'bg-sidebar-accent',
      'ring-sidebar-ring',
      'border-sidebar-border',
      'text-default',
      'text-light',
      'text-lighter',
      // opacity modifiers on token colors
      'bg-surface-100/50',
      'bg-primary-bright/10',
      'bg-alternative/90',
      'text-sidebar-foreground/70',
      // custom utilities
      'bg',
      'text-code-inline',
      'focus-ring',
      'focus-inset',
      'control-surface-shadows',
      'raised-control-surface',
      'line-loading-bg',
      'line-loading-bg-light',
      'shimmer',
      'shimmer-once',
      'shimmer-duration-1500',
      'hit-area-1',
      'hit-area-6',
      'hit-area-x-2',
      'hit-area-[10px]',
      'hit-area-debug',
      'hit-area',
      // motion
      'animate-in',
      'animate-out',
      'fade-in-50',
      'fade-out-0',
      'zoom-in-95',
      'slide-in-from-top-1',
      'animate-overlay-show',
      'animate-overlay-hide',
      'animate-fade-in',
      'animate-accordion-down',
      'animate-collapsible-up',
      'animate-caret-blink',
      'animate-panel-slide-left-in',
      'ease-enter',
      'ease-move',
      'animate-line-loading-slower',
      // shape and variants
      'rounded-item',
      'rounded-panel',
      'p-card',
      'px-card',
      'xs:flex',
      'data-open:flex',
      'data-closed:animate-overlay-hide',
      'data-open-parent:flex',
      'data-closed-parent:flex',
      'aria-expanded:bg-muted',
      'not-disabled:hover:bg-accent',
    ]
    const compiler = await tokenCompiler()
    const css = compiler.build(candidates)
    const missing = candidates.filter((c) => !hasSelector(css, c))
    expect(missing).toEqual([])
    // Keeps the arbitrary-value reads of the primitives alive: --radius-md is emitted when read.
    const radius = (await tokenCompiler()).build(['rounded-[calc(var(--radius-md)*1.2)]'])
    expect(radius).toMatch(/--radius-md:\s*0\.375rem/)
  })

  it('applies the data-state variants to the Radix state attributes', async () => {
    const css = await compileTokens(['data-open:flex', 'data-closed:flex', 'data-open-parent:flex'])
    expect(css).toMatch(/\.data-open\\:flex\[data-state=['"]open['"]\]/)
    expect(css).toMatch(/\.data-closed\\:flex\[data-state=['"]closed['"]\]/)
    expect(css).toMatch(/\[data-state=['"]open['"]\] \.data-open-parent\\:flex/)
  })

  it('declares only .woff2 font faces, from the package files', async () => {
    const css = await compileTokens([])
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] as string)
    expect(faces).toHaveLength(10)
    for (const face of faces) {
      const urls = [...face.matchAll(/url\(([^)]*)\)/g)].map((m) =>
        (m[1] as string).replace(/['"]/g, ''),
      )
      expect(urls).toHaveLength(1)
      expect(urls[0]).toMatch(
        /node_modules\/@fontsource\/(inter|source-code-pro)\/files\/[a-z-]+-(400|500|600)-normal\.woff2$/,
      )
    }
    expect(css).not.toMatch(/\.woff(?!2)/)
  })

  it('resolves the tokens entry from the package export', async () => {
    const compiler = await tokenCompiler()
    expect(compiler.build(['bg-production'])).toContain('.bg-production')
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, string>
    }
    expect(manifest.exports['./tokens.css']).toBe('./src/tokens.css')
  })
})

/** The CSS class selector a Tailwind candidate generates, escaped like Tailwind escapes it. */
function selectorOf(candidate: string): string {
  return `.${candidate.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)}`
}

function hasSelector(css: string, candidate: string): boolean {
  const selector = selectorOf(candidate).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${selector}(?![A-Za-z0-9_\\\\-])`).test(css)
}

describe('a Vite build with @tailwindcss/vite', () => {
  it('bundles the .woff2 fonts from the package and nothing remote', async () => {
    const cache = join(packageRoot, 'node_modules', '.cache')
    mkdirSync(cache, { recursive: true })
    const dir = mkdtempSync(join(cache, 'vite-build-'))
    try {
      const entry = relative(dir, join(srcDir, 'tokens.css')).split('\\').join('/')
      writeFileSync(
        join(dir, 'index.html'),
        '<!doctype html><html data-theme="dark"><head><meta charset="utf-8">' +
          '<link rel="stylesheet" href="./main.css"></head>' +
          '<body class="bg-background font-sans text-foreground"><p class="font-mono">x</p></body></html>',
      )
      writeFileSync(
        join(dir, 'main.css'),
        `@import 'tailwindcss';\n@import '${entry}';\n@source './index.html';\n`,
      )
      await build({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        plugins: [tailwindcss()],
        build: { outDir: join(dir, 'dist'), emptyOutDir: true, sourcemap: false },
      })
      const assets = join(dir, 'dist', 'assets')
      const files = readdirSync(assets)
      const fonts = files.filter((f) => /\.(woff2?|ttf|otf|eot)$/.test(f))
      expect(fonts.filter((f) => !f.endsWith('.woff2'))).toEqual([])
      expect(fonts.map((f) => f.replace(/-[\w-]{8}\.woff2$/, '')).sort()).toEqual(
        [
          'inter-latin-400-normal',
          'inter-latin-500-normal',
          'inter-latin-600-normal',
          'inter-latin-ext-400-normal',
          'inter-latin-ext-500-normal',
          'inter-latin-ext-600-normal',
          'source-code-pro-latin-400-normal',
          'source-code-pro-latin-500-normal',
          'source-code-pro-latin-ext-400-normal',
          'source-code-pro-latin-ext-500-normal',
        ].sort(),
      )
      const cssFile = files.find((f) => f.endsWith('.css'))
      expect(cssFile).toBeDefined()
      const css = readFileSync(join(assets, cssFile as string), 'utf8')
      for (const font of fonts) {
        expect(css, font).toContain(font)
        expect(existsSync(join(assets, font))).toBe(true)
      }
      const code = stripComments(css)
      expect(code).not.toMatch(/https?:\/\//)
      expect(code).not.toMatch(/url\((['"]?)(https?:)?\/\//)
      expect(code).not.toMatch(/\.woff(?!2)/)
      expect(css).toMatch(/\.bg-background/)
      expect(css).toMatch(/--production:/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

/** The class names written as string literals in the TypeScript sources of a directory. */
function classCandidates(dir: string): Set<string> {
  const found = new Set<string>()
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules') continue
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(path)) {
        const text = readFileSync(path, 'utf8')
        for (const literal of text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*?)\1/gs)) {
          for (const token of (literal[2] as string).split(/\s+/)) {
            if (token !== '' && !token.includes('${')) found.add(token)
          }
        }
      }
    }
  }
  walk(dir)
  return found
}

/**
 * The utility part of a candidate (variants removed) names a token color, a custom utility or a
 * motion token. Built-in Tailwind utilities (text-sm, border-b) compile on their own and are not
 * what this test is about, but they are harmless in it.
 */
const tokenUtility =
  /^!?-?(?:(?:bg|text|border|border-[trblxy]|ring|ring-offset|fill|stroke|outline|divide|shadow|placeholder|from|to|via|decoration|caret|accent)-[a-z][a-z0-9-]*(?:\/\d+)?!?|bg|focus-ring|focus-inset|control-surface-shadows|raised-control-surface|line-loading-bg(?:-light)?|shimmer[a-z0-9-]*|hit-area[a-z0-9-]*|(?:animate|ease)-[a-z-]+|rounded-(?:item|panel)|[pm][xytrbl]?-card)$/

function utilityPart(candidate: string): string {
  let depth = 0
  let cut = 0
  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate.charAt(i)
    if (ch === '[' || ch === '(') depth += 1
    else if (ch === ']' || ch === ')') depth -= 1
    else if (ch === ':' && depth === 0) cut = i + 1
  }
  return candidate.slice(cut)
}

for (const pkg of ['ui', 'ui-patterns'] as const) {
  describe(`classes used by packages/${pkg}`, () => {
    const src = join(packageRoot, '..', pkg, 'src')

    // Plain classes a package defines in its own stylesheets are not token utilities.
    const ownClasses = new Set(
      (existsSync(src) ? walkCss(src) : []).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1] as string),
      ),
    )

    it('compile: every token color, custom utility and motion class resolves', async () => {
      const candidates = [...classCandidates(src)].filter(
        (c) => tokenUtility.test(utilityPart(c)) && !ownClasses.has(c),
      )
      expect(candidates.length).toBeGreaterThan(pkg === 'ui' ? 150 : 100)
      // The source palette's brand classes are not provided (ADR-0030, design-system.md section 2):
      // the components use primary-* classes instead.
      expect(candidates.filter((c) => /brand/.test(c))).toEqual([])
      const compiler = await tokenCompiler()
      const css = compiler.build(candidates)
      const missing = candidates.filter((c) => !hasSelector(css, c))
      expect(missing).toEqual([])
    })
  })
}

function walkCss(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walkCss(path)
    return entry.name.endsWith('.css') ? [path] : []
  })
}
