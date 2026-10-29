// usage: node diffruns.mjs <a.tsv> <b.tsv>  -> lists tests whose status differs or that exist in one run only
import { readFileSync } from 'node:fs'
const load = (f) => { const m = new Map(); for (const l of readFileSync(f, 'utf8').split('\n')) { if (!l) continue; const [pkg, file, name, status] = l.split('\t'); const k = `${pkg}\t${file}\t${name}`; m.set(k, (m.get(k) ? m.get(k) + ',' : '') + status) } return m }
const a = load(process.argv[2]), b = load(process.argv[3])
let n = 0
for (const [k, v] of a) { const w = b.get(k); if (w === undefined) { console.log(`ONLY-A\t${k}\t${v}`); n++ } else if (w !== v) { console.log(`DIFF\t${k}\ta=${v} b=${w}`); n++ } }
for (const [k, v] of b) if (!a.has(k)) { console.log(`ONLY-B\t${k}\t${v}`); n++ }
console.log(`# ${n} differing; a=${a.size} b=${b.size}`)
