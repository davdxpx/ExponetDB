// usage: node counts.mjs <old.summary.json> <new.summary.json>  -> markdown table of per-package files/tests old vs new
import { readFileSync } from 'node:fs'
const o = JSON.parse(readFileSync(process.argv[2], 'utf8')), n = JSON.parse(readFileSync(process.argv[3], 'utf8'))
const pk = [...new Set([...Object.keys(o.packages), ...Object.keys(n.packages)])].sort()
console.log('| package | files old | files new | tests old | tests new | delta |\n|---|---:|---:|---:|---:|---:|')
for (const p of pk) { const a = o.packages[p] ?? { files: 0, total: 0 }, b = n.packages[p] ?? { files: 0, total: 0 }; console.log(`| ${p} | ${a.files} | ${b.files} | ${a.total} | ${b.total} | ${b.total - a.total >= 0 ? '+' : ''}${b.total - a.total} |`) }
const A = o.total, B = n.total
console.log(`| **total** | ${A.files} | ${B.files} | ${A.total} | ${B.total} | ${B.total - A.total >= 0 ? '+' : ''}${B.total - A.total} |`)
