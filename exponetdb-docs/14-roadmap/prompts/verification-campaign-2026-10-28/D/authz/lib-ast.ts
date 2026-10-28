/**
 * Static reachability: from a REST handler (HANDLERS in api.ts) or an MCP
 * binding (BINDINGS in mcp/registry.ts) through the application layer to the
 * central-engine calls (`#authorize`, `#admit`, `#plan`, `#inline`, `host.authorize`,
 * `host.admit`, `host.allowed`, `host.plan`, `host.inline`), with a small
 * constant propagation of string arguments (the action id is usually passed as a
 * parameter to a shared helper).
 *
 * Over-approximation by design: a call `x.m()` whose receiver type is unknown
 * resolves to every application method called `m` (at most 4). The report says
 * `fuzzy` when that happened. The result is evidence, not proof: the rows it
 * cannot close are read by hand (see agent-safety.md and the IDOR section).
 */
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type * as TS from 'typescript'

export interface AuthCall {
  /** `authorize` (both phases), `admit` (phase 1 only), `allowed` (boolean check), `plan`, `inline`. */
  readonly fn: 'authorize' | 'admit' | 'allowed' | 'plan' | 'inline'
  /** The action id when it resolved to a literal, else null. */
  readonly action: string | null
  /** Source text of the action argument when it did not resolve. */
  readonly dynamic?: string
  /** Kind of the subject argument: installation, self, target, plan, cluster, server, product, project, environment, dynamic or none. */
  readonly subject: string
  readonly where: string
  /** Reached only through a fuzzy (receiver type unknown) hop. */
  readonly weak?: true
}

export interface Reach {
  readonly auths: readonly AuthCall[]
  readonly mentions: readonly string[]
  readonly reached: readonly string[]
  readonly fuzzy: boolean
  /** Call sites of `lookup before authorize` shapes found on the path (see lookupBeforeAdmit). */
  readonly notes: readonly string[]
  /** Lookups (names starting find, get, read or load) that run before the first call into the engine, in source order with callee expansion. */
  readonly lookupFirst: readonly string[]
  readonly events: readonly string[]
}

interface Decl {
  readonly key: string
  readonly cls: string | undefined
  readonly name: string
  readonly file: string
  readonly line: number
  readonly node: TS.Node
  readonly params: readonly string[]
}

const AUTH_NAMES = new Set(['authorize', 'admit', 'allowed', 'plan', 'inline'])
const LOOKUP = /^(find|get|read|load|nodeState)[A-Za-z]*$/
const SKIP = new Set([
  'then', 'catch', 'map', 'filter', 'push', 'parse', 'safeParse', 'get', 'set', 'has', 'add', 'delete', 'slice', 'join',
  'includes', 'some', 'every', 'find', 'sort', 'keys', 'values', 'entries', 'toString', 'query', 'transaction',
])

export function loadTs(tree: string): typeof TS {
  return createRequire(join(tree, 'package.json'))('typescript') as typeof TS
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
  }
  return out
}

export class AstIndex {
  readonly ts: typeof TS
  readonly decls: Decl[] = []
  readonly byName = new Map<string, Decl[]>()
  readonly fieldClass = new Map<string, string>()
  readonly #tree: string

  constructor(tree: string) {
    this.#tree = tree
    this.ts = loadTs(tree)
    const files = [
      ...walk(join(tree, 'packages/application/src')),
      join(tree, 'apps/server/src/interfaces/http/api.ts'),
      join(tree, 'apps/server/src/interfaces/mcp/registry.ts'),
    ]
    for (const f of files) this.#index(f)
  }

