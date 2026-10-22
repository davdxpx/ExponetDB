import { beforeAll, describe, expect, it } from 'vitest'
import {
  type ClusterGlobalStatement,
  clusterGlobalStatements,
  expectationKey,
  loadClusterGlobalParsers,
  quoteIdentLike,
} from '../src/parser/index.ts'

/**
 * Cluster-global effects of legacy role statements (legacy-import.md §2.4,
 * Wave 9 order A6): what the replay elides and what it checks instead.
 * Each major's own grammar reads the file; the PL/pgSQL parser of 18 reads
 * `DO` bodies.
 */
beforeAll(async () => {
  await Promise.all([16, 17, 18].map((m) => loadClusterGlobalParsers(m as 16 | 17 | 18)))
})

const one = (text: string, major: 16 | 17 | 18 = 17): ClusterGlobalStatement => {
  const all = clusterGlobalStatements(major, text) ?? []
  expect(all).toHaveLength(1)
  return all[0] as ClusterGlobalStatement
}

describe('top-level role statements', () => {
  it('states existence, the attributes and memberships of CREATE ROLE, never a password', () => {
    const s = one(
      "CREATE ROLE acme_anon NOLOGIN NOINHERIT BYPASSRLS CONNECTION LIMIT 5 PASSWORD 'secret' IN ROLE acme_web ROLE acme_member ADMIN acme_admin;",
    )
    expect(s).toMatchObject({ index: 0, form: 'role_statement', type: 'CreateRoleStmt' })
    expect(s.effects.unknown).toBe(false)
    expect(s.effects.expectations).toEqual([
      { kind: 'role', role: 'acme_anon', exists: true },
      { kind: 'role_attribute', role: 'acme_anon', attribute: 'login', value: false },
      { kind: 'role_attribute', role: 'acme_anon', attribute: 'inherit', value: false },
      { kind: 'role_attribute', role: 'acme_anon', attribute: 'bypassrls', value: true },
      { kind: 'role_connection_limit', role: 'acme_anon', value: 5 },
      { kind: 'membership', role: 'acme_web', member: 'acme_anon', exists: true },
      { kind: 'membership', role: 'acme_anon', member: 'acme_member', exists: true },
      { kind: 'membership', role: 'acme_anon', member: 'acme_admin', exists: true },
      {
        kind: 'membership_option',
        role: 'acme_anon',
        member: 'acme_admin',
        option: 'admin',
        value: true,
      },
    ])
    expect(JSON.stringify(s.effects)).not.toContain('secret')
  })

  it('reads ALTER ROLE and ALTER GROUP, and a connection limit of 0', () => {
    expect(one('ALTER ROLE acme_anon WITH LOGIN CONNECTION LIMIT 0').effects.expectations).toEqual([
      { kind: 'role_attribute', role: 'acme_anon', attribute: 'login', value: true },
      { kind: 'role_connection_limit', role: 'acme_anon', value: 0 },
    ])
    expect(one('ALTER GROUP acme_web ADD USER acme_anon').effects.expectations).toEqual([
      { kind: 'membership', role: 'acme_web', member: 'acme_anon', exists: true },
    ])
    expect(one('ALTER GROUP acme_web DROP USER acme_anon').effects.expectations).toEqual([
      { kind: 'membership', role: 'acme_web', member: 'acme_anon', exists: false },
    ])
  })

  it('renders role settings as PostgreSQL stores them, and refuses to guess the others', () => {
    expect(
      one('ALTER ROLE acme_anon SET search_path = public, "Ext", "$user", extensions').effects
        .expectations,
    ).toEqual([
      {
        kind: 'role_setting',
        role: 'acme_anon',
        database: null,
        name: 'search_path',
        value: 'public, "Ext", "$user", extensions',
      },
    ])
    expect(
      one("ALTER ROLE acme_anon IN DATABASE acme SET statement_timeout = '3s'").effects
        .expectations,
    ).toEqual([
      {
        kind: 'role_setting',
        role: 'acme_anon',
        database: 'acme',
        name: 'statement_timeout',
        value: '3s',
      },
    ])
    expect(one('ALTER ROLE acme_anon SET work_mem = 4096').effects.expectations[0]).toMatchObject({
      value: '4096',
    })
    expect(one('ALTER ROLE acme_anon RESET search_path').effects.expectations).toEqual([
      { kind: 'role_setting', role: 'acme_anon', database: null, name: 'search_path', value: null },
    ])
    expect(one('ALTER ROLE ALL SET acme.flag = 1').effects.expectations[0]).toMatchObject({
      role: null,
      name: 'acme.flag',
      value: '1',
    })
    for (const q of [
      'ALTER ROLE acme_anon SET work_mem FROM CURRENT',
      'ALTER ROLE acme_anon RESET ALL',
      'ALTER ROLE CURRENT_USER SET work_mem = 1',
    ]) {
      expect(one(q).effects, q).toEqual({ expectations: [], unknown: true })
    }
  })

  it('reads DROP ROLE, GRANT and REVOKE of roles with their options, RENAME and COMMENT', () => {
    expect(one('DROP ROLE IF EXISTS acme_old, acme_older').effects.expectations).toEqual([
      { kind: 'role', role: 'acme_old', exists: false },
      { kind: 'role', role: 'acme_older', exists: false },
    ])
    expect(
      one('GRANT acme_anon TO acme_auth WITH INHERIT FALSE, SET TRUE').effects.expectations,
    ).toEqual([
      { kind: 'membership', role: 'acme_anon', member: 'acme_auth', exists: true },
      {
        kind: 'membership_option',
        role: 'acme_anon',
        member: 'acme_auth',
        option: 'inherit',
        value: false,
      },
      {
        kind: 'membership_option',
        role: 'acme_anon',
        member: 'acme_auth',
        option: 'set',
        value: true,
      },
    ])
    expect(one('REVOKE acme_anon FROM acme_auth').effects.expectations).toEqual([
      { kind: 'membership', role: 'acme_anon', member: 'acme_auth', exists: false },
    ])
    expect(one('REVOKE ADMIN OPTION FOR acme_anon FROM acme_auth').effects.expectations).toEqual([
      {
        kind: 'membership_option',
        role: 'acme_anon',
        member: 'acme_auth',
        option: 'admin',
        value: false,
      },
    ])
    expect(one('GRANT acme_anon TO CURRENT_USER').effects.unknown).toBe(true)
    expect(one('ALTER ROLE acme_anon RENAME TO acme_public').effects.expectations).toEqual([
      { kind: 'role', role: 'acme_anon', exists: false },
      { kind: 'role', role: 'acme_public', exists: true },
    ])
    expect(one("COMMENT ON ROLE acme_anon IS 'the public role'").effects.expectations).toEqual([
      { kind: 'role_comment', role: 'acme_anon', value: 'the public role' },
    ])
  })

  it('keys expectations so a later statement about the same thing supersedes an earlier one', () => {
    const [a, b] = [
      one('ALTER ROLE acme_anon LOGIN').effects.expectations[0],
      one('ALTER ROLE acme_anon NOLOGIN').effects.expectations[0],
    ]
    expect(a && expectationKey(a)).toBe(b && expectationKey(b))
    expect(quoteIdentLike('public')).toBe('public')
    expect(quoteIdentLike('$user')).toBe('"$user"')
    expect(quoteIdentLike('Ext"x')).toBe('"Ext""x"')
  })

  it('leaves every other statement alone, and the same on 16, 17 and 18', () => {
    for (const major of [16, 17, 18] as const) {
      const all = clusterGlobalStatements(
        major,
        'CREATE TABLE public.acme_t (id int);\nCREATE ROLE acme_anon;\nREASSIGN OWNED BY acme_a TO acme_b;\n',
      )
      expect(all?.map((s) => [s.index, s.form])).toEqual([[1, 'role_statement']])
    }
  })
})

