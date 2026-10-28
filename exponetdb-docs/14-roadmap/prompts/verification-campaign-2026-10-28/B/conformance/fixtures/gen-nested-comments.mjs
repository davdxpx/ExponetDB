// usage: node gen-nested-comments.mjs 40000 > nested.sql     (160 KB for n = 40000)
// PostgreSQL's own scanner is quadratic on `/*/*/*...`; the repo runs it synchronously inside serve (lint/plan).
// analyzeMigrationSql: n=10000 -> ~1 s, n=20000 -> ~4.5 s, n=40000 -> ~18 s (lint repeats it: ~38 s in all).
// The c1 scanner (validateBundle) is linear and accepts the file, and comments are free in the token bound.
const n = Number(process.argv[2] ?? 40000)
process.stdout.write('/*'.repeat(n) + '*/'.repeat(n) + '\nSELECT 1;\n')
