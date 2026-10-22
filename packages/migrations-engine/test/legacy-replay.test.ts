import { loadClusterGlobalParsers } from '@exponetdb/postgres/parser'
import { beforeAll, describe, expect, it } from 'vitest'
import { type FileReplay, fileReplay, survivingGlobals } from '../src/legacy-replay.ts'

/**
 * The replay of a legacy file (legacy-import.md §2.4, Wave 9 order A6):
 * elided role statements, `CONCURRENTLY` in autocommit, comment-only
 * files, and the chain's surviving cluster-global expectations.
 */
beforeAll(async () => {
  await loadClusterGlobalParsers(17)
})

const replay = (text: string): FileReplay => {
  const r = fileReplay(17, text)
  if (r === undefined) throw new Error('unparsable')
  return r
}

describe('fileReplay', () => {
  it('runs a file without role statements or CONCURRENTLY exactly as submitted', () => {
    const text =
      '-- notes\nCREATE TABLE public.acme_t (id int);\nCREATE INDEX acme_i ON public.acme_t (id);\n'
    expect(replay(text)).toMatchObject({
      segments: [{ kind: 'transactional', statements: [0, 1], text }],
      elided: [],
      noStatements: false,
    })
  })

  it('elides top-level role statements and role-only DO blocks, and keeps the rest in order', () => {
    const r = replay(`CREATE ROLE acme_anon NOLOGIN;
CREATE TABLE public.acme_t (id int);
DO $$ BEGIN GRANT acme_anon TO acme_auth; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT ON public.acme_t TO acme_anon; -- a table grant stays
ALTER ROLE acme_anon SET search_path = public;
`)
    expect(r.elided).toEqual([
      { statement: 0, form: 'role_statement', type: 'CreateRoleStmt' },
      { statement: 2, form: 'role_do_block', type: 'DoStmt' },
      { statement: 4, form: 'role_statement', type: 'AlterRoleSetStmt' },
    ])
    expect(r.segments).toEqual([
      {
        kind: 'transactional',
        statements: [1, 3],
        text: 'CREATE TABLE public.acme_t (id int);\nGRANT SELECT ON public.acme_t TO acme_anon;\n',
      },
    ])
    expect(r.globals.map((g) => [g.statement, g.expectations.length])).toEqual([
      [0, 2],
      [2, 1],
      [4, 1],
    ])
  })

  it('replays a mixed DO block unchanged and names it', () => {
    const r = replay(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_anon') THEN CREATE ROLE acme_anon; END IF; END $$;\n",
    )
    expect(r.mixedDoBlocks).toEqual([0])
    expect(r.elided).toEqual([])
    expect(r.segments).toHaveLength(1)
  })

  it('runs CONCURRENTLY alone between transactional segments', () => {
    const r = replay(`CREATE TABLE public.acme_t (id int);
CREATE INDEX CONCURRENTLY acme_i ON public.acme_t (id);
COMMENT ON INDEX public.acme_i IS 'by id';
`)
    expect(r.autocommit).toEqual([1])
    expect(r.segments.map((s) => [s.kind, s.statements])).toEqual([
      ['transactional', [0]],
      ['autocommit', [1]],
      ['transactional', [2]],
    ])
    expect(r.segments[1]?.text).toBe('CREATE INDEX CONCURRENTLY acme_i ON public.acme_t (id);\n')
  })

  it('names a comment-only file instead of refusing it', () => {
    expect(replay('-- nothing left here\n/* a note */\n')).toMatchObject({
      noStatements: true,
      segments: [],
    })
  })

  it('refuses text its major cannot parse', () => {
    expect(fileReplay(17, 'CREATE TABLE (')).toBeUndefined()
  })
})

describe('survivingGlobals', () => {
  it('keeps the last statement about a thing, and drops what a later removal supersedes', () => {
    const chain = [
      replay('CREATE ROLE acme_anon NOLOGIN;\nCREATE ROLE acme_old;\n'),
      replay('ALTER ROLE acme_anon LOGIN;\nGRANT acme_anon TO acme_old;\n'),
      replay('DROP ROLE acme_old;\n'),
    ]
    const { surviving } = survivingGlobals(chain)
    expect(surviving[0]).toEqual([{ kind: 'role', role: 'acme_anon', exists: true }])
    expect(surviving[1]).toEqual([
      { kind: 'role_attribute', role: 'acme_anon', attribute: 'login', value: true },
    ])
    expect(surviving[2]).toEqual([{ kind: 'role', role: 'acme_old', exists: false }])
  })

  it('lets a role created again after its removal survive', () => {
    const { surviving } = survivingGlobals([
      replay('DROP ROLE IF EXISTS acme_anon;\n'),
      replay('CREATE ROLE acme_anon;\n'),
    ])
    expect(surviving).toEqual([[], [{ kind: 'role', role: 'acme_anon', exists: true }]])
  })
})
