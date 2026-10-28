// R1 probe TC-003: node --liftoff-only --conditions=@exponetdb/source tc003-repro.mts <shape> <n> <count|refuse|parse>
import { loadClusterGlobalParsers, countTokens, exceedsParseWork, parsePlpgsql, MAX_PARSE_TOKENS, legacyReferences } from '@exponetdb/postgres/parser'
const [shape, nArg, mode] = process.argv.slice(2)
const n = Number(nArg)
const body = `BEGIN ${'PERFORM 1;'.repeat(n)} END`
const shapes: Record<string, string> = {
  dollar: `DO $$${body}$$;`,
  single: `DO '${body}';`,
  lang_before: `DO LANGUAGE plpgsql '${body}';`,
  lang_after: `DO '${body}' LANGUAGE plpgsql;`,
  estr: `DO E'${body}';`,
  qlang: `DO LANGUAGE "plpgsql" '${body}';`,
  tag: `DO $tag$${body}$tag$;`,
  func_as: `CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS '${body}';`,
  func_as_dollar: `CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$${body}$$;`,
  procedure: `CREATE PROCEDURE public.p() LANGUAGE plpgsql AS '${body}';`,
  comment_between: `DO /* c */ -- x\n '${body}';`,
  concat_split: `DO '${body.slice(0, 1000)}'\n'${body.slice(1000)}';`,
  uamp: `DO U&'${body}';`,
  nstr: `DO N'${body}';`,
}
const sql = shapes[shape]
if (!sql) throw new Error('shape?')
await loadClusterGlobalParsers(18)
const base = process.memoryUsage().rss
const t0 = performance.now()
if (mode === 'count') {
  console.log(JSON.stringify({ shape, bytes: Buffer.byteLength(sql), plain: countTokens(sql, MAX_PARSE_TOKENS), withBodies: countTokens(sql, MAX_PARSE_TOKENS, 'standard', true), exceeds: exceedsParseWork(sql) }))
} else if (mode === 'parse') {
  const r = parsePlpgsql(sql)
  console.log(JSON.stringify({ shape, parsed: r !== undefined }))
} else if (mode === 'refs') {
  const r = legacyReferences(18, [{ name: '0001_x.sql', text: sql }], () => false) as { tooComplex?: boolean }
  console.log(JSON.stringify({ shape, tooComplex: r.tooComplex }))
}
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), rssGrowthMiB: Math.round((process.memoryUsage().rss - base) / 1048576), maxrssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }))
