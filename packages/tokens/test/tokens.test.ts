import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageRoot, partNames, readPart, srcDir, stripComments } from './support/css.ts'
import {
  type Block,
  declaredProperties,
  parseBlocks,
  referencedVariables,
} from './support/css-parse.ts'
import { supportedRange } from './support/pairs.ts'

/** Biome formats CSS with double quotes; quote style carries no meaning, so tests read single. */
const single = (css: string): string => css.replace(/"/g, "'")

const parts = Object.fromEntries(partNames.map((name) => [name, single(readPart(name))])) as Record<
  (typeof partNames)[number],
  string
>
const entry = single(readPart('tokens'))
const everyFile = [
  ...partNames.map((name) => [name, parts[name]] as const),
  ['tokens', entry] as const,
]
const allText = everyFile.map(([, text]) => text).join('\n')
const allCode = stripComments(allText)

/** The inputs of design-system.md section 2. */
const inputs = [
  '--hue',
  '--surface-hue',
  '--chroma',
  '--surface',
  '--foreground-lightness',
  '--contrast',
  '--elevation-step',
] as const

const inputBlocks = parseBlocks(parts.inputs)
const rootBlock = block((b) => b.media === undefined && b.selector === ':root')
const lightBlock = block(
  (b) => b.media === undefined && b.selector === ":root, [data-theme='light']",
)
const darkBlock = block((b) => b.media === undefined && b.selector === "[data-theme='dark']")
const systemDarkBlock = block(
  (b) =>
    b.media === '@media (prefers-color-scheme: dark)' &&
    b.selector === ":root:not([data-theme='light']):not([data-theme='dark'])",
)

function block(match: (b: Block) => boolean): Block {
  const found = inputBlocks.filter(match)
  if (found.length !== 1) {
    throw new Error(`inputs.css: expected exactly one matching block, found ${found.length}`)
  }
  return found[0] as Block
}

describe('theme inputs', () => {
  it('declares every input of design-system.md section 2 for both themes', () => {
    for (const input of inputs) {
      const themed = input !== '--hue' && input !== '--surface-hue'
      if (themed) {
        expect(lightBlock.decls.has(input), `${input} in the light theme`).toBe(true)
        expect(darkBlock.decls.has(input), `${input} in the dark theme`).toBe(true)
        expect(systemDarkBlock.decls.has(input), `${input} in the system dark block`).toBe(true)
      } else {
        expect(rootBlock.decls.has(input), `${input} on :root`).toBe(true)
      }
    }
  })

  it('uses the turquoise accent hue 178 (owner decision S9)', () => {
    expect(rootBlock.decls.get('--hue')).toBe('178')
    expect(rootBlock.decls.get('--surface-hue')).toBe('var(--hue)')
  })

  it('gives every themed input a value in the light, dark and system-dark blocks', () => {
    const light = [...lightBlock.decls.keys()].sort()
    expect([...darkBlock.decls.keys()].sort()).toEqual(light)
    expect([...systemDarkBlock.decls.keys()].sort()).toEqual(light)
  })

  it('keeps theme-independent inputs out of the theme blocks', () => {
    for (const name of rootBlock.decls.keys()) {
      expect(lightBlock.decls.has(name), `${name} must not be set by a theme`).toBe(false)
      expect(darkBlock.decls.has(name), `${name} must not be set by a theme`).toBe(false)
    }
  })

  it('keeps the explicit dark block identical to the system-dark block', () => {
    expect(Object.fromEntries(systemDarkBlock.decls)).toEqual(Object.fromEntries(darkBlock.decls))
  })

  it('documents the supported ranges that the contrast sweep tests', () => {
    const doc = parts.inputs
    const range = (values: readonly string[]): string => `${values[0]} .. ${values[1]}`
    expect(doc).toContain(`supported range ${range(['0', '0.04'])}`)
    expect(doc).toContain(
      `dark ${range(supportedRange.surface.dark)}, light ${range(supportedRange.surface.light)}`,
    )
    expect(doc).toContain(
      `dark ${range(supportedRange.foregroundLightness.dark)}, light ${range(supportedRange.foregroundLightness.light)}`,
    )
    expect(supportedRange.chroma).toEqual(['0', '0.04'])
    expect(supportedRange.elevationStep).toEqual(['0', '0.04'])
    expect(supportedRange.contrast).toEqual(['0', '0.5', '1'])
  })

  it('declares a color scheme per theme', () => {
    expect(lightBlock.decls.get('color-scheme')).toBe('light')
    expect(darkBlock.decls.get('color-scheme')).toBe('dark')
    expect(systemDarkBlock.decls.get('color-scheme')).toBe('dark')
  })
})

describe('theme mechanism', () => {
  it('uses data-theme on html as the single mechanism, with no class selector', () => {
    expect(allCode).not.toMatch(/\.dark\b/)
    expect(allCode).not.toMatch(/\.light\b/)
    expect(allCode).not.toMatch(/next-themes/)
    for (const [name, text] of everyFile) {
      const selectors = parseBlocks(text).map((b) => b.selector)
      for (const selector of selectors) {
        expect(selector, `${name}.css: ${selector}`).not.toMatch(/(^|[\s,>+~(])\.(dark|light)\b/)
      }
    }
  })

  it('defines the dark variant over data-theme and nothing else', () => {
    const variant = "@custom-variant dark (&:where([data-theme*='dark'] *, [data-theme*='dark']));"
    expect(stripComments(parts.theme)).toContain(variant)
    expect(allCode.match(/@custom-variant dark\b/g)).toHaveLength(1)
  })

  it('applies the OS preference only while data-theme is absent or system', () => {
    expect(systemDarkBlock.selector).toBe(
      ":root:not([data-theme='light']):not([data-theme='dark'])",
    )
    expect(systemDarkBlock.media).toBe('@media (prefers-color-scheme: dark)')
  })

  it('derives the semantic layer on :root and on every theme scope', () => {
    const semantic = parseBlocks(parts.semantic)
    expect(semantic.some((b) => b.selector === ':root, [data-theme]')).toBe(true)
  })
})

describe('forbidden content', () => {
  it('has no trace of the source brand hue or its scale', () => {
    expect(allText).not.toContain('157.5')
    expect(allText).not.toMatch(/--[\w-]*brand/i)
    expect(allCode).not.toMatch(/brand/i)
  })

  it('has no Circular or custom font face', () => {
    expect(allText).not.toMatch(/Circular|custom-font|CustomFont/i)
  })

  it('names no remote URL and imports no url()', () => {
    expect(allText).not.toMatch(/https?:\/\//)
    expect(allText).not.toMatch(/@import\s+url\(/)
    expect(allText).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}\//i)
  })

  it('has no hard-coded hex color', () => {
    expect(allCode).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('has no literal rgb or rgba color in a token (the source palettes are gone)', () => {
    expect(allCode).not.toMatch(/\brgba?\(/)
  })
})

describe('provenance headers', () => {
  const derived: Readonly<Record<string, string>> = {
    inputs: 'packages/ui/build/css/themes/dark.css',
    semantic: 'packages/ui/build/css/source/semantic.css',
    theme: 'packages/config/css/theme.css',
    animations: 'packages/config/css/animations.css',
    utilities: 'packages/config/css/utilities.css',
    base: 'packages/config/css/base.css',
  }

  for (const [name, source] of Object.entries(derived)) {
    it(`${name}.css starts with the exact provenance header`, () => {
      const first = (parts[name as keyof typeof parts] ?? '').split('\n')[0]
      expect(first).toBe(
        `/* Derived from supabase/supabase ${source} @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB. */`,
      )
    })

    it(`${name}.css names its origin only in the header`, () => {
      const rest = (parts[name as keyof typeof parts] ?? '').split('\n').slice(1).join('\n')
      expect(rest).not.toMatch(/supabase/i)
    })
  }

  it('fonts.css and tokens.css are native files without a header', () => {
    expect(parts.fonts).not.toMatch(/Derived from/i)
    expect(entry).not.toMatch(/Derived from/i)
  })
})

describe('token coverage', () => {
  const semanticNames = declaredProperties(parts.semantic)
  const inputNames = declaredProperties(parts.inputs)
  const themeText = stripComments(parts.theme)

  it('defines every variable that theme.css reads', () => {
    // --radius-md is Tailwind's own default theme value, not a token of this package.
    const external = new Set(['--radius-md'])
    for (const name of referencedVariables(parts.theme)) {
      if (external.has(name)) continue
      expect(
        semanticNames.has(name) || inputNames.has(name),
        `${name} is read by theme.css but declared nowhere`,
      ).toBe(true)
    }
  })

  it('defines every variable that semantic.css reads', () => {
    for (const name of referencedVariables(parts.semantic)) {
      expect(
        semanticNames.has(name) || inputNames.has(name),
        `${name} is read by semantic.css but declared nowhere`,
      ).toBe(true)
    }
  })

  it('reads only inputs that exist in every theme', () => {
    const themed = new Set(lightBlock.decls.keys())
    const rootOnly = new Set(rootBlock.decls.keys())
    for (const name of referencedVariables(parts.semantic)) {
      if (semanticNames.has(name)) continue
      expect(themed.has(name) || rootOnly.has(name), `${name} is a theme input`).toBe(true)
    }
  })

  it('declares production, the five state tokens and chart-1 to chart-8', () => {
    const wanted = [
      '--production',
      '--production-foreground',
      '--production-muted',
      ...['healthy', 'degraded', 'unhealthy', 'unknown', 'stale'].flatMap((s) => [
        `--state-${s}`,
        `--state-${s}-foreground`,
      ]),
      ...Array.from({ length: 8 }, (_, i) => `--chart-${i + 1}`),
      '--success',
      '--success-foreground',
      '--warning',
      '--destructive',
      '--info',
      '--info-foreground',
    ]
    for (const name of wanted) {
      expect(semanticNames.has(name), `${name} in semantic.css`).toBe(true)
    }
  })

  it('maps production, the state tokens and the chart slots in @theme inline', () => {
    const wanted = [
      'production',
      'production-foreground',
      'production-muted',
      ...['healthy', 'degraded', 'unhealthy', 'unknown', 'stale'].flatMap((s) => [
        `state-${s}`,
        `state-${s}-foreground`,
      ]),
      ...Array.from({ length: 8 }, (_, i) => `chart-${i + 1}`),
      'success',
      'success-foreground',
      'info',
      'info-foreground',
    ]
    for (const name of wanted) {
      expect(themeText, `--color-${name}`).toMatch(
        new RegExp(`--color-${name}:\\s*var\\(--${name}\\);`),
      )
    }
  })

  it('keeps the stepped scales of primary, success, warning and destructive', () => {
    for (const scale of ['primary', 'success', 'warning', 'destructive']) {
      for (const step of [200, 300, 400, 500, 600]) {
        expect(semanticNames.has(`--${scale}-${step}`), `--${scale}-${step}`).toBe(true)
        expect(themeText).toContain(`--color-${scale}-${step}: var(--${scale}-${step});`)
      }
    }
  })

  it('keeps the reserved production color out of the destructive and warning hues', () => {
    const hue = (name: string): number => Number(rootBlock.decls.get(name))
    for (const other of ['--destructive-hue', '--warning-hue', '--hue']) {
      const d = Math.abs(hue('--production-hue') - hue(other)) % 360
      expect(Math.min(d, 360 - d), `production hue vs ${other}`).toBeGreaterThanOrEqual(45)
    }
  })
})

describe('fonts', () => {
  const fontCss = stripComments(parts.fonts)

  it('declares Inter 400, 500, 600 and Source Code Pro 400, 500 with font-display swap', () => {
    const faces = [...fontCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] as string)
    const seen = new Set<string>()
    for (const face of faces) {
      const family = /font-family:\s*'([^']+)'/.exec(face)?.[1]
      const weight = /font-weight:\s*(\d+)/.exec(face)?.[1]
      expect(face).toMatch(/font-display:\s*swap/)
      expect(face).toMatch(/font-style:\s*normal/)
      expect(face).toMatch(/unicode-range:\s*U\+/)
      seen.add(`${family} ${weight}`)
    }
    expect([...seen].sort()).toEqual(
      ['Inter 400', 'Inter 500', 'Inter 600', 'Source Code Pro 400', 'Source Code Pro 500'].sort(),
    )
    // Latin and Latin Extended per weight: 2 x 5.
    expect(faces).toHaveLength(10)
  })

  it('references only .woff2 files (the server delivers no other font format)', () => {
    expect(fontCss).not.toMatch(/\.woff(?!2)/)
    expect(fontCss).not.toMatch(/\.woff["')]/)
    expect(fontCss).not.toMatch(/\.(ttf|otf|eot)\b/)
    const urls = [...fontCss.matchAll(/url\(([^)]*)\)/g)].map((m) =>
      (m[1] as string).replace(/['"]/g, ''),
    )
    expect(urls).toHaveLength(10)
    for (const url of urls) {
      expect(url, url).toMatch(/\.woff2$/)
      expect(url, url).not.toMatch(/^[a-z]+:/i)
    }
  })

  it('points every url() at an installed font file of the pinned package', () => {
    for (const m of fontCss.matchAll(/url\('([^']+)'\)/g)) {
      const file = join(srcDir, m[1] as string)
      expect(existsSync(file), file).toBe(true)
      expect(file).toMatch(/node_modules\/@fontsource\/(inter|source-code-pro)\/files\//)
    }
  })

  it('does not use the package stylesheets that name .woff fallbacks', () => {
    expect(fontCss).not.toMatch(/@import/)
  })

  it('ships the OFL license text with each font package', () => {
    for (const pkg of ['inter', 'source-code-pro']) {
      const dir = join(packageRoot, 'node_modules', '@fontsource', pkg)
      expect(existsSync(join(dir, 'LICENSE')), `${pkg}/LICENSE`).toBe(true)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        license: string
      }
      expect(manifest.license).toBe('OFL-1.1')
    }
  })

  it('stacks name Inter and Source Code Pro first and never a removed face', () => {
    const theme = stripComments(parts.theme)
    expect(theme).toMatch(/--font-sans:\s*'Inter',/)
    expect(theme).toMatch(/--font-mono:\s*'Source Code Pro',/)
  })
})

describe('package manifest', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, string>
    sideEffects: string[]
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  it('exports the entry and every part, and each target exists', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual(
      ['tokens', ...partNames].map((n) => `./${n}.css`).sort(),
    )
    for (const [key, target] of Object.entries(manifest.exports)) {
      expect(key.endsWith('.css')).toBe(true)
      expect(existsSync(join(packageRoot, target)), target).toBe(true)
    }
  })

  it('marks CSS as side effects', () => {
    expect(manifest.sideEffects).toEqual(['**/*.css'])
  })

  it('imports every part from the entry, in order', () => {
    const imports = [...stripComments(entry).matchAll(/@import\s+'\.\/([a-z]+)\.css';/g)].map(
      (m) => m[1],
    )
    expect(imports).toEqual([...partNames])
  })

  it('pins the fonts and every dependency exactly', () => {
    expect(manifest.dependencies['@fontsource/inter']).toBe('5.3.0')
    expect(manifest.dependencies['@fontsource/source-code-pro']).toBe('5.3.0')
    for (const range of [
      ...Object.values(manifest.dependencies),
      ...Object.values(manifest.devDependencies),
    ]) {
      expect(range).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})

/** Files of a directory tree whose extension is one of `extensions`. */
function walk(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...walk(path, extensions))
    else if (extensions.some((e) => path.endsWith(e))) found.push(path)
  }
  return found
}

describe('primitives of packages/ui', () => {
  const uiSrc = join(packageRoot, '..', 'ui', 'src')
  // Custom properties that exist at run time: declared in a style rule or by a utility, not in
  // an @theme block (an `@theme inline` variable is inlined into utilities and never emitted).
  const declared = new Set([
    ...everyFile.flatMap(([, text]) =>
      parseBlocks(text).flatMap((b) => [...b.decls.keys()].filter((k) => k.startsWith('--'))),
    ),
    // --button-shadow-raised and the like: written by the control-surface-shadows utility on
    // the element that also reads them.
    ...declaredProperties(parts.utilities),
  ])

  /**
   * Variables a primitive sets itself (a `style` prop, a hook that writes a property) or that a
   * Radix primitive sets at run time. They are referenced but are not tokens, so the tokens
   * package does not declare them. Every entry says where it is set.
   */
  const setByComponent: Readonly<Record<string, string>> = {
    '--sidebar-width': 'style prop of the sidebar provider (sidebar.tsx)',
    '--sidebar-width-icon': 'style prop of the sidebar provider (sidebar.tsx)',
    '--skeleton-width': 'style prop of the sidebar menu skeleton (sidebar.tsx)',
    '--active-tab-left': 'written by the tab indicator hook (use-tab-indicator.ts)',
    '--active-tab-width': 'written by the tab indicator hook (use-tab-indicator.ts)',
    '--active-segment-left': 'written by the segmented indicator (toggle-group.tsx)',
    '--active-segment-width': 'written by the segmented indicator (toggle-group.tsx)',
    '--color-bg': 'style prop of the chart tooltip indicator (chart.tsx)',
    '--color-border': 'style prop of the chart tooltip indicator (chart.tsx)',
    '--radius-md':
      "Tailwind's default theme value, emitted when a candidate reads it (tailwind.test.ts)",
  }
  /** Optional per-instance overrides: every read carries a fallback, so no default is needed. */
  const optionalOverrides = new Set(['--tab-track', '--tab-track-inset'])

  const files = existsSync(uiSrc) ? walk(uiSrc, ['.ts', '.tsx', '.css']) : []
  const sources = files.map((file) => ({ file, text: readFileSync(file, 'utf8') }))

  function references(): Map<string, string[]> {
    const found = new Map<string, string[]>()
    const add = (name: string, file: string): void => {
      found.set(name, [...(found.get(name) ?? []), file])
    }
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)(\$\{)?/g)) {
        // `var(--chart-${slot})` is a template: only its prefix is known here.
        add(m[2] === undefined ? (m[1] as string) : `${m[1]}*`, file)
      }
      // Tailwind's shorthand for a variable: w-(--sidebar-width), px-(--card-padding-x).
      for (const m of text.matchAll(/\((--[A-Za-z0-9_-]+)\)/g)) add(m[1] as string, file)
    }
    return found
  }

  it('finds the primitives', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  it('declares every variable the primitives read (both themes, via the token files)', () => {
    const missing: string[] = []
    for (const [name, where] of references()) {
      if (name.endsWith('*')) {
        const prefix = name.slice(0, -1)
        expect(
          [...declared].some((d) => d.startsWith(prefix)),
          `${prefix}\${...} template`,
        ).toBe(true)
        continue
      }
      if (declared.has(name)) continue
      if (name.startsWith('--radix-')) continue
      if (name in setByComponent || optionalOverrides.has(name)) continue
      missing.push(
        `${name} (read in ${[...new Set(where)].map((f) => f.replace(uiSrc, 'ui/src')).join(', ')})`,
      )
    }
    expect(missing).toEqual([])
  })

  it('has no stale entry in the allowlist of component-set variables', () => {
    const everything = sources.map((s) => s.text).join('\n')
    for (const name of Object.keys(setByComponent)) {
      expect(everything, `${name} is no longer referenced`).toContain(name)
      expect(declared.has(name), `${name} is set by a component, not a token`).toBe(false)
    }
  })

  it('reads the optional overrides only with a fallback', () => {
    for (const { file, text } of sources) {
      for (const name of optionalOverrides) {
        for (const m of text.matchAll(new RegExp(`var\\(\\s*${name}([^A-Za-z0-9_-])`, 'g'))) {
          expect(m[1], `${file}: var(${name}) needs a fallback`).toBe(',')
        }
      }
    }
  })
})
