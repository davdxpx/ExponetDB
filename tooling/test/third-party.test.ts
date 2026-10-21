import { describe, expect, it } from 'vitest'
import {
  BRAND_PATTERNS,
  checkOtherSources,
  checkRegister,
  findMalformedHeader,
  findMalformedOtherHeader,
  isExempt,
  OTHER_COLUMNS,
  OTHER_SECTION,
  OTHER_SOURCES,
  type OtherRow,
  PINNED_SOURCE_COMMIT,
  parseHeader,
  parseOtherHeader,
  parseOtherRegister,
  parseRegister,
  REGISTER_PATH,
  type RegisterRow,
  type SourceFile,
  scopeProblems,
} from '../checks/third-party.ts'

/**
 * The register check must fail on real problems, not only pass on a clean tree. Every case
 * builds in-memory files and register rows (the check reads the repository only in `main`).
 */
const SOURCE = 'packages/ui/src/components/Button/Button.tsx'
const MIT_NOTICE = '; package declared MIT'

function headerLine(sourcePath = SOURCE, commit = PINNED_SOURCE_COMMIT, mit = true): string {
  const declared = mit ? MIT_NOTICE : ''
  return `Derived from supabase/supabase ${sourcePath} @ ${commit}. Apache-2.0 (Copyright 2024 Supabase)${declared}. Modified for ExponetDB.`
}

function file(path: string, header: string, body = 'export const x = 1\n'): SourceFile {
  return { path, text: `${header}\n${body}` }
}

function row(path: string, overrides: Partial<RegisterRow> = {}): RegisterRow {
  return {
    line: 50,
    path,
    sourcePath: SOURCE,
    commit: PINNED_SOURCE_COMMIT,
    licenseBasis: 'Apache-2.0 / MIT (declared)',
    notices: 'header, LICENSES/Apache-2.0.txt',
    changes: 'Removed the telemetry hook; ExponetDB tokens',
    review: 'reviewed 2026-10-13',
    ...overrides,
  }
}

const COPY = 'packages/ui/src/button.tsx'
const clean = (): SourceFile => file(COPY, `// ${headerLine()}`)

describe('parseHeader', () => {
  it('reads the three comment forms and both notice forms', () => {
    const ts = parseHeader(`// ${headerLine()}\nexport {}\n`)
    expect(ts).toEqual({ sourcePath: SOURCE, commit: '8b9af568', declaredMit: true, line: 1 })
    expect(parseHeader(`/* ${headerLine()} */\n:root {}\n`)?.sourcePath).toBe(SOURCE)
    expect(parseHeader(`{/* ${headerLine()} */}\n# Title\n`)?.commit).toBe('8b9af568')
    expect(parseHeader(`/**\n * ${headerLine()}\n */\n`)?.line).toBe(2)
    const studio = parseHeader(
      `// ${headerLine('apps/studio/components/A.tsx', '8b9af568', false)}\n`,
    )
    expect(studio).toEqual({
      sourcePath: 'apps/studio/components/A.tsx',
      commit: '8b9af568',
      declaredMit: false,
      line: 1,
    })
  })

  it('finds the header within the first five lines only', () => {
    const near = `'use client'\n\n\n\n// ${headerLine()}\n`
    expect(parseHeader(near)?.line).toBe(5)
    const far = `'use client'\n\n\n\n\n// ${headerLine()}\n`
    expect(parseHeader(far)).toBeUndefined()
  })

  it('does not read a header out of prose or a string', () => {
    expect(parseHeader(`const s = "${headerLine()}"\n`)).toBeUndefined()
    expect(parseHeader('export const x = 1\n')).toBeUndefined()
  })

  it('flags a header that claims Supabase but does not match the exact form', () => {
    expect(findMalformedHeader('// Derived from supabase/supabase x.ts @ main.\n')).toBe(1)
    expect(findMalformedHeader('\n// derived from Supabase Studio, modified\n')).toBe(2)
    expect(findMalformedHeader(`// ${headerLine()}\n`)).toBeUndefined()
    expect(findMalformedHeader('export const x = 1\n')).toBeUndefined()
  })
})

