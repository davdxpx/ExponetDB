import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  analyze,
  blankComments,
  formatProblem,
  inScope,
  isAllowedUrl,
  isForbiddenImport,
  isTestFile,
  mayWriteStorage,
  RULES,
  scanSource,
  URL_ALLOWLIST,
} from '../checks/ui-safety.ts'

/**
 * The scanner must fail on planted problems and stay quiet on clean browser code. Every case
 * runs `scanSource` on an in-memory file; the check reads the repository only in `main`.
 */
const SRC = 'packages/ui/src/widget.tsx'

function rulesOf(text: string, path = SRC): string[] {
  return scanSource(path, text).map((p) => p.rule)
}

describe('markup sinks and dynamic code', () => {
  const planted: [string, string, string][] = [
    [
      'dangerous-html',
      'dangerouslySetInnerHTML',
      '<div dangerouslySetInnerHTML={{ __html: x }} />',
    ],
    ['dangerous-html', '.innerHTML =', 'el.innerHTML = value'],
    ['dangerous-html', '.innerHTML +=', 'el.innerHTML += value'],
    ['dangerous-html', '.innerHTML ||=', 'el.innerHTML ||= value'],
    ['dangerous-html', '.outerHTML =', 'el.outerHTML = value'],
    ['dangerous-html', "['innerHTML'] =", "el['innerHTML'] = value"],
    ['dangerous-html', 'insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', html)"],
    ['dangerous-html', 'document.write', 'document.write(html)'],
    ['dangerous-html', 'document.writeln', 'document.writeln(html)'],
    ['dynamic-code', 'eval(', 'const r = eval(code)'],
    ['dynamic-code', 'new Function(', "const f = new Function('a', 'return a')"],
    ['style-attribute', "setAttribute('style'", "el.setAttribute('style', css)"],
    ['style-attribute', 'setAttribute("style"', 'el.setAttribute("style", css)'],
    ['native-dialog', 'window.confirm(', "if (window.confirm('Sure?')) go()"],
    ['native-dialog', 'window.alert(', "window.alert('Done')"],
    ['native-dialog', 'window.prompt(', "const name = window.prompt('Name')"],
    ['native-dialog', 'bare confirm(', "if (confirm('Sure?')) go()"],
    ['native-dialog', 'bare alert(', "alert('Done')"],
    ['native-dialog', 'bare prompt(', "const name = await prompt('Name')"],
  ]

  it.each(planted)('reports %s: %s', (rule, _name, code) => {
    const problems = scanSource(SRC, `export function f() {\n  ${code}\n}\n`)
    expect(problems.map((p) => p.rule)).toEqual([rule])
    expect(problems[0]?.line).toBe(2)
    expect(problems[0]?.path).toBe(SRC)
  })

  it('does not flag reads, comparisons and look-alikes', () => {
    const clean = [
      'const html = el.innerHTML',
      'if (el.innerHTML === "") return',
      'if (el.innerHTML == null) return',
      'el.textContent = value',
      'const e = el.evaluate(query)',
      'const p = pretrain(x)',
      'const ok = await dialogs.confirm(options)',
      'const ok = await this.confirm(options)',
      'const ok = await useConfirm()',
      'const a = reportAlert(x)',
      'element.setAttribute("class", name)',
      "element.setAttribute('data-style', name)",
      'function confirm(question: string): boolean { return question.length > 0 }',
      'new FunctionComponent()',
    ]
    for (const code of clean) {
      expect(scanSource(SRC, `${code}\n`), code).toEqual([])
    }
  })

  it('does not take a member declaration for a call', () => {
    const declarations = [
      '  alert(error: unknown): void',
      '  readonly confirm?: () => void',
      '  confirm(question?: string): Promise<boolean>',
      '  async prompt(message: string): Promise<string> {',
      '  alert(error) {',
      '  confirm(): boolean',
    ]
    for (const code of declarations) {
      expect(scanSource(SRC, `${code}\n`), code).toEqual([])
    }
    // The same names called in a statement are still reported.
    for (const code of [
      '  alert(error)',
      '  confirm()',
      '  x = prompt(message)',
      'cond && alert(e)',
    ]) {
      expect(rulesOf(`${code}\n`), code).toEqual(['native-dialog'])
    }
  })

  it('applies to tsx, ts and tests are exempt from these (src) rules', () => {
    const code =
      "el.innerHTML = x\nalert('x')\nlocalStorage.setItem('a', 'b')\nfetch('https://x.example')\n"
    expect(rulesOf(code, 'apps/web/src/a.ts')).toEqual([
      'dangerous-html',
      'native-dialog',
      'web-storage',
      'external-url',
    ])
    expect(scanSource('packages/ui/test/widget.test.tsx', code)).toEqual([])
    expect(scanSource('packages/ui/src/widget.test.ts', code)).toEqual([])
    expect(scanSource('packages/ui/src/__tests__/widget.ts', code)).toEqual([])
    expect(isTestFile('packages/ui/test/widget.test.tsx')).toBe(true)
    expect(isTestFile('packages/ui/src/widget.tsx')).toBe(false)
  })
})

