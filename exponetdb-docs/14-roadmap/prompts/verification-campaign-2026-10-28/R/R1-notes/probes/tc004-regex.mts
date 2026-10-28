// R1 probe TC-004: node --conditions=@exponetdb/source tc004-regex.mts <family> <chars>  (calls guardStrictness)
import { guardStrictness } from '@exponetdb/postgres/parser'
const [family, n] = [process.argv[2] as string, Number(process.argv[3])]
const fam: Record<string, (n: number) => string> = {
  one_ws: (n) => `SET search_path =,${' '.repeat(n)}`,
  rep_noterm: (n) => 'SET search_path = a, b '.repeat(Math.ceil(n / 23)),
  rep_comma: (n) => 'search_path,'.repeat(Math.ceil(n / 12)),
  rep_pad: (n) => `search_path${' '.repeat(40)}`.repeat(Math.ceil(n / 51)),
  quote_ws: (n) => `search_path a,"${' '.repeat(n)}`,
  quote_ws2: (n) => `search_path a,'${' '.repeat(n)}'${' '.repeat(n)}`,
  comma_ws_rep: (n) => `search_path a${', '.repeat(n / 2)}`,
  comma_quote_rep: (n) => `search_path a${',"'.repeat(n / 2)}`,
  comma_tab_rep: (n) => `search_path a${',\t\n"\t'.repeat(n / 5)}`,
  term_semicolon: (n) => 'SET search_path = a, b; '.repeat(Math.ceil(n / 24)),
  nl_ws: (n) => `search_path a,${'\n \t'.repeat(n / 3)}"`,
  pgcatalog_prefix: (n) => `search_path a${',pg_catalogx'.repeat(n / 11)}`,
  pgcat_ws_prefix: (n) => `search_path a${', pg_catalo '.repeat(n / 12)}`,
  search_in_ident: (n) => `${'search_pathx '.repeat(n / 13)}`,
  eq_op: (n) => `${'create operator = '.repeat(n / 18)}`,
  eq_op2: (n) => `create operator ${' '.repeat(n)}`,
  eq_op3: (n) => `create operator ${'a.'.repeat(n / 2)}`,
}
const text = fam[family]!(n)
const t0 = performance.now()
const r = guardStrictness([text])
console.log(JSON.stringify({ family, chars: text.length, result: r, ms: Math.round(performance.now() - t0) }))