describe('parseRegister', () => {
  const table = [
    '| ExponetDB path | Source path | Commit | License basis | Notices applied | Changes | Review |',
    '|---|---|---|---|---|---|---|',
  ]

  it('reads rows, strips code spans and unescapes pipes', () => {
    const md = [
      '# Third-party register',
      '',
      '## Rules',
      '| not | the | register |',
      '',
      '## Register',
      '',
      ...table,
      `| \`${COPY}\` | \`${SOURCE}\` | \`8b9af568\` | Apache-2.0 / MIT (declared) | header | a \\| b | reviewed |`,
      '',
      '## Later',
      '| ignored | row |',
    ].join('\n')
    const parsed = parseRegister(md)
    expect(parsed.problems).toEqual([])
    expect(parsed.rows).toEqual([
      {
        line: 10,
        path: COPY,
        sourcePath: SOURCE,
        commit: '8b9af568',
        licenseBasis: 'Apache-2.0 / MIT (declared)',
        notices: 'header',
        changes: 'a | b',
        review: 'reviewed',
      },
    ])
  })

  it('accepts an empty register', () => {
    expect(parseRegister(['## Register', '', ...table].join('\n'))).toEqual({
      rows: [],
      problems: [],
    })
  })

  it('reports a missing section, a wrong header and a ragged row', () => {
    expect(parseRegister('# nothing here\n').problems).toHaveLength(1)
    const wrong = ['## Register', '| Path | Source |', '|---|---|'].join('\n')
    expect(parseRegister(wrong).problems.join('\n')).toContain('the table header must be')
    const ragged = ['## Register', ...table, '| a | b | c |'].join('\n')
    const parsed = parseRegister(ragged)
    expect(parsed.rows).toEqual([])
    expect(parsed.problems.join('\n')).toContain('a row has 3 cells, expected 7')
  })
})

