import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * License-compliance register check (ADR-0030 §3, ADR-0033, third-party-register.md). Apache-2.0 §4 asks
 * for the license text, the retained notices and a prominent change notice once code is copied.
 * This check keeps the files and the register in step:
 *
 * 1. every file that starts with the provenance header has exactly one register row;
 * 2. every row names an existing file that starts with the header, and the header agrees with
 *    the row (source path, commit);
 * 3. every commit is the pinned source commit;
 * 4. every cell is filled, the review is recorded and the header notice is applied;
 * 5. a copied file keeps no brand, telemetry or framework leftovers of its origin.
 *
 * Files copied from another source (C-2, second paragraph) are kept the same way under
 * "Other sources": an allowed package at its pinned version and license, inside its scope, with
 * the "Copied from <package>@<version> (npm)" header and one row naming the upstream files.
 *
 * The register is a compliance record, not a runtime provenance layer: nothing reads it at
 * runtime and a registered file is ExponetDB code that is changed freely.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The only source commit ADR-0030 allows (`davdxpx/supabase`); a later commit is a new copy. */
export const PINNED_SOURCE_COMMIT = '8b9af568'

export const REGISTER_PATH = 'exponetdb-docs/11-ui/third-party-register.md'

export const REGISTER_COLUMNS = [
  'ExponetDB path',
  'Source path',
  'Commit',
  'License basis',
  'Notices applied',
  'Changes',
  'Review',
] as const

/** A provenance header sits within the first lines of a copied file. */
const HEADER_WINDOW = 5

/** `//`, `/* … *\/`, `{/* … *\/}` and the continuation line of a block comment. */
const HEADER =
  /^\s*(?:\/\/|\{\/\*+|\/\*+|\*)\s*Derived from supabase\/supabase (\S+) @ ([0-9a-f]+)\. Apache-2\.0 \(Copyright 2024 Supabase\)(; package declared MIT)?\. Modified for ExponetDB\./

/** Anything that claims to be a Supabase provenance header, well formed or not. */
const LOOSE_HEADER = /derived\s+from\s+supabase/i

export interface Header {
  readonly sourcePath: string
  readonly commit: string
  /** True for the form with "; package declared MIT" (files of Supabase packages declaring MIT). */
  readonly declaredMit: boolean
  /** 1-based line of the header. */
  readonly line: number
}

/** The provenance header within the first lines of a file, or undefined. */
export function parseHeader(text: string): Header | undefined {
  const lines = text.split(/\r?\n/, HEADER_WINDOW)
  for (const [i, line] of lines.entries()) {
    const m = HEADER.exec(line)
    const sourcePath = m?.[1]
    const commit = m?.[2]
    if (sourcePath !== undefined && commit !== undefined) {
      return { sourcePath, commit, declaredMit: m?.[3] !== undefined, line: i + 1 }
    }
  }
  return undefined
}

/**
 * The 1-based line of a header that names Supabase as the origin but does not match the exact
 * form (a typo would otherwise let a copied file escape the register).
 */
export function findMalformedHeader(text: string): number | undefined {
  if (parseHeader(text) !== undefined) {
    return undefined
  }
  const lines = text.split(/\r?\n/, HEADER_WINDOW)
  const index = lines.findIndex((line) => LOOSE_HEADER.test(line))
  return index === -1 ? undefined : index + 1
}

export interface RegisterRow {
  /** 1-based line in the register document. */
  readonly line: number
  readonly path: string
  readonly sourcePath: string
  readonly commit: string
  readonly licenseBasis: string
  readonly notices: string
  readonly changes: string
  readonly review: string
}

export interface ParsedRegister {
  readonly rows: RegisterRow[]
  readonly problems: string[]
}

function splitCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i)
    if (ch === '\\' && body.charAt(i + 1) === '|') {
      cell += '|'
      i += 1
    } else if (ch === '|') {
      cells.push(cell)
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell)
  return cells.map((c) => unwrap(c.trim()))
}

