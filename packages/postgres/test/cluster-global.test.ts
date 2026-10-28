import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import { catalogNamedLater } from '../src/parser/cluster-global.ts'
import {
  type ClusterGlobalStatement,
  clusterGlobalStatements,
  expectationKey,
  guardStrictness,
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
      ["EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_b' LIMIT 0)", undefined],
      ["EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_b' LIMIT (SELECT 1))", undefined],
      ["EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_b') OR FOUND", undefined],
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
    // An ELSE branch that does more than raise a notice, or an ELSIF branch, runs when the
    // guard is false; so does a notice with an expression the replay would evaluate.
    expect(guard(roles, 'GRANT acme_a TO acme_b; ELSE GRANT acme_a TO acme_c;')).toBe(
      'mixed_do_block',
    )
    expect(guard(roles, "GRANT acme_a TO acme_b; RAISE NOTICE '%', public.acme_audit();")).toBe(
      'mixed_do_block',
    )
    expect(guard(roles, "GRANT acme_a TO acme_b; ELSE RAISE EXCEPTION 'missing';")).toBe(
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

  it('accepts the common safe shapes: a notice, an ELSE that only notices, AND, LIMIT (review)', () => {
    const notice = one(`DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_anon') THEN
    CREATE ROLE acme_anon NOLOGIN;
    RAISE NOTICE 'created';
  ELSE
    RAISE NOTICE 'role acme_anon exists';
  END IF;
END $$`)
    expect(notice.form).toBe('role_do_block')
    expect(notice.effects.expectations).toEqual([{ kind: 'role', role: 'acme_anon', exists: true }])
    const both = one(`DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_x' LIMIT 1)
     AND EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_y') THEN
    GRANT acme_x TO acme_y;
  END IF;
END $$`)
    expect(both.form).toBe('role_do_block')
    expect(both.effects.expectations).toEqual([
      {
        kind: 'membership',
        role: 'acme_x',
        member: 'acme_y',
        exists: true,
        when: [
          { kind: 'role', role: 'acme_x', exists: true },
          { kind: 'role', role: 'acme_y', exists: true },
        ],
      },
    ])
  })

  it('lets a later statement of the block supersede an earlier one about the same thing (review P2-2)', () => {
    const x = { kind: 'role', role: 'acme_x', exists: true } as const
    // Recreate: the role exists afterwards, while the guard holds.
    const recreate = one(`DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_x') THEN
    DROP ROLE acme_x;
    CREATE ROLE acme_x LOGIN;
  END IF;
END $$`)
    expect(recreate.effects.expectations).toEqual([
      { kind: 'role', role: 'acme_x', exists: true, when: [x] },
      { kind: 'role_attribute', role: 'acme_x', attribute: 'login', value: true, when: [x] },
    ])
    // Regrant: the membership exists afterwards, with ADMIN, while the guard holds.
    const ab = { kind: 'membership', role: 'acme_a', member: 'acme_b', exists: true } as const
    const regrant = one(`DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_auth_members WHERE roleid = 'acme_a'::regrole AND member = 'acme_b'::regrole) THEN
    REVOKE acme_a FROM acme_b;
    GRANT acme_a TO acme_b WITH ADMIN OPTION;
  END IF;
END $$`)
    expect(regrant.effects.expectations).toEqual([
      { ...ab, when: [ab] },
      {
        kind: 'membership_option',
        role: 'acme_a',
        member: 'acme_b',
        option: 'admin',
        value: true,
        when: [ab],
      },
    ])
    // A later statement behind a guard of its own does not supersede an earlier one.
    const narrower = one(`DO $$ BEGIN
  GRANT acme_a TO acme_b;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_x') THEN REVOKE acme_a FROM acme_b; END IF;
END $$`)
    expect(narrower.effects.expectations).toEqual([
      { kind: 'membership', role: 'acme_a', member: 'acme_b', exists: true },
      { kind: 'membership', role: 'acme_a', member: 'acme_b', exists: false, when: [x] },
    ])
  })

  it('keeps unconditional behind NOT EXISTS only the guard subject made present (review P3-1)', () => {
    const s = one(`DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'acme_x') THEN
    CREATE ROLE acme_x NOLOGIN;
    GRANT acme_x TO acme_auth;
    DROP ROLE acme_y;
  END IF;
END $$`)
    expect(s.effects.expectations).toEqual([
      { kind: 'role', role: 'acme_x', exists: true },
      // Checked, but never superseding: they ran only if acme_x was missing then.
      { kind: 'membership', role: 'acme_x', member: 'acme_auth', exists: true, when: [] },
      { kind: 'role', role: 'acme_y', exists: false, when: [] },
    ])
  })

  it('stays mixed with a declared variable, a guard catalog the file shadows (security review)', () => {
    for (const declare of [
      'DECLARE found boolean := public.acme_seed();',
      "DECLARE sqlstate text := nextval('public.acme_s')::text;",
      'DECLARE sqlerrm CONSTANT text := public.acme_seed();',
      'DECLARE found boolean;',
    ]) {
      expect(one(`DO $$ ${declare} BEGIN GRANT acme_a TO acme_b; END $$`).form, declare).toBe(
        'mixed_do_block',
      )
    }
    expect(
      one(
        'DO $$ BEGIN DECLARE found boolean := public.acme_seed(); BEGIN GRANT acme_a TO acme_b; END; END $$',
      ).form,
    ).toBe('mixed_do_block')
    // A temporary pg_roles is found before pg_catalog's: in such a file only qualified guards count.
    const shadowed = (from: string) =>
      (clusterGlobalStatements(
        17,
        `CREATE TEMP TABLE pg_roles (rolname name);
DO $$ BEGIN IF EXISTS (SELECT 1 FROM ${from} WHERE rolname = 'acme_x') THEN GRANT acme_a TO acme_x; END IF; END $$;`,
      ) ?? [])[0]?.form
    expect(shadowed('pg_roles')).toBe('mixed_do_block')
    expect(shadowed('pg_catalog.pg_roles')).toBe('role_do_block')
  })

  it('cuts a guard name to 63 bytes as PostgreSQL does (security review)', () => {
    const long = `acme_${'x'.repeat(70)}`
    const s = one(
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${long}') THEN GRANT acme_a TO ${long}; END IF; END $$`,
    )
    const [e] = s.effects.expectations
    expect(e).toMatchObject({ member: long.slice(0, 63), when: [{ role: long.slice(0, 63) }] })
  })
})

