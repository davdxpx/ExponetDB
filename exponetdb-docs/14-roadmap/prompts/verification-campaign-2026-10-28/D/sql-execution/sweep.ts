// Catalog sweep: which pg_catalog / information_schema relations does the reader (a member of
// pg_read_all_data) read that an ordinary login role cannot, which of those does the guard admit,
// and does a planted canary in the server configuration come back through the product's path?
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CANARY = `D2CANARY-${Math.random().toString(36).slice(2, 10)}`

export async function runSweep(ctx: any, h: any): Promise<void> {
  const { kit, pgp, rawClient, rawRun, parser, OUT } = h
  const out: Record<string, unknown> = { major: ctx.major }
  const plainPass = 'd2-plain-pass-not-a-secret'
  await kit.runAsSuperuser(ctx.server, 'postgres', [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'd2_plain') THEN CREATE ROLE d2_plain LOGIN PASSWORD '${plainPass}'; END IF; END $$`,
  ])
  await kit.runAsSuperuser(ctx.server, ctx.database, [`GRANT CONNECT ON DATABASE "${ctx.database}" TO d2_plain`])
  const rels = (
    await ctx.su.query(
      `SELECT n.nspname AS s, c.relname AS r, c.relkind::text AS k FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('pg_catalog','information_schema') AND c.relkind IN ('r','v','m') ORDER BY 1, 2`,
    )
  ).rows as { s: string; r: string; k: string }[]
  // plant canaries where a secret would sit in a real configuration (disposable server)
  await ctx.su.query(`ALTER SYSTEM SET primary_conninfo = 'host=d2.invalid user=r password=${CANARY}-conninfo'`)
  await ctx.su.query(`ALTER SYSTEM SET archive_command = 'true # ${CANARY}-archive'`)
  await ctx.su.query(`ALTER SYSTEM SET cluster_name = '${CANARY}-name'`)
  const delta: any[] = []
  let readerOk = 0
  let plainOk = 0
  for (const { s, r } of rels) {
    const text = `SELECT * FROM ${s}.${JSON.stringify(r)} LIMIT 5`
    const a = await rawRun(rawClient(ctx, 'exponetdb_reader', kit.loginPassword('exponetdb_reader')), text, { frame: true, simple: false })
    const b = await rawRun(rawClient(ctx, 'd2_plain', plainPass), text, { frame: true, simple: false })
    if (a.ok) readerOk++
    if (b.ok) plainOk++
    if (a.ok && !b.ok) {
      const g = await parser.admitRead(ctx.major, text)
      delta.push({ rel: `${s}.${r}`, rows: a.rows, plainSqlstate: b.sqlstate, guard: g.ok ? 'admits' : `refuses:${g.reason}` })
    }
  }
  out['relations'] = rels.length
  out['readerCanRead'] = readerOk
  out['plainRoleCanRead'] = plainOk
  out['delta'] = delta
  // product path: the delta relations the guard admits, with the canary scan over the sealed result
  const hits: any[] = []
  for (const d of delta.filter((x) => x.guard === 'admits')) {
    const [s, r] = d.rel.split('.')
    const { o } = await h.e2e?.(ctx, { id: 'sweep', class: 'sweep', kind: 'query', sql: `SELECT * FROM ${s}.${r}`, expected: 'RUNS_READ_ONLY' }, 4000) ?? {}
    const text = JSON.stringify(o ?? {})
    hits.push({ rel: d.rel, outcome: o?.kind ?? 'n/a', rowCount: o?.rowCount ?? null, canary: text.includes(CANARY) })
  }
  out['e2e'] = hits
  out['canaryReturned'] = hits.filter((x) => x.canary).map((x) => x.rel)
  for (const k of ['primary_conninfo', 'archive_command', 'cluster_name']) {
    await ctx.su.query(`ALTER SYSTEM RESET ${k}`)
  }
  writeFileSync(join(OUT, `sweep-pg${ctx.major}.json`), `${JSON.stringify(out, null, 2)}\n`)
}
