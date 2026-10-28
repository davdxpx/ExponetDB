// A seeded generator of SQL scripts full of lexical hazards, with a MODEL of what each script does.
// Every statement is a utility command with a visible effect, so three independent parties can be
// compared: the model (this file), the server (the whole text, one simple-protocol message) and the
// engine's path (statement ranges from the repo's parser, one extended-protocol message each).
//
//   COMMENT ON TABLE b2.t_<k> IS <literal>        effect: obj_description = the decoded literal
//   CREATE TABLE b2.<quoted identifier> (c int)   effect: a relation with that exact name
//   DO <body literal> [LANGUAGE plpgsql]          effect: a row (k, value) in b2.log
//
// The value of every literal is chosen first and then ENCODED in a randomly chosen quoting form
// (standard, E'', U&'', dollar-quoted with a tag, a continuation across a newline), so the model never
// has to lex SQL.

export class Rng {
  #s: number
  constructor(seed: number) {
    this.#s = seed >>> 0 || 1
  }
  next(): number {
    // mulberry32
    this.#s = (this.#s + 0x6d2b79f5) >>> 0
    let t = this.#s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(n: number): number {
    return Math.floor(this.next() * n)
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)] as T
  }
  chance(p: number): boolean {
    return this.next() < p
  }
}

/** Characters that make lexers argue (no NUL, no control characters other than TAB and LF). */
const VALUE_CHARS = [
  "'", '"', '\\', ';', '-', '-', '/', '*', '$', '\n', ' ', ' ', 'a', 'b', 'E', 'e', 'U', 'u', '&', '(', ')', '%', '_', '0', '9',
  '\t', 'é', '日', '😀', ' ', ' ', ',', '.', ':', '?',
]
const VALUE_SNIPPETS = ["''", '--', '/*', '*/', '$$', '$a$', ';--', "';", "\\'", "E'", "U&'", 'a;b', '\n--', '/*/', '-- x\n', '$1', '\\\\', '"', ';']

export function randomValue(r: Rng, maxLen = 14): string {
  let out = ''
  const n = r.int(maxLen + 1)
  while (out.length < n) out += r.chance(0.25) ? r.pick(VALUE_SNIPPETS) : r.pick(VALUE_CHARS)
  return out
}

// ---------- literal encoders: value -> SQL text that denotes exactly that value ----------

const TAG_START = ['a', 'b', 'tag', '_x', 'D', 'q1', 'é', '日x']
export type Form = 'plain' | 'escape' | 'unicode' | 'dollar' | 'continued'
export const FORMS: readonly Form[] = ['plain', 'escape', 'unicode', 'dollar', 'continued']

export function encodeLiteral(value: string, form: Form, r: Rng): string {
  switch (form) {
    case 'plain':
      return `'${value.replaceAll("'", "''")}'`
    case 'escape': {
      // E'': backslash and quote escaped; a raw newline stays raw half of the time
      let out = ''
      for (const ch of value) {
        if (ch === '\\') out += '\\\\'
        else if (ch === "'") out += r.chance(0.5) ? "\\'" : "''"
        else if (ch === '\n' && r.chance(0.5)) out += '\\n'
        else if (ch === '\t' && r.chance(0.5)) out += '\\t'
        else out += ch
      }
      return `E'${out}'`
    }
    case 'unicode':
      // U&'': the default escape character is the backslash, so it is doubled; quotes are doubled
      return `U&'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
    case 'dollar': {
      const options = ['', ...TAG_START.map((t) => t + (r.chance(0.5) ? '1' : ''))]
      for (let i = 0; i < 40; i++) {
        const tag = r.pick(options)
        const delim = `$${tag}$`
        // the closing delimiter must be the FIRST occurrence in value + delim, and no `$` may glue
        if ((value + delim).indexOf(delim) === value.length) return `${delim}${value}${delim}`
      }
      return `'${value.replaceAll("'", "''")}'`
    }
    case 'continued': {
      // two adjacent literals separated by a newline (optionally with a comment) are ONE literal in SQL
      const cps = Array.from(value)
      const cut = r.int(cps.length + 1)
      const a = cps.slice(0, cut).join('')
      const b = cps.slice(cut).join('')
      // A line comment between the pieces is also continuation for PostgreSQL, but the libpg_query builds
      // refuse it: that divergence has its own test (I5 "continuation across a line comment"), so the
      // random scripts stay inside what both accept.
      const sep = r.pick(['\n', '\n  ', ' \n', '\t\n\t', '\n\n'])
      return `'${a.replaceAll("'", "''")}'${sep}'${b.replaceAll("'", "''")}'`
    }
  }
}

/** A quoted identifier for `value` (1..40 chars, no NUL), plain or U&"…". */
export function encodeIdent(value: string, r: Rng): string {
  if (r.chance(0.25)) return `U&"${value.replaceAll('\\', '\\\\').replaceAll('"', '""')}"`
  return `"${value.replaceAll('"', '""')}"`
}

// ---------- noise between statements ----------

function noiseText(r: Rng): string {
  return randomValue(r, 8).replaceAll('*/', '* /').replaceAll('/*', '/ *').replaceAll('\n', ' ')
}