describe('comments and strings', () => {
  it('ignores rules mentioned in comments', () => {
    const text = [
      '// never use dangerouslySetInnerHTML or eval( or alert(',
      '/* el.innerHTML = x; see https://example.com */',
      '/**',
      ' * confirm() is native; localStorage.setItem is not allowed here',
      ' * @see https://example.com/docs',
      ' */',
      '{/* window.confirm("x") */}',
      'export const ok = 1 // eval(x) and https://example.com',
    ].join('\n')
    expect(scanSource(SRC, `${text}\n`)).toEqual([])
  })

  it('keeps strings visible: a URL or sink inside a string is still a hit', () => {
    expect(rulesOf("const u = 'https://example.com/a'\n")).toEqual(['external-url'])
    const placeholder = '$' + '{host}'
    expect(rulesOf(`const t = \`https://${placeholder}/a\`\n`)).toEqual(['external-url'])
    expect(rulesOf('const s = "el.innerHTML = x"\n')).toEqual(['dangerous-html'])
  })

  it('does not take // inside a string or regular expression for a comment', () => {
    expect(rulesOf("const u = 'http://example.com' // fine\n")).toEqual(['external-url'])
    // The `//` inside the regular expression must not hide the call after it.
    expect(rulesOf('const m = /https?:\\/\\//.test(value) && eval(value)\n')).toEqual([
      'dynamic-code',
    ])
    expect(rulesOf('const a = b / c; eval(d) // c\n')).toEqual(['dynamic-code'])
    expect(rulesOf('const re = /[/]/; eval(d)\n')).toEqual(['dynamic-code'])
  })

  it('blanks comments in place and keeps lines and columns', () => {
    const text = "a // x\n/* b\nc */ d 'e // f'\n"
    const blank = blankComments(text)
    expect(blank).toBe("a     \n    \n     d 'e // f'\n")
    expect(blank.split('\n')).toHaveLength(text.split('\n').length)
    expect(blankComments('a { b: url("x/*y*/") } /* c */', true)).toBe(
      `a { b: url("x/*y*/") }${' '.repeat(8)}`,
    )
    // `//` is not a comment in CSS.
    expect(blankComments('a { background: url(//cdn.example.com/a.png) }\n', true)).toContain(
      '//cdn',
    )
  })
})

