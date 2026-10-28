// R1 probe TC-003: memory just below the token bound, long tokens, single-quoted vs dollar
import { loadClusterGlobalParsers, parsePlpgsql, MAX_PARSE_TOKENS, countTokens } from '@exponetdb/postgres/parser'
await loadClusterGlobalParsers(18)
const [shape, kind] = process.argv.slice(2)
const stmt = kind === 'long' ? `PERFORM ${'x'.repeat(57)};` : 'PERFORM 1;' // long: ~4 tokens, 68 bytes
const per = kind === 'long' ? 3 : 3
let n = Math.floor((MAX_PARSE_TOKENS - 20) / per)
if (kind === 'long') n = Math.min(n, Math.floor((4 * 1048576 - 200) / stmt.length))
const body = `BEGIN ${stmt.repeat(n)} END`
const sql = shape === 'single' ? `DO '${body}';` : `DO $$${body}$$;`
const base = process.memoryUsage().rss
const t0 = performance.now()
const tokens = countTokens(sql, MAX_PARSE_TOKENS, 'standard', true)
const r = parsePlpgsql(sql)
console.log(JSON.stringify({ shape, kind, bytes: Buffer.byteLength(sql), tokens, parsed: r !== undefined, ms: Math.round(performance.now() - t0), growthMiB: Math.round((process.memoryUsage().rss - base) / 1048576), maxrssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }))