export function noise(r: Rng): string {
  const parts: string[] = []
  const n = r.int(4)
  for (let i = 0; i < n; i++) {
    switch (r.int(7)) {
      case 0: parts.push(' '); break
      case 1: parts.push('\n'); break
      case 2: parts.push('\t\n  '); break
      case 3: parts.push(`-- ${noiseText(r)}\n`); break
      case 4: parts.push(`/* ${noiseText(r)} */`); break
      case 5: parts.push(`/* a /* ${noiseText(r)} */ b */`); break
      default: parts.push('\u000c'); break // FF; VT is whitespace only from PostgreSQL 17 (own case in I5)
    }
  }
  return parts.join('')
}

// ---------- the script ----------

export type Stmt =
  | { kind: 'comment'; k: number; value: string; form: Form }
  | { kind: 'table'; k: number; name: string }
  | { kind: 'do'; k: number; value: string; form: Form; bodyForm: Form }

export interface Script {
  text: string
  stmts: readonly Stmt[]
  /** expected state after a correct execution */
  model: Model
  /** statement texts without surrounding noise, in order */
  bare: readonly string[]
}

export interface Model {
  comments: Record<string, string>
  tables: string[]
  log: { k: number; v: string }[]
}

const TABLE_CHARS = ['a', 'B', ' ', ';', '-', '--', '/*', '"', "'", '\\', '$', 'é', '日', '.', '(', '$$']

function bareStatement(s: Stmt, r: Rng): string {
  switch (s.kind) {
    case 'comment':
      return `COMMENT ON TABLE b2.t_${s.k} IS ${encodeLiteral(s.value, s.form, r)}`
    case 'table':
      return `CREATE TABLE b2.${encodeIdent(s.name, r)} (c int)`
    case 'do': {
      const inner = encodeLiteral(s.value, s.bodyForm === 'continued' ? 'plain' : s.bodyForm, r)
      // The body is PL/pgSQL text; it is then quoted as a whole in the DO form chosen.
      const body = `BEGIN INSERT INTO b2.log VALUES (${s.k}, ${inner}); END`
      const lit = encodeLiteral(body, s.form === 'continued' ? 'plain' : s.form, r)
      return r.chance(0.3) ? `DO LANGUAGE plpgsql ${lit}` : r.chance(0.3) ? `DO ${lit} LANGUAGE plpgsql` : `DO ${lit}`
    }
  }
}

/** A script of `count` statements; `tables` upper-bounds the comment targets. */
export function script(seed: number, count: number, opts: { trailingSemicolon?: boolean } = {}): Script {
  const r = new Rng(seed)
  const stmts: Stmt[] = []
  const model: Model = { comments: {}, tables: [], log: [] }
  const used = new Set<string>()
  for (let k = 0; k < count; k++) {
    const kind = r.pick(['comment', 'comment', 'table', 'do', 'do'] as const)
    if (kind === 'comment') {
      const s: Stmt = { kind, k, value: randomValue(r, 20), form: r.pick(FORMS) }
      stmts.push(s)
      if (s.value !== '') model.comments[`t_${k}`] = s.value // COMMENT ... IS '' removes the comment
    } else if (kind === 'table') {
      let name = ''
      do {
        name = ''
        const n = 1 + r.int(5)
        for (let i = 0; i < n; i++) name += r.pick(TABLE_CHARS)
        name = name.trim() === '' ? `n${k}` : name
      } while (used.has(name) || Buffer.byteLength(name) > 60 || name.includes('\u0000'))
      used.add(name)
      stmts.push({ kind, k, name })
      model.tables.push(name)
    } else {
      const s: Stmt = { kind, k, value: randomValue(r, 12), form: r.pick(FORMS), bodyForm: r.pick(FORMS) }
      stmts.push(s)
      model.log.push({ k, v: s.value })
    }
  }
  const bare = stmts.map((s) => bareStatement(s, r))
  let text = noise(r)
  bare.forEach((b, i) => {
    text += b
    const last = i === bare.length - 1
    if (!last || opts.trailingSemicolon !== false) text += ';' + (r.chance(0.15) ? ';' : '')
    text += noise(r)
  })
  return { text, stmts, model, bare }
}

/** The setup that gives the model its tables (t_0 .. t_{n-1}) and the log. */
export function setupSql(count: number): string {
  const tables = Array.from({ length: count }, (_, k) => `CREATE TABLE b2.t_${k} (c int);`).join('\n')
  return `DROP SCHEMA IF EXISTS b2 CASCADE; CREATE SCHEMA b2; CREATE TABLE b2.log (k int, v text);\n${tables}`
}

/** The observable state of a run. */
export const STATE_SQL = `
SELECT json_build_object(
  'comments', COALESCE((SELECT json_object_agg(c.relname, obj_description(c.oid, 'pg_class'))
                          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'b2' AND c.relname ~ '^t_[0-9]+$' AND obj_description(c.oid, 'pg_class') IS NOT NULL), '{}'::json),
  'tables', COALESCE((SELECT json_agg(c.relname ORDER BY c.relname COLLATE "C") FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'b2' AND c.relkind = 'r' AND c.relname !~ '^t_[0-9]+$' AND c.relname <> 'log'), '[]'::json),
  'log', COALESCE((SELECT json_agg(json_build_object('k', k, 'v', v) ORDER BY k) FROM b2.log), '[]'::json)
) AS state`

function sortedObject(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function modelToState(m: Model): unknown {
  return {
    comments: sortedObject(m.comments),
    tables: [...m.tables].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)))),
    log: [...m.log].sort((a, b) => a.k - b.k),
  }
}
