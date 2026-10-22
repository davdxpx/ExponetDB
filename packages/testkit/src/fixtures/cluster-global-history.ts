import type { LegacyFile } from './legacy-history.ts'

/**
 * A synthetic legacy history whose files change roles, in the shapes
 * Supabase-origin projects use (Wave 9 order A6): top-level role
 * statements, a `DO` block that swallows `duplicate_object`, `GRANT
 * <role> TO <role>` with options, `ALTER ROLE … SET`, `IF [NOT] EXISTS`
 * guards on `pg_roles` (the shapes of the first real import, follow-up 2
 * F1: a grant to a role that exists, one to a role that does not), a mixed
 * `DO` block, `CREATE INDEX CONCURRENTLY`, a comment-only file, and one
 * file whose role statement the target no longer reflects.
 *
 * Roles are cluster-wide and test servers are shared, so every name carries
 * `suffix`. Only shapes: no consumer name, no password, no data.
 */
export interface ClusterGlobalHistory {
  readonly files: readonly LegacyFile[]
  /** The roles the history names (for cleanup). */
  readonly roles: readonly string[]
  /** What the history left on the imported target, run as a superuser. */
  readonly targetStatements: (owner: string) => string[]
  /** What exists on every target of the cluster before any file (the platform's own roles). */
  readonly clusterStatements: string[]
}

export function clusterGlobalHistory(suffix: string): ClusterGlobalHistory {
  const anon = `acme_anon_${suffix}`
  const auth = `acme_auth_${suffix}`
  const svc = `acme_svc_${suffix}`
  const legacy = `acme_legacy_${suffix}`
  const reader = `acme_case_reader_${suffix}`
  const consent = `acme_consent_writer_${suffix}`
  const absent = `acme_absent_${suffix}`
  const files: LegacyFile[] = [
    {
      name: '0200_roles.sql',
      text: `-- Roles the application expects (top level).
CREATE ROLE ${anon} NOLOGIN NOINHERIT;
CREATE ROLE ${auth} NOLOGIN;
COMMENT ON ROLE ${anon} IS 'requests without a session';
`,
    },
    {
      name: '0201_service_role.sql',
      text: `DO $$
BEGIN
  CREATE ROLE ${svc} NOLOGIN BYPASSRLS;
  GRANT ${anon} TO ${svc};
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'already there: %', SQLERRM;
END
$$;
`,
    },
    {
      name: '0202_grants.sql',
      text: `CREATE TABLE public.acme_profiles (id bigint PRIMARY KEY, handle text NOT NULL);
--> statement-breakpoint
GRANT SELECT ON public.acme_profiles TO ${anon};
GRANT ${anon} TO ${auth} WITH INHERIT FALSE, SET TRUE;
ALTER ROLE ${auth} SET search_path = public, extensions;
`,
    },
    {
      name: '0203_optional_role.sql',
      text: `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${legacy}') THEN
    CREATE ROLE ${legacy} NOLOGIN;
  END IF;
END $$;
`,
    },
    {
      name: '0204_index.sql',
      text: `CREATE TABLE public.acme_events (id bigint PRIMARY KEY, kind text NOT NULL);
CREATE INDEX CONCURRENTLY acme_events_kind ON public.acme_events (kind);
COMMENT ON TABLE public.acme_events IS 'what happened';
`,
    },
    {
      name: '0205_notes.sql',
      text: '-- This change was folded into 0204; the file stays for the history.\n',
    },
    {
      name: '0206_limits.sql',
      text: `ALTER ROLE ${svc} CONNECTION LIMIT 3;\n`,
    },
    {
      name: '0207_case_studies.sql',
      text: `CREATE ROLE ${reader} NOLOGIN;
CREATE TABLE public.acme_case_studies (id bigint PRIMARY KEY, title text NOT NULL);
GRANT SELECT ON public.acme_case_studies TO ${reader};
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${consent}') THEN
    GRANT ${reader} TO ${consent};
  END IF;
END $$;
`,
    },
    {
      name: '0208_absent_role.sql',
      text: `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${absent}') THEN
    GRANT ${reader} TO ${absent};
  END IF;
END
$$;
`,
    },
    {
      name: '0209_mixed.sql',
      text: `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${legacy}') THEN
    CREATE ROLE ${legacy} NOLOGIN;
  END IF;
  RAISE NOTICE 'roles checked';
END $$;
`,
    },
  ]
  return {
    files,
    roles: [anon, auth, svc, legacy, reader, consent],
    clusterStatements: [
      // The optional role exists on the cluster, so the mixed block's guard skips its CREATE.
      `CREATE ROLE ${legacy} NOLOGIN`,
      // A role of the platform the case studies grant to; the absent one is never created.
      `CREATE ROLE ${consent} NOLOGIN`,
    ],
    targetStatements: (owner) => [
      `CREATE ROLE ${anon} NOLOGIN NOINHERIT`,
      `CREATE ROLE ${auth} NOLOGIN`,
      `COMMENT ON ROLE ${anon} IS 'requests without a session'`,
      `CREATE ROLE ${svc} NOLOGIN BYPASSRLS`,
      `GRANT ${anon} TO ${svc}`,
      `GRANT ${anon} TO ${auth} WITH INHERIT FALSE, SET TRUE`,
      `ALTER ROLE ${auth} SET search_path = public, extensions`,
      // Changed by hand since 0206: the file's limit no longer holds.
      `ALTER ROLE ${svc} CONNECTION LIMIT 5`,
      `SET ROLE ${owner}`,
      'CREATE TABLE public.acme_profiles (id bigint PRIMARY KEY, handle text NOT NULL)',
      `GRANT SELECT ON public.acme_profiles TO ${anon}`,
      'CREATE TABLE public.acme_events (id bigint PRIMARY KEY, kind text NOT NULL)',
      'CREATE INDEX acme_events_kind ON public.acme_events (kind)',
      "COMMENT ON TABLE public.acme_events IS 'what happened'",
      'RESET ROLE',
      `CREATE ROLE ${reader} NOLOGIN`,
      `GRANT ${reader} TO ${consent}`,
      `SET ROLE ${owner}`,
      'CREATE TABLE public.acme_case_studies (id bigint PRIMARY KEY, title text NOT NULL)',
      `GRANT SELECT ON public.acme_case_studies TO ${reader}`,
      'RESET ROLE',
    ],
  }
}
