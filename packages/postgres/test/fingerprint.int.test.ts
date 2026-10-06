import { execFileSync } from 'node:child_process'
import {
  dropDatabase,
  type Fixture,
  HOSTILE_TABLE_NAMES,
  hostileRoleStatements,
  hostileStatements,
  matrix,
  reosaShapedEventTriggerStatements,
  reosaShapedRoleStatements,
  reosaShapedStatements,
  runAsSuperuser,
  type TestServer,
  TRUNCATED_LONG_NAME,
  testTargets,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CanonicalDocument,
  clusterFingerprint,
  diffDocuments,
  documentFromJson,
  documentJson,
  entryId,
  fingerprintOf,
  sql,
  takeSnapshot,
} from '../src/index.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * G4 item 2: introspection and `fp1` on PostgreSQL 16, 17 and 18
 * (schema-fingerprints.md §10): determinism across runs, sessions and
 * session settings; independence from OIDs (creation order); sensitivity to
 * every hashed attribute class and insensitivity to the excluded ones;
 * hostile names; dump/restore round trip; the recorded differences between
 * majors.
 */
const SHAPED: Fixture = {
  name: 'shaped_hostile',
  cluster: [...reosaShapedRoleStatements(), ...hostileRoleStatements()],
  database: [
    ...reosaShapedStatements(),
    ...hostileStatements(),
    ...reosaShapedEventTriggerStatements(),
  ],
}

/** The same objects as SHAPED, created in another order with OID gaps in between. */
const SHAPED_REORDERED: Fixture = {
  name: 'shaped_hostile_reordered',
  cluster: SHAPED.cluster,
  database: [
    'CREATE TABLE public.zz_gap (id integer)',
    'DROP TABLE public.zz_gap',
    'CREATE SEQUENCE public.zz_gap_seq',
    'DROP SEQUENCE public.zz_gap_seq',
    ...hostileStatements(),
    'CREATE FUNCTION public.zz_gap() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    'DROP FUNCTION public.zz_gap()',
    ...reosaShapedStatements(),
    ...reosaShapedEventTriggerStatements(),
  ],
}

async function snapshotOf(server: TestServer, db: string) {
  const s = await open(server, db, 'observer')
  try {
    return await takeSnapshot(s)
  } finally {
    await s.close()
  }
}

