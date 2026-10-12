import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostScenario } from '../support/host-world.ts'

/**
 * Host scenario: confidentiality of node exports (Wave 5 correction F1,
 * capabilities.md §6), on a node of its own. Synthetic canaries sit where
 * PostgreSQL keeps secrets of its own and of extensions: a standard
 * parameter (ALTER SYSTEM), a custom parameter in a conf.d file and in the
 * managed fragment, a role and a database setting, foreign pg_hba rules with
 * LDAP and RADIUS secrets (parsed only; no server is contacted), and a
 * client's failed statement in the server log. Reads through REST and an
 * unrelated configuration change keep every one on the host and out of the
 * signed completions, jobs, observations, REST answers, audit, operation
 * events, every other Control Store table, the agent's and the helper's
 * state and their logs. The enrollment token never appears in a log.
 */
const w = hostScenario({ scenario: 'secrets' })

describe('secret canaries stay on the host (host scenario)', () => {
  it('keeps every canary out of the gateway, the API, audit, history, node state and logs', async () => {
    const node = w.requireNode()
    const canary = `EXDBHOSTCANARY${randomBytes(6).toString('hex')}`
    const canaryRole = `exdb_canary_${w.runTag}`
    const customFile = join(dirname(w.instance.configFile), 'conf.d', '50-exdb-host-canary.conf')
    const hbaBefore = readFileSync(w.instance.hbaFile)
    const header =
      '# ExponetDB managed configuration (OD-20), written by exponetdb-node-helper.\n' +
      '# Do not edit: the next postgres.config.apply replaces this file.\n'
    await w.psql(
      `ALTER SYSTEM SET primary_conninfo = 'host=192.0.2.1 user=replicator password=${canary}'`,
    )
    await w.psql(`CREATE ROLE ${canaryRole} NOLOGIN`)
    await w.psql(`ALTER ROLE ${canaryRole} SET exdbcanary.api_token = '${canary}'`)
    await w.psql(`ALTER DATABASE postgres SET exdbcanary.db_secret = '${canary}'`)
    writeFileSync(customFile, `exdbcanary.api_key = '${canary}'\n`, { mode: 0o644 })
    writeFileSync(w.instance.managedInclude, `${header}exdbcanary.fragment_token = '${canary}'\n`)
    writeFileSync(
      w.instance.hbaFile,
      Buffer.concat([
        hbaBefore,
        Buffer.from(
          `\n# exdb host canary (test)\n` +
            `host all ${canaryRole} 192.0.2.0/24 ldap ldapserver=ldap.invalid ldapbasedn="dc=example" ldapbinddn="cn=reader" ldapbindpasswd=${canary} ldapsearchattribute=uid\n` +
            `host all ${canaryRole} 198.51.100.0/24 radius radiusservers=radius.invalid radiussecrets=${canary}\n`,
        ),
      ]),
    )
    await w.psql('SELECT pg_reload_conf()')
    await w.psql(`SELECT '${canary}'::int`).then(
      () => {
        throw new Error('the canary statement ran')
      },
      () => undefined,
    )
    const logWindow = {
      since: new Date(Date.now() - 15 * 60_000).toISOString(),
      until: new Date(Date.now() + 60_000).toISOString(),
      minSeverity: 'info',
      maxLines: 500,
    }
    await w.inspect('postgres.config.inspect@2')
    await w.inspect('postgres.roles.inspect@2', { expectSettings: [] })
    await w.inspect('postgres.hba.inspect@2')
    await w.inspect('log.inspect@2', { source: 'postgresql', ...logWindow })
    await w.inspect('log.inspect@2', { source: 'agent', ...logWindow }, null)
    await w.inspect('log.inspect@2', { source: 'helper', ...logWindow }, null)
    await w.inspect('agent.diagnostics@2', {}, null)
    // The foreign rules go back before the configuration change reloads PostgreSQL.
    writeFileSync(w.instance.hbaFile, hbaBefore)
    await w.psql('SELECT pg_reload_conf()')
    // Another parameter changes: the withheld fragment value stays on the host.
    const kept = await w.finished(await w.configChange('9MB'))
    expect([kept.state, kept.applyOutcome, kept.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'applied',
      'passed',
    ])
    expect(readFileSync(w.instance.managedInclude, 'utf8')).toBe(
      `${header}exdbcanary.fragment_token = '${canary}'\nwork_mem = '9MB'\n`,
    )
    // A planned value the node withholds (a custom parameter) is never compared on the host.
    const custom = { name: 'exdbcanary.planned_setting', value: 'planned-value' }
    await w.inspect('postgres.config.plan@2', { changes: [custom] })
    const withheld = await w.planAndApply({
      kind: 'postgres.config.apply',
      changes: [custom],
      reload: true,
    })
    expect([withheld.state, withheld.applyOutcome, withheld.verificationOutcome]).toEqual([
      'succeeded',
      'applied',
      'passed',
    ])
    // What a reader gets: values withheld as such, never the canary.
    const clusterReads = await w.call(
      'GET',
      `/api/v1/nodes/${node.nodeId}/observations?clusterId=${w.clusterId}`,
    )
    const nodeReads = await w.call('GET', `/api/v1/nodes/${node.nodeId}/observations`)
    expect([clusterReads.status, nodeReads.status]).toEqual([200, 200])
    const ops = await w.call('GET', '/api/v1/operations?limit=200')
    for (const body of [clusterReads.body, nodeReads.body, ops.body]) {
      expect(JSON.stringify(body)).not.toContain(canary)
    }
    const reads = [...clusterReads.body.items, ...nodeReads.body.items] as {
      capability: string
      clusterId: string | null
      result: Record<string, unknown>
    }[]
    const read = (capability: string) => reads.find((o) => o.capability === capability)?.result
    const settings = read('postgres.config.inspect@2')?.['settings'] as {
      name: string
      setting: unknown
    }[]
    expect(settings.find((s) => s.name === 'primary_conninfo')?.setting).toEqual({
      withheld: 'secret',
    })
    expect(JSON.stringify(read('postgres.hba.inspect@2'))).toContain(
      '{"name":"ldapbindpasswd","value":{"withheld":"secret"}}',
    )
    const serverLog = JSON.stringify(
      reads.find((o) => o.capability === 'log.inspect@2' && o.clusterId === w.clusterId)?.result,
    )
    expect(serverLog).toContain('invalid input syntax for type integer: [withheld]')
    // Every table of the Control Store.
    const holding = await w.db.asSuperuser(async (c) => {
      const { rows: tables } = await c.query(
        `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`,
      )
      const found: string[] = []
      for (const { t } of tables) {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM ${t} x WHERE x::text LIKE '%' || $1 || '%'`,
          [canary],
        )
        if (rows[0].n > 0) found.push(t)
      }
      return found
    })
    expect(holding).toEqual([])
    // The agent's buffer and journal, the helper's state, and the logs.
    const filesHolding = (root: string): string[] =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name))
        .filter((f) => readFileSync(f).includes(canary))
    expect([...filesHolding(node.state), ...filesHolding(node.helperDir)]).toEqual([])
    const logs = await w.logs()
    expect(logs).not.toContain(canary)
    expect(logs).not.toContain(node.token.slice(7, 47))
    expect(logs).not.toContain('SCRAM-SHA-256$')
    rmSync(customFile)
  })
})