describe('web storage', () => {
  const writes = [
    "localStorage.setItem('k', v)",
    "sessionStorage.removeItem('k')",
    'window.localStorage.clear()',
    "localStorage['k'] = v",
    'localStorage.theme = v',
    'const s = localStorage',
    'const s = window.sessionStorage',
    'save(localStorage)',
  ]

  it.each(writes)('reports %s outside a preferences or storage module', (code) => {
    expect(rulesOf(`${code}\n`, 'apps/web/src/features/enrollment/enrollment-page.tsx')).toEqual([
      'web-storage',
    ])
  })

  it('allows the write in a path that contains preferences or storage', () => {
    for (const path of [
      'apps/web/src/preferences.ts',
      'packages/ui/src/theme/theme-preferences.ts',
      'apps/web/src/storage.ts',
      'packages/ui/src/lib/Storage/local.ts',
    ]) {
      expect(mayWriteStorage(path), path).toBe(true)
      for (const code of writes) {
        expect(scanSource(path, `${code}\n`), `${path}: ${code}`).toEqual([])
      }
    }
    expect(mayWriteStorage('apps/web/src/features/enrollment/enrollment-page.tsx')).toBe(false)
  })

  it('allows reads and guards anywhere', () => {
    const reads = [
      "const v = localStorage.getItem('k')",
      "const v = window.sessionStorage.getItem('k')",
      "if (typeof localStorage === 'undefined') return",
      "const has = 'localStorage' in window",
      'const n = localStorage.length',
    ]
    for (const code of reads) {
      expect(scanSource('apps/web/src/theme.ts', `${code}\n`), code).toEqual([])
    }
  })
})

describe('external URLs', () => {
  it('reports http and https literals, also with a template or a port', () => {
    for (const code of [
      "fetch('https://api.example.com/v1')",
      'fetch("http://example.com")',
      `const u = \`https://${'$'}{host}/path\``,
      "const u = 'http://localhost:8080/x'",
      'const img = \'<img src="https://cdn.example.com/a.png">\'',
    ]) {
      expect(rulesOf(`${code}\n`), code).toEqual(['external-url'])
    }
  })

  it('allows the namespace identifiers and the product origin only', () => {
    expect(URL_ALLOWLIST).toEqual([
      'http://www.w3.org/2000/svg',
      'http://www.w3.org/1999/xlink',
      'https://db.exponet.cloud',
    ])
    const clean = [
      "const ns = 'http://www.w3.org/2000/svg'",
      'const xl = "http://www.w3.org/1999/xlink"',
      "const origin = 'https://db.exponet.cloud'",
      "const mcp = 'https://db.exponet.cloud/mcp'",
      "const t = value.startsWith('https://')",
      'const re = /^https?:\\/\\//',
    ]
    for (const code of clean) {
      expect(scanSource(SRC, `${code}\n`), code).toEqual([])
    }
    expect(isAllowedUrl('https://db.exponet.cloud.evil.example')).toBe(false)
    expect(isAllowedUrl('https://db.exponet.cloud@evil.example')).toBe(false)
    expect(isAllowedUrl('http://www.w3.org/2000/svgx')).toBe(false)
    expect(isAllowedUrl('http://www.w3.org/1999/xhtml')).toBe(false)
  })

  it('reports each URL once per line even when several appear', () => {
    const problems = scanSource(SRC, "const a = ['https://a.example', 'https://b.example']\n")
    expect(problems).toHaveLength(1)
  })
})

describe('imports', () => {
  const forbidden = [
    "import Image from 'next/image'",
    "import next from 'next'",
    "import type { NextConfig } from 'next'",
    "import { ThemeProvider } from 'next-themes'",
    "import { createClient } from '@supabase/supabase-js'",
    "import { x } from '@supabase/auth-helpers-react'",
    "import DataGrid from 'react-data-grid'",
    "import 'react-data-grid/lib/styles.css'",
    "import loader from '@monaco-editor/loader'",
    "export * from 'next/link'",
    "const m = await import('next/dynamic')",
    "const m = require('@supabase/ssr')",
    "import 'next-themes'",
  ]

  it.each(forbidden)('reports %s', (code) => {
    expect(rulesOf(`${code}\n`)).toEqual(['forbidden-import'])
  })

  it('applies to tests and CSS too, and accepts look-alikes', () => {
    expect(rulesOf("import Image from 'next/image'\n", 'packages/ui/test/a.test.tsx')).toEqual([
      'forbidden-import',
    ])
    expect(rulesOf('@import "@supabase/ui/styles.css";\n', 'packages/tokens/src/a.css')).toEqual([
      'forbidden-import',
    ])
    for (const code of [
      "import { next } from './next'",
      "import { x } from 'nextra'",
      "import { y } from 'next-tick'",
      "import { z } from '@exponetdb/ui'",
      "import { c } from 'react'",
      "import { cn } from '../lib/supabase-like'",
    ]) {
      expect(scanSource(SRC, `${code}\n`), code).toEqual([])
    }
    expect(isForbiddenImport('next')).toBe(true)
    expect(isForbiddenImport('next/head')).toBe(true)
    expect(isForbiddenImport('nextjs')).toBe(false)
  })
})