  #push(d: Decl): void {
    this.decls.push(d)
    const l = this.byName.get(d.name) ?? []
    l.push(d)
    this.byName.set(d.name, l)
  }

  #index(file: string): void {
    const ts = this.ts
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const rel = relative(this.#tree, file)
    const line = (n: TS.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
    const nameOf = (n: TS.PropertyName | undefined): string | undefined =>
      n === undefined ? undefined : ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n) ? n.text.replace(/^#/, '') : undefined
    const paramsOf = (fn: TS.SignatureDeclarationBase): string[] =>
      fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : '_'))
    for (const stmt of sf.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name !== undefined) {
        const cls = stmt.name.text
        for (const m of stmt.members) {
          const n = nameOf(m.name as TS.PropertyName | undefined)
          if (n === undefined) continue
          if (ts.isMethodDeclaration(m) && m.body !== undefined) {
            this.#push({ key: `${cls}.${n}@${line(m)}`, cls, name: n, file: rel, line: line(m), node: m.body, params: paramsOf(m) })
          } else if (ts.isPropertyDeclaration(m)) {
            if (m.initializer !== undefined && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))) {
              this.#push({ key: `${cls}.${n}@${line(m)}`, cls, name: n, file: rel, line: line(m), node: m.initializer.body, params: paramsOf(m.initializer) })
            }
            if (cls === 'Application' && m.type !== undefined && ts.isTypeReferenceNode(m.type) && ts.isIdentifier(m.type.typeName)) {
              this.fieldClass.set(n, m.type.typeName.text)
            }
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined && stmt.body !== undefined) {
        this.#push({ key: `${rel}::${stmt.name.text}`, cls: undefined, name: stmt.name.text, file: rel, line: line(stmt), node: stmt.body, params: paramsOf(stmt) })
      } else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue
          const init = d.initializer
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            this.#push({ key: `${rel}::${d.name.text}`, cls: undefined, name: d.name.text, file: rel, line: line(d), node: init.body, params: paramsOf(init) })
          } else if ((d.name.text === 'HANDLERS' || d.name.text === 'BINDINGS') && ts.isObjectLiteralExpression(init.kind === ts.SyntaxKind.AsExpression ? init : init)) {
            for (const p of init.properties) {
              const n = nameOf(p.name)
              if (n !== undefined && ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) {
                this.#push({ key: `${d.name.text}.${n}`, cls: d.name.text, name: n, file: rel, line: line(p), node: p.initializer.body, params: paramsOf(p.initializer) })
              }
            }
          }
        }
      }
    }
  }

  entry(table: 'HANDLERS' | 'BINDINGS', name: string): Decl | undefined {
    return this.decls.find((d) => d.cls === table && d.name === name)
  }

  /** Reachability with constant propagation of string parameters. */
  reach(entry: Decl, maxDepth = 9): Reach {
    const ts = this.ts
    const auths: AuthCall[] = []
    const mentions = new Set<string>()
    const reached = new Set<string>()
    const notes: string[] = []
    const events: string[] = []
    let fuzzy = false
    const seen = new Set<string>()

    const lit = (n: TS.Expression | undefined, env: Map<string, string>): string | null => {
      if (n === undefined) return null
      if (ts.isStringLiteralLike(n)) return n.text
      if (ts.isIdentifier(n)) return env.get(n.text) ?? null
      if (ts.isTemplateExpression(n)) {
        let s = n.head.text
        for (const span of n.templateSpans) {
          const v = lit(span.expression, env)
          if (v === null) return null
          s += v + span.literal.text
        }
        return s
      }
      if (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) return lit(n.expression, env)
      return null
    }
    const subjectKind = (n: TS.Expression | undefined): string => {
      if (n === undefined) return 'none'
      const t = n.getText()
      const m = /kind:\s*'(\w+)'/.exec(t)
      if (m?.[1] !== undefined) return m[1]
      if (/INSTALLATION/.test(t)) return 'installation'
      if (/selfRef/.test(t)) return 'self'
      if (/subjectOf\(|kind:\s*'plan'/.test(t)) return 'plan'
      return 'dynamic'
    }

    const visit = (d: Decl, env: Map<string, string>, depth: number, weak: boolean): void => {
      const id = `${d.key}|${weak ? 'w' : 's'}|${[...env].map(([k, v]) => `${k}=${v}`).join(',')}`
      if (seen.has(id) || depth > maxDepth) return
      seen.add(id)
      reached.add(d.key.replace(/@\d+$/, ''))
      const rec = (node: TS.Node): void => {
        if (ts.isStringLiteralLike(node) && /^[a-z_]+(\.[a-z_]+)+$/.test(node.text)) mentions.add(node.text)
        if (ts.isCallExpression(node)) {
          const e = node.expression
          let name: string | undefined
          let recv: TS.Expression | undefined
          let priv = false
          if (ts.isPropertyAccessExpression(e)) {
            name = e.name.text.replace(/^#/, '')
            priv = ts.isPrivateIdentifier(e.name)
            recv = e.expression
          } else if (ts.isIdentifier(e)) {
            name = e.text
          }
          const isAuthShape = name !== undefined && AUTH_NAMES.has(name)
          const lastArgIsCreate = isAuthShape && (name === 'plan' || name === 'inline')
          if (recv !== undefined) rec(recv)
          // arguments are evaluated before the call: a subject thunk runs before the engine is asked
          node.arguments.forEach((a, i) => {
            if (!(lastArgIsCreate && i === node.arguments.length - 1)) rec(a)
          })
          if (name !== undefined) {
            const recvText = recv?.getText() ?? ''
            const isHost = /^(this\.#?h|this\.#?host|this\.#d\.host|host|h)$/.test(recvText)
            const isSelfPriv = recvText === 'this' && priv
            if ((name === 'authorize' || name === 'admit') && /authorizer$/.test(recvText) && node.arguments.length >= 2) {
              const req = node.arguments[1]
              let action: string | null = null
              let dyn = ''
              if (req !== undefined && ts.isObjectLiteralExpression(req)) {
                for (const p of req.properties) {
                  if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'action') {
                    action = env.get('action') ?? null
                    dyn = 'action'
                  } else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'action') {
                    action = lit(p.initializer, env)
                    dyn = p.initializer.getText().slice(0, 60)
                  }
                }
              }
              events.push(`A:${name}`)
              auths.push({
                fn: name,
                action,
                ...(action === null ? { dynamic: dyn } : {}),
                subject: name === 'admit' ? 'none' : subjectKind(node.arguments[2]),
                where: `${d.file}:${d.line}`,
                ...(weak ? { weak: true } : {}),
              })
            } else if (AUTH_NAMES.has(name) && (isHost || isSelfPriv) && node.arguments.length >= 2) {
              const action = lit(node.arguments[1], env)
              events.push(`A:${name}`)
              const sub = name === 'plan' ? (isSelfPriv ? node.arguments[5] : node.arguments[3]) : name === 'inline' ? node.arguments[3] : name === 'admit' ? undefined : node.arguments[3]
              auths.push({
                fn: name as AuthCall['fn'],
                action,
                ...(action === null ? { dynamic: node.arguments[1]?.getText().slice(0, 60) ?? '' } : {}),
                subject: name === 'admit' ? 'none' : subjectKind(sub) === 'dynamic' && name === 'plan' && sub === undefined ? 'installation' : subjectKind(sub),
                where: `${d.file}:${d.line}`,
                ...(weak ? { weak: true } : {}),
              })
            } else if (!SKIP.has(name) || /^app(\.\w+)?$/.test(recvText)) {
              let hopWeak = weak
              const targets = this.#resolve(name, recv, recvText, d, (f) => { fuzzy ||= f; hopWeak ||= f })
              for (const t of targets) {
                const next = new Map<string, string>()
                t.params.forEach((p, i) => {
                  const v = lit(node.arguments[i], env)
                  if (v !== null) next.set(p, v)
                })
                visit(t, next, depth + 1, hopWeak)
              }
              if (targets.length === 0 && LOOKUP.test(name) && !/^getOwnProperty|^getPrototype|^readPermission|^get(Time|Date)/.test(name)) events.push(`L:${name}`)
            }
          }
          return
        }
        ts.forEachChild(node, rec)
      }
      rec(d.node)
    }
    visit(entry, new Map(), 0, false)
    const firstAuth = events.findIndex((e) => e.startsWith('A:'))
    const lookups = events.slice(0, firstAuth < 0 ? events.length : firstAuth).filter((e) => e.startsWith('L:')).map((e) => e.slice(2))
    return { auths, mentions: [...mentions].sort(), reached: [...reached].sort(), fuzzy, notes, lookupFirst: lookups, events }
  }

  #resolve(name: string, recv: TS.Expression | undefined, recvText: string, ctx: Decl, onFuzzy: (f: boolean) => void): Decl[] {
    const ts = this.ts
    const all = this.byName.get(name) ?? []
    if (all.length === 0) return []
    const inClass = (cls: string) => all.filter((d) => d.cls === cls)
    if (recv === undefined) {
      const local = all.filter((d) => d.cls === undefined && d.file === ctx.file)
      return local.length > 0 ? local : all.filter((d) => d.cls === undefined).slice(0, 4)
    }
    if (recv.kind === ts.SyntaxKind.ThisKeyword) return ctx.cls === undefined ? [] : inClass(ctx.cls)
    if (ctx.cls === 'HANDLERS' || ctx.cls === 'BINDINGS') {
      if (recvText === 'app') return inClass('Application')
      const m = /^app\.(\w+)$/.exec(recvText)
      if (m?.[1] !== undefined) {
        const cls = this.fieldClass.get(m[1])
        return cls === undefined ? [] : inClass(cls)
      }
    }
    const app = all.filter((d) => d.cls !== 'HANDLERS' && d.cls !== 'BINDINGS')
    if (app.length > 0 && app.length <= 4) {
      onFuzzy(true)
      return app
    }
    return []
  }
}