describe('checkRegister', () => {
  it('accepts a registered, reviewed copy and a register naming an open decision', () => {
    expect(checkRegister([clean()], [row(COPY)])).toEqual([])
    expect(
      checkRegister([clean()], [row(COPY, { review: 'OD-38 (license basis) is open' })]),
    ).toEqual([])
    expect(checkRegister([], [])).toEqual([])
  })

  it('reports a file with a header and no row', () => {
    const problems = checkRegister([clean()], [])
    expect(problems).toEqual([
      `${COPY}:1: has a provenance header but no row in exponetdb-docs/11-ui/third-party-register.md`,
    ])
  })

  it('reports a row whose file does not exist', () => {
    const problems = checkRegister([], [row('packages/ui/src/gone.tsx')])
    expect(problems.join('\n')).toContain(
      'packages/ui/src/gone.tsx is registered but does not exist',
    )
  })

  it('reports a row whose file lacks the header', () => {
    const bare: SourceFile = { path: COPY, text: 'export const x = 1\n' }
    expect(checkRegister([bare], [row(COPY)]).join('\n')).toContain(
      'registered (register line 50) but lacks the provenance header',
    )
  })

  it('reports a header that differs from its row', () => {
    const other = file(COPY, `// ${headerLine('packages/ui/src/components/Other/Other.tsx')}`)
    expect(checkRegister([other], [row(COPY)]).join('\n')).toContain(
      'header names source packages/ui/src/components/Other/Other.tsx, the register row (line 50) names',
    )
    const commit = file(COPY, `// ${headerLine(SOURCE, '1234567')}`)
    const problems = checkRegister([commit], [row(COPY)]).join('\n')
    expect(problems).toContain(
      'header names commit 1234567, the register row (line 50) names 8b9af568',
    )
    expect(problems).toContain('only the pinned 8b9af568 may be copied')
  })

  it('reports a commit other than the pinned one in a row', () => {
    const problems = checkRegister([clean()], [row(COPY, { commit: 'deadbeef' })]).join('\n')
    expect(problems).toContain('names commit deadbeef, only the pinned 8b9af568 may be copied')
    expect(problems).toContain(
      'header names commit 8b9af568, the register row (line 50) names deadbeef',
    )
  })

  it('reports duplicate rows', () => {
    const problems = checkRegister([clean()], [row(COPY, { line: 50 }), row(COPY, { line: 51 })])
    expect(problems).toEqual([
      `exponetdb-docs/11-ui/third-party-register.md:51: ${COPY} is registered twice (first at line 50)`,
    ])
  })

  it('reports an empty cell in every column and treats placeholders as empty', () => {
    const empty = row(COPY, {
      sourcePath: '',
      licenseBasis: '',
      notices: '—',
      changes: 'n/a',
      review: '',
    })
    const text = checkRegister([clean()], [empty]).join('\n')
    for (const column of ['Source path', 'License basis', 'Notices applied', 'Changes', 'Review']) {
      expect(text, column).toContain(`the "${column}" cell`)
    }
    expect(checkRegister([clean()], [row(COPY, { path: '' })]).join('\n')).toContain(
      'the "ExponetDB path" cell',
    )
    expect(checkRegister([clean()], [row(COPY, { commit: '' })]).join('\n')).toContain(
      'the "Commit" cell',
    )
  })

  it('requires a recorded review', () => {
    for (const review of ['pending', 'open', 'Pending review', 'to do']) {
      const text = checkRegister([clean()], [row(COPY, { review })]).join('\n')
      expect(text, review).toContain('has no recorded review')
    }
    for (const review of ['reviewed', 'Reviewed: no notices inside', 'see OD-38']) {
      expect(checkRegister([clean()], [row(COPY, { review })]), review).toEqual([])
    }
  })

  it('requires the header among the notices', () => {
    const text = checkRegister([clean()], [row(COPY, { notices: 'LICENSES/Apache-2.0.txt' })])
    expect(text.join('\n')).toContain('must list the provenance "header" among its notices')
  })

  it('refuses a path that leaves the repository', () => {
    const problems = checkRegister([], [row('../outside/a.ts'), row('/etc/passwd', { line: 51 })])
    expect(problems.join('\n')).toContain('must be a repository-relative path')
  })

  it('reports a malformed header instead of letting the file escape the register', () => {
    const typo = file(COPY, '// Derived from supabase/supabase button.tsx @ main. MIT.')
    const problems = checkRegister([typo], [])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(`${COPY}:1: malformed provenance header`)
  })

  it('ignores documentation, tooling, license texts and node_modules', () => {
    const header = `// ${headerLine()}`
    const ignored = [
      'exponetdb-docs/11-ui/design-system.md',
      'tooling/test/third-party.test.ts',
      'LICENSES/Apache-2.0.txt',
      'THIRD_PARTY_NOTICES.md',
      'packages/ui/README.md',
      'packages/ui/node_modules/x/index.ts',
      'packages/ui/dist/index.js',
    ]
    for (const path of ignored) {
      expect(isExempt(path), path).toBe(true)
      expect(checkRegister([file(path, header)], []), path).toEqual([])
    }
    expect(isExempt('packages/ui/src/button.mdx')).toBe(false)
    expect(isExempt(COPY)).toBe(false)
  })

  it('finds leftovers of the origin outside the header line', () => {
    const planted: [string, string][] = [
      ['supabase', "import { x } from '@supabase/auth-js'"],
      ['supabase', 'const link = <a href="https://supabase.com/docs">docs</a>'],
      ['supabase', 'export const label = "Supabase"'],
      ['next/', "import Image from 'next/image'"],
      ['next-themes', "import { useTheme } from 'next-themes'"],
      ["from 'common'", "import { useFlag } from 'common'"],
      ['posthog', 'posthog.capture("clicked")'],
      ['configcat', 'const flag = ConfigCat.get()'],
      ['sentry', 'Sentry.captureException(e)'],
      ['IS_PLATFORM', 'if (IS_PLATFORM) run()'],
      ['--brand-', '.a { color: var(--brand-600); }'],
      ['CustomFont', "font-family: 'CustomFont-Book'"],
      ['Circular', "font-family: 'Circular', sans-serif"],
    ]
    for (const [name, line] of planted) {
      const copied = file(COPY, `// ${headerLine()}`, `${line}\n`)
      const problems = checkRegister([copied], [row(COPY)])
      expect(problems, line).toHaveLength(1)
      expect(problems.join('\n'), line).toContain(
        `${COPY}:2: leftover of the origin in a copied file (${name})`,
      )
    }
    expect(BRAND_PATTERNS.map(([name]) => name)).toEqual([
      'supabase',
      'next/',
      'next-themes',
      "from 'common'",
      'posthog',
      'configcat',
      'sentry',
      'IS_PLATFORM',
      '--brand-',
      'CustomFont',
      'Circular',
    ])
  })

  it('does not count the header line and accepts a clean file', () => {
    const body =
      "import { cn } from '../lib/utils'\nexport const Button = () => <button className={cn('a')} />\n"
    const copied = file(COPY, `// ${headerLine()}`, body)
    expect(checkRegister([copied], [row(COPY)])).toEqual([])
    // The same header further down a block comment is still exempt as the header line.
    const block: SourceFile = {
      path: 'packages/ui/src/a.css',
      text: `/* ${headerLine()} */\n:root { --x: 1 }\n`,
    }
    expect(checkRegister([block], [row('packages/ui/src/a.css')])).toEqual([])
  })

  it('counts a copy outside the register as unregistered even when other rows exist', () => {
    const second = file('packages/ui/src/second.tsx', `// ${headerLine()}`)
    const problems = checkRegister([clean(), second], [row(COPY)])
    expect(problems).toEqual([
      'packages/ui/src/second.tsx:1: has a provenance header but no row in exponetdb-docs/11-ui/third-party-register.md',
    ])
  })
})

