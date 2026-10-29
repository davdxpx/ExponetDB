/**
 * S4: the person's consent for an authorize URL (loopback CLI sign-in or an MCP client's authorization code flow),
 * with the target restriction the stock helper cannot express. Never prints a secret.
 *   EXSTACK_OWNER_FILE=<person>.json bun --conditions=@exponetdb/source s4/consent.ts <authorize url> [--targets tgt_a,tgt_b] [--tiers nonprod|nonprod,prod] scope...
 * With --no-deliver the redirect target is written to $S4/last-redirect (0600) instead of being followed.
 */
import { writeFileSync } from 'node:fs'
import { Human, must } from '../human.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const url = args.shift() as string
  let targets: string[] | undefined
  let tiers: string[] | undefined
  let deliver = true
  const scopes: string[] = []
  while (args.length > 0) {
    const a = args.shift() as string
    if (a === '--targets') targets = String(args.shift()).split(',')
    else if (a === '--tiers') tiers = String(args.shift()).split(',')
    else if (a === '--no-deliver') deliver = false
    else scopes.push(a)
  }
  const human = Human.load()
  await human.signIn()
  const u = new URL(url)
  const started = await human.call('GET', `${u.pathname}${u.search}`)
  if (started.status !== 302 || started.location === null) throw new Error(`authorize: HTTP ${started.status} ${String(started.body?.code ?? '')}`)
  const handle = started.location.slice(started.location.indexOf('#request=') + '#request='.length)
  const production = scopes.some((s) => s.endsWith(':prod'))
  const t = tiers ?? (production ? ['nonprod', 'prod'] : ['nonprod'])
  if (t.includes('prod')) await human.reauth()
  const decided = await human.call('POST', '/auth/oauth/consent', {
    request: handle,
    decision: 'allow',
    scopes,
    tiers: t,
    lifetimeDays: 30,
    ...(t.includes('prod') ? { acknowledgeProduction: true } : {}),
    ...(targets === undefined ? {} : { targets: { kind: 'list', targetIds: targets } }),
  })
  must(decided, 200, 'consent')
  if (deliver) {
    const r = await fetch(String(decided.body.redirectTo), { redirect: 'manual' })
    console.log(JSON.stringify({ consent: decided.status, delivered: r.status, scopes: scopes.length, tiers: t, targets: targets?.length ?? 'all' }))
  } else {
    writeFileSync(`${process.env['S4'] ?? '.'}/last-redirect`, `${decided.body.redirectTo}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ consent: decided.status, redirectSaved: true, scopes: scopes.length, tiers: t }))
  }
}
main().catch((e: unknown) => {
  console.error(String(e instanceof Error ? e.message : e))
  process.exit(1)
})
