/**
 * Generated authorization matrix (verification campaign 2026-10-28, block D).
 *
 *   EXDB_TREE=/path/to/tree bun --conditions=@exponetdb/source gen-matrix.ts [--out DIR]
 *
 * The tree must have `bun install --frozen-lockfile` done (the generator imports its
 * contracts, policy catalog, CLI command table and REST handler table, and parses the
 * application layer with the tree's own `typescript`). Nothing is read by hand: every
 * row comes from ACTIONS, ROUTE_LIST/AUTH_ROUTES, MCP_TOOLS, COMMANDS, SCOPES,
 * BUILT_IN_ROLES, the policy rule catalog, the web sources and the handler call graph.
 * EXPECTED = the contract tables and the documents (parsed, section 3.1/4 of
 * authorization.md and the MCP tool catalog); ACTUAL = the code (handler reachability).
 * Output: authz-matrix.md (compact) and authz-matrix.json (machine readable).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { AstIndex, type AuthCall } from './lib-ast.ts'
import { CREDENTIAL_CLASSES, expectString, type OracleRow, type Variant } from './lib-oracle.ts'
import { sample } from './lib-sample.ts'

const here = dirname(new URL(import.meta.url).pathname)
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const TREE = arg('--tree') ?? process.env['EXDB_TREE'] ?? '/home/david/Development/ExponetDB-verify-d1'
const OUT = arg('--out') ?? here
const imp = (p: string): Promise<any> => import(join(TREE, p))

const c = await imp('packages/contracts/src/index.ts')
const policy = await imp('packages/policy/src/index.ts')
const api = await imp('apps/server/src/interfaces/http/api.ts')
const cli = await imp('apps/cli/src/commands/index.ts')

const ACTIONS: Record<string, any> = c.ACTIONS
const ROUTES: any[] = [...c.AUTH_ROUTES.map((r: any) => ({ ...r, base: '/auth' })), ...c.ROUTE_LIST.map((r: any) => ({ ...r, base: '/api/v1' }))]
const TOOLS: any[] = c.MCP_TOOLS
const SCOPES: Record<string, any> = c.SCOPES
const ROLES: Record<string, any> = c.BUILT_IN_ROLES
const served = new Set<string>(api.servedRoutes().map((s: any) => s.route.operationId))
const ast = new AstIndex(TREE)

// ---------------------------------------------------------------- docs (EXPECTED)
const read = (p: string) => readFileSync(join(TREE, p), 'utf8')
const authzDoc = read('exponetdb-docs/08-auth-and-security/authorization.md')
const toolDoc = read('exponetdb-docs/05-mcp/tool-catalog.md')

const docRoleMatrix = new Map<string, Set<string>>() // role -> permissions (section 3.1)
{
  const header = ['owner', 'admin', 'operator', 'developer', 'viewer', 'auditor']
  const sect = authzDoc.slice(authzDoc.indexOf('### 3.1'), authzDoc.indexOf('**Role bindings**'))
  for (const r of header) docRoleMatrix.set(r, new Set())
  for (const line of sect.split('\n')) {
    const m = /^\| `([a-z_.]+)` \|(.*)\|\s*$/.exec(line)
    if (m?.[1] === undefined || m[2] === undefined) continue
    m[2].split('|').forEach((cell, i) => {
      if (cell.trim() === 'yes') docRoleMatrix.get(header[i] as string)?.add(m[1] as string)
    })
  }
}
const docScopes = new Map<string, { perm: string; mcp: string }>() // section 4 table
{
  const sect = authzDoc.slice(authzDoc.indexOf('## 4. OAuth scopes'), authzDoc.indexOf('**Never grantable'))
  for (const line of sect.split('\n')) {
    const m = /^\| `([a-z_.:]+)` \| (`[a-z_.]+`|\(session-equivalent[^|]*\)) \| ([^|]+) \|/.exec(line)
    if (m?.[1] !== undefined) docScopes.set(m[1], { perm: (m[2] ?? '').replace(/`/g, ''), mcp: (m[3] ?? '').trim() })
  }
}
const docPermissions = new Set<string>()
{
  const sect = authzDoc.slice(authzDoc.indexOf('## 2. Permissions'), authzDoc.indexOf('## 3. Roles'))
  for (const line of sect.split('\n')) {
    const m = /^\| `([a-z_.]+)` \|/.exec(line)
    if (m?.[1] !== undefined) docPermissions.add(m[1])
  }
}
const docTools = new Map<string, { scopes: string[]; wave: string; cell: string }>()
for (const line of toolDoc.split('\n')) {
  const m = /^\| `([a-z_]+)` \| ([^|]*) \|/.exec(line)
  if (m?.[1] === undefined) continue
  const cells = line.split('|').map((x) => x.trim())
  docTools.set(m[1], {
    scopes: [...(m[2] ?? '').matchAll(/`([a-z_.:]+)`/g)].map((x) => x[1] as string),
    wave: cells[cells.length - 2] ?? '',
    cell: (m[2] ?? '').trim(),
  })
}

// ---------------------------------------------------------------- helpers
const permOf = (a: any): string => (a.permission.kind === 'fixed' ? a.permission.permission : a.permission.kind)
function scopeOf(a: any): { np: string; p: string; fixed: string } {
  const s = a.scope
  if (s.kind === 'fixed') return { np: s.scope, p: s.scope, fixed: s.scope }
  if (s.kind === 'tiered') return { np: `${s.permission}:nonprod`, p: `${s.permission}:prod`, fixed: '' }
  return { np: s.kind, p: s.kind, fixed: s.kind }
}
const classOf = (a: any): string =>
  a.class.kind === 'fixed' ? a.class.class : a.class.kind === 'by_tier' ? `${a.class.nonprod}/${a.class.prod}` : 'by_plan'
const callers = (a: any): string => (['web', 'cli', 'mcp', 'ci'] as const).map((k, i) => (a.clientKinds.includes(k) ? 'WCMS'[i] : '.')).join('')
const ID_NAME = /(Id|target|pid|cluster|node|plan|operation|backup|restore|repository|project|product|environment|server|grant|client|identity|finding|bundle|migration|session|query|digest|file)$/i
function idParams(route: any): string[] {
  const out: string[] = []
  const shape = (z: any): string[] => (z?.shape ? Object.keys(z.shape) : [])
  for (const k of shape(route.pathParams)) if (ID_NAME.test(k)) out.push(`path:${k}`)
  for (const k of shape(route.query)) if (ID_NAME.test(k)) out.push(`query:${k}`)
  for (const k of shape(route.body)) if (ID_NAME.test(k)) out.push(`body:${k}`)
  return out
}

// policy rules per kind
const RULES: any[] = [...policy.ACCESS_RULES, ...policy.BACKUP_RULES, ...policy.CONNECTION_RULES, ...policy.DATA_RULES, ...policy.MIGRATION_RULES, ...policy.NODE_RULES, ...policy.REGISTRY_RULES]
const applies = (pattern: string, kind: string) => (pattern.endsWith('.*') ? kind.startsWith(pattern.slice(0, -1)) : pattern === kind)
function policyFor(kind: string): { approval: string[]; reauth: string[]; deny: string[]; warn: string[] } {
  const out = { approval: [] as string[], reauth: [] as string[], deny: [] as string[], warn: [] as string[] }
  for (const r of RULES) {
    if (!r.appliesTo.some((p: string) => applies(p, kind))) continue
    if (r.severity === 'deny') out.deny.push(r.id)
    else if (r.severity === 'warn') out.warn.push(r.id)
    else {
      const reqs = r.requirements(r.defaults) as any[]
      if (reqs.some((q) => q.kind === 'approval')) out.approval.push(r.id)
      if (reqs.some((q) => q.kind === 'reauth')) out.reauth.push(r.id)
    }
  }
  return out
}

// ---------------------------------------------------------------- surfaces
interface Binding { surface: 'rest' | 'auth' | 'mcp'; id: string; http?: string; handlerEvidence: Ev }
interface Ev {
  served: boolean
  authz: 'strong' | 'weak' | 'admit-only' | 'none' | 'n/a'
  hits: string[]
  other: string[]
  subjects: string[]
  fuzzy: boolean
  dynamic: number
  lookupFirst: string[]
}
function evidence(action: string, auths: readonly AuthCall[], mentions: readonly string[], fuzzy: boolean, publicRule: boolean, lookupFirst: readonly string[] = []): Ev {
  const strong = auths.filter((a) => !a.weak)
  const hit = (list: readonly AuthCall[]) => list.filter((a) => a.action === action)
  const full = (list: readonly AuthCall[]) => list.filter((a) => a.fn !== 'admit')
  const sHit = full(hit(strong))
  const wHit = full(hit(auths))
  let authz: Ev['authz'] = 'none'
  if (publicRule) authz = 'n/a'
  else if (sHit.length > 0) authz = 'strong'
  else if (wHit.length > 0) authz = 'weak'
  else if (hit(auths).length > 0) authz = 'admit-only'
  else if (auths.some((a) => a.action === null && a.fn !== 'admit')) authz = 'weak'
  else if (mentions.includes(action) && auths.length > 0) authz = 'weak'
  return {
    served: true,
    authz,
    hits: [...new Set(hit(auths).map((a) => a.fn))],
    other: [...new Set(auths.filter((a) => a.action !== null && a.action !== action).map((a) => a.action as string))].sort(),
    subjects: [...new Set(hit(auths).map((a) => a.subject))],
    fuzzy,
    dynamic: auths.filter((a) => a.action === null).length,
    lookupFirst: [...lookupFirst],
  }
}

const rest: any[] = []
for (const r of ROUTES) {
  const a = ACTIONS[r.action]
  const isServed = served.has(r.operationId)
  const entry = ast.entry('HANDLERS', r.operationId)
  let ev: Ev = { served: isServed, authz: 'none', hits: [], other: [], subjects: [], fuzzy: false, dynamic: 0, lookupFirst: [] }
  if (isServed && entry !== undefined) {
    const reach = ast.reach(entry)
    ev = { ...evidence(r.action, reach.auths, reach.mentions, reach.fuzzy, a.permission.kind === 'public' || a.permission.kind === 'protocol', reach.lookupFirst), served: true }
  }
  rest.push({ ...r, ev, ids: idParams(r), a })
}

const mcp: any[] = []
for (const t of TOOLS) {
  const a = ACTIONS[t.action]
  const entry = ast.entry('BINDINGS', t.name)
  let ev: Ev = { served: t.status === 'served', authz: 'none', hits: [], other: [], subjects: [], fuzzy: false, dynamic: 0, lookupFirst: [] }
  if (entry !== undefined) {
    const reach = ast.reach(entry)
    ev = { ...evidence(t.action, reach.auths, reach.mentions, reach.fuzzy, false, reach.lookupFirst), served: t.status === 'served' }
  }
  mcp.push({ t, a, ev })
}

// CLI commands
const knownOps = new Set<string>(ROUTES.map((r) => r.operationId))
const cmds = (cli.COMMANDS as any[]).map((cmd) => {
  const src = (() => { try { return String(cmd.run) } catch { return '' } })()
  const ops = new Set<string>()
  for (const m of src.matchAll(/\.call\(\s*['"`]([A-Za-z]+)['"`]/g)) if (knownOps.has(m[1] as string)) ops.add(m[1] as string)
  if (typeof cmd.operation === 'string' && knownOps.has(cmd.operation)) ops.add(cmd.operation)
  return { name: (cmd.path as string[]).join(' '), action: cmd.action as string | undefined, scopes: (cmd.scopes ?? []) as string[], effect: cmd.effect as string, locality: cmd.locality as string, ops: [...ops].sort() }
})

// Web App: every operation id named in the web sources, by feature
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(p) && !/\.(test|spec)\./.test(p)) out.push(p)
  }
  return out
}
const webOps = new Map<string, Set<string>>() // operationId -> features
for (const f of walk(join(TREE, 'apps/web/src'))) {
  const rel = relative(join(TREE, 'apps/web/src'), f)
  const feature = rel.split('/')[0] === 'features' ? (rel.split('/')[1] ?? 'features') : rel.split('/')[0] === 'routes' ? 'routes' : (rel.split('/')[0] ?? '?')
  for (const m of readFileSync(f, 'utf8').matchAll(/['"`]([A-Za-z]+)['"`]/g)) {
    if (knownOps.has(m[1] as string)) {
      const s = webOps.get(m[1] as string) ?? new Set()
      s.add(feature)
      webOps.set(m[1] as string, s)
    }
  }
}
const webPages = walk(join(TREE, 'apps/web/src/routes')).length

// ---------------------------------------------------------------- per-action rows
const routeByAction = new Map<string, any[]>()
for (const r of rest) routeByAction.set(r.action, [...(routeByAction.get(r.action) ?? []), r])
const toolByAction = new Map<string, any[]>()
for (const m of mcp) toolByAction.set(m.t.action, [...(toolByAction.get(m.t.action) ?? []), m])
const cmdByAction = new Map<string, any[]>()
for (const cmd of cmds) {
  const acts = new Set<string>()
  if (cmd.action !== undefined) acts.add(cmd.action)
  for (const op of cmd.ops) acts.add(rest.find((r) => r.operationId === op)?.action)
  for (const act of acts) if (act !== undefined) cmdByAction.set(act, [...(cmdByAction.get(act) ?? []), cmd])
}
const webByAction = new Map<string, string[]>()
for (const [op, feats] of webOps) {
  const act = rest.find((r) => r.operationId === op)?.action
  if (act !== undefined) webByAction.set(act, [...(webByAction.get(act) ?? []), ...[...feats].map((f) => `${op}@${f}`)])
}
const tables = {
  roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]: [string, any]) => [k, { permissions: v.permissions }])),
  scopes: SCOPES as any,
}
const rows: any[] = []
for (const id of Object.keys(ACTIONS)) {
  const a = ACTIONS[id]
  const sc = scopeOf(a)
  const pol = policyFor(id)
  const rs = routeByAction.get(id) ?? []
  const ts = toolByAction.get(id) ?? []
  const row = {
    action: id,
    effect: a.effect,
    mechanism: a.mechanism,
    class: classOf(a),
    permission: permOf(a),
    scopeNonprod: sc.np,
    scopeProd: sc.p,
    tierSemantics: a.tierSemantics,
    humanOnly: a.humanOnly,
    reauthSeconds: a.reauthentication ? a.reauthWithinSeconds : null,
    verification: a.verification,
    operationKind: a.operationKind,
    clientKinds: a.clientKinds,
    policy: pol,
    rest: rs.map((r) => ({ op: r.operationId, http: `${r.method.toUpperCase()} ${r.base}${r.path}`, served: r.ev.served, authz: r.ev.authz, subjects: r.ev.subjects, ids: r.ids })),
    mcp: ts.map((m) => ({ tool: m.t.name, version: m.t.toolVersion, status: m.t.status, authz: m.ev.authz, rate: m.t.rateClass })),
    cli: (cmdByAction.get(id) ?? []).map((x) => x.name),
    web: webByAction.get(id) ?? [],
    exp: {} as Record<string, string>,
  }
  const variants: Variant[] = a.subject === 'target' || a.scope.kind === 'tiered' ? ['nonprod', 'prod'] : ['none']
  const oracleBase = { permission: a.permission, scope: a.scope, clientKinds: a.clientKinds, humanOnly: a.humanOnly, reauth: a.reauthentication, subject: a.subject, tierSemantics: a.tierSemantics, variants }
  const restExp = rs.length > 0 ? expectString({ ...oracleBase, surface: 'rest' } as OracleRow, tables) : undefined
  const mcpExp = ts.length > 0 ? expectString({ ...oracleBase, surface: 'mcp' } as OracleRow, tables) : undefined
  for (const k of Object.keys(CREDENTIAL_CLASSES)) {
    const cls = CREDENTIAL_CLASSES[k]!
    row.exp[k] = (cls.client === 'mcp' ? mcpExp : restExp)?.[k] ?? ''
  }
  rows.push(row)
}

// ---------------------------------------------------------------- discrepancies
interface Disc { kind: string; where: string; detail: string }
const D: Disc[] = []
const add = (kind: string, where: string, detail: string) => D.push({ kind, where, detail })

// R1 contract routes without handler (not served)
for (const r of rest) if (!r.ev.served) add('route-not-served', r.operationId, `${r.method.toUpperCase()} ${r.base}${r.path} (${r.action}) has no handler`)
// R2 served routes with no / weak / admit-only authz evidence
for (const r of rest) {
  if (!r.ev.served) continue
  if (r.ev.authz === 'none') add('no-authz-reached', r.operationId, `${r.action}: no authorize/admit/plan/inline call reached from the handler`)
  else if (r.ev.authz === 'weak') add('authz-weak-evidence', r.operationId, `${r.action}: evidence only through a fuzzy hop or a dynamic action (${r.ev.dynamic} dynamic call(s))`)
  else if (r.ev.authz === 'admit-only') add('authz-admit-only', r.operationId, `${r.action}: only phase 1 (admit) reached for this action; list filtering by visibility is expected, anything else is a gap`)
}
// R2b lookup of a stored object before the engine is asked (error-model.md section 4: admit first, then look up)
for (const r of rest) if (r.ev.served && r.ev.lookupFirst.length > 0 && r.ev.authz !== 'n/a') add('lookup-before-authz', r.operationId, `${r.action}: ${r.ev.lookupFirst.join(', ')} runs before the first authorize/admit (existence of the id is visible to a caller without access: NOT_FOUND vs PERMISSION_DENIED)`)
// R3 same for MCP tools
for (const m of mcp) {
  if (!m.ev.served) continue
  if (m.ev.authz === 'none') add('no-authz-reached', `mcp:${m.t.name}`, `${m.t.action}: no authorize reached from the binding`)
  else if (m.ev.authz === 'weak') add('authz-weak-evidence', `mcp:${m.t.name}`, `${m.t.action}: weak evidence`)
  else if (m.ev.authz === 'admit-only') add('authz-admit-only', `mcp:${m.t.name}`, `${m.t.action}: only phase 1 reached`)
}
// R4 MCP tool vs REST route pairs
for (const m of mcp) {
  const r = rest.find((x) => x.operationId === m.t.restOperationId)
  if (r === undefined) add('pair-mcp-rest', `mcp:${m.t.name}`, `restOperationId ${m.t.restOperationId} does not exist`)
  else if (r.action !== m.t.action) add('pair-mcp-rest', `mcp:${m.t.name}`, `tool action ${m.t.action} != route action ${r.action}`)
  if (!m.a.clientKinds.includes('mcp')) add('pair-mcp-clientkind', `mcp:${m.t.name}`, `action ${m.t.action} does not admit client kind mcp`)
  const needed = [scopeOf(m.a).np, scopeOf(m.a).p].filter((s) => s !== 'none' && s !== 'read_of_kind' && s !== 'of_plan_kind')
  for (const s of needed) if (SCOPES[s] !== undefined && !SCOPES[s].mcpGrantable) add('pair-mcp-scope', `mcp:${m.t.name}`, `requires scope ${s}, which is not MCP-grantable`)
  const ro = m.t.annotations.readOnlyHint
  if (ro !== (m.a.effect === 'read')) add('pair-mcp-annotation', `mcp:${m.t.name}`, `readOnlyHint=${ro} but action effect=${m.a.effect}`)
  if (m.a.humanOnly) add('pair-mcp-humanonly', `mcp:${m.t.name}`, `action ${m.t.action} is humanOnly yet bound to an MCP tool`)
  if (m.a.permission.kind === 'fixed' && ['plans.approve', 'breakglass.activate', 'registry.manage', 'access.manage', 'policy.manage', 'restore.execute', 'operations.recover', 'data.read_sensitive', 'diagnostics.read_sensitive', 'migrations.import', 'schema.manage'].includes(m.a.permission.permission)) add('pair-mcp-ineligible-permission', `mcp:${m.t.name}`, `uses MCP-ineligible permission ${m.a.permission.permission}`)
  const doc = docTools.get(m.t.name)
  if (doc === undefined) add('doc-tool-missing', `mcp:${m.t.name}`, 'tool is in the contract but not in tool-catalog.md')
  else {
    const want = [...new Set(needed)]
    const base = (s: string) => s.replace(/:(nonprod|prod)$/, '')
    const docBases = new Set(doc.scopes.map(base))
    if (!/^as /.test(doc.cell)) for (const s of want) if (!docBases.has(base(s)) && docBases.size > 0) add('doc-tool-scope', `mcp:${m.t.name}`, `code scope ${s} vs doc scopes [${doc.scopes.join(', ')}]`)
    if (/served/.test(doc.wave) !== (m.t.status === 'served') && !/no contract/.test(doc.wave)) add('doc-tool-status', `mcp:${m.t.name}`, `doc wave "${doc.wave}" vs code status ${m.t.status}`)
  }
}
for (const name of docTools.keys()) if (!TOOLS.some((t) => t.name === name) && /served|planned|no contract/.test(docTools.get(name)!.wave) && !/no contract|not offered/.test(docTools.get(name)!.wave)) add('doc-tool-orphan', `doc:${name}`, `tool-catalog.md names ${name} (${docTools.get(name)!.wave}); no contract`)
// R5 actions without any surface
for (const r of rows) {
  const surfaces = r.rest.length + r.mcp.length + r.cli.length + r.web.length
  const viaPlan = r.operationKind && (rows.some((x) => x.action === `${r.action}.plan`) || r.action === 'migration.apply' || r.action === 'migration.rollback' || r.action === 'migration.resume' || r.action === 'backup.run' || r.action === 'restore.drill' || r.action === 'restore.execute' || r.action.startsWith('postgres.') || r.action === 'packages.apply_update')
  if (surfaces === 0 && !r.action.startsWith('oauth.') && !viaPlan) add('action-no-surface', r.action, `no REST route, MCP tool, CLI command or Web call (operationKind=${r.operationKind})`)
  if (r.rest.length === 0 && r.operationKind && !viaPlan && r.mechanism !== 'plan_apply') add('action-kind-no-planner', r.action, 'operation kind without a ".plan" action or a known planner route')
}
// R6 mutations outside plan -> apply -> verify
for (const r of rows) {
  const a = ACTIONS[r.action]
  if (a.effect === 'consequential' && a.mechanism === 'inline_plan') add('mutation-inline', r.action, `consequential, inline plan (class ${r.class}); documented exception for class low (operations-engine.md section 1); verification=${a.verification}`)
  if (a.effect === 'consequential' && a.mechanism === 'none') add('mutation-no-mechanism', r.action, 'consequential but mechanism none')
  if (a.effect === 'consequential' && a.verification !== 'required') add('mutation-no-verification', r.action, 'consequential without verification=required (C-13)')
  if (a.effect === 'control_record' && (r.action.startsWith('breakglass') || r.action.startsWith('approval.') || r.action.startsWith('oauth.client.') || r.action.startsWith('restore.drill.offline'))) add('control-record-security-state', r.action, `control_record with security meaning (${r.action}); no plan/apply`)
}
// R7 re-authentication: declared vs reachable phase 2
for (const r of rows) {
  const a = ACTIONS[r.action]
  if (a.reauthentication) {
    for (const x of r.rest) if (x.served && x.authz !== 'strong' && x.authz !== 'n/a') add('reauth-declared-not-proven', x.op, `${r.action} declares re-auth (${r.reauthSeconds}s) but only ${x.authz} evidence of the full (phase 2) authorize`)
  }
  if (a.humanOnly && a.effect === 'consequential' && !a.reauthentication && a.permission.kind === 'fixed') add('humanonly-consequential-no-reauth', r.action, `human-only consequential action without re-authentication (policy may add one: ${r.policy.reauth.join(', ') || 'none'})`)
}
// R8 tier handling
for (const r of rows) {
  const a = ACTIONS[r.action]
  if (a.scope.kind === 'tiered' && a.tierSemantics === 'none') add('tier-scope-without-semantics', r.action, 'tiered scope but tierSemantics none')
  if (a.effect !== 'read' && a.subject === 'target' && a.scope.kind !== 'tiered' && !['subject', 'cluster_registry', 'production', 'placement'].includes(a.tierSemantics)) add('tier-target-mutation-untiered', r.action, `target mutation with scope ${scopeOf(a).fixed} and tierSemantics ${a.tierSemantics}`)
}
// R9 agent reach of production changes
const agentProd: any[] = []
for (const r of rows) {
  const a = ACTIONS[r.action]
  const mcpReach = a.clientKinds.includes('mcp') && !a.humanOnly
  const ciReach = a.clientKinds.includes('ci') && !a.humanOnly
  if (!(mcpReach || ciReach) || a.effect === 'read') continue
  const prodScope = r.scopeProd !== r.scopeNonprod || a.tierSemantics !== 'none'
  agentProd.push({ action: r.action, effect: a.effect, class: r.class, mcp: mcpReach, ci: ciReach, tier: r.tierSemantics, approval: r.policy.approval, deny: r.policy.deny, prodScope })
  if (a.effect === 'consequential' && r.policy.approval.length === 0 && r.policy.deny.length === 0) add('agent-consequential-no-policy-rule', r.action, `reachable by agent/ci, consequential, no policy rule requires approval or denies (class ${r.class})`)
}
// R10 code vs docs: roles, scopes, permissions
for (const [role, perms] of docRoleMatrix) {
  const code = new Set<string>(ROLES[role]?.permissions ?? [])
  for (const p of perms) if (!code.has(p)) add('doc-role', `role:${role}`, `doc grants ${p}, code does not`)
  for (const p of code) if (!perms.has(p)) add('doc-role', `role:${role}`, `code grants ${p}, doc does not`)
}
for (const [s, d] of docScopes) {
  const def = SCOPES[s]
  if (def === undefined) { add('doc-scope', `scope:${s}`, 'in doc table, not in SCOPES'); continue }
  if (d.perm !== 'session-equivalent for first-party Web App' && !d.perm.startsWith('(session') && d.perm !== def.permission) add('doc-scope', `scope:${s}`, `doc permission ${d.perm} vs code ${def.permission}`)
  const docMcp = /^yes/.test(d.mcp)
  if (docMcp !== def.mcpGrantable) add('doc-scope', `scope:${s}`, `doc MCP-grantable "${d.mcp}" vs code ${def.mcpGrantable}`)
}
for (const s of Object.keys(SCOPES)) if (!docScopes.has(s) && !['access.read', 'registry.manage', 'access.manage', 'policy.manage', 'restore.execute', 'plans.approve', 'operations.recover', 'breakglass.activate', 'diagnostics.read_sensitive', 'data.read_sensitive', 'migrations.import', 'schema.manage'].includes(s)) add('doc-scope', `scope:${s}`, 'in SCOPES, not in the doc table')
for (const p of docPermissions) if (c.PERMISSIONS[p] === undefined) add('doc-permission', p, 'in doc, not in PERMISSIONS')
for (const p of Object.keys(c.PERMISSIONS)) if (!docPermissions.has(p)) add('doc-permission', p, 'in PERMISSIONS, not in doc')
// R11 CLI vs action (the declared scopes drive help and the agent reference; the server decides)
for (const cmd of cmds) {
  if (cmd.locality !== 'remote' || cmd.action === undefined) continue
  const a = ACTIONS[cmd.action]
  if (a === undefined) { add('cli-unknown-action', cmd.name, `declares action ${cmd.action}`); continue }
  const base = (x: string) => x.replace(/:(nonprod|prod)$/, '')
  const sc = scopeOf(a)
  const need = a.scope.kind === 'fixed' ? [sc.fixed] : a.scope.kind === 'tiered' ? [base(sc.np)] : []
  const declared = cmd.scopes.map(base)
  for (const n of need) if (!declared.includes(base(n))) add('cli-scope-mismatch', cmd.name, `declares [${cmd.scopes.join(', ')}]; action ${cmd.action} needs ${n}`)
  if (!a.clientKinds.includes('cli')) add('cli-action-not-for-cli', cmd.name, `${cmd.action} admits ${a.clientKinds.join(',')} only`)
  if (cmd.effect === 'read' && a.effect === 'consequential') add('cli-effect', cmd.name, `declared read but ${cmd.action} is consequential`)
  if (cmd.effect === 'mutation' && a.effect === 'read') add('cli-effect', cmd.name, `declared mutation but ${cmd.action} is a read`)
}
// R12 web calls
for (const [op, feats] of webOps) {
  const r = rest.find((x) => x.operationId === op)
  if (r === undefined) continue
  if (!r.a.clientKinds.includes('web')) add('web-calls-non-web-action', op, `Web App (${[...feats].join(',')}) calls ${r.action}, which does not admit client kind web`)
  if (!r.ev.served) add('web-calls-unserved', op, `Web App (${[...feats].join(',')}) names ${op}; no handler`)
}

// valid-shaped request samples for run-matrix.ts (ids are placeholders `@id:xxx`)
const js = (z: any) => (z === undefined ? undefined : c.contractJsonSchema(z, { io: 'input' }))
const samples = {
  schema: 'exponetdb.authz-samples/v1',
  rest: Object.fromEntries(rest.map((r) => [r.operationId, {
    method: r.method.toUpperCase(), path: `${r.base}${r.path}`, action: r.action,
    params: sample(js(r.pathParams)) ?? null,
    query: r.query === undefined ? {} : (sample(js(r.query)) ?? null),
    body: r.rawBody !== undefined ? 'raw' : r.body === undefined ? undefined : (sample(js(r.body)) ?? null),
  }])),
  mcp: Object.fromEntries(mcp.map((m) => [m.t.name, { action: m.t.action, args: sample(js(m.t.input)) ?? null }])),
}
writeFileSync(join(OUT, 'authz-samples.json'), JSON.stringify(samples))
const sampled = Object.values(samples.rest).filter((x: any) => x.params !== null && x.query !== null && x.body !== null).length

// ---------------------------------------------------------------- output

// MCP output text: which string fields are marked untrusted, which free strings are not
function textFields(schema: any): { marked: string[]; unmarked: string[] } {
  const out = { marked: [] as string[], unmarked: [] as string[] }
  const defs = schema.$defs ?? {}
  const walk = (s: any, path: string, stack: string[], depth: number): void => {
    if (!s || typeof s !== 'object' || depth > 14) return
    if (s.untrusted === true) {
      out.marked.push(path)
      return
    }
    if (s.$ref) {
      const n = String(s.$ref).replace('#/$defs/', '')
      if (!stack.includes(n)) walk(defs[n], path, [...stack, n], depth + 1)
      return
    }
    if (s.type === 'string' || (Array.isArray(s.type) && s.type.includes('string'))) {
      const free = !s.enum && !s.const && !s.pattern && !(s.format && s.format !== 'uri-reference')
      if (s.untrusted === true) out.marked.push(path)
      else if (free) out.unmarked.push(path)
    }
    for (const [k, v] of Object.entries<any>(s.properties ?? {})) walk(v, `${path}.${k}`, stack, depth + 1)
    if (s.items) walk(s.items, `${path}[]`, stack, depth + 1)
    for (const k of ['anyOf', 'oneOf', 'allOf']) for (const x of s[k] ?? []) walk(x, path, stack, depth + 1)
    if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, `${path}{}`, stack, depth + 1)
  }
  walk(schema, '', [], 0)
  return out
}
const mcpText = mcp.map((m) => ({ tool: m.t.name, ...textFields(c.contractJsonSchema(m.t.output, { io: 'output' })), openWorld: m.t.annotations.openWorldHint }))
for (const x of mcpText) {
  const nonSystem = x.unmarked.filter((p) => !/\.(state|waitEvent\.type|waitEvent\.event|lockMode|nextCursor|lsn|fromLsn|toLsn|actor\.label)$|\.lsn$|Lsn$/.test(p))
  if (nonSystem.length > 0) add('mcp-unmarked-free-text', `mcp:${x.tool}`, `openWorldHint=${x.openWorld}; free strings not marked untrusted: ${nonSystem.slice(0, 8).join(' ')}${nonSystem.length > 8 ? ' ...' : ''}`)
}

const counts: Record<string, number> = {}
for (const d of D) counts[d.kind] = (counts[d.kind] ?? 0) + 1
const restServed = rest.filter((r) => r.ev.served)
const summary = {
  tree: relative(process.cwd(), TREE) || TREE,
  actions: rows.length,
  restRoutes: rest.length,
  restServed: restServed.length,
  authCeremonyRoutes: rest.filter((r) => r.base === '/auth').length,
  mcpTools: mcp.length,
  mcpServed: mcp.filter((m) => m.ev.served).length,
  samplesComplete: `${sampled}/${rest.length}`,
  cliCommands: cmds.length,
  cliRemote: cmds.filter((x) => x.locality === 'remote').length,
  webPages,
  webOperations: webOps.size,
  docParsed: { roles: [...docRoleMatrix].map(([k, v]) => `${k}:${v.size}`).join(' '), scopes: docScopes.size, permissions: docPermissions.size, tools: docTools.size },
  authzEvidence: Object.fromEntries(['strong', 'weak', 'admit-only', 'none', 'n/a'].map((k) => [k, restServed.filter((r) => r.ev.authz === k).length])),
  discrepancyCounts: counts,
}
const json = {
  schema: 'exponetdb.authz-matrix/v1',
  summary,
  credentialClasses: CREDENTIAL_CLASSES,
  expectLegend: 'one char per subject tier variant (nonprod,prod; one char when the row has no tier variant): A authorization passes, D authorization refuses, N not decidable statically',
  rows: rows.map((r) => ({
    action: r.action, perm: r.permission, scope: r.scopeNonprod === r.scopeProd ? r.scopeNonprod : `${r.scopeNonprod}|${r.scopeProd}`,
    tier: r.tierSemantics, class: r.class, effect: r.effect, mech: r.mechanism, human: r.humanOnly, reauth: r.reauthSeconds,
    callers: r.clientKinds, policy: r.policy, rest: r.rest.map((x: any) => ({ op: x.op, http: x.http, served: x.served, authz: x.authz, subj: x.subjects, ids: x.ids })),
    mcp: r.mcp, cli: r.cli, web: r.web, exp: r.exp,
  })),
  discrepancies: D,
  agentReachable: agentProd,
}
writeFileSync(join(OUT, 'authz-matrix.json'), JSON.stringify(json, (_k, v) => (Array.isArray(v) && v.length === 0) || v === false || v === null || v === '' ? undefined : v))

const md: string[] = []
const P = (s = '') => md.push(s)
P('# Authorization matrix (generated)')
P()
P(`Generated by \`gen-matrix.ts\` from the tree at \`${basenameOf(TREE)}\` (commit under test d51da5d0). Do not edit; re-run the generator. EXPECTED = contract tables and documents; ACTUAL = handler call graph (static). Counts: ${summary.actions} actions, ${summary.restRoutes} REST routes (${summary.restServed} served), ${summary.mcpTools} MCP tools (${summary.mcpServed} served), ${summary.cliCommands} CLI commands (${summary.cliRemote} remote), ${summary.webPages} Web App route files, ${summary.webOperations} REST operations named in the Web App.`)
P()
P('## 1. Reading the tables')
P()
P('- **Callers** `WCMS`: client kinds the action admits (W web session, C first-party CLI, M MCP client, S service account/CI); a REST route is reachable by W, C, S only (an MCP grant never holds the REST audience), `/mcp` by M only.')
P('- **Scope** `np|p`: the OAuth scope at tier nonprod / prod (one value = untiered). **Tier** = tierSemantics (subject = the subject target/plan tier; production/cluster_registry/placement = registry.manage tiers, authorization.md 5.1).')
P('- **H** human-only; **R** re-authentication window in seconds; **Pol**: policy rules that apply to the kind (AP = requires approval, DN = denies, RA = requires re-auth, WN = warns).')
P('- **Ev** (code evidence for the REST handler): `S` the action id reaches a full authorize (phase 1+2) / plan / inline call; `w` only through a fuzzy hop or dynamic id; `a` phase 1 only (list filtered by visibility); `-` nothing reached; `.` public/protocol (own proof).')
P('- **Exp** (expected, 8 credential classes `owner admin dev-np dev-prod viewer svc narrow mcp`): per class, `A` allow / `D` deny at authorization, one char per tier (nonprod,prod) where the subject has a tier. `N` = not decidable statically. Defined in `lib-oracle.ts`.')
P()
P('## 2. Summary of discrepancies')
P()
P('| Kind | Count |')
P('|---|---:|')
for (const [k, n] of Object.entries(counts).sort()) P(`| ${k} | ${n} |`)
P()
P('REST handler evidence: ' + Object.entries(summary.authzEvidence).map(([k, n]) => `${k}=${n}`).join(', '))
P()
P('## 3. One row per action')
P()
P('`rest` = operation ids (see json for method/path), `mcp` = tool@version, `cli` = commands (first 2), `web` = number of web call sites.')
P()
P('| Action | Eff/Mech/Class | Perm | Scope np/p | Tier | H | R | Pol | WCMS | Ev | rest | mcp | cli | web | Exp o a dn dp v s n m |')
P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
const ab = (p: any) => [p.approval.length ? 'AP' : '', p.deny.length ? 'DN' : '', p.reauth.length ? 'RA' : '', p.warn.length ? 'WN' : ''].filter(Boolean).join('+') || '-'
const evChar = (r: any) => (r.rest.length === 0 ? '' : r.rest.map((x: any) => (x.served ? ({ strong: 'S', weak: 'w', 'admit-only': 'a', none: '-', 'n/a': '.' } as any)[x.authz] : 'x')).join(''))
for (const r of rows) {
  const scope = r.scopeNonprod === r.scopeProd ? r.scopeNonprod : `${r.scopeNonprod.replace(/^.*:/, '')}/${r.scopeProd.replace(/^.*:/, '')} ${r.scopeNonprod.replace(/:.*$/, '')}`
  const exp = Object.keys(CREDENTIAL_CLASSES).map((k) => r.exp[k] || '-').join(' ')
  P(`| ${r.action} | ${r.effect[0]}/${r.mechanism === 'stored_plan' ? 'sp' : r.mechanism === 'inline_plan' ? 'ip' : r.mechanism === 'plan_apply' ? 'pa' : '-'}/${r.class} | ${r.permission} | ${scope} | ${r.tierSemantics === 'none' ? '' : r.tierSemantics} | ${r.humanOnly ? 'H' : ''} | ${r.reauthSeconds ?? ''} | ${ab(r.policy)} | ${callers({ clientKinds: r.clientKinds })} | ${evChar(r)} | ${r.rest.map((x: any) => x.op).join(' ')} | ${r.mcp.map((m: any) => `${m.tool}@${m.version}${m.status === 'served' ? '' : '(planned)'}`).join(' ')} | ${r.cli.slice(0, 2).join(' ; ')}${r.cli.length > 2 ? ' +' + (r.cli.length - 2) : ''} | ${r.web.length || ''} | ${exp} |`)
}
P()
P('## 4. Discrepancies (full list, grouped)')
const byKind = new Map<string, Disc[]>()
for (const d of D) byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), d])
for (const [k, list] of [...byKind].sort()) {
  P()
  P(`### ${k} (${list.length})`)
  P()
  for (const d of list.slice(0, 40)) P(`- \`${d.where}\`: ${d.detail}`)
  if (list.length > 40) P(`- ... ${list.length - 40} more (see authz-matrix.json)`)
}
P()
P('## 5. Agent- and CI-reachable mutations (production handling)')
P()
P('Actions with effect other than read that the MCP endpoint (M) or a service account (S) can reach. `AP` rules require a human approval; `DN` deny. A production change by an agent must show an AP or DN entry or be human-gated by scope/tier.')
P()
P('| Action | Eff | Class | M | S | Tier | Approval rules | Deny rules |')
P('|---|---|---|---|---|---|---|---|')
for (const x of agentProd) P(`| ${x.action} | ${x.effect[0]} | ${x.class} | ${x.mcp ? 'M' : ''} | ${x.ci ? 'S' : ''} | ${x.tier === 'none' ? '' : x.tier} | ${x.approval.join(', ')} | ${x.deny.join(', ')} |`)
P()
P('## 6. Web App: REST operations named per feature')
P()
const byFeature = new Map<string, string[]>()
for (const [op, feats] of webOps) for (const f of feats) byFeature.set(f, [...(byFeature.get(f) ?? []), op])
P('| Feature | Operations |')
P('|---|---|')
for (const [f, ops] of [...byFeature].sort()) P(`| ${f} | ${ops.sort().join(' ')} |`)
P()
P('## 7. Endpoints outside the contract list (hand-mounted)')
P()
P('| Endpoint | Auth | Source |')
P('|---|---|---|')
for (const e of [
  ['GET /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource/{api,mcp}', 'public metadata (oauth.metadata.get, protocol rule)', 'interfaces/http/oauth.ts'],
  ['GET /oauth/authorize, POST /oauth/token, /oauth/device_authorization, /oauth/register, /oauth/revoke', 'protocol: own proof (PKCE, client assertion, refresh token, device code)', 'interfaces/http/oauth.ts'],
  ['ALL /mcp', 'bearer, audience mcp; each tool call authorizes in the use case', 'interfaces/mcp/edge.ts'],
  ['GET /healthz/live, /healthz/ready, /api/v1/openapi.json, schema documents', 'unauthenticated by design (no data)', 'interfaces/http/app.ts'],
  ['GET /healthz/detail, /metrics (internal listener)', 'unauthenticated; internal listener only (network placement is the control)', 'interfaces/http/app.ts'],
  ['GET /assets/*, SPA pages', 'static', 'interfaces/http/web.ts'],
]) P(`| ${e[0]} | ${e[1]} | ${e[2]} |`)
P()
P('## 8. MCP tools: foreign text in results (agent safety, see agent-safety.md)')
P()
P('`untrusted` = string fields the output schema marks untrusted (database, catalog or caller text); `unmarked` = free strings (no enum/pattern/format) it does not mark; `OW` = openWorldHint. Server-made prose (rule messages) is listed as unmarked on purpose: the question is whether a field can quote foreign text.')
P()
P('| Tool | v | Action | Eff | Scope np/p | Rate | OW | untrusted | unmarked free strings |')
P('|---|---|---|---|---|---|---|---:|---|')
for (const m of mcp) {
  const tf = mcpText.find((x) => x.tool === m.t.name)!
  const sc = scopeOf(m.a)
  P(`| ${m.t.name} | ${m.t.toolVersion} | ${m.t.action} | ${m.a.effect[0]} | ${sc.np === sc.p ? sc.np : `${sc.np.replace(/^.*:/, '')}/${sc.p.replace(/^.*:/, '')} ${sc.np.replace(/:.*$/, '')}`} | ${m.t.rateClass} | ${m.t.annotations.openWorldHint ? 'Y' : ''} | ${tf.marked.length} | ${tf.unmarked.slice(0, 6).join(' ')}${tf.unmarked.length > 6 ? ' ...' : ''} |`)
}
writeFileSync(join(OUT, 'authz-matrix.md'), md.join('\n') + '\n')
console.log(JSON.stringify(summary, null, 1))
console.log(`wrote ${md.length} lines of authz-matrix.md`)

function basenameOf(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}
