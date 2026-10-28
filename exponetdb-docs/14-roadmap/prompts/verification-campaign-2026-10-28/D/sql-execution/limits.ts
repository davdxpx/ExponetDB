// Limits: row cap, byte cap, 100 MB result, statement_timeout, lock_timeout, cancel, temp files, memory,
// error texts. Runs against the product's executor (executeDataRead) on a real reader session.
import { spawnSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function sh(args: string[]): string {
  return spawnSync('docker', args, { encoding: 'utf8' }).stdout.trim()
}

async function waitServer(ctx: any, kit: any): Promise<void> {
  for (let i = 0; i < 90; i++) {
    try {
      const c = await kit.superuserClient(ctx.server, 'postgres')
      await c.query('SELECT 1')
      await c.end()
      ctx.su = await kit.superuserClient(ctx.server, ctx.database)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error('server did not come back')
}

export async function runLimits(ctx: any, h: any): Promise<void> {
  const { kit, e2e, slimOutcome, leaks, OUT } = h
  const file = join(OUT, `limits-pg${ctx.major}.jsonl`)
  writeFileSync(file, '')
  const container = ctx.server.container as string | undefined
  if (container !== undefined) sh(['update', '--memory', '3g', '--memory-swap', '3g', container])
  const log = (r: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify({ major: ctx.major, ...r })}\n`)
  const corpus = (await import('node:fs'))
    .readFileSync(new URL('./corpus.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.class === 'limit')

  const stat = async () => {
    const r = await ctx.su.query(
      `SELECT temp_bytes::text AS tb, temp_files::text AS tf FROM pg_stat_database WHERE datname = current_database()`,
    )
    const readers = await ctx.su.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'exponetdb_reader'`)
    return { tempBytes: Number(r.rows[0].tb), tempFiles: Number(r.rows[0].tf), readers: readers.rows[0].n as number }
  }
  const mem = () => Number.parseInt(sh(['exec', container ?? '', 'cat', '/sys/fs/cgroup/memory.current']) || '0', 10)
  const peak = () => Number.parseInt(sh(['exec', container ?? '', 'cat', '/sys/fs/cgroup/memory.peak']) || '0', 10)

  async function one(label: string, entry: any, timeoutMs: number, maxRows = 500, signal?: AbortSignal) {
    let before: any
    try {
      before = await stat()
    } catch {
      await waitServer(ctx, kit)
      before = await stat()
    }
    let rss = process.memoryUsage().rss
    const sampler = setInterval(() => {
      rss = Math.max(rss, process.memoryUsage().rss)
    }, 50)
    let res: any
    try {
      const { o, ms } = await e2e(ctx, entry, timeoutMs, maxRows, signal)
      res = { ...slimOutcome(o), ms, leaks: leaks(o) }
      if (o.kind === 'query') {
        const bytes = JSON.stringify(o.rows).length
        res.resultBytes = bytes
      }
    } catch (err) {
      res = { kind: 'throw', error: String(err).slice(0, 160) }
    } finally {
      clearInterval(sampler)
    }
    await new Promise((r) => setTimeout(r, 400))
    let after: any
    try {
      after = await stat()
    } catch {
      await waitServer(ctx, kit)
      after = await stat()
      res.serverRestarted = true
    }
    log({
      label,
      id: entry.id,
      sql: (entry.sql ?? '').slice(0, 120),
      timeoutMs,
      result: res,
      tempBytesDelta: after.tempBytes - before.tempBytes,
      readerBackendsAfter: after.readers,
      workerRssMb: Math.round(rss / 1048576),
      containerPeakMb: container === undefined ? null : Math.round(peak() / 1048576),
    })
  }

  // 1. the resource-limit corpus entries, agent class
  for (const e of corpus) await one('corpus', e, e.id === 'limit-002' ? 2000 : 2500)
  // 2. human class: 5000 rows, EXPLAIN ANALYZE of a long read
  await one('human-rows', { id: 'human-rows', class: 'limit', kind: 'query', sql: 'SELECT g FROM generate_series(1, 1000000000) g', callerClass: 'human' }, 2500, 5000)
  await one('human-explain-analyze', { id: 'human-explain', class: 'limit', kind: 'explain', sql: 'SELECT count(*) FROM generate_series(1, 1000000000000)', analyze: true, callerClass: 'human' }, 2500)
  // 3. cancel: abort a long read after 500 ms; the next read must work and no backend may remain
  {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 500)
    await one('cancel-mid-run', { id: 'cancel', class: 'limit', kind: 'query', sql: 'SELECT count(*) FROM generate_series(1, 1000000000000)' }, 30_000, 500, ac.signal)
    const pre = new AbortController()
    pre.abort()
    await one('cancel-before-start', { id: 'cancel0', class: 'limit', kind: 'query', sql: 'SELECT 1' }, 5000, 500, pre.signal)
    await one('after-cancel', { id: 'after', class: 'limit', kind: 'query', sql: 'SELECT count(*) FROM public.accounts' }, 5000)
  }
  // 4. lock_timeout: another session holds ACCESS EXCLUSIVE on the table
  {
    const holder = await kit.superuserClient(ctx.server, ctx.database)
    await holder.query('BEGIN')
    await holder.query('LOCK TABLE public.accounts IN ACCESS EXCLUSIVE MODE')
    await one('lock-timeout', { id: 'lock', class: 'limit', kind: 'query', sql: 'SELECT count(*) FROM public.accounts' }, 10_000)
    await holder.query('ROLLBACK')
    await holder.end()
  }
  // 5. error texts: a runtime error is its SQLSTATE only; nothing of the server leaks
  const errors = [
    'SELECT 1/0',
    'SELECT * FROM public.nonexistent',
    "SELECT 'x'::int",
    'SELECT (SELECT 1 UNION ALL SELECT 2)',
    "SELECT current_setting('d2.nonexistent')",
    "SELECT * FROM public.accounts WHERE id = 'a'",
    "SELECT pg_read_file('/etc/passwd')",
    'SELECT * FROM pg_catalog.pg_authid',
    'SELECT * FROM public.ft_passwd',
    "SELECT * FROM public.accounts WHERE note ~ '('",
    "SELECT to_char(1, repeat('9', 100000))",
    "SELECT lo_import('/etc/passwd')",
    "SELECT dblink_connect('host=127.0.0.1 port=5432 dbname=postgres user=postgres password=D2CANARY-conn')",
    'SELECT inet_server_addr(), inet_server_port(), version()',
  ]
  for (const [i, sql] of errors.entries()) {
    await one('error-text', { id: `err-${i + 1}`, class: 'limit', kind: 'query', sql }, 4000)
  }
  // 6. memory: a read that allocates without bound until the statement timeout (container capped at 3 GiB)
  for (const sql of [
    'SELECT array_agg(g) FROM generate_series(1, 2000000000) g',
    "SELECT string_agg(repeat('y', 100000), ',') FROM generate_series(1, 100000)",
    "SELECT jsonb_agg(repeat('y', 100)) FROM generate_series(1, 2000000000)",
  ]) {
    await one('memory', { id: `mem`, class: 'limit', kind: 'query', sql }, 8000)
  }
  if (container !== undefined) log({ label: 'container-memory-at-end', currentMb: Math.round(mem() / 1048576), peakMb: Math.round(peak() / 1048576) })
}
