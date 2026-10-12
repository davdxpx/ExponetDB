import { createHash } from 'node:crypto'

/**
 * A synthetic legacy migration history with the shapes of the real-world
 * consumer ([legacy-import.md §1](../../../../exponetdb-docs/04-migrations/legacy-import.md#1-what-reosa-brings-the-design-case)):
 * one flat directory of `NNNN_name.sql` files with a duplicated number
 * prefix, a file applied under an earlier name (renumbered after a merge),
 * a hash ledger (drizzle-shaped) and an applied-statements ledger
 * (supabase-shaped), an applied entry whose effect is missing on the
 * target, a column a later file drops (superseded), a `DO` block that
 * branches on `pg_roles`, a file of another project, a ledger entry whose
 * file was deleted, and an object created by hand that no file explains.
 *
 * Only shapes: no consumer name, no data, no real password (objects are
 * `acme_*`). Test setup only.
 */
export interface LegacyFile {
  readonly name: string
  readonly text: string
}

export const LEGACY_FILES: readonly LegacyFile[] = [
  {
    name: '0000_init.sql',
    text: 'CREATE TABLE public.acme_tenants (\n  id uuid PRIMARY KEY,\n  slug text NOT NULL UNIQUE\n);\n',
  },
  {
    name: '0001_conditional_policy.sql',
    text: `-- creates the policy only where the optional role exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_agent_admin') THEN
    EXECUTE 'CREATE POLICY acme_tenants_agent ON public.acme_tenants FOR SELECT TO acme_agent_admin USING (true)';
  END IF;
END $$;
`,
  },
  {
    name: '0002_listings.sql',
    text: 'CREATE TABLE public.acme_listings (\n  id bigint PRIMARY KEY,\n  tenant_id uuid NOT NULL REFERENCES public.acme_tenants (id),\n  title text NOT NULL\n);\n',
  },
  {
    // The same number prefix as the file before: identity is the full stem.
    name: '0002_listings_index.sql',
    text: 'CREATE INDEX acme_listings_tenant ON public.acme_listings (tenant_id);\n',
  },
  {
    name: '0003_notes.sql',
    text: 'CREATE TABLE public.acme_notes (\n  id bigint PRIMARY KEY,\n  body text NOT NULL\n);\n',
  },
  {
    // Applied as 0004_old_name before a merge renumbered it.
    name: '0004_listing_status.sql',
    text: "ALTER TABLE public.acme_listings ADD COLUMN status text NOT NULL DEFAULT 'draft';\n",
  },
  {
    // Belongs to the status database (another project).
    name: '0005_status_incidents.sql',
    text: 'CREATE TABLE public.acme_status_incidents (id bigint PRIMARY KEY);\n',
  },
  {
    name: '0006_listing_tmp.sql',
    text: 'ALTER TABLE public.acme_listings ADD COLUMN tmp text;\n',
  },
  {
    name: '0007_drop_tmp.sql',
    text: 'ALTER TABLE public.acme_listings DROP COLUMN tmp;\n',
  },
  {
    name: '0008_events.sql',
    text: 'CREATE TABLE public.acme_events (\n  id bigint PRIMARY KEY,\n  kind text NOT NULL\n);\n',
  },
  {
    // The header was edited after apply: the statements still match.
    name: '0009_event_index.sql',
    text: '-- header rewritten long after apply\nCREATE INDEX acme_events_kind ON public.acme_events (kind);\n',
  },
]

/** File stems that belong to another project. */
export const LEGACY_NOT_APPLICABLE = ['0005_status_incidents'] as const
/** Curated alias: the name the old ledger recorded → today's stem. */
export const LEGACY_ALIASES = { '0004_old_name': '0004_listing_status' } as const

function stem(name: string): string {
  return name.slice(0, -'.sql'.length)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Builds the target the history is imported from, as a superuser: what the
 * legacy chain left behind as the owner role (without 0003, whose ledger
 * entry exists but whose effect is missing, and without the other project's
 * 0005), one object made by hand, and the two legacy ledgers readable by the
 * observer.
 */
export function legacyTargetStatements(owner: string, observer: string): string[] {
  const byName = new Map(LEGACY_FILES.map((f) => [stem(f.name), f.text]))
  const applied = [
    '0000_init',
    '0001_conditional_policy',
    '0002_listings',
    '0002_listings_index',
    '0004_listing_status',
    '0006_listing_tmp',
    '0007_drop_tmp',
    '0008_events',
    '0009_event_index',
  ]
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`
  return [
    `SET ROLE ${owner}`,
    ...applied.map((s) => byName.get(s) ?? ''),
    // Made by hand: no legacy file creates it.
    'CREATE TABLE public.acme_handmade (id int)',
    'RESET ROLE',
    'CREATE SCHEMA supabase_migrations',
    'CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[])',
    `INSERT INTO supabase_migrations.schema_migrations VALUES
       ('0002', 'listings', NULL),
       ('0003', 'notes', NULL),
       ('0004', 'old_name', NULL),
       ('0009', 'event_index_applied', ARRAY[${quote('CREATE INDEX acme_events_kind ON public.acme_events (kind)')}]),
       ('0010', 'deleted_file', NULL)`,
    'CREATE SCHEMA drizzle',
    'CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${quote(
      sha256(byName.get('0008_events') ?? ''),
    )}, 1700000000000)`,
    `GRANT USAGE ON SCHEMA supabase_migrations, drizzle TO ${observer}`,
    `GRANT SELECT ON supabase_migrations.schema_migrations, drizzle.__drizzle_migrations TO ${observer}`,
  ]
}
