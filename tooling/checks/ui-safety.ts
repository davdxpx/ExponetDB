import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Browser code rules for the Web App packages (threat model, Wave 8; ADR-0030 §6; C-20, C-26).
 * The Web App runs under `script-src 'self'; style-src 'self'`, renders untrusted content as
 * text only and talks to the network only through the SDK. This check keeps the source in line:
 * no markup sinks, no dynamic code, no native dialogs, no storage writes outside the preference
 * modules, no external URLs, no remote CSS, and none of the imports ADR-0030 forbids.
 *
 * The scan works on source with its comments blanked out (strings stay visible, so a hit in a
 * string literal is still a hit). A hit is excused only by a trailing comment on the same line,
 * `// ui-safety: allow <rule> — <reason>` (`/* … *\/` in CSS and JSX), and the reason is required.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Directories scanned for `*.ts`, `*.tsx` and `*.css`. */
export const SCAN_ROOTS: readonly string[] = [
  'packages/tokens',
  'packages/ui',
  'packages/ui-patterns',
  'packages/ui-data',
  'packages/icons',
  'apps/web/src',
  'apps/design-system/src',
]

/**
 * The framework-free Web App of Waves 3A to 7, kept until the rebuilt app
 * passes the parity oracle and then deleted (Wave 8 Phase 8, order D6). It
 * predates these rules; the check names every file so the list cannot hide
 * new code, and fails once a listed file is gone, so the list is emptied with
 * the deletion.
 */
export const LEGACY_WEB_FILES: readonly string[] = [
  'apps/web/src/api.ts',
  'apps/web/src/dom.ts',
  'apps/web/src/main.ts',
  'apps/web/src/reauth.ts',
  'apps/web/src/review.ts',
  'apps/web/src/safe.ts',
  'apps/web/src/shell.ts',
  'apps/web/src/webauthn.ts',
  'apps/web/src/pages/account.ts',
  'apps/web/src/pages/admin.ts',
  'apps/web/src/pages/approvals.ts',
  'apps/web/src/pages/consent.ts',
  'apps/web/src/pages/credentials.ts',
  'apps/web/src/pages/enrollment.ts',
  'apps/web/src/pages/login.ts',
  'apps/web/src/pages/stepup.ts',
  'apps/web/src/app.css',
]

/** URL literals that are identifiers or the product's own origin, never a request to a third party. */
export const URL_ALLOWLIST: readonly string[] = [
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xlink',
  'https://db.exponet.cloud',
]

/** Modules the browser packages never import (ADR-0030 §2: framework, platform, grid, loader). */
export const FORBIDDEN_IMPORTS: readonly string[] = [
  'next',
  'next-themes',
  'react-data-grid',
  '@monaco-editor/loader',
]
const FORBIDDEN_IMPORT_SCOPES: readonly string[] = ['@supabase/']

export const RULES = [
  'dangerous-html',
  'dynamic-code',
  'style-attribute',
  'native-dialog',
  'web-storage',
  'external-url',
  'css-import',
  'css-remote-url',
  'forbidden-import',
] as const
export type Rule = (typeof RULES)[number]

export interface Problem {
  readonly path: string
  /** 1-based line. */
  readonly line: number
  /** A rule id, or `escape` for a malformed escape comment (which excuses nothing). */
  readonly rule: string
  readonly message: string
}

export interface Exception {
  readonly path: string
  readonly line: number
  readonly rule: Rule
  readonly reason: string
}

export interface Analysis {
  readonly problems: Problem[]
  readonly exceptions: Exception[]
}

export function formatProblem(problem: Problem): string {
  return `${problem.path}:${problem.line}: [${problem.rule}] ${problem.message}`
}

// ---------------------------------------------------------------------------
// Blanking comments
// ---------------------------------------------------------------------------