/** A cell that is one code span carries its value inside the backticks. */
function unwrap(cell: string): string {
  const m = /^`([^`]*)`$/.exec(cell)
  return m?.[1]?.trim() ?? cell
}

/** An empty cell, or a placeholder that stands in for one. */
function isEmpty(cell: string): boolean {
  return cell === '' || /^(?:-+|–|—|\?|n\/a|tbd|todo)$/i.test(cell)
}

/** The rows of the Markdown table under `## Register`. */
export function parseRegister(markdown: string): ParsedRegister {
  const rows: RegisterRow[] = []
  const problems: string[] = []
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Register\s*$/.test(l))
  if (start === -1) {
    return { rows, problems: [`${REGISTER_PATH}: no "## Register" section`] }
  }
  let tableLine = 0
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    if (/^#{1,2}\s/.test(raw)) {
      break
    }
    if (!raw.trimStart().startsWith('|')) {
      continue
    }
    tableLine += 1
    const label = `${REGISTER_PATH}:${i + 1}`
    const cells = splitCells(raw)
    if (tableLine === 1) {
      const wanted = REGISTER_COLUMNS.join(' | ').toLowerCase()
      if (cells.join(' | ').toLowerCase() !== wanted) {
        problems.push(`${label}: the table header must be ${REGISTER_COLUMNS.join(' | ')}`)
      }
      continue
    }
    if (tableLine === 2) {
      if (!cells.every((c) => /^:?-+:?$/.test(c))) {
        problems.push(`${label}: the second table line must be the separator row`)
      }
      continue
    }
    const [path, sourcePath, commit, licenseBasis, notices, changes, review] = cells
    if (cells.length !== REGISTER_COLUMNS.length) {
      problems.push(
        `${label}: a row has ${cells.length} cells, expected ${REGISTER_COLUMNS.length} (escape a | inside a cell as \\|)`,
      )
      continue
    }
    rows.push({
      line: i + 1,
      path: path ?? '',
      sourcePath: sourcePath ?? '',
      commit: commit ?? '',
      licenseBasis: licenseBasis ?? '',
      notices: notices ?? '',
      changes: changes ?? '',
      review: review ?? '',
    })
  }
  return { rows, problems }
}

export interface SourceFile {
  /** Repository-relative path with `/` separators. */
  readonly path: string
  readonly text: string
}

/** Files whose header text is documentation, tooling or a license text, never a copied file. */
export function isExempt(path: string): boolean {
  return (
    path.startsWith('exponetdb-docs/') ||
    path.startsWith('tooling/') ||
    path.startsWith('LICENSES/') ||
    path === 'THIRD_PARTY_NOTICES.md' ||
    path.endsWith('.md') ||
    path.split('/').some((segment) => segment === 'node_modules' || segment === 'dist')
  )
}

/**
 * Leftovers of the origin in a copied file (ADR-0030 §2: brand, telemetry, framework and
 * platform code is never copied). The header line is exempt; every other occurrence counts.
 */