describe('ADR-0030 scope of copied files', () => {
  it('accepts the UI packages and the two browser apps as destinations', () => {
    expect(scopeProblems('packages/ui/src/button.tsx', 'packages/ui/src/x.tsx', 1)).toEqual([])
    expect(scopeProblems('apps/web/src/a.tsx', 'apps/studio/components/x.tsx', 1)).toEqual([])
  })

  it('refuses another destination and the never-copied sources', () => {
    expect(scopeProblems('packages/kernel/src/x.ts', 'packages/ui/src/x.tsx', 1)).toHaveLength(1)
    expect(scopeProblems('packages/icons/src/x.tsx', 'packages/ui/src/x.tsx', 1)).toHaveLength(1)
    for (const source of [
      'packages/icons/src/index.ts',
      'packages/common/hooks.ts',
      'apps/studio/data/projects/x.ts',
      'packages/common/assets/fonts/CustomFont-Book.woff2',
      'packages/ui/src/components/LogoLoader/LogoLoader.tsx',
      'packages/ui-patterns/src/McpUrlBuilder/index.tsx',
      'packages/ui-patterns/src/Markdown/index.tsx',
    ]) {
      expect(scopeProblems('packages/ui/src/x.tsx', source, 1), source).toHaveLength(1)
    }
  })
})