const REGEX_PREVIOUS = /[(,=:[!&|?{};+\-*%>~^]$/
const REGEX_KEYWORD =
  /(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|void|delete|throw|new|yield|await)$/

function regexAllowed(tail: string): boolean {
  const t = tail.trimEnd()
  // `</div>`: a slash right after `<` closes a JSX tag, it does not start a regular expression.
  return t === '' || (!t.endsWith('<') && (REGEX_PREVIOUS.test(t) || REGEX_KEYWORD.test(t)))
}

/** The index of the slash that closes the regular expression starting at `start`, or -1. */
function regexEnd(text: string, start: number): number {
  let inClass = false
  for (let j = start + 1; j < text.length; j += 1) {
    const c = text.charAt(j)
    if (c === '\n') {
      return -1
    }
    if (c === '\\') {
      j += 1
    } else if (inClass) {
      inClass = c !== ']'
    } else if (c === '[') {
      inClass = true
    } else if (c === '/') {
      return j
    }
  }
  return -1
}

/**
 * Replaces every comment with spaces and keeps newlines, so lines and columns stay put. Strings
 * and template literals are copied unchanged. The lexer tells a slash that starts a regular
 * expression from a division by the token before it; a wrong guess only ever leaves text visible
 * (a comment stays scanned), it never hides code.
 */
export function blankComments(text: string, css = false): string {
  type State = 'code' | 'block' | 'single' | 'double' | 'template'
  const out: string[] = []
  let state: State = 'code'
  let tail = ''
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    const next = text.charAt(i + 1)
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        out.push('  ')
        i += 2
        state = 'code'
      } else {
        out.push(ch === '\n' ? '\n' : ' ')
        i += 1
      }
      continue
    }
    if (state !== 'code') {
      const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`'
      if (ch === '\\') {
        out.push(ch, next)
        i += 2
        continue
      }
      if (ch === quote || (ch === '\n' && state !== 'template')) {
        state = 'code'
        tail = `${tail}${quote}`.slice(-16)
      }
      out.push(ch)
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      state = 'block'
      out.push('  ')
      i += 2
      continue
    }
    if (!css && ch === '/' && next === '/') {
      let end = text.indexOf('\n', i)
      end = end === -1 ? text.length : end
      out.push(' '.repeat(end - i))
      i = end
      continue
    }
    if (ch === "'" || ch === '"' || (!css && ch === '`')) {
      state = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template'
      out.push(ch)
      i += 1
      continue
    }
    if (!css && ch === '/' && regexAllowed(tail)) {
      const end = regexEnd(text, i)
      if (end !== -1) {
        out.push(text.slice(i, end + 1))
        i = end + 1
        tail = `${tail})`.slice(-16)
        continue
      }
    }
    out.push(ch)
    i += 1
    tail = `${tail}${ch.trim() === '' ? ' ' : ch}`.slice(-16)
  }
  return out.join('')
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const ASSIGN = String.raw`(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?!=)`

const NATIVE_DIALOG_MESSAGE =
  'native dialogs are not allowed; use the confirmation dialog of the UI package'

interface Pattern {
  readonly rule: Rule
  readonly regex: RegExp
  readonly message: string
}