describe('DO blocks (the PL/pgSQL parser of 18)', () => {
  const ROLE_ONLY = `DO $$
BEGIN
  CREATE ROLE acme_anon NOLOGIN;
  GRANT acme_anon TO acme_auth;
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'exists: %', SQLERRM;
END
$$;`

  it('elides a block of role statements and handlers, keeping only presence under a handler', () => {
    for (const major of [16, 17, 18] as const) {
      const s = one(ROLE_ONLY, major)
      expect(s.form).toBe('role_do_block')
      expect(s.effects).toEqual({
        expectations: [
          { kind: 'role', role: 'acme_anon', exists: true },
          { kind: 'membership', role: 'acme_anon', member: 'acme_auth', exists: true },
        ],
        unknown: false,
      })
    }
  })

  it('accepts nested blocks, each with its handler', () => {
    const s = one(`DO $$ BEGIN
  BEGIN CREATE ROLE acme_anon; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN GRANT acme_anon TO acme_auth; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END;
END $$`)
    expect(s.form).toBe('role_do_block')
    expect(s.effects.expectations).toHaveLength(2)
  })

  it('keeps the attributes of a block without a handler', () => {
    const s = one('DO $$ BEGIN CREATE ROLE acme_anon NOLOGIN; END $$')
    expect(s.form).toBe('role_do_block')
    expect(s.effects.expectations).toContainEqual({
      kind: 'role_attribute',
      role: 'acme_anon',
      attribute: 'login',
      value: false,
    })
  })

  it('calls a block mixed when it does anything else next to its role statements', () => {
    for (const body of [
      'CREATE ROLE acme_anon; CREATE TABLE public.acme_t (id int);',
      'CREATE ROLE acme_anon; PERFORM pg_catalog.pg_sleep(0);',
    ]) {
      expect(one(`DO $$ BEGIN ${body} END $$`).form, body).toBe('mixed_do_block')
    }
    expect(one(`DO $$ DECLARE n int := 1; BEGIN CREATE ROLE acme_anon; END $$`).form).toBe(
      'mixed_do_block',
    )
    expect(
      one(
        `DO $$ BEGIN CREATE ROLE acme_anon; EXCEPTION WHEN others THEN RAISE EXCEPTION 'no'; END $$`,
      ).form,
    ).toBe('mixed_do_block')
    expect(
      one(
        `DO $$ BEGIN CREATE ROLE acme_anon; EXCEPTION WHEN others THEN RAISE NOTICE '%', pg_catalog.now(); END $$`,
      ).form,
    ).toBe('mixed_do_block')
  })

  it('ends a block mixed at a RETURN that is not the last statement of the block', () => {
    expect(one('DO $$ BEGIN BEGIN RETURN; END; CREATE ROLE acme_anon; END $$').form).toBe(
      'mixed_do_block',
    )
  })

  it('leaves a DO block without role statements, or in another language, alone', () => {
    expect(
      clusterGlobalStatements(17, 'DO $$ BEGIN CREATE TABLE public.acme_t (id int); END $$'),
    ).toEqual([])
    expect(clusterGlobalStatements(17, "DO $$ BEGIN EXECUTE 'SELECT 1'; END $$")).toEqual([])
    expect(clusterGlobalStatements(17, 'DO LANGUAGE sql $$ SELECT 1 $$')).toEqual([])
  })
})