describe('guarded DO blocks: the verification review of follow-up 2', () => {
  const guard = (role: string) => `SELECT FROM pg_catalog.pg_roles WHERE rolname = '${role}'`

  it('stays mixed with any datum but the parser own: a constant of a domain or %TYPE (P2-1)', () => {
    for (const declare of [
      'DECLARE sqlstate CONSTANT public.carrier.v%TYPE;',
      'DECLARE sqlstate CONSTANT public.acme_domain;',
      'DECLARE sqlerrm CONSTANT text;',
    ]) {
      expect(
        one(
          `DO $$ ${declare} BEGIN IF NOT EXISTS (${guard('acme_a')}) THEN CREATE ROLE acme_a; END IF; END $$`,
        ).form,
        declare,
      ).toBe('mixed_do_block')
    }
    // The implicit ones of two exception blocks are the parser's own.
    expect(
      one(`DO $$ BEGIN
  BEGIN CREATE ROLE acme_a; EXCEPTION WHEN duplicate_object THEN RAISE NOTICE '%', sqlerrm; END;
  BEGIN CREATE ROLE acme_b; EXCEPTION WHEN duplicate_object THEN RAISE NOTICE '%', sqlstate; END;
END $$`).form,
    ).toBe('role_do_block')
  })

  it('reads guards only as written in pg_catalog when the history may resolve them elsewhere (P2-2, P3-3)', () => {
    const block = (from: string, cast = '::regrole', op = '=') =>
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM ${from} WHERE roleid ${op} 'acme_a'${cast} AND member ${op} 'acme_b'${cast}) THEN GRANT acme_a TO acme_b; END IF; END $$;`
    const form = (history: string, text: string) =>
      clusterGlobalStatements(17, text, guardStrictness([history, text]))?.at(-1)?.form
    // An operator named = (here, or in another file of the history): only OPERATOR(pg_catalog.=)
    // and qualified casts count.
    const operator =
      'CREATE OPERATOR public.= (LEFTARG = oid, RIGHTARG = regrole, FUNCTION = public.acme_eq);'
    expect(guardStrictness([operator])).toBe('all')
    expect(form(operator, block('pg_catalog.pg_auth_members'))).toBe('mixed_do_block')
    expect(
      form(
        operator,
        block('pg_catalog.pg_auth_members', '::pg_catalog.regrole', 'OPERATOR(pg_catalog.=)'),
      ),
    ).toBe('role_do_block')
    // A search_path that names pg_catalog after another schema: the same.
    const path = "SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);"
    expect(guardStrictness([path])).toBe('all')
    expect(form(path, block('pg_catalog.pg_auth_members'))).toBe('mixed_do_block')
    // An empty search_path, as pg_dump sets it, keeps pg_catalog first.
    expect(guardStrictness(["SELECT pg_catalog.set_config('search_path', '', false);"])).toBe(
      'none',
    )
    // A relation under a guard catalog's name, made in any way and in any file: only
    // pg_catalog.pg_roles counts.
    for (const shadow of [
      "SELECT 'acme_a'::name AS rolname INTO TEMPORARY TABLE pg_roles;",
      'ALTER VIEW acme_v RENAME TO pg_roles;',
      "DO $x$ BEGIN EXECUTE 'CREATE TEMPORARY VIEW pg_roles AS SELECT 1'; END $x$;",
      'CREATE TEMP TABLE IF NOT EXISTS "pg_auth_members" (roleid oid);',
    ]) {
      expect(guardStrictness([shadow]), shadow).toBe('relations')
      expect(form(shadow, block('pg_auth_members')), shadow).toBe('mixed_do_block')
      expect(form(shadow, block('pg_catalog.pg_auth_members')), shadow).toBe('role_do_block')
    }
    expect(guardStrictness(['SELECT rolname FROM pg_roles;'])).toBe('none')
  })

  it('keeps conditional what waited for another missing thing too (P2-5)', () => {
    const s = one(`DO $$ BEGIN
  IF NOT EXISTS (${guard('acme_a')}) AND NOT EXISTS (${guard('acme_b')}) THEN
    CREATE ROLE acme_a;
  END IF;
END $$`)
    expect(s.effects.expectations).toEqual([
      { kind: 'role', role: 'acme_a', exists: true, when: [] },
    ])
    const nested = one(`DO $$ BEGIN
  IF NOT EXISTS (${guard('acme_b')}) THEN
    IF NOT EXISTS (${guard('acme_a')}) THEN CREATE ROLE acme_a; END IF;
  END IF;
END $$`)
    expect(nested.effects.expectations).toEqual([
      { kind: 'role', role: 'acme_a', exists: true, when: [] },
    ])
  })

  it('never lets a later IF supersede an earlier one with the same guard: each decides anew (P3-1)', () => {
    const s = one(`DO $$ BEGIN
  IF EXISTS (${guard('acme_a')}) THEN DROP ROLE acme_a; END IF;
  IF EXISTS (${guard('acme_a')}) THEN CREATE ROLE acme_a; END IF;
END $$`)
    expect(s.effects.expectations).toEqual([
      { kind: 'role', role: 'acme_a', exists: false },
      {
        kind: 'role',
        role: 'acme_a',
        exists: true,
        when: [{ kind: 'role', role: 'acme_a', exists: true }],
      },
    ])
  })

  it('stays mixed with a notice that names SQLERRM outside a handler (P3-2)', () => {
    expect(
      one(`DO $$ BEGIN
  BEGIN
    RAISE NOTICE 'creating (%)', sqlerrm;
    CREATE ROLE acme_raise_a;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'skipped: %', sqlerrm;
  END;
END $$`).form,
    ).toBe('mixed_do_block')
  })

  it('does not read a ::text guard longer than a name as one (P3-4)', () => {
    const long = 'a'.repeat(70)
    expect(
      one(
        `DO $$ BEGIN IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${long}'::text) THEN DROP ROLE ${long}; END IF; END $$`,
      ).form,
    ).toBe('mixed_do_block')
  })

  it('calls a block nested deeper than it follows mixed, without running out of stack (P3-6)', () => {
    const n = 3000
    const text = `DO $$ BEGIN ${'IF true THEN '.repeat(n)}CREATE ROLE acme_a;${' END IF;'.repeat(n)} END $$`
    expect(one(text).form).toBe('mixed_do_block')
    const guarded = `DO $$ BEGIN ${`IF EXISTS (${guard('acme_b')}) THEN `.repeat(80)}CREATE ROLE acme_a;${' END IF;'.repeat(80)} END $$`
    expect(one(guarded).form).toBe('mixed_do_block')
  })
})