/** Rules for the source of the browser packages; test files are exempt. */
const SOURCE_PATTERNS: readonly Pattern[] = [
  {
    rule: 'dangerous-html',
    regex: /\bdangerouslySetInnerHTML\b/,
    message: 'dangerouslySetInnerHTML turns data into markup; render untrusted content as text',
  },
  {
    rule: 'dangerous-html',
    regex: new RegExp(String.raw`\.\s*(?:inner|outer)HTML\s*${ASSIGN}`),
    message: 'assigning innerHTML or outerHTML turns data into markup; use text nodes',
  },
  {
    rule: 'dangerous-html',
    regex: new RegExp(String.raw`\[\s*['"\`](?:inner|outer)HTML['"\`]\s*\]\s*${ASSIGN}`),
    message: 'assigning innerHTML or outerHTML turns data into markup; use text nodes',
  },
  {
    rule: 'dangerous-html',
    regex: /\binsertAdjacentHTML\b/,
    message: 'insertAdjacentHTML turns data into markup; use text nodes',
  },
  {
    rule: 'dangerous-html',
    regex: /\bdocument\s*\.\s*write(?:ln)?\b/,
    message: 'document.write turns data into markup',
  },
  {
    rule: 'dynamic-code',
    regex: /\beval\s*\(/,
    message: 'eval runs text as code (CSP forbids it)',
  },
  {
    rule: 'dynamic-code',
    regex: /\bnew\s+Function\s*\(/,
    message: 'new Function runs text as code (CSP forbids it)',
  },
  {
    rule: 'style-attribute',
    regex: /\bsetAttribute\s*\(\s*['"`]style['"`]/,
    message: "setAttribute('style') needs style-src 'unsafe-inline'; use classes or CSS variables",
  },
  {
    rule: 'native-dialog',
    regex: /\b(?:window|globalThis|self|top|parent)\s*\.\s*(?:confirm|alert|prompt)\s*\(/,
    message: NATIVE_DIALOG_MESSAGE,
  },
]

const STORAGE_MESSAGE =
  'web storage is written only in a module whose path contains "preferences" or "storage"'

const STORAGE_PATTERNS: readonly RegExp[] = [
  /\b(?:local|session)Storage\s*\.\s*(?:setItem|removeItem|clear)\s*\(/,
  new RegExp(String.raw`\b(?:local|session)Storage\s*\[[^\]]*\]\s*${ASSIGN}`),
  new RegExp(String.raw`\b(?:local|session)Storage\s*\.\s*[A-Za-z_$][\w$]*\s*${ASSIGN}`),
  // The storage object itself handed around or aliased (`const s = localStorage`) can write.
  /(?<![\w$'"`])(?<!\btypeof\s+)(?:(?:window|globalThis|self)\s*\.\s*)?(?:local|session)Storage\b(?!\s*[.[])/,
]

/** Storage writes belong to preference and storage modules, which own the keys and the schema. */
export function mayWriteStorage(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.includes('preferences') || lower.includes('storage')
}

const URL_PATTERN = /https?:\/\/(?=[\w$[-])[^\s'"`<>()[\]{},;\\]*/g

export function isAllowedUrl(url: string): boolean {
  return URL_ALLOWLIST.some(
    (allowed) =>
      url === allowed || (url.startsWith(allowed) && /^[/?#]/.test(url.slice(allowed.length))),
  )
}

export function isForbiddenImport(specifier: string): boolean {
  return (
    FORBIDDEN_IMPORT_SCOPES.some((scope) => specifier.startsWith(scope)) ||
    FORBIDDEN_IMPORTS.some((name) => specifier === name || specifier.startsWith(`${name}/`))
  )
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g
const CSS_IMPORT_SPECIFIER = /@import\s+(?:url\(\s*)?(['"])([^'"\n]+)\1/g

const CSS_PATTERNS: readonly Pattern[] = [
  {
    rule: 'css-import',
    regex: /@import\s+url\s*\(/i,
    message: '@import url() pulls a stylesheet at run time; bundle the CSS instead',
  },
  {
    rule: 'css-import',
    regex: /@import\s+['"]\s*(?:https?:)?\/\//i,
    message: 'a remote @import pulls a stylesheet from a third party',
  },
  {
    rule: 'css-remote-url',
    regex: /(?<!@import\s+)url\(\s*['"]?\s*(?:https?:)?\/\//i,
    message: 'url() to a remote origin loads a third-party resource; self-host the asset',
  },
]

const BARE_DIALOG = /(?<![\w$.])(?<!\bfunction\s+)(?:confirm|alert|prompt)\s*\(/g
const MEMBER_PREFIX =
  /^\s*(?:(?:public|private|protected|static|readonly|async|get|set|override|abstract|declare)\s+)*\*?\s*$/
const TYPED_FIRST_PARAMETER = /^\s*(?:\.\.\.)?[A-Za-z_$][\w$]*\s*\??\s*:/
const SIGNATURE_END = /^\s*\)\s*(?::|\{)|\)\s*\{\s*$/

/**
 * Bare `confirm(`, `alert(` and `prompt(` calls. A member declaration (`alert(error: unknown): void`,
 * `confirm() {`) names the function without calling it: it starts the line and carries a typed
 * first parameter, a return type or a body, none of which a call can have.
 */
function bareDialogCall(line: string): boolean {
  for (const m of line.matchAll(BARE_DIALOG)) {
    const before = line.slice(0, m.index)
    const after = line.slice(m.index + m[0].length)
    const declaration =
      MEMBER_PREFIX.test(before) && (TYPED_FIRST_PARAMETER.test(after) || SIGNATURE_END.test(after))
    if (!declaration) {
      return true
    }
  }
  return false
}

interface Hit {
  readonly rule: Rule
  readonly message: string
}

export function isTestFile(path: string): boolean {
  return (
    path.split('/').some((s) => s === 'test' || s === 'tests' || s === '__tests__') ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  )
}

function hitsOf(path: string, line: string, css: boolean, test: boolean): Hit[] {
  const hits: Hit[] = []
  if (css) {
    for (const p of CSS_PATTERNS) {
      if (p.regex.test(line)) {
        hits.push({ rule: p.rule, message: p.message })
      }
    }
    for (const m of line.matchAll(CSS_IMPORT_SPECIFIER)) {
      const specifier = m[2] ?? ''
      if (isForbiddenImport(specifier)) {
        hits.push({ rule: 'forbidden-import', message: `${specifier} must not be imported` })
      }
    }
    return hits
  }
  for (const m of line.matchAll(IMPORT_SPECIFIER)) {
    const specifier = m[2] ?? ''
    if (isForbiddenImport(specifier)) {
      hits.push({ rule: 'forbidden-import', message: `${specifier} must not be imported` })
    }
  }
  if (test) {
    return hits
  }
  for (const p of SOURCE_PATTERNS) {
    if (p.regex.test(line)) {
      hits.push({ rule: p.rule, message: p.message })
    }
  }
  if (bareDialogCall(line)) {
    hits.push({ rule: 'native-dialog', message: NATIVE_DIALOG_MESSAGE })
  }
  if (!mayWriteStorage(path) && STORAGE_PATTERNS.some((re) => re.test(line))) {
    hits.push({ rule: 'web-storage', message: STORAGE_MESSAGE })
  }
  for (const m of line.matchAll(URL_PATTERN)) {
    if (!isAllowedUrl(m[0])) {
      hits.push({
        rule: 'external-url',
        message: `${m[0]} is an external URL; the Web App talks to its own origin only`,
      })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Escapes
// ---------------------------------------------------------------------------

const ESCAPE =
  /^ui-safety:\s*allow\s+([a-z][a-z-]*)(?:\s+(?:—|–|--|-)\s+(?!\*\/)(.+?))?\s*(?:\*\/\s*\}?\s*)?$/

interface Escapes {
  readonly allowed: Map<Rule, string>
  readonly malformed: string[]
}

/** The escape comments on one line; only text inside a comment counts. */
function escapesOf(raw: string, blanked: string): Escapes {
  const allowed = new Map<Rule, string>()
  const malformed: string[] = []
  const marker = /ui-safety:/g
  const starts: number[] = []
  for (let m = marker.exec(raw); m !== null; m = marker.exec(raw)) {
    if (blanked.slice(m.index, m.index + 10).trim() === '') {
      starts.push(m.index)
    }
  }
  for (const [n, start] of starts.entries()) {
    const segment = raw.slice(start, starts[n + 1] ?? raw.length).trimEnd()
    const m = ESCAPE.exec(segment)
    const rule = m?.[1]
    const reason = m?.[2]?.trim()
    if (rule === undefined || reason === undefined || reason === '') {
      malformed.push(
        'an escape needs a rule and a reason: "ui-safety: allow <rule> — <reason>" (rules: ' +
          `${RULES.join(', ')})`,
      )
    } else if (!(RULES as readonly string[]).includes(rule)) {
      malformed.push(`unknown rule "${rule}" in an escape (rules: ${RULES.join(', ')})`)
    } else {
      allowed.set(rule as Rule, reason)
    }
  }
  return { allowed, malformed }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/** Problems and documented exceptions of one file. */
export function analyze(path: string, text: string): Analysis {
  const css = path.endsWith('.css')
  const test = isTestFile(path)
  const problems: Problem[] = []
  const exceptions: Exception[] = []
  const rawLines = text.split('\n')
  const blankedLines = blankComments(text, css).split('\n')
  for (const [i, raw] of rawLines.entries()) {
    const blanked = blankedLines[i] ?? ''
    const hits = hitsOf(path, blanked, css, test)
    const escapes = raw.includes('ui-safety:')
      ? escapesOf(raw, blanked)
      : { allowed: new Map<Rule, string>(), malformed: [] as string[] }
    for (const message of escapes.malformed) {
      problems.push({ path, line: i + 1, rule: 'escape', message })
    }
    const done = new Set<Rule>()
    for (const hit of hits) {
      if (done.has(hit.rule)) {
        continue
      }
      done.add(hit.rule)
      const reason = escapes.allowed.get(hit.rule)
      if (reason === undefined) {
        problems.push({ path, line: i + 1, rule: hit.rule, message: hit.message })
      } else {
        exceptions.push({ path, line: i + 1, rule: hit.rule, reason })
      }
    }
  }
  return { problems, exceptions }
}

/** The problems of one file (documented exceptions are not problems). */
export function scanSource(path: string, text: string): Problem[] {
  return analyze(path, text).problems
}

/** Whether a repository path is browser code this check scans. */
export function inScope(path: string): boolean {
  if (!/\.(?:tsx?|css)$/.test(path) || /\.gen\.tsx?$/.test(path)) {
    return false
  }
  if (path.split('/').some((s) => s === 'node_modules' || s === 'dist')) {
    return false
  }
  return SCAN_ROOTS.some((scanRoot) => path.startsWith(`${scanRoot}/`))
}

function main(): void {
  const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    // A tracked file that is deleted in the working tree is not a file any more.
    .filter((f) => f.length > 0 && inScope(f) && existsSync(join(root, f)))
    .filter((f) => !LEGACY_WEB_FILES.includes(f))
  const problems: Problem[] = []
  for (const legacy of LEGACY_WEB_FILES) {
    if (!existsSync(join(root, legacy))) {
      problems.push({
        path: legacy,
        line: 0,
        rule: 'legacy',
        message: 'a listed legacy file is gone: remove it from LEGACY_WEB_FILES',
      })
    }
  }
  let exceptions = 0
  for (const path of listed) {
    const analysis = analyze(path, readFileSync(join(root, path), 'utf8'))
    problems.push(...analysis.problems)
    exceptions += analysis.exceptions.length
  }
  if (problems.length > 0) {
    console.error(problems.map(formatProblem).join('\n'))
    process.exit(1)
  }
  console.log(
    `ui-safety holds (${listed.length} files scanned, ${exceptions} documented exceptions)`,
  )
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
