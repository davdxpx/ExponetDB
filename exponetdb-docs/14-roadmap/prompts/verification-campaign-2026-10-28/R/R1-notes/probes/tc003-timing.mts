// R1 probe TC-003 neighbours: time the new body decoder on hostile 4 MiB inputs.
import { loadClusterGlobalParsers, countTokens, exceedsParseWork, statementBodies, MAX_PARSE_TOKENS } from '@exponetdb/postgres/parser'
await loadClusterGlobalParsers(18)
const MIB = 1048576
const mk = (name: string, f: () => string) => ({ name, f })
const cases = [
  mk('E-escapes \\x3b x1.3M', () => `DO E'${'\\x3b'.repeat(1_000_000)}';`),
  mk("doubled quotes x2M", () => `DO '${"''".repeat(2_000_000)}';`),
  mk('continuation pieces', () => `DO ${"'a'\n".repeat(1_000_000)};`),
  mk('many tiny DO', () => "DO 'x';".repeat(500_000)),
  mk('many tiny DO $$', () => 'DO $$x$$;'.repeat(450_000)),
  mk('nested depth 4 dollar', () => { let b = `BEGIN ${'PERFORM 1;'.repeat(60_000)} END`; for (const t of ['d','c','b','a']) b = `DO $${t}$ ${b} $${t}$;`; return b }),
  mk('nested depth 3 single', () => { let b = `BEGIN ${'PERFORM 1;'.repeat(60_000)} END`; for (let i = 0; i < 3; i++) b = `DO '${b.replaceAll("'", "''")}';`; return b }),
  mk('string then language x200k', () => "SELECT 'a' language ".repeat(200_000)),
  mk('AS string x500k', () => "SELECT 1 AS 'a';".repeat(300_000)),
  mk('unterminated E', () => `DO E'${'\\'.repeat(4 * MIB - 10)}`),
  mk('backslash storm', () => `DO E'${'\\\\'.repeat(2 * MIB)}';`),
]
for (const c of cases) {
  const sql = c.f()
  const t0 = performance.now()
  const n = countTokens(sql, MAX_PARSE_TOKENS, 'standard', true)
  const t1 = performance.now()
  const ex = exceedsParseWork(sql)
  const t2 = performance.now()
  const bodies = statementBodies(sql).length
  const t3 = performance.now()
  console.log(JSON.stringify({ case: c.name, bytes: Buffer.byteLength(sql), tokens: n, exceeds: ex, bodies, ms: { count: Math.round(t1 - t0), exceeds: Math.round(t2 - t1), bodies: Math.round(t3 - t2) } }))
}
