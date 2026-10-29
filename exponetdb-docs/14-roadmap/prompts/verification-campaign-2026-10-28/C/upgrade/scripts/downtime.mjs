// downtime.mjs <sampler log> ...   per endpoint: the interval(s) in which readiness was not 200, split into "503 not_ready" and "ERR (refused)"
import { readFileSync } from 'node:fs'
for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => { const [t, name, code] = l.split(' '); return { t: Date.parse(t), name, code } })
  const names = [...new Set(rows.map((r) => r.name))]
  console.log(`# ${file}`)
  for (const n of names) {
    const s = rows.filter((r) => r.name === n)
    let down = null, total = 0, refused = 0, notReady = 0, first = null, last = null
    for (let i = 0; i < s.length; i++) {
      const r = s[i], next = s[i + 1]
      if (r.code !== '200') {
        if (down === null) { down = r.t; first ??= r.t }
        const dur = (next ? next.t : r.t) - r.t
        if (r.code === 'ERR') refused += dur; else notReady += dur
        if (next && next.code === '200') { total += next.t - down; last = next.t; down = null }
      }
    }
    console.log(`${n}\tnon-200 total ${total} ms\t(503 not_ready ${notReady} ms, connection refused ${refused} ms)\tfirst ${first ? new Date(first).toISOString().slice(11, 23) : '-'}\tback to 200 ${last ? new Date(last).toISOString().slice(11, 23) : '-'}`)
  }
}
