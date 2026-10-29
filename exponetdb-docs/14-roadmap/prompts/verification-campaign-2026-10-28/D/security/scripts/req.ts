/**
 * S4: one REST request as a signed-in person (session cookie, CSRF) with canary placeholders substituted from
 * $S4/planted.json at run time, so no secret is ever on a command line. The response body goes to $L4/api/<name>.json
 * (0600) for the sink scan; stdout shows the status, the error code and the length of the message only.
 *
 *   EXSTACK_OWNER_FILE=<person>.json bun --conditions=@exponetdb/source s4/req.ts [--reauth] [--wait] [--approve] [--show k1,k2]
 *        [--age seconds] [--header name=value] <name> <METHOD> <path> [body-json-or-@file]
 * Placeholders in the body: @@<planted id>@@ (e.g. @@C2-migrator-password@@).
 * --wait: the response is an operation or a plan apply; poll the operation to its end and print its state.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Human } from '../human.ts'

const S4 = process.env['S4'] ?? '/srv/work/s4'
const L4 = process.env['L4'] ?? '/srv/work/logs-s4'
mkdirSync(`${L4}/api`, { recursive: true, mode: 0o700 })
const planted = JSON.parse(readFileSync(`${S4}/planted.json`, 'utf8')) as Record<string, string>

function fill(text: string): string {
  // JSON-encode the substituted value so special characters survive
  return text.replace(/@@([A-Za-z0-9-]+)@@/g, (_, id: string) => {
    const v = planted[id]
    if (v === undefined) throw new Error(`no planted value ${id}`)
    return JSON.stringify(v).slice(1, -1)
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const flags = { reauth: false, wait: false, approve: false, age: 0, show: [] as string[], headers: {} as Record<string, string> }
  const pos: string[] = []
  while (args.length > 0) {
    const a = args.shift() as string
    if (a === '--reauth') flags.reauth = true
    else if (a === '--wait') flags.wait = true
    else if (a === '--approve') flags.approve = true
    else if (a === '--age') flags.age = Number(args.shift())
    else if (a === '--show') flags.show = String(args.shift()).split(',')
    else if (a === '--header') {
      const [k, ...v] = String(args.shift()).split('=')
      flags.headers[k as string] = v.join('=')
    } else pos.push(a)
  }
  const [name, method, path, bodyArg] = pos
  const human = Human.load()
  await human.signIn()
  if (flags.reauth) await human.reauth()
  // --age N: the session ages N seconds before the request (a proof older than the window is stale)
  if (flags.age > 0) await new Promise((r) => setTimeout(r, flags.age * 1000))
  let body: unknown
  if (bodyArg !== undefined) {
    const raw = bodyArg.startsWith('@') ? readFileSync(bodyArg.slice(1), 'utf8') : bodyArg
    body = JSON.parse(fill(raw))
  }
  const r = await human.call(method as string, path as string, body, flags.headers)
  writeFileSync(`${L4}/api/${name}.json`, JSON.stringify({ status: r.status, body: r.body ?? r.text }), { mode: 0o600 })
  const out: Record<string, unknown> = { name, status: r.status }
  if (r.body?.code !== undefined) out['code'] = r.body.code
  if (typeof r.body?.message === 'string') out['messageLength'] = r.body.message.length
  for (const k of flags.show) out[k] = r.body?.[k]
  if (r.body?.state !== undefined) out['state'] = r.body.state
  if (r.body?.id !== undefined) out['id'] = r.body.id
  if (flags.wait && (r.status === 201 || r.status === 202) && typeof r.body?.id === 'string') {
    let opId: string = r.body.id
    if (opId.startsWith('pln_')) {
      // a plan: apply it (the person re-authenticates), approve when asked, then wait
      if (!flags.reauth) await human.reauth()
      const planHash = r.body.planHash as string
      const a = await human.call('POST', `/api/v1/plans/${opId}/apply`, {})
      writeFileSync(`${L4}/api/${name}-apply.json`, JSON.stringify({ status: a.status, body: a.body ?? a.text }), { mode: 0o600 })
      out['applyStatus'] = a.status
      if (a.status !== 202) {
        out['applyCode'] = a.body?.code
        console.log(JSON.stringify(out))
        return
      }
      opId = a.body.id
      if (a.body.state === 'awaiting_approval' && flags.approve) {
        const ap = await human.approve(opId, planHash)
        out['approveStatus'] = ap.status
      }
    }
    const end = await human.finished(opId, 180_000).catch((e: unknown) => ({ state: `timeout:${String(e).slice(0, 60)}` }))
    const full = await human.call('GET', `/api/v1/operations/${opId}`)
    writeFileSync(`${L4}/api/${name}-op.json`, JSON.stringify(full.body ?? full.text), { mode: 0o600 })
    out['operation'] = opId
    out['opState'] = (end as { state: string }).state
    out['errorCode'] = full.body?.errorCode
  }
  console.log(JSON.stringify(out))
}
main().catch((e: unknown) => {
  console.error(String(e instanceof Error ? e.message : e).slice(0, 300))
  process.exit(1)
})