/**
 * The `search_path` check of the guard strictness ran a lazy, backtracking
 * regular expression over the raw text of the history: quadratic in the
 * length of one statement, synchronous, and reachable with a 100 KB file
 * (TC-004, Part A P1 no. 3; 17 s at 100 000 characters, hours at 4 MiB).
 */
describe('the search_path check of the guard strictness', () => {
  /** What the function replaced: the semantic reference, quadratic on long input. */
  const OLD = /\bsearch_path\b[^;]*?,\s*["']?\s*pg_catalog\b/i

  it('reads pg_catalog after another schema, in one statement only', () => {
    for (const text of [
      'SET search_path = public, pg_catalog;',
      "SELECT set_config('search_path', 'public,pg_catalog', false);",
      'ALTER ROLE r SET search_path = a,\n  "pg_catalog", b',
      "set SEARCH_PATH = a , 'pg_catalog'",
    ]) {
      expect(catalogNamedLater(text), text).toBe(true)
    }
    for (const text of [
      'SET search_path = pg_catalog, public;',
      "SELECT set_config('search_path', '', false);",
      'SET search_path = a; SELECT 1, pg_catalog.now();',
      'SET search_path = a, pg_catalogx;',
      'SELECT 1, pg_catalog.now(); SET search_path = a;',
    ]) {
      expect(catalogNamedLater(text), text).toBe(false)
    }
  })

  it('agrees with the regular expression it replaced on short generated texts', () => {
    const atoms = [
      'search_path',
      'SEARCH_PATH',
      'xsearch_path',
      ' ',
      '\n',
      ',',
      ';',
      '=',
      "'",
      '"',
      '.',
      'pg_catalog',
      'PG_CATALOG',
      'pg_catalogx',
      'public',
      'a',
    ]
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...atoms), { maxLength: 16 }).map((a) => a.join('')),
        (text) => catalogNamedLater(text) === OLD.test(text),
      ),
      { numRuns: 30_000 },
    )
  })

  it('keeps the history strictness: a ; after each search_path is none, a real pg_catalog later is all', () => {
    const terminated = 'SET search_path = a, b; '.repeat(1000)
    expect(guardStrictness([terminated])).toBe('none')
    expect(guardStrictness([`${terminated}SET search_path = public, pg_catalog;`])).toBe('all')
  })

  // Linear is 4 when the size grows by 4, quadratic 16; a machine's speed cancels out.
  const SMALL = 256 * 1024
  const LARGE = 1024 * 1024
  const families: Record<string, (chars: number) => string> = {
    one_ws: (n) => `SET search_path =,${' '.repeat(n)}`,
    rep_noterm: (n) => 'SET search_path = a, b '.repeat(Math.ceil(n / 23)),
    rep_comma: (n) => 'search_path,'.repeat(Math.ceil(n / 12)),
    rep_pad: (n) => `search_path${' '.repeat(40)}`.repeat(Math.ceil(n / 51)),
  }
  const best = (text: string): number => {
    let ms = Number.POSITIVE_INFINITY
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      guardStrictness([text])
      ms = Math.min(ms, performance.now() - t0)
    }
    return ms
  }
  it.each(Object.keys(families))('takes linear time on the %s family', (family) => {
    const make = families[family] as (chars: number) => string
    const small = best(make(SMALL))
    const large = best(make(LARGE))
    expect(guardStrictness([make(LARGE)])).toBe('none')
    expect(large).toBeLessThan(200)
    // A floor of 5 ms keeps timer noise out of the ratio of two very fast runs.
    expect(large / Math.max(small, 5)).toBeLessThan(8)
  })
})