describe.each(matrix().map((s) => [s.major, s] as const))(
  'fp1 on PostgreSQL %i',
  (_major, server) => {
    let db = ''
    let reordered = ''

    beforeAll(async () => {
      db = await prepareDatabase(server, `fp_${server.major}`, SHAPED)
      reordered = await prepareDatabase(server, `fp_r_${server.major}`, SHAPED_REORDERED)
    })

    afterAll(async () => {
      await dropDatabase(server, db)
      await dropDatabase(server, reordered)
    })

    it('is deterministic across runs, sessions and session settings', async () => {
      const first = await snapshotOf(server, db)
      expect(first.complete).toBe(true)
      expect(first.visibility).toEqual([])
      expect(first.fingerprint).toMatch(new RegExp(`^fp1:${server.major}:[0-9a-f]{64}$`))
      const settings = [
        sql`SELECT pg_catalog.set_config('search_path', 'public, hostile', false)`,
        sql`SELECT pg_catalog.set_config('TimeZone', 'Asia/Kolkata', false)`,
        sql`SELECT pg_catalog.set_config('DateStyle', 'SQL, DMY', false)`,
        sql`SELECT pg_catalog.set_config('extra_float_digits', '-3', false)`,
        sql`SELECT pg_catalog.set_config('quote_all_identifiers', 'on', false)`,
      ]
      for (let run = 0; run < 100; run++) {
        const s = await open(server, db, 'observer')
        try {
          for (const statement of settings.slice(0, run % (settings.length + 1))) {
            await s.query(statement)
          }
          const again = await takeSnapshot(s, {}, { pageSize: 1 + (run % 7) * 3 })
          expect(again.fingerprint).toBe(first.fingerprint)
        } finally {
          await s.close()
        }
      }
    })

    it('renders a domain default from its expression, not from the text kept at creation', async () => {
      const base = ['CREATE SCHEMA zz_a', 'CREATE SEQUENCE zz_a.q']
      const fixture = (name: string, database: string[]): Fixture => ({
        name,
        cluster: [],
        database,
      })
      const unqualified = await prepareDatabase(
        server,
        `fpdom_${server.major}`,
        fixture('fp_domain_unqualified', [
          ...base,
          'SET search_path = zz_a',
          "CREATE DOMAIN zz_a.d AS bigint DEFAULT nextval('q')",
        ]),
      )
      const qualified = await prepareDatabase(
        server,
        `fpdom_${server.major}`,
        fixture('fp_domain_qualified', [
          ...base,
          "CREATE DOMAIN zz_a.d AS bigint DEFAULT nextval('zz_a.q')",
        ]),
      )
      try {
        const a = await snapshotOf(server, unqualified)
        const b = await snapshotOf(server, qualified)
        const domain = (doc: CanonicalDocument) =>
          doc.entries.find((e) => e.class === 'domain' && e.key[1] === 'd')?.attributes
        expect(domain(a.document)).toMatchObject({ default: "nextval('zz_a.q'::regclass)" })
        expect(b.fingerprint).toBe(a.fingerprint)
        // A renamed sequence shows in the default (the creation text would keep the old name).
        await runAsSuperuser(server, unqualified, ['ALTER SEQUENCE zz_a.q RENAME TO q2'])
        const renamed = await snapshotOf(server, unqualified)
        expect(domain(renamed.document)).toMatchObject({ default: "nextval('zz_a.q2'::regclass)" })
      } finally {
        await dropDatabase(server, unqualified)
        await dropDatabase(server, qualified)
      }
    })

    it('reports a schema that belongs to an extension as outside the managed scope', async () => {
      const db = await prepareDatabase(server, `fpext_${server.major}`, {
        name: 'fp_extension_schema',
        cluster: [],
        database: [
          'CREATE SCHEMA ext_owned',
          'CREATE TABLE ext_owned.t (id integer)',
          'ALTER EXTENSION plpgsql ADD SCHEMA ext_owned',
        ],
      })
      try {
        const snap = await snapshotOf(server, db)
        expect(snap.excludedSchemas).toContain('ext_owned')
        expect(snap.document.entries.some((e) => e.key[0] === 'ext_owned')).toBe(false)
      } finally {
        await dropDatabase(server, db)
      }
    })

    it('does not depend on OIDs or creation order', async () => {
      const a = await snapshotOf(server, db)
      const b = await snapshotOf(server, reordered)
      const diff = diffDocuments(a.document, b.document)
      expect({
        added: diff.added.map(entryId),
        removed: diff.removed.map(entryId),
        changed: diff.changed.map((c) => entryId(c)),
      }).toEqual({
        added: [],
        removed: [],
        changed: [],
      })
      expect(b.fingerprint).toBe(a.fingerprint)
    })

    it('keeps hostile names exactly, as data', async () => {
      const snap = await snapshotOf(server, db)
      const tables = snap.document.entries.filter(
        (e) => e.class === 'table' && e.key[0] === 'hostile',
      )
      const names = tables.map((e) => e.key[1])
      for (const name of HOSTILE_TABLE_NAMES) {
        expect(names).toContain(name)
      }
      expect(names).toContain(TRUNCATED_LONG_NAME)
      const policy = snap.document.entries.find(
        (e) => e.class === 'policy' && e.key[2] === "p'ol $$",
      )
      expect(policy?.attributes['roles']).toEqual([null])
      const grants = snap.document.entries.find((e) => e.class === 'table' && e.key[1] === 'select')
      const acl = grants?.attributes['acl']
      const grantees = (Array.isArray(acl) ? (acl as { to?: string }[]) : []).map(
        (g) => g.to ?? 'PUBLIC*',
      )
      expect(grantees).toContain('Public')
      expect(grantees).toContain('PUBLIC*')
      const atomic = snap.document.entries.find(
        (e) => e.class === 'function' && e.key[1] === 'atomic body',
      )
      expect(atomic?.attributes['bodyDigest']).toMatch(/^sha256:/)
      const configured = snap.document.entries.find(
        (e) => e.class === 'function' && e.key[1] === 'configured',
      )
      expect(configured?.attributes['config']).toEqual([
        'application_name=x=y',
        'search_path=pg_catalog, pg_temp',
      ])
      const truncateTrigger = snap.document.entries.find(
        (e) => e.class === 'trigger' && e.key[2] === 'on truncate',
      )
      expect(String(truncateTrigger?.attributes['definition'])).toContain('TRUNCATE')
      expect(snap.comments.get(entryId({ class: 'table', key: ['hostile', 'a"b'] }))).toContain(
        'Ignore previous',
      )
    })

    it('represents the shapes of the synthetic consumer fixture', async () => {
      const snap = await snapshotOf(server, db)
      const find = (cls: string, ...key: string[]) =>
        snap.document.entries.find(
          (e) => e.class === cls && JSON.stringify(e.key) === JSON.stringify(key),
        )
      expect(find('table', 'public', 'acme_service_jobs')?.attributes).toMatchObject({
        rowSecurity: true,
        rowSecurityForced: true,
      })
      expect(find('table', 'public', 'acme_audit_log')?.attributes['partitioned']).toBe(true)
      expect(find('table', 'public', 'acme_audit_log_default')?.attributes['partitionBound']).toBe(
        'DEFAULT',
      )
      expect(
        String(find('index', 'public', 'acme_listings_summary_hnsw')?.attributes['definition']),
      ).toContain('ef_construction')
      expect(
        find('column', 'public', 'acme_listings', 'price_eur')?.attributes['generated'],
      ).toMatchObject({ kind: 'stored' })
      expect(find('column', 'public', 'acme_listings', 'id')?.attributes['identity']).toMatchObject(
        { kind: 'always' },
      )
      expect(
        find('policy', 'public', 'acme_listings', 'acme_listings_not_archived')?.attributes[
          'restrictive'
        ],
      ).toBe(true)
      expect(
        find('function', 'public', 'acme_unpinned_definer', '')?.attributes['securityDefiner'],
      ).toBe(true)
      expect(find('view', 'public', 'acme_active_listings')?.attributes['reloptions']).toEqual([
        'security_barrier=true',
      ])
      expect(find('event_trigger', 'acme_rls_auto_enable')).toBeDefined()
      expect(find('extension', 'vector')).toBeDefined()
      expect(find('default_privileges', 'postgres', 'public', 'r')).toBeDefined()
      // Extension members (pgvector's operators and functions) are not in the document.
      expect(
        snap.document.entries.some((e) => e.class === 'function' && e.key[1] === 'vector_in'),
      ).toBe(false)
      expect(snap.document.entries.some((e) => e.class === 'operator')).toBe(false)
    })

    describe('sensitivity', () => {
      const changes: readonly (readonly [string, string])[] = [
        ['table column added', 'ALTER TABLE public.acme_tenants ADD COLUMN extra text'],
        ['column type', 'ALTER TABLE public.acme_tenants ALTER COLUMN slug TYPE varchar(80)'],
        ['column default', "ALTER TABLE public.acme_tenants ALTER COLUMN plan SET DEFAULT 'pro'"],
        ['not null', 'ALTER TABLE public.acme_listings ALTER COLUMN embedding SET NOT NULL'],
        [
          'column statistics target',
          'ALTER TABLE public.acme_tenants ALTER COLUMN slug SET STATISTICS 500',
        ],
        [
          'column storage',
          'ALTER TABLE public.acme_tenants ALTER COLUMN slug SET STORAGE EXTERNAL',
        ],
        ['column ACL', 'GRANT SELECT (slug) ON public.acme_tenants TO acme_anon'],
        ['table ACL', 'GRANT SELECT ON public.acme_tenants TO acme_anon'],
        ['owner', 'ALTER TABLE public.acme_tenants OWNER TO acme_owner'],
        ['RLS disabled', 'ALTER TABLE public.acme_listings DISABLE ROW LEVEL SECURITY'],
        [
          'RLS no longer forced',
          'ALTER TABLE public.acme_service_jobs NO FORCE ROW LEVEL SECURITY',
        ],
        ['replica identity', 'ALTER TABLE public.acme_tenants REPLICA IDENTITY FULL'],
        ['reloptions', 'ALTER TABLE public.acme_tenants SET (fillfactor = 70)'],
        ['unlogged', 'ALTER TABLE public.acme_service_jobs SET UNLOGGED'],
        [
          'constraint added',
          'ALTER TABLE public.acme_tenants ADD CONSTRAINT slug_len CHECK (length(slug) < 100)',
        ],
        [
          'constraint not valid',
          'ALTER TABLE public.acme_tenants ADD CONSTRAINT slug_len2 CHECK (length(slug) < 99) NOT VALID',
        ],
        ['index added', 'CREATE INDEX acme_tenants_created ON public.acme_tenants (created_at)'],
        [
          'index option',
          'ALTER INDEX public.acme_listings_summary_hnsw SET (ef_construction = 128)',
        ],
        [
          'view changed',
          'CREATE OR REPLACE VIEW public.acme_tenant_listings WITH (security_invoker = true) AS SELECT id, title FROM public.acme_listings WHERE id > 0',
        ],
        ['view option', 'ALTER VIEW public.acme_active_listings SET (security_barrier = false)'],
        [
          'function body',
          "CREATE OR REPLACE FUNCTION public.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant', true), '')::uuid $$",
        ],
        ['function volatility', 'ALTER FUNCTION public.current_tenant_id() VOLATILE'],
        ['function security definer', 'ALTER FUNCTION public.current_tenant_id() SECURITY DEFINER'],
        [
          'function config',
          'ALTER FUNCTION public.acme_unpinned_definer() SET search_path = pg_catalog',
        ],
        ['function ACL', 'REVOKE EXECUTE ON FUNCTION public.current_tenant_id() FROM PUBLIC'],
        [
          'policy expression',
          "ALTER POLICY acme_listings_not_archived ON public.acme_listings USING (status <> 'deleted')",
        ],
        [
          'policy roles',
          'ALTER POLICY acme_listings_tenant ON public.acme_listings TO acme_authenticated, acme_anon',
        ],
        ['policy added', 'CREATE POLICY extra ON public.acme_tenants USING (true)'],
        ['trigger disabled', 'ALTER TABLE hostile.checks DISABLE TRIGGER "on truncate"'],
        ['enum label', 'ALTER TYPE hostile."en um" ADD VALUE \'z\''],
        [
          'domain check',
          'ALTER DOMAIN hostile."dom""ain" ADD CONSTRAINT not_y CHECK (VALUE <> \'y\')',
        ],
        ['sequence option', 'ALTER TABLE public.acme_listings ALTER COLUMN id SET INCREMENT BY 2'],
        ['event trigger disabled', 'ALTER EVENT TRIGGER acme_rls_auto_enable DISABLE'],
        [
          'default privileges',
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO acme_anon',
        ],
        ['schema ACL', 'GRANT USAGE ON SCHEMA public TO acme_anon'],
        ['extension added', 'CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public'],
        [
          'publication',
          'CREATE PUBLICATION pub_listings FOR TABLE public.acme_listings WITH (publish = insert)',
        ],
        ['rule', 'CREATE RULE no_delete AS ON DELETE TO public.acme_tenants DO INSTEAD NOTHING'],
        ['statistics object', 'CREATE STATISTICS public.st ON plan, slug FROM public.acme_tenants'],
      ]

      const unchanged: readonly (readonly [string, string])[] = [
        ['comment', "COMMENT ON TABLE public.acme_tenants IS 'changed comment'"],
        [
          'rows and sizes',
          "INSERT INTO public.acme_tenants SELECT gen_random_uuid(), 'slug-' || g, 'free', now() FROM generate_series(1, 200) g",
        ],
        ['statistics', 'ANALYZE public.acme_tenants'],
        ['sequence value', "SELECT nextval('public.acme_audit_log_id_seq')"],
        ['vacuum', 'VACUUM public.acme_tenants'],
      ]

      it.each(changes)('changes with %s', async (_label, statement) => {
        const scratch = await prepareDatabase(server, `fp_s_${server.major}`, SHAPED)
        try {
          const before = await snapshotOf(server, scratch)
          await runAsSuperuser(server, scratch, [statement])
          const after = await snapshotOf(server, scratch)
          expect(after.fingerprint).not.toBe(before.fingerprint)
        } finally {
          await dropDatabase(server, scratch)
        }
      })

      it.each(unchanged)('stays equal with %s', async (_label, statement) => {
        const scratch = await prepareDatabase(server, `fp_u_${server.major}`, SHAPED)
        try {
          const before = await snapshotOf(server, scratch)
          await runAsSuperuser(server, scratch, [statement])
          const after = await snapshotOf(server, scratch)
          expect(after.fingerprint).toBe(before.fingerprint)
          if (_label === 'comment') {
            expect(diffDocuments(before.document, after.document).documentationChanged.length).toBe(
              1,
            )
          }
        } finally {
          await dropDatabase(server, scratch)
        }
      })
    })

    it('survives a pg_dump and pg_restore round trip (same roles)', async () => {
      const container = server.container
      if (container === undefined) throw new Error('the test server has no container name')
      const restored = await prepareDatabase(server, `fp_rt_${server.major}`)
      const password = testTargets().superuserPassword
      const env = ['-e', `PGPASSWORD=${password}`]
      const dump = execFileSync(
        'docker',
        ['exec', ...env, container, 'pg_dump', '-h', '127.0.0.1', '-U', 'postgres', '-Fc', db],
        {
          maxBuffer: 64 * 1024 * 1024,
        },
      )
      // The fixture's event trigger would fire during the restore; restore it with triggers as they were.
      execFileSync(
        'docker',
        [
          'exec',
          '-i',
          ...env,
          container,
          'pg_restore',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          restored,
          '--exit-on-error',
        ],
        {
          input: dump,
          maxBuffer: 64 * 1024 * 1024,
        },
      )
      try {
        const a = await snapshotOf(server, db)
        const b = await snapshotOf(server, restored)
        const diff = diffDocuments(a.document, b.document)
        expect(diff.changed.map((c) => `${entryId(c)} ${c.attributes.join(',')}`)).toEqual([])
        expect(b.fingerprint).toBe(a.fingerprint)
      } finally {
        await dropDatabase(server, restored)
      }
    })

    it('stores and reloads the document with every entry hash checked', async () => {
      const snap = await snapshotOf(server, db)
      const json = documentJson(snap.document)
      const back = documentFromJson(JSON.parse(JSON.stringify(json)))
      expect(back === undefined ? undefined : fingerprintOf(back)).toBe(snap.fingerprint)
      const tampered = JSON.parse(JSON.stringify(json))
      tampered.entries[0].attributes.owner = 'someone_else'
      expect(documentFromJson(tampered)).toBeUndefined()
    })

    it('computes a cluster fingerprint over roles, memberships and role settings', async () => {
      const s = await open(server, db, 'observer')
      try {
        const a = await clusterFingerprint(s)
        const b = await clusterFingerprint(s)
        expect(a.fingerprint).toMatch(new RegExp(`^cfp1:${server.major}:[0-9a-f]{64}$`))
        expect(b.fingerprint).toBe(a.fingerprint)
        expect(a.roles).toBeGreaterThan(5)
      } finally {
        await s.close()
      }
    })
  },
)