describe('other sources (ADR-0033)', () => {
  const GLYPHS = 'packages/icons/src/provider-glyphs.ts'
  const otherHeader = (pkg = 'simple-icons', version = '16.35.0', license = 'CC0-1.0') =>
    `// Copied from ${pkg}@${version} (npm). ${license}. The marks belong to their owners and identify a provider only. Modified for ExponetDB.`
  const glyphs = (header = otherHeader()): SourceFile =>
    file(GLYPHS, header, '// icons/hetzner.svg\n// data/simple-icons.json\nexport const x = 1\n')
  const otherRow = (overrides: Partial<OtherRow> = {}): OtherRow => ({
    line: 80,
    path: GLYPHS,
    packageName: 'simple-icons',
    version: '16.35.0',
    upstreamFiles: ['icons/hetzner.svg', 'data/simple-icons.json'],
    licenseBasis: 'CC0-1.0',
    notices: 'header; LICENSES/CC0-1.0-simple-icons.txt',
    changes: 'mono flag added',
    review: 'reviewed: no per-icon license entry',
    ...overrides,
  })

  it('reads the header and flags a near miss', () => {
    expect(parseOtherHeader(`${otherHeader()}\n`)).toEqual({
      packageName: 'simple-icons',
      version: '16.35.0',
      license: 'CC0-1.0',
      line: 1,
    })
    const near = '// Copied from simple-icons@16 (npm). CC0-1.0.\n'
    expect(parseOtherHeader(near)).toBeUndefined()
    expect(findMalformedOtherHeader(near)).toBe(1)
    expect(findMalformedOtherHeader(`${otherHeader()}\n`)).toBeUndefined()
    expect(findMalformedOtherHeader('export const x = 1\n')).toBeUndefined()
  })

  it('parses the "Other sources" table and splits the upstream files', () => {
    const md = [
      '## Register',
      '| ExponetDB path | Source path | Commit | License basis | Notices applied | Changes | Review |',
      '|---|---|---|---|---|---|---|',
      '',
      `## ${OTHER_SECTION}`,
      '',
      `| ${OTHER_COLUMNS.join(' | ')} |`,
      `|${OTHER_COLUMNS.map(() => '---').join('|')}|`,
      `| \`${GLYPHS}\` | \`simple-icons\` | \`16.35.0\` | \`icons/hetzner.svg\`, \`data/simple-icons.json\` | CC0-1.0 | header | none | reviewed |`,
      '',
      '## Notes',
      '| ignored | row |',
    ].join('\n')
    expect(parseRegister(md)).toEqual({ rows: [], problems: [] })
    const parsed = parseOtherRegister(md)
    expect(parsed.problems).toEqual([])
    expect(parsed.rows).toEqual([
      {
        line: 9,
        path: GLYPHS,
        packageName: 'simple-icons',
        version: '16.35.0',
        upstreamFiles: ['icons/hetzner.svg', 'data/simple-icons.json'],
        licenseBasis: 'CC0-1.0',
        notices: 'header',
        changes: 'none',
        review: 'reviewed',
      },
    ])
    expect(parseOtherRegister('## Register\n')).toEqual({ rows: [], problems: [] })
    const wrong = [`## ${OTHER_SECTION}`, '| Path | Package |', '|---|---|'].join('\n')
    expect(parseOtherRegister(wrong).problems.join('\n')).toContain('the table header must be')
  })

  it('accepts a registered copy of the pinned version inside its scope', () => {
    expect(checkOtherSources([glyphs()], [otherRow()])).toEqual([])
    // The Supabase register does not claim the file.
    expect(checkRegister([glyphs()], [])).toEqual([])
  })

  it('reports a header without a row and a malformed header', () => {
    expect(checkOtherSources([glyphs()], [])).toEqual([
      `${GLYPHS}:1: has a provenance header but no row under "Other sources" in ${REGISTER_PATH}`,
    ])
    const bad = file(GLYPHS, '// Copied from simple-icons@latest. CC0.')
    expect(checkOtherSources([bad], []).join('\n')).toContain('malformed provenance header')
  })

  it('refuses another package, another version, another license and another place', () => {
    const text = (overrides: Partial<OtherRow>, f = glyphs()) =>
      checkOtherSources([f], [otherRow(overrides)]).join('\n')
    expect(text({ packageName: 'some-icons' }, glyphs(otherHeader('some-icons')))).toContain(
      'which is not an allowed source',
    )
    expect(text({ version: '16.36.0' })).toContain('only the pinned 16.35.0 may be copied')
    expect(text({ version: '16.36.0' })).toContain(
      'header names simple-icons@16.35.0, the register row (line 80) names simple-icons@16.36.0',
    )
    expect(text({}, glyphs(otherHeader('simple-icons', '16.35.0', 'MIT')))).toContain(
      'header names the license MIT, simple-icons is copied under CC0-1.0',
    )
    expect(text({ licenseBasis: 'MIT' })).toContain('must name the license CC0-1.0')
    const elsewhere: SourceFile = { ...glyphs(), path: 'packages/ui/src/glyphs.ts' }
    expect(text({ path: 'packages/ui/src/glyphs.ts' }, elsewhere)).toContain(
      'lies outside the scope of simple-icons',
    )
  })

  it('reports an empty cell, a missing review, a missing file and an unnamed upstream file', () => {
    const problems = (rows: OtherRow[], files = [glyphs()]) =>
      checkOtherSources(files, rows).join('\n')
    expect(problems([otherRow({ changes: '—' })])).toContain('the "Changes" cell')
    expect(problems([otherRow({ review: 'pending' })])).toContain('has no recorded review')
    expect(problems([otherRow()], [])).toContain('is registered but does not exist')
    const bare: SourceFile = { path: GLYPHS, text: 'export const x = 1\n' }
    expect(problems([otherRow()], [bare])).toContain('lacks the provenance header')
    expect(problems([otherRow({ upstreamFiles: ['icons/aws.svg'] })])).toContain(
      'the upstream file icons/aws.svg (register line 80) is not named in the file',
    )
    expect(problems([otherRow(), otherRow({ line: 81 })])).toContain(
      'is registered twice (first at line 80)',
    )
  })

  it('pins Simple Icons to one version, CC0-1.0, in packages/icons only', () => {
    expect(OTHER_SOURCES['simple-icons']).toEqual({
      version: '16.35.0',
      license: 'CC0-1.0',
      scope: ['packages/icons/src/'],
      decision: 'ADR-0033',
    })
  })
})