describe('CSS', () => {
  const CSS = 'packages/tokens/src/tokens.css'

  it('reports remote imports and remote url() values', () => {
    const planted: [string, string][] = [
      ['@import url(https://fonts.example/css?family=Inter);', 'css-import'],
      ["@import url('./local.css');", 'css-import'],
      ['@import "https://fonts.example/inter.css";', 'css-import'],
      ['a { background: url(https://cdn.example/a.png) }', 'css-remote-url'],
      ["a { background: url('http://cdn.example/a.png') }", 'css-remote-url'],
      ['a { background: url("//cdn.example/a.png") }', 'css-remote-url'],
      ['a { background: url(//cdn.example/a.png) }', 'css-remote-url'],
    ]
    for (const [code, rule] of planted) {
      expect(rulesOf(`${code}\n`, CSS), code).toEqual([rule])
    }
  })

  it('accepts local assets, data URIs, namespaces and comments', () => {
    const clean = [
      '@import "tailwindcss";',
      "@import './base.css';",
      'a { background: url(./a.png) }',
      'a { background: url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'/>") }',
      '/* @import url(https://fonts.example/css); */',
      ':root { --hue: 250; }',
    ]
    for (const code of clean) {
      expect(scanSource(CSS, `${code}\n`), code).toEqual([])
    }
  })

  it('does not apply the TypeScript rules to CSS', () => {
    expect(scanSource(CSS, '.a { content: "alert(1) eval(x) https://example.com" }\n')).toEqual([])
  })
})

describe('documented exceptions', () => {
  it('excuses a hit with a trailing comment that names the rule and a reason', () => {
    const text =
      "const u = 'https://example.com' // ui-safety: allow external-url — link text for the docs page\n"
    const analysis = analyze(SRC, text)
    expect(analysis.problems).toEqual([])
    expect(analysis.exceptions).toEqual([
      { path: SRC, line: 1, rule: 'external-url', reason: 'link text for the docs page' },
    ])
  })

  it('reads the comment in block, JSX and CSS form', () => {
    const jsx =
      '<a href="https://example.com">x</a> {/* ui-safety: allow external-url — documented link */}\n'
    expect(analyze(SRC, jsx).exceptions).toHaveLength(1)
    expect(analyze(SRC, jsx).problems).toEqual([])
    const block = "alert('x') /* ui-safety: allow native-dialog - legacy shim */\n"
    expect(analyze(SRC, block).exceptions[0]?.reason).toBe('legacy shim')
    const css =
      'a { background: url(https://x.example/a.png) } /* ui-safety: allow css-remote-url — mock */\n'
    expect(analyze('packages/ui/src/a.css', css)).toMatchObject({ problems: [] })
  })

  it('requires a reason', () => {
    for (const comment of [
      '// ui-safety: allow external-url',
      '// ui-safety: allow external-url —',
      '// ui-safety: allow external-url — ',
      '// ui-safety: allow external-url because it is fine',
      '/* ui-safety: allow external-url — */',
      '{/* ui-safety: allow external-url — */}',
      '// ui-safety: external-url — reason',
      '// ui-safety:',
    ]) {
      const analysis = analyze(SRC, `fetch('https://example.com') ${comment}\n`)
      expect(analysis.exceptions, comment).toEqual([])
      expect(analysis.problems.map((p) => p.rule).sort(), comment).toEqual([
        'escape',
        'external-url',
      ])
    }
  })

  it('excuses only the named rule on that line only', () => {
    const wrongRule = "alert('https://x.example') // ui-safety: allow external-url — reason\n"
    expect(analyze(SRC, wrongRule).problems.map((p) => p.rule)).toEqual(['native-dialog'])
    const nextLine = "// ui-safety: allow external-url — reason\nfetch('https://x.example')\n"
    expect(analyze(SRC, nextLine).problems.map((p) => p.rule)).toEqual(['external-url'])
    const both =
      "alert('https://x.example') // ui-safety: allow external-url — a // ui-safety: allow native-dialog — b\n"
    const analysis = analyze(SRC, both)
    expect(analysis.problems).toEqual([])
    expect(analysis.exceptions.map((e) => e.rule).sort()).toEqual(['external-url', 'native-dialog'])
  })

  it('rejects an unknown rule and ignores the marker inside a string', () => {
    const unknown = 'x() // ui-safety: allow no-such-rule — reason\n'
    expect(analyze(SRC, unknown).problems.map((p) => p.rule)).toEqual(['escape'])
    const quoted = "const u = 'https://x.example ui-safety: allow external-url — reason'\n"
    expect(analyze(SRC, quoted).problems.map((p) => p.rule)).toEqual(['external-url'])
    expect(RULES).toContain('external-url')
  })
})