describe('differences between majors', () => {
  it('are limited to the documented catalog differences', async () => {
    const documents = new Map<number, CanonicalDocument>()
    for (const server of matrix()) {
      const db = await prepareDatabase(server, `fp_m_${server.major}`, SHAPED)
      try {
        documents.set(server.major, (await snapshotOf(server, db)).document)
      } finally {
        await dropDatabase(server, db)
      }
    }
    const base = documents.get(17)
    const report: Record<string, readonly string[]> = {}
    for (const major of [16, 18] as const) {
      const other = documents.get(major)
      if (base === undefined || other === undefined) throw new Error('missing document')
      const diff = diffDocuments(base, other)
      expect(diff.comparable).toBe(false)
      const classes = new Set([
        ...diff.added.map((e) => `added:${e.class}`),
        ...diff.removed.map((e) => `removed:${e.class}`),
        ...diff.changed.map((c) => `changed:${c.class}:${c.attributes.join('+')}`),
      ])
      report[major] = [...classes].sort()
    }
    // Recorded differences (the adapter coverage table in schema-fingerprints.md):
    // 17 adds MAINTAIN to the default relation ACL (tables and views) and gives the
    // partitions of a table with an identity column the identity as well; 18
    // records NOT NULL as constraints (pg_constraint contype n). Nothing else differs.
    expect(report).toEqual({
      16: ['changed:column:identity', 'changed:table:acl', 'changed:view:acl'],
      18: ['added:constraint'],
    })
  })
})
