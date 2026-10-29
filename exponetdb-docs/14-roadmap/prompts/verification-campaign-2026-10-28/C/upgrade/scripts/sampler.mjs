// Polls /healthz/ready of the three internal listeners and the public listener every 50 ms; prints a line per change:
//   <iso ms> <name> <http code|ERR> <first 80 chars of the body>
const ports = process.argv.slice(2).map(Number)
const names = ['serve-int', 'worker-int', 'gateway-int', 'serve-pub']
const last = new Map()
async function probe(i) {
  const url = `http://127.0.0.1:${ports[i]}/healthz/ready`
  let code, body = ''
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) })
    code = String(r.status)
    body = (await r.text()).replace(/"requestId":"[^"]*"/, '').slice(0, 80)
  } catch (e) { code = 'ERR'; body = String(e?.cause?.code ?? e?.name ?? e).slice(0, 40) }
  const key = `${code} ${body}`
  if (last.get(i) !== key) { last.set(i, key); console.log(`${new Date().toISOString()} ${names[i]} ${key}`) }
}
for (;;) { await Promise.all(ports.map((_, i) => probe(i))); await new Promise((r) => setTimeout(r, 50)) }
