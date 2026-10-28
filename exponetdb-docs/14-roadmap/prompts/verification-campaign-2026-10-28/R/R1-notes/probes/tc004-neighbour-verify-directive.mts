// R1 neighbour probe of TC-004: other quadratic regular expressions in packages/postgres.
// verify-checks.ts DIRECTIVE = /^--\s*(check|covers|calls|reads-view):[ \t]*(.*?)\s*$/ on a verify.sql comment line.
import { analyzeVerifyFile, loadClusterGlobalParsers } from '@exponetdb/postgres/parser'
await loadClusterGlobalParsers(18); const { loadParser } = await import("@exponetdb/postgres/parser"); await loadParser(17)
for (const n of [10_000, 20_000, 40_000, 80_000]) {
  const text = `-- check: ok${' '.repeat(n)}x\nSELECT true AS ok;\n`
  const t0 = performance.now()
  analyzeVerifyFile(17 as never, text)
  console.log(JSON.stringify({ spaces: n, bytes: text.length, ms: Math.round(performance.now() - t0) }))
}
