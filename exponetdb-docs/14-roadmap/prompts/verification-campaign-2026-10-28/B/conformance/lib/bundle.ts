// Helpers shared by the B2 conformance tests: build bundles as plain bytes, lint them, hash them.
import { type BundleInput, validateBundle } from '@exponetdb/migrations/format'
import { lintBundles, type LintContext, type LintReport } from '@exponetdb/migrations/lint'
import type { ProjectConfig } from '@exponetdb/contracts'

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Crockford base32 alphabet of ULIDs. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A valid ULID from a number (deterministic): the first character stays within 0..7. */
export function ulidOf(n: number): string {
  let s = ''
  let v = n
  for (let i = 0; i < 12; i++) {
    s = CROCKFORD[v % 32] + s
    v = Math.floor(v / 32)
  }
  return `01JB2Z6G8M4Q${s.padStart(14, '0').slice(-14)}`
}

export const PROJECT_DEFAULTS = {
  lockTimeout: '5s',
  statementTimeout: '15m',
  role: 'owner',
  searchPath: ['public'],
}

export interface Spec {
  id?: string
  name?: string
  /** exact bytes of up.sql (string is UTF-8 encoded) */
  up?: string | Uint8Array
  verify?: string | Uint8Array | null
  down?: string | Uint8Array | null
  dependsOn?: readonly string[]
  transactional?: boolean
  declared?: string
  description?: string
  /** replaces the whole migration.yaml (exact text) */
  yaml?: string | Uint8Array
  /** extra lines appended to the yaml (after the generated lines) */
  extraYaml?: string
  /** override of the execution block lines, e.g. ['  lockTimeout: 10s'] */
  executionExtra?: readonly string[]
  newline?: '\n' | '\r\n'
}

export function manifestYaml(spec: Spec, id: string, name: string): string {
  const nl = spec.newline ?? '\n'
  const lines = [
    'schema: exponetdb.migration/v1',
    `id: ${id}`,
    `name: ${name}`,
    `description: ${JSON.stringify(spec.description ?? 'A change of the conformance suite.')}`,
    `dependsOn: ${JSON.stringify(spec.dependsOn ?? [])}`,
    'execution:',
    `  transactional: ${spec.transactional ?? true}`,
    ...(spec.executionExtra ?? []),
    'compatibility:',
    `  declared: ${spec.declared ?? 'additive'}`,
    ...(spec.declared !== undefined && spec.declared !== 'additive' ? ['  notes: reviewed'] : []),
    'verification:',
    '  expectations: auto',
    `  runtimeChecks: ${spec.verify === undefined || spec.verify === null ? 'none' : 'verify.sql'}`,
    ...(spec.down === undefined || spec.down === null
      ? []
      : ['rollback:', '  script: down.sql', '  safety: safe', '  notes: reviewed']),
    ...(spec.extraYaml === undefined ? [] : [spec.extraYaml]),
    '',
  ]
  return lines.join(nl)
}

export function mk(spec: Spec = {}): BundleInput {
  const id = spec.id ?? ulidOf(1)
  const name = spec.name ?? 'change'
  const files = new Map<string, Uint8Array>()
  const b = (v: string | Uint8Array): Uint8Array => (typeof v === 'string' ? enc(v) : v)
  files.set('migration.yaml', b(spec.yaml ?? manifestYaml(spec, id, name)))
  files.set('up.sql', b(spec.up ?? 'CREATE TABLE public.t (id int);\n'))
  if (spec.verify !== undefined && spec.verify !== null) files.set('verify.sql', b(spec.verify))
  if (spec.down !== undefined && spec.down !== null) files.set('down.sql', b(spec.down))
  return { directory: `${id}_${name}`, files, projectDefaults: PROJECT_DEFAULTS }
}

/** The digests of a bundle, or the refusal. */
export function digestsOf(spec: Spec | BundleInput) {
  const input = 'files' in spec ? spec : mk(spec)
  const r = validateBundle(input)
  return r
}

export const PROJECT: ProjectConfig = {
  schema: 'exponetdb.project/v1',
  project: 'conformance/project',
  layout: 'bundles',
  defaults: PROJECT_DEFAULTS,
  executionRoles: { owner: 'conformance_owner' },
  managedScope: { includeSchemas: ['public'], excludeSchemas: [] },
  lintProfile: 'strict',
} as unknown as ProjectConfig

export function lint(
  inputs: readonly BundleInput[],
  over: Partial<LintContext> = {},
): LintReport {
  return lintBundles(inputs, { major: 17, project: PROJECT, tier: 'prod', ...over })
}

/** Rules that block, for a short assertion message. */
export function blockingRules(report: LintReport): string[] {
  const out: string[] = []
  for (const b of report.bundles) for (const f of b.findings) if (f.blocking) out.push(f.rule)
  for (const f of report.findings) if (f.blocking) out.push(f.rule)
  return out
}

/** Every rule that fired (any level). */
export function allRules(report: LintReport): string[] {
  const out: string[] = []
  for (const b of report.bundles) for (const f of b.findings) out.push(f.rule)
  for (const f of report.findings) out.push(f.rule)
  return out
}
