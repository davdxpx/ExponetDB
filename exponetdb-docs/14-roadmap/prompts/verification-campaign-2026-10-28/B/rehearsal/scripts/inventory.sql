-- counts of what the generated schema contains (run with psql -At on the target database)
select 'tables', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','auth','storage','app_private')
union all select 'tables_public', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname='public'
union all select 'tables_rls', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and c.relrowsecurity and n.nspname in ('public','auth','storage','app_private')
union all select 'policies', count(*) from pg_policies
union all select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth','storage','app_private') and p.prokind in ('f','p')
union all select 'functions_secdef', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth','storage','app_private') and p.prosecdef
union all select 'triggers', count(*) from pg_trigger where not tgisinternal
union all select 'views', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='v' and n.nspname in ('public','auth','storage')
union all select 'matviews', count(*) from pg_class where relkind='m'
union all select 'sequences', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S' and n.nspname in ('public','auth','storage','app_private')
union all select 'enums', count(*) from pg_type where typtype='e'
union all select 'indexes', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='i' and n.nspname in ('public','auth','storage','app_private')
union all select 'extensions', count(*) from pg_extension
union all select 'publications', count(*) from pg_publication
union all select 'db_size_mb', pg_database_size(current_database())/1024/1024;
