-- Every ACL of the control database: relations, columns, functions, schemas, plus RLS policies, owners. Sorted, comparable.
SELECT 'rel ' || n.nspname || '.' || c.relname || ' owner=' || c.relowner::regrole || ' rls=' || c.relrowsecurity || '/' || c.relforcerowsecurity || ' acl=' || coalesce(c.relacl::text, '-')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind IN ('r','p','v','m','S')
UNION ALL
SELECT 'col ' || n.nspname || '.' || c.relname || '.' || a.attname || ' acl=' || a.attacl::text
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND a.attacl IS NOT NULL
UNION ALL
SELECT 'fn  ' || p.oid::regprocedure || ' owner=' || p.proowner::regrole || ' definer=' || p.prosecdef || ' config=' || coalesce(p.proconfig::text, '-') || ' acl=' || coalesce(p.proacl::text, '-')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
UNION ALL
SELECT 'sch ' || n.nspname || ' owner=' || n.nspowner::regrole || ' acl=' || coalesce(n.nspacl::text, '-') FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_'
UNION ALL
SELECT 'pol ' || schemaname || '.' || tablename || '.' || policyname || ' ' || cmd || ' roles=' || roles::text FROM pg_policies
ORDER BY 1;
