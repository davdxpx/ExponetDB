// Minimal HTTP load generator for the S6 tests. No dependency, no secret on argv.
//   node load.mjs --url URL [--method GET] [--headers FILE (curl -H @file format, one header per line)]
//                 [--body FILE|--bodystr STR] [--c 200] [--n 2000 | --seconds 30] [--timeout-ms 60000] [--label x]
// Prints one JSON line: statuses, problem codes, latency percentiles (ms), errors (socket level), duration.
import { readFileSync } from 'node:fs'
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? '1' : arr[i + 1]]] : acc), []))
const url = a.url, method = a.method ?? 'GET', C = Number(a.c ?? 50), N = a.n ? Number(a.n) : Infinity
const until = a.seconds ? Date.now() + Number(a.seconds) * 1000 : Infinity
const tmo = Number(a['timeout-ms'] ?? 60000)
const headers = {}
if (a.headers) for (const l of readFileSync(a.headers, 'utf8').split('\n')) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim()] = l.slice(i + 1).trim() }
const body = a.body ? readFileSync(a.body) : a.bodystr
if (body && !headers['content-type']) headers['content-type'] = 'application/json'
const statuses = {}, codes = {}, errs = {}, lat = []
let started = 0, done = 0
const t00 = Date.now()
async function one() {
  const t = performance.now()
  try {
    const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(tmo) })
    const txt = await r.text()
    statuses[r.status] = (statuses[r.status] ?? 0) + 1
    if (r.status >= 400) { try { const c = JSON.parse(txt).code ?? 'noncode'; codes[`${r.status} ${c}`] = (codes[`${r.status} ${c}`] ?? 0) + 1 } catch { codes[`${r.status} nonjson`] = (codes[`${r.status} nonjson`] ?? 0) + 1 } }
  } catch (e) { const k = (e.cause?.code ?? e.name ?? 'err'); errs[k] = (errs[k] ?? 0) + 1 }
  lat.push(performance.now() - t); done++
}
async function worker() { while (started < N && Date.now() < until) { started++; await one() } }
await Promise.all(Array.from({ length: C }, worker))
lat.sort((x, y) => x - y)
const q = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0)
console.log(JSON.stringify({ label: a.label ?? '', c: C, requests: done, seconds: +((Date.now() - t00) / 1000).toFixed(1), statuses, codes, socketErrors: errs, ms: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) } }))
