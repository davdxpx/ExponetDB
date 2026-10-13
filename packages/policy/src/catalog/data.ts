import type { JsonObject } from '@exponetdb/kernel'
import type { Rule } from '../rules.ts'

/**
 * Data reads (Wave 7, ADR-0028 §3, OD-13 option a): who may read rows of a
 * managed database, per target. The setting lives in `policy.rule_settings`
 * like every rule setting (installation → product → project → environment
 * → target; the most specific wins), so an administrator changes it with a
 * policy settings plan; the frozen registry is untouched.
 *
 * `mode`: `by_tier` (the default: people read every tier, agents only
 * non-production), `enabled`, `humans_only` (agents read no rows) or
 * `disabled` (nobody does). An unknown tier counts as production. An agent
 * is every caller that is not a person through the Web App or the
 * first-party CLI: an MCP client, a service account, an API key, CI. A
 * scope never lifts it: `data.read:prod` on a `humans_only` target is
 * still refused.
 *
 * `sensitiveColumns`: patterns `schema.table.column` (`*` matches a name
 * part) whose values are masked for callers without `data.read_sensitive`
 * (which no MCP client ever holds). Reported in the rule's facts so the
 * read path masks with the same effective setting the decision used.
 */
export const DATA_READ_MODES = ['by_tier', 'enabled', 'humans_only', 'disabled'] as const
export type DataReadMode = (typeof DATA_READ_MODES)[number]

const PART = '[A-Za-z_*][A-Za-z0-9_$*]{0,62}'
export const SENSITIVE_COLUMN_PATTERN = new RegExp(`^${PART}\\.${PART}\\.${PART}$`)

/** A mode of the catalog and at most 256 well-formed column patterns. */
export function validDataReadParams(params: JsonObject): boolean {
  const mode = params['mode']
  const listed = params['sensitiveColumns']
  return (
    typeof mode === 'string' &&
    (DATA_READ_MODES as readonly string[]).includes(mode) &&
    Array.isArray(listed) &&
    listed.length <= 256 &&
    listed.every((c) => typeof c === 'string' && SENSITIVE_COLUMN_PATTERN.test(c))
  )
}

export const dataRead: Rule = {
  id: 'data.read',
  version: 1,
  description:
    'Who may read rows of a target (OD-13): by tier people read everywhere and agents only non-production; humans_only keeps agents out, disabled keeps everyone out.',
  appliesTo: ['query.run', 'query.explain'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { mode: 'by_tier', sensitiveColumns: [] },
  requirements: () => [],
  checkParams: (params) => validDataReadParams(params),
  evaluate({ request, params }) {
    const mode = params['mode']
    if (!validDataReadParams(params) || typeof mode !== 'string') {
      return { result: 'unknown', message: 'The data.read setting is not valid.' }
    }
    const sensitive = params['sensitiveColumns'] as string[]
    const effective =
      mode === 'by_tier' ? (request.subject.tier === 'nonprod' ? 'enabled' : 'humans_only') : mode
    const p = request.principal
    const agent = p.kind !== 'human' || (p.client !== 'web' && p.client !== 'cli')
    const facts = { mode, effective, agent, sensitiveColumns: sensitive }
    if (effective === 'disabled') {
      return {
        result: 'fail',
        message: 'Row reads are disabled for this target.',
        facts,
        remediation: 'Read the schema and statistics instead, or ask an administrator.',
      }
    }
    if (effective === 'humans_only' && agent) {
      return {
        result: 'fail',
        message:
          'On this target only people read rows; an agent (an MCP client, a service account, an API key or CI) does not, whatever its scopes.',
        facts,
        remediation:
          'Use schema, statistics and EXPLAIN without ANALYZE, or ask a person to run the query.',
      }
    }
    return { result: 'pass', message: 'This caller may read rows of this target.', facts }
  },
}

export const DATA_RULES: readonly Rule[] = [dataRead]