describe('DO blocks with IF EXISTS guards on pg_roles and pg_auth_members (follow-up 2, F1)', () => {
  // The two shapes of the first real import (a Supabase-origin history).
  const CASE_STUDIES = `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_consent_writer') THEN
    GRANT acme_case_study_reader TO acme_consent_writer;
  END IF;
END $$;`
  const TEAM_PROFILES = `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_consent_writer') THEN
    GRANT acme_team_reader TO acme_consent_writer;
  END IF;
END
$$;`
  const consentWriter = { kind: 'role', role: 'acme_consent_writer', exists: true } as const

  it('elides a GRANT behind an EXISTS guard and checks it only while the guard holds', () => {
    for (const major of [16, 17, 18] as const) {
      for (const [text, role] of [
        [CASE_STUDIES, 'acme_case_study_reader'],
        [TEAM_PROFILES, 'acme_team_reader'],
      ] as const) {
        const s = one(text, major)
        expect(s.form).toBe('role_do_block')
        expect(s.effects).toEqual({
          expectations: [
            {
              kind: 'membership',
              role,
              member: 'acme_consent_writer',
              exists: true,
              when: [consentWriter],
            },
          ],
          unknown: false,
        })
      }
    }
  })

  it('keeps only presence behind a NOT EXISTS guard, unconditionally', () => {
    const s = one(`DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'acme_anon') THEN
    CREATE ROLE acme_anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_auth_members m
                  WHERE m.roleid = 'acme_anon'::regrole AND m.member = 'Acme_Auth'::pg_catalog.regrole) THEN
    GRANT acme_anon TO acme_auth WITH ADMIN OPTION;
  END IF;
END $$`)
    expect(s.form).toBe('role_do_block')
    expect(s.effects).toEqual({
      expectations: [
        { kind: 'role', role: 'acme_anon', exists: true },
        { kind: 'membership', role: 'acme_anon', member: 'acme_auth', exists: true },
      ],
      unknown: false,
    })
  })

  it('stacks nested guards, and drops a guard its own statement undoes', () => {
    const s = one(`DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_a') THEN
    IF EXISTS (SELECT FROM pg_auth_members WHERE roleid = 'acme_a'::regrole AND member = '"Acme B"'::regrole) THEN
      REVOKE acme_a FROM "Acme B";
      GRANT acme_c TO "Acme B";
    END IF;
    BEGIN
      ALTER ROLE acme_a NOLOGIN;
    EXCEPTION WHEN undefined_object THEN NULL;
    END;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE 'acme_old' = rolname) THEN
    DROP ROLE acme_old;
  END IF;
END $$`)
    const a = { kind: 'role', role: 'acme_a', exists: true } as const
    const ab = { kind: 'membership', role: 'acme_a', member: 'Acme B', exists: true } as const
    expect(s.form).toBe('role_do_block')
    expect(s.effects.expectations).toEqual([
      { kind: 'membership', role: 'acme_a', member: 'Acme B', exists: false, when: [a] },
      { kind: 'membership', role: 'acme_c', member: 'Acme B', exists: true, when: [a, ab] },
      // Under the handler only presence is kept, and ALTER ROLE states nothing else.
      { kind: 'role', role: 'acme_old', exists: false },
    ])
  })

  it('stays mixed with a guard next to anything else, or a guard that is not a plain catalog read', () => {
    const guard = (cond: string, body = 'GRANT acme_a TO acme_b;') =>
      one(`DO $$ BEGIN IF ${cond} THEN ${body} END IF; END $$`).form
    const roles = "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_b')"
    for (const [cond, body] of [
      // A guard plus a statement that is not a role statement.
      [roles, 'GRANT acme_a TO acme_b; CREATE TABLE public.acme_t (id int);'],
      [roles, 'GRANT acme_a TO acme_b; PERFORM pg_catalog.pg_sleep(0);'],
      [roles, "GRANT acme_a TO acme_b; EXECUTE 'GRANT acme_a TO acme_c';"],
      // Anything in the guard beyond a plain read of pg_roles or pg_auth_members.
      ["EXISTS (SELECT public.acme_audit() FROM pg_roles WHERE rolname = 'acme_b')", undefined],
      [
        "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_b' AND public.acme_audit())",
        undefined,
      ],
      ["EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_b' OR rolname = 'acme_c')", undefined],
      ["EXISTS (SELECT 1 FROM pg_roles WHERE rolname = lower('ACME_B'))", undefined],
      ["EXISTS (SELECT 1 FROM pg_roles WHERE rolname LIKE 'acme_%')", undefined],
      ["EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_b' LIMIT 1)", undefined],
      ["EXISTS (SELECT 1 FROM public.pg_roles WHERE rolname = 'acme_b')", undefined],
      ["EXISTS (SELECT 1 FROM pg_roles, pg_database WHERE rolname = 'acme_b')", undefined],
      ["EXISTS (SELECT 1 FROM pg_class WHERE relname = 'acme_b')", undefined],
      ["EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_b' UNION SELECT 1)", undefined],
      ["(SELECT count(*) FROM pg_roles WHERE rolname = 'acme_b') > 0", undefined],
      ["EXISTS (SELECT 1 FROM pg_roles WHERE rolname = (SELECT 'acme_b'))", undefined],
      ["EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = 'acme_a'::regrole)", undefined],
      [
        "EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = '16384'::regrole AND member = 'acme_b'::regrole)",
        undefined,
      ],
      [
        "EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = 'acme_a' AND member = 'acme_b')",
        undefined,
      ],
      ['FOUND', undefined],
      ["current_user = 'acme_b'", undefined],
    ] as const) {
      expect(guard(cond, body), `${cond} ${body ?? ''}`).toBe('mixed_do_block')
    }
    // An ELSE or ELSIF branch runs when the guard is false.
    expect(guard(roles, 'GRANT acme_a TO acme_b; ELSE GRANT acme_a TO acme_c;')).toBe(
      'mixed_do_block',
    )
    expect(
      guard(roles, `GRANT acme_a TO acme_b; ELSIF ${roles} THEN GRANT acme_a TO acme_c;`),
    ).toBe('mixed_do_block')
    // A RETURN inside a guard skips what follows it.
    expect(
      one(`DO $$ BEGIN IF ${roles} THEN RETURN; END IF; GRANT acme_a TO acme_b; END $$`).form,
    ).toBe('mixed_do_block')
  })
})