export const BRAND_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['supabase', /supabase/i],
  ['next/', /next\//],
  ['next-themes', /next-themes/],
  ["from 'common'", /\bfrom\s+['"]common(?:['"]|\/)/],
  ['posthog', /posthog/i],
  ['configcat', /configcat/i],
  ['sentry', /sentry/i],
  ['IS_PLATFORM', /IS_PLATFORM/],
  ['--brand-', /--brand-/],
  ['CustomFont', /CustomFont/],
  ['Circular', /Circular/],
]

function brandProblems(file: SourceFile, headerLine: number): string[] {
  const out: string[] = []
  for (const [i, line] of file.text.split(/\r?\n/).entries()) {
    if (i + 1 === headerLine) {
      continue
    }
    for (const [name, pattern] of BRAND_PATTERNS) {
      if (pattern.test(line)) {
        out.push(`${file.path}:${i + 1}: leftover of the origin in a copied file (${name})`)
      }
    }
  }
  return out
}

function rowProblems(row: RegisterRow, file: SourceFile | undefined): string[] {
  const label = `${REGISTER_PATH}:${row.line}`
  const out: string[] = []
  const cells: readonly (readonly [string, string])[] = [
    [REGISTER_COLUMNS[0], row.path],
    [REGISTER_COLUMNS[1], row.sourcePath],
    [REGISTER_COLUMNS[2], row.commit],
    [REGISTER_COLUMNS[3], row.licenseBasis],
    [REGISTER_COLUMNS[4], row.notices],
    [REGISTER_COLUMNS[5], row.changes],
    [REGISTER_COLUMNS[6], row.review],
  ]
  for (const [column, value] of cells) {
    if (isEmpty(value)) {
      out.push(`${label}: the "${column}" cell of ${row.path || '(no path)'} is empty`)
    }
  }
  if (!isEmpty(row.path) && (row.path.startsWith('/') || row.path.split('/').includes('..'))) {
    out.push(`${label}: ${row.path} must be a repository-relative path`)
  }
  if (!isEmpty(row.commit) && row.commit !== PINNED_SOURCE_COMMIT) {
    out.push(
      `${label}: ${row.path} names commit ${row.commit}, only the pinned ${PINNED_SOURCE_COMMIT} may be copied (ADR-0030 §1)`,
    )
  }
  if (!isEmpty(row.notices) && !/\bheader\b/i.test(row.notices)) {
    out.push(`${label}: ${row.path} must list the provenance "header" among its notices`)
  }
  if (!isEmpty(row.review) && !/^reviewed\b/i.test(row.review) && !/\bOD-\d+\b/.test(row.review)) {
    out.push(
      `${label}: ${row.path} has no recorded review ("${row.review}"): start with "reviewed" or name the open decision (OD-<n>)`,
    )
  }
  if (isEmpty(row.path)) {
    return out
  }
  if (file === undefined) {
    out.push(`${label}: ${row.path} is registered but does not exist`)
    return out
  }
  const header = parseHeader(file.text)
  if (header === undefined) {
    out.push(`${file.path}: registered (register line ${row.line}) but lacks the provenance header`)
    return out
  }
  if (header.sourcePath !== row.sourcePath) {
    out.push(
      `${file.path}:${header.line}: header names source ${header.sourcePath}, the register row (line ${row.line}) names ${row.sourcePath}`,
    )
  }
  if (header.commit !== row.commit) {
    out.push(
      `${file.path}:${header.line}: header names commit ${header.commit}, the register row (line ${row.line}) names ${row.commit}`,
    )
  }
  if (header.commit !== PINNED_SOURCE_COMMIT) {
    out.push(
      `${file.path}:${header.line}: header names commit ${header.commit}, only the pinned ${PINNED_SOURCE_COMMIT} may be copied (ADR-0030 §1)`,
    )
  }
  return out
}

/** Every problem between the files of the repository and the rows of the register. */
/** Where ADR-0030 lets copied files live (§1, Scope). */
export const COPY_SCOPE: readonly string[] = [
  'packages/tokens/',
  'packages/ui/',
  'packages/ui-patterns/',
  'packages/ui-data/',
  'apps/web/',
  'apps/design-system/',
]

/** Source paths ADR-0030 never copies from (§2): icons, common, Studio's data layer, fonts. */
export const NEVER_COPIED_SOURCES: readonly RegExp[] = [
  /^packages\/(icons|build-icons|common)\//,
  /^apps\/studio\/(data|lib\/(api|telemetry|constants))\//,
  /\.(woff2?|ttf|otf|eot)$/,
  /(^|\/)(LogoLoader|SupabaseWordmark|McpUrlBuilder|Markdown|Mermaid|SqlToRest|AssistantChat)(\/|\.|$)/,
]

/** Problems of a copied file's location and source against ADR-0030's scope. */
export function scopeProblems(path: string, sourcePath: string, line: number): string[] {
  const problems: string[] = []
  if (!COPY_SCOPE.some((dir) => path.startsWith(dir))) {
    problems.push(
      `${path}:${line}: a copied file outside the scope of ADR-0030 (${COPY_SCOPE.join(', ')})`,
    )
  }
  if (NEVER_COPIED_SOURCES.some((re) => re.test(sourcePath))) {
    problems.push(`${path}:${line}: copied from ${sourcePath}, which ADR-0030 never copies`)
  }
  return problems
}

export function checkRegister(
  files: readonly SourceFile[],
  register: readonly RegisterRow[],
): string[] {
  const problems: string[] = []
  const byPath = new Map(files.map((f) => [f.path, f]))
  const firstLine = new Map<string, number>()
  for (const row of register) {
    const earlier = firstLine.get(row.path)
    if (earlier !== undefined && row.path !== '') {
      problems.push(
        `${REGISTER_PATH}:${row.line}: ${row.path} is registered twice (first at line ${earlier})`,
      )
    } else {
      firstLine.set(row.path, row.line)
    }
    problems.push(...rowProblems(row, byPath.get(row.path)))
  }
  const registered = new Set(register.map((r) => r.path))
  for (const file of files) {
    if (isExempt(file.path)) {
      continue
    }
    const header = parseHeader(file.text)
    if (header === undefined) {
      const malformed = findMalformedHeader(file.text)
      if (malformed !== undefined) {
        problems.push(
          `${file.path}:${malformed}: malformed provenance header: it must read exactly "Derived from supabase/supabase <source path> @ <commit>. Apache-2.0 (Copyright 2024 Supabase)[; package declared MIT]. Modified for ExponetDB."`,
        )
      }
      continue
    }
    if (!registered.has(file.path)) {
      problems.push(
        `${file.path}:${header.line}: has a provenance header but no row in ${REGISTER_PATH}`,
      )
    }
    problems.push(...brandProblems(file, header.line))
    problems.push(...scopeProblems(file.path, header.sourcePath, header.line))
  }
  return problems
}

// ---------------------------------------------------------------------------
// Other sources (C-2, second paragraph; ADR-0033)
// ---------------------------------------------------------------------------

/**
 * A third-party npm package other than Supabase from which specific files are copied: an
 * explicit exception of C-2 with a file-specific review. One pinned version, one license, and
 * the directories the copies may live in.
 */
export interface OtherSource {
  readonly version: string
  /** SPDX identifier of the license the copied files are under. */
  readonly license: string
  readonly scope: readonly string[]
  /** The decision that allows the copy. */
  readonly decision: string
}

export const OTHER_SOURCES: Readonly<Record<string, OtherSource>> = {
  'simple-icons': {
    version: '16.35.0',
    license: 'CC0-1.0',
    scope: ['packages/icons/src/'],
    decision: 'ADR-0033',
  },
}

export const OTHER_SECTION = 'Other sources'

export const OTHER_COLUMNS = [
  'ExponetDB path',
  'Package',
  'Version',
  'Upstream files',
  'License basis',
  'Notices applied',
  'Changes',
  'Review',
] as const

/** `// Copied from <package>@<version> (npm). <SPDX>. <notice>. Modified for ExponetDB.` */
const OTHER_HEADER =
  /^\s*(?:\/\/|\/\*+|\*)\s*Copied from ([a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+) \(npm\)\. ([A-Za-z0-9.+-]+)\. .*Modified for ExponetDB\./

/** Anything that claims to be such a header, well formed or not. */
const LOOSE_OTHER_HEADER = /\bcopied\s+from\s+[^\s@]+@/i

export interface OtherHeader {
  readonly packageName: string
  readonly version: string
  readonly license: string
  /** 1-based line of the header. */
  readonly line: number
}

/** The header of a file copied from another source, within the first lines, or undefined. */
export function parseOtherHeader(text: string): OtherHeader | undefined {
  for (const [i, line] of text.split(/\r?\n/, HEADER_WINDOW).entries()) {
    const m = OTHER_HEADER.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      return { packageName: m[1], version: m[2], license: m[3], line: i + 1 }
    }
  }
  return undefined
}

/** The 1-based line of a "Copied from …@…" header that does not match the exact form. */
export function findMalformedOtherHeader(text: string): number | undefined {
  if (parseOtherHeader(text) !== undefined) {
    return undefined
  }
  const index = text.split(/\r?\n/, HEADER_WINDOW).findIndex((l) => LOOSE_OTHER_HEADER.test(l))
  return index === -1 ? undefined : index + 1
}

export interface OtherRow {
  /** 1-based line in the register document. */
  readonly line: number
  readonly path: string
  readonly packageName: string
  readonly version: string
  /** The upstream files the copy takes from, each named in the copied file too. */
  readonly upstreamFiles: readonly string[]
  readonly licenseBasis: string
  readonly notices: string
  readonly changes: string
  readonly review: string
}

export interface ParsedOtherRegister {
  readonly rows: OtherRow[]
  readonly problems: string[]
}

/**
 * The rows of the table under `## Other sources`. A register without that section has no
 * rows; a copied file then fails the check for want of its row.
 */
export function parseOtherRegister(markdown: string): ParsedOtherRegister {
  const rows: OtherRow[] = []
  const problems: string[] = []
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${OTHER_SECTION}\\s*$`).test(l))
  if (start === -1) {
    return { rows, problems }
  }
  let tableLine = 0
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    if (/^#{1,2}\s/.test(raw)) {
      break
    }
    if (!raw.trimStart().startsWith('|')) {
      continue
    }
    tableLine += 1
    const label = `${REGISTER_PATH}:${i + 1}`
    const cells = splitCells(raw)
    if (tableLine === 1) {
      if (cells.join(' | ').toLowerCase() !== OTHER_COLUMNS.join(' | ').toLowerCase()) {
        problems.push(`${label}: the table header must be ${OTHER_COLUMNS.join(' | ')}`)
      }
      continue
    }
    if (tableLine === 2) {
      if (!cells.every((c) => /^:?-+:?$/.test(c))) {
        problems.push(`${label}: the second table line must be the separator row`)
      }
      continue
    }
    if (cells.length !== OTHER_COLUMNS.length) {
      problems.push(
        `${label}: a row has ${cells.length} cells, expected ${OTHER_COLUMNS.length} (escape a | inside a cell as \\|)`,
      )
      continue
    }
    const [path, packageName, version, upstream, licenseBasis, notices, changes, review] = cells
    rows.push({
      line: i + 1,
      path: path ?? '',
      packageName: packageName ?? '',
      version: version ?? '',
      upstreamFiles: (upstream ?? '')
        .split(',')
        .map((f) => f.trim().replace(/^`|`$/g, '').trim())
        .filter((f) => !isEmpty(f)),
      licenseBasis: licenseBasis ?? '',
      notices: notices ?? '',
      changes: changes ?? '',
      review: review ?? '',
    })
  }
  return { rows, problems }
}

function otherRowProblems(row: OtherRow, file: SourceFile | undefined): string[] {
  const label = `${REGISTER_PATH}:${row.line}`
  const out: string[] = []
  const cells: readonly (readonly [string, string])[] = [
    [OTHER_COLUMNS[0], row.path],
    [OTHER_COLUMNS[1], row.packageName],
    [OTHER_COLUMNS[2], row.version],
    [OTHER_COLUMNS[3], row.upstreamFiles.join(', ')],
    [OTHER_COLUMNS[4], row.licenseBasis],
    [OTHER_COLUMNS[5], row.notices],
    [OTHER_COLUMNS[6], row.changes],
    [OTHER_COLUMNS[7], row.review],
  ]
  for (const [column, value] of cells) {
    if (isEmpty(value)) {
      out.push(`${label}: the "${column}" cell of ${row.path || '(no path)'} is empty`)
    }
  }
  if (!isEmpty(row.path) && (row.path.startsWith('/') || row.path.split('/').includes('..'))) {
    out.push(`${label}: ${row.path} must be a repository-relative path`)
  }
  const source = Object.hasOwn(OTHER_SOURCES, row.packageName)
    ? OTHER_SOURCES[row.packageName]
    : undefined
  if (!isEmpty(row.packageName) && source === undefined) {
    out.push(
      `${label}: ${row.path} is copied from ${row.packageName}, which is not an allowed source (${Object.keys(OTHER_SOURCES).join(', ')})`,
    )
  }
  if (source !== undefined) {
    if (!isEmpty(row.version) && row.version !== source.version) {
      out.push(
        `${label}: ${row.path} names ${row.packageName}@${row.version}, only the pinned ${source.version} may be copied (${source.decision})`,
      )
    }
    if (!isEmpty(row.licenseBasis) && !row.licenseBasis.includes(source.license)) {
      out.push(`${label}: ${row.path} must name the license ${source.license} as its basis`)
    }
    if (!isEmpty(row.path) && !source.scope.some((dir) => row.path.startsWith(dir))) {
      out.push(
        `${label}: ${row.path} lies outside the scope of ${row.packageName} (${source.scope.join(', ')})`,
      )
    }
  }
  if (!isEmpty(row.notices) && !/\bheader\b/i.test(row.notices)) {
    out.push(`${label}: ${row.path} must list the provenance "header" among its notices`)
  }
  if (!isEmpty(row.review) && !/^reviewed\b/i.test(row.review) && !/\bOD-\d+\b/.test(row.review)) {
    out.push(
      `${label}: ${row.path} has no recorded review ("${row.review}"): start with "reviewed" or name the open decision (OD-<n>)`,
    )
  }
  if (isEmpty(row.path)) {
    return out
  }
  if (file === undefined) {
    out.push(`${label}: ${row.path} is registered but does not exist`)
    return out
  }
  const header = parseOtherHeader(file.text)
  if (header === undefined) {
    out.push(`${file.path}: registered (register line ${row.line}) but lacks the provenance header`)
    return out
  }
  if (header.packageName !== row.packageName || header.version !== row.version) {
    out.push(
      `${file.path}:${header.line}: header names ${header.packageName}@${header.version}, the register row (line ${row.line}) names ${row.packageName}@${row.version}`,
    )
  }
  if (source !== undefined && header.license !== source.license) {
    out.push(
      `${file.path}:${header.line}: header names the license ${header.license}, ${row.packageName} is copied under ${source.license}`,
    )
  }
  for (const upstream of row.upstreamFiles) {
    if (!file.text.includes(upstream)) {
      out.push(
        `${file.path}: the upstream file ${upstream} (register line ${row.line}) is not named in the file`,
      )
    }
  }
  return out
}

/** Every problem between the files copied from other sources and their register rows. */
export function checkOtherSources(
  files: readonly SourceFile[],
  register: readonly OtherRow[],
): string[] {
  const problems: string[] = []
  const byPath = new Map(files.map((f) => [f.path, f]))
  const firstLine = new Map<string, number>()
  for (const row of register) {
    const earlier = firstLine.get(row.path)
    if (earlier !== undefined && row.path !== '') {
      problems.push(
        `${REGISTER_PATH}:${row.line}: ${row.path} is registered twice (first at line ${earlier})`,
      )
    } else {
      firstLine.set(row.path, row.line)
    }
    problems.push(...otherRowProblems(row, byPath.get(row.path)))
  }
  const registered = new Set(register.map((r) => r.path))
  for (const file of files) {
    if (isExempt(file.path)) {
      continue
    }
    const header = parseOtherHeader(file.text)
    if (header === undefined) {
      const malformed = findMalformedOtherHeader(file.text)
      if (malformed !== undefined) {
        problems.push(
          `${file.path}:${malformed}: malformed provenance header: it must read exactly "Copied from <package>@<version> (npm). <SPDX license>. <notice>. Modified for ExponetDB."`,
        )
      }
      continue
    }
    if (!registered.has(file.path)) {
      problems.push(
        `${file.path}:${header.line}: has a provenance header but no row under "${OTHER_SECTION}" in ${REGISTER_PATH}`,
      )
    }
  }
  return problems
}

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|pdf|zip|gz|wasm)$/i

function listFiles(): string[] {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((f) => f.length > 0)
}

function main(): void {
  const registerFile = join(root, REGISTER_PATH)
  if (!existsSync(registerFile)) {
    console.error(`${REGISTER_PATH} does not exist`)
    process.exit(1)
  }
  const registerText = readFileSync(registerFile, 'utf8')
  const parsed = parseRegister(registerText)
  const other = parseOtherRegister(registerText)
  const files: SourceFile[] = []
  for (const path of listFiles()) {
    const absolute = join(root, path)
    // A tracked file that is deleted in the working tree is not a file any more.
    if (BINARY.test(path) || !existsSync(absolute)) {
      continue
    }
    files.push({ path, text: readFileSync(absolute, 'utf8') })
  }
  const problems = [
    ...parsed.problems,
    ...checkRegister(files, parsed.rows),
    ...other.problems,
    ...checkOtherSources(files, other.rows),
  ]
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(
    `third-party register holds (${parsed.rows.length} copied files registered and reviewed; ${other.rows.length} from other sources)`,
  )
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
