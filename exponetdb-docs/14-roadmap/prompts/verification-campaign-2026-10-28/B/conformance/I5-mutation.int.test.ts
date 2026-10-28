// I5 mutation fuzz: take a generated script, damage it with one random edit (insert / delete / swap one hazard
// character), and compare three parsers on the damaged text: the SERVER (whole text, one message), libpg_query as
// the engine uses it (`analyzeMigrationSql`) and the c1 scanner (`executableText`).  Only LEXICAL/SYNTAX
// verdicts are compared: a semantic error of the server (a missing table) counts as "parsed".
//   server parsed  =>  libpg_query parsed  and  c1 accepted            (otherwise the engine refuses valid SQL)
//   server refused with a syntax/lexer error  =>  libpg_query refused  (otherwise the engine passes SQL the server will reject)
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { executableText } from '@exponetdb/migrations/format'
import { analyzeMigrationSql, loadParser } from '@exponetdb/postgres/parser'
import { enc } from './lib/bundle.ts'
import { Rng, script, setupSql } from './lib/gen.ts'
import { MAJORS, openLab, runWholeTx, type Lab, type Major } from './lib/pg.ts'

const MUTANTS = Number(process.env['B2_I5_MUTANTS'] ?? 150)
const EDIT = ["'", '"', '$', '$$', '\\', '/*', '*/', '--', '\n', ';', 'E', 'e', 'U&', '(', ')', '\u0000'.replace('\u0000', ' '), 'a', 'é']

const labs = new Map<Major, Lab>()
beforeAll(async () => {
  for (const m of MAJORS) {
    labs.set(m, await openLab(m, `b2_i5m_${m}`))
    await loadParser(m)
  }
}, 300_000)
afterAll(async () => {
  for (const l of labs.values()) await l.close()
})

type ServerVerdict = 'parsed' | 'syntax'
const SYNTAX = /syntax error|unterminated|invalid (Unicode|escape|input|byte)|zero-length delimited identifier|invalid .* escape|unsafe use of string constant|nested comment|incomplete|trailing junk|operator too long|unexpected/i

function mutate(text: string, r: Rng): string {
  const chars = Array.from(text)
  const at = r.int(chars.length + 1)
  switch (r.int(3)) {
    case 0:
      chars.splice(at, 0, r.pick(EDIT))
      break
    case 1:
      chars.splice(at, 1)
      break
    default:
      chars.splice(at, 1, r.pick(EDIT))
  }
  return chars.join('')
}

describe.each(MAJORS)('I5 mutation fuzz on PostgreSQL %i', (major) => {
  test(`${MUTANTS} mutated scripts: libpg_query and c1 agree with the server on what is lexically valid`, async () => {
    const lab = labs.get(major) as Lab
    const r = new Rng(31337 + major)
    const problems: string[] = []
    const counts = { parsed: 0, syntax: 0 }
    for (let i = 0; i < MUTANTS && problems.length < 6; i++) {
      const count = 4 + (i % 9)
      // no DO blocks: a mutated PL/pgSQL body is an execution-time error of the server, not a parse-time one
      const base = script(1000 + i * 17 + major, count, { noDo: true }).text
      const text = mutate(base, r)
      if (text.includes('\u0000')) continue
      await lab.admin.query(setupSql(count))
      const server = await runWholeTx(lab.admin, text)
      const verdict: ServerVerdict = server.ok || !SYNTAX.test(server.error?.message ?? '') ? 'parsed' : 'syntax'
      counts[verdict]++
      const a = analyzeMigrationSql(major, text.replaceAll('\r', '\n'), { trustedExtensions: [] })
      const repoParsed = a.ok
      const x = executableText(enc(text))
      if (verdict === 'parsed' && !repoParsed) problems.push(`server parsed, libpg_query refused: ${JSON.stringify(text.slice(0, 400))}`)
      if (verdict === 'parsed' && !x.ok) problems.push(`server parsed, c1 refused (${x.error}): ${JSON.stringify(text.slice(0, 400))}`)
      if (verdict === 'syntax' && repoParsed) problems.push(`server refused (${server.error?.message}), libpg_query parsed: ${JSON.stringify(text.slice(0, 400))}`)
      if (verdict === 'syntax' && !repoParsed && x.ok && /unterminated|quoted string/.test(server.error?.message ?? '') === false && false) problems.push('')
    }
    console.log(`I5 mutation[pg${major}]: ${counts.parsed} parsed by the server, ${counts.syntax} refused as syntax; ${problems.length} disagreements`)
    expect(problems, problems.join('\n')).toEqual([])
  }, 900_000)
})