describe('reporting and scope', () => {
  it('formats problems as file:line with the rule', () => {
    const [problem] = scanSource('apps/web/src/a.ts', 'const a = 1\neval(x)\n')
    expect(problem).toBeDefined()
    expect(formatProblem(problem as NonNullable<typeof problem>)).toBe(
      'apps/web/src/a.ts:2: [dynamic-code] eval runs text as code (CSP forbids it)',
    )
  })

  it('scans the browser packages and skips generated and installed files', () => {
    for (const path of [
      'packages/tokens/src/tokens.css',
      'packages/ui/src/a.tsx',
      'packages/ui-patterns/src/a.ts',
      'packages/ui-data/test/a.test.ts',
      'packages/icons/src/index.ts',
      'apps/web/src/main.tsx',
      'apps/web/src/styles/app.css',
      'apps/design-system/src/app.tsx',
    ]) {
      expect(inScope(path), path).toBe(true)
    }
    for (const path of [
      'apps/web/scripts/postbuild.ts',
      'apps/design-system/vite.config.ts',
      'apps/server/src/a.ts',
      'packages/uix/src/a.ts',
      'packages/ui/node_modules/x/a.ts',
      'packages/ui/dist/a.ts',
      'packages/ui/src/routeTree.gen.ts',
      'packages/ui/package.json',
      'apps/web/src/index.html',
    ]) {
      expect(inScope(path), path).toBe(false)
    }
  })

  it('accepts a clean component', () => {
    const clean = [
      "import { cn } from '../lib/utils'",
      '',
      'export function Badge({ text }: { text: string }) {',
      "  return <span className={cn('badge')}>{text}</span>",
      '}',
      '',
    ].join('\n')
    expect(analyze(SRC, clean)).toEqual({ problems: [], exceptions: [] })
  })
})

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('the framework-free Web App of Waves 3A to 7', () => {
  it('is gone since the switch to the rebuilt app (Wave 8 Phase 8, order D6): every file is scanned', () => {
    for (const file of [
      'apps/web/src/api.ts',
      'apps/web/src/dom.ts',
      'apps/web/src/main.ts',
      'apps/web/src/reauth.ts',
      'apps/web/src/review.ts',
      'apps/web/src/safe.ts',
      'apps/web/src/shell.ts',
      'apps/web/src/webauthn.ts',
      'apps/web/src/pages',
      'apps/web/src/app.css',
      'apps/web/src/index.html',
      'apps/web/scripts/build.ts',
    ]) {
      expect(existsSync(join(repoRoot, file)), file).toBe(false)
    }
  })
})
