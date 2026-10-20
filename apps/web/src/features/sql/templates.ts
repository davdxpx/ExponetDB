import type { MessageKey } from '../../lib/i18n/i18n.ts'
import type { SqlMode } from './sql-model.ts'

/**
 * The templates of the SQL workspace: fixed starting points, not a library
 * the server knows. Opening one puts its text in a new tab in the right mode
 * with the origin `template` (never run on opening). The text is plain SQL
 * the person reads and changes; the server classifies and admits whatever is
 * sent, like any other text.
 *
 * Query templates are one read-only statement over the system catalogs and
 * statistics views, and select no statement text or setting values. Draft
 * templates are one statement each; a change that needs two steps (a check
 * constraint added and then validated) is two templates, because the two
 * belong in two migrations.
 */
export interface SqlTemplate {
  readonly id: string
  readonly mode: SqlMode
  readonly titleKey: MessageKey
  readonly descriptionKey: MessageKey
  readonly sql: string
}

export const QUERY_TEMPLATES: readonly SqlTemplate[] = [
  {
    id: 'version',
    mode: 'query',
    titleKey: 'sql.template.version.title',
    descriptionKey: 'sql.template.version.description',
    sql: 'SELECT pg_catalog.version() AS version;',
  },
  {
    id: 'sessions',
    mode: 'query',
    titleKey: 'sql.template.sessions.title',
    descriptionKey: 'sql.template.sessions.description',
    sql: `SELECT state, count(*) AS sessions
FROM pg_catalog.pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY sessions DESC;`,
  },
  {
    id: 'sizes',
    mode: 'query',
    titleKey: 'sql.template.sizes.title',
    descriptionKey: 'sql.template.sizes.description',
    sql: `SELECT n.nspname AS schema,
       c.relname AS name,
       pg_catalog.pg_total_relation_size(c.oid) AS total_bytes
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_toast'
ORDER BY total_bytes DESC
LIMIT 50;`,
  },
  {
    id: 'index-usage',
    mode: 'query',
    titleKey: 'sql.template.indexUsage.title',
    descriptionKey: 'sql.template.indexUsage.description',
    sql: `SELECT schemaname AS schema,
       relname AS table,
       indexrelname AS index,
       idx_scan AS scans,
       idx_tup_read AS tuples_read,
       idx_tup_fetch AS tuples_fetched
FROM pg_catalog.pg_stat_user_indexes
ORDER BY idx_scan ASC, schemaname, relname
LIMIT 50;`,
  },
  {
    id: 'extensions',
    mode: 'query',
    titleKey: 'sql.template.extensions.title',
    descriptionKey: 'sql.template.extensions.description',
    sql: `SELECT extname AS name, extversion AS version
FROM pg_catalog.pg_extension
ORDER BY extname;`,
  },
  {
    id: 'long-transactions',
    mode: 'query',
    titleKey: 'sql.template.longTransactions.title',
    descriptionKey: 'sql.template.longTransactions.description',
    sql: `SELECT pid, usename AS role, state, xact_start, now() - xact_start AS open_for
FROM pg_catalog.pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start
LIMIT 50;`,
  },
]

export const DRAFT_TEMPLATES: readonly SqlTemplate[] = [
  {
    id: 'create-table',
    mode: 'draft',
    titleKey: 'sql.template.createTable.title',
    descriptionKey: 'sql.template.createTable.description',
    sql: `CREATE TABLE public.example (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);`,
  },
  {
    id: 'add-column',
    mode: 'draft',
    titleKey: 'sql.template.addColumn.title',
    descriptionKey: 'sql.template.addColumn.description',
    sql: 'ALTER TABLE public.example ADD COLUMN note text;',
  },
  {
    id: 'add-index',
    mode: 'draft',
    titleKey: 'sql.template.addIndex.title',
    descriptionKey: 'sql.template.addIndex.description',
    sql: 'CREATE INDEX CONCURRENTLY example_name_idx ON public.example (name);',
  },
  {
    id: 'add-check',
    mode: 'draft',
    titleKey: 'sql.template.addCheck.title',
    descriptionKey: 'sql.template.addCheck.description',
    sql: `ALTER TABLE public.example
  ADD CONSTRAINT example_name_not_blank CHECK (length(btrim(name)) > 0) NOT VALID;`,
  },
  {
    id: 'validate-check',
    mode: 'draft',
    titleKey: 'sql.template.validateCheck.title',
    descriptionKey: 'sql.template.validateCheck.description',
    sql: 'ALTER TABLE public.example VALIDATE CONSTRAINT example_name_not_blank;',
  },
]

export const TEMPLATES: readonly SqlTemplate[] = [...QUERY_TEMPLATES, ...DRAFT_TEMPLATES]
