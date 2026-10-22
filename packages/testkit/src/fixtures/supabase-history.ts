import type { LegacyFile } from './legacy-history.ts'

/**
 * A synthetic legacy history in the shape of a real Supabase-origin
 * project (Wave 9 order A2, measured on a real ledger on 2026-10-21):
 *
 * - flat `NNNN_name.sql` files with drizzle `--> statement-breakpoint`
 *   comments, header comments, inline comments and comments inside function
 *   bodies;
 * - a Supabase ledger `supabase_migrations.schema_migrations` whose
 *   `version` is a 14-digit UTC timestamp, whose `name` equals the file stem
 *   and whose `statements` hold **one element: the whole file with its
 *   comments stripped** (most entries keep comments inside dollar-quoted
 *   bodies; one entry's stripper removed those too);
 * - one ledger entry that stands for two files (a curated multi-file alias);
 * - one file edited after apply (executable text changed): only its name
 *   still matches;
 * - one applied entry with `statements` NULL;
 * - a drizzle-style runner's `public.applied_migrations (filename text,
 *   applied_at timestamptz)`, name-only.
 *
 * Only shapes: no consumer name, no data, no real password (objects are
 * `acme_*`). Test setup only.
 */
export const SUPABASE_FILES: readonly LegacyFile[] = [
  {
    name: '0100_accounts.sql',
    text: `-- 0100_accounts: the account table
-- (header rewritten after the merge)
CREATE TABLE public.acme_accounts (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE, -- the public handle
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE public.acme_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.acme_accounts FORCE ROW LEVEL SECURITY;
`,
  },
  {
    name: '0101_account_members.sql',
    text: `CREATE TABLE public.acme_account_members (
  account_id uuid NOT NULL REFERENCES public.acme_accounts (id),
  member text NOT NULL, /* the member's handle */
  PRIMARY KEY (account_id, member)
);
--> statement-breakpoint
ALTER TABLE public.acme_account_members ENABLE ROW LEVEL SECURITY;
`,
  },
  {
    name: '0102_member_count.sql',
    text: `-- A definer function on a FORCE table (the shape that needs BYPASSRLS).
CREATE FUNCTION public.acme_member_count(account uuid) RETURNS bigint
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  -- every member of the account, row security notwithstanding
  RETURN (SELECT count(*) FROM public.acme_account_members m WHERE m.account_id = account);
END
$fn$;
`,
  },
  {
    // With 0104 one ledger entry (a merge applied both as one migration).
    name: '0103_notes.sql',
    text: 'CREATE TABLE public.acme_notes (\n  id bigint PRIMARY KEY,\n  body text NOT NULL\n);\n',
  },
  {
    name: '0104_notes_index.sql',
    text: '-- the index of the merged entry\nCREATE INDEX acme_notes_body ON public.acme_notes (body);\n',
  },
  {
    // Edited after apply: the column type changed in the file, not on the target.
    name: '0105_events.sql',
    text: 'CREATE TABLE public.acme_events (\n  id bigint PRIMARY KEY,\n  kind varchar(64) NOT NULL\n);\n',
  },
  {
    name: '0106_tags.sql',
    text: 'CREATE TABLE public.acme_tags (\n  id bigint PRIMARY KEY,\n  label text NOT NULL\n);\n',
  },
  {
    // Applied by the drizzle-style runner only (no Supabase entry).
    name: '0107_settings.sql',
    text: 'CREATE TABLE public.acme_settings (\n  key text PRIMARY KEY,\n  value jsonb NOT NULL\n);\n',
  },
]

/** The curated hint of the merged entry: the applied name → the files it stands for. */
export const SUPABASE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  '0103_0104_notes': ['0103_notes', '0104_notes_index'],
}

/** Line comments removed outside dollar-quoted bodies (and inside them when `bodies`), lines kept. */
function stripComments(text: string, bodies: boolean): string {
  const out: string[] = []
  let inBody = false
  for (const line of text.split('\n')) {
    const dollars = (line.match(/\$fn\$/g) ?? []).length
    const keep = inBody && !bodies ? line : line.replace(/\s*--.*$/, '')
    if (!(keep.trim() === '' && line.trim().startsWith('--'))) out.push(keep)
    if (dollars % 2 === 1) inBody = !inBody
  }
  return out
    .join('\n')
    .replace(/\/\*[^*]*\*\//g, '')
    .trim()
}

function stem(name: string): string {
  return name.slice(0, -'.sql'.length)
}

/**
 * Builds the imported target as a superuser: what the history left behind
 * as the owner role (0105 as it was applied, before the file was edited),
 * the Supabase ledger in its real shape and the drizzle-style runner's
 * table, readable by the observer.
 */
export function supabaseTargetStatements(owner: string, observer: string): string[] {
  const byStem = new Map(SUPABASE_FILES.map((f) => [stem(f.name), f.text]))
  const text = (s: string) => byStem.get(s) ?? ''
  const applied0105 = text('0105_events').replace('varchar(64)', 'text')
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`
  const array = (parts: readonly string[]) =>
    parts.length === 0 ? 'NULL' : `ARRAY[${parts.map(quote).join(', ')}]::text[]`
  const rows: [string, string, readonly string[]][] = [
    ['20260101090000', '0100_accounts', [stripComments(text('0100_accounts'), false)]],
    [
      '20260102090000',
      '0101_account_members',
      [stripComments(text('0101_account_members'), false)],
    ],
    // This entry's stripper removed the comment inside the function body too.
    ['20260103090000', '0102_member_count', [stripComments(text('0102_member_count'), true)]],
    [
      '20260104090000',
      '0103_0104_notes',
      [
        `${stripComments(text('0103_notes'), false)}\n\n${stripComments(text('0104_notes_index'), false)}`,
      ],
    ],
    ['20260105090000', '0105_events', [stripComments(applied0105, false)]],
    ['20260106090000', '0106_tags', []],
  ]
  return [
    `SET ROLE ${owner}`,
    text('0100_accounts'),
    text('0101_account_members'),
    text('0102_member_count'),
    text('0103_notes'),
    text('0104_notes_index'),
    applied0105,
    text('0106_tags'),
    text('0107_settings'),
    'RESET ROLE',
    'CREATE SCHEMA supabase_migrations',
    'CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text)',
    ...rows.map(
      ([version, name, statements]) =>
        `INSERT INTO supabase_migrations.schema_migrations (version, statements, name) VALUES (${quote(version)}, ${array(statements)}, ${quote(name)})`,
    ),
    'CREATE TABLE public.applied_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL)',
    `INSERT INTO public.applied_migrations VALUES ('0107_settings.sql', '2026-01-07T09:00:00Z'), ('0100_accounts.sql', '2026-01-01T08:00:00Z')`,
    `GRANT USAGE ON SCHEMA supabase_migrations TO ${observer}`,
    `GRANT SELECT ON supabase_migrations.schema_migrations, public.applied_migrations TO ${observer}`,
  ]
}
