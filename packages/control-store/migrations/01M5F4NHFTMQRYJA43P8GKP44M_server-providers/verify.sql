-- check: the provider CHECK accepts the Wave 4 values and the added ones
SELECT pg_get_constraintdef(c.oid) LIKE '%''hetzner_cloud''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''hetzner_robot''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''other''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''unknown''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''aws''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''akamai_linode''%'
       AND pg_get_constraintdef(c.oid) LIKE '%''on_premises''%' AS ok
  FROM pg_catalog.pg_constraint c
 WHERE c.conrelid = 'registry.servers'::regclass
   AND c.conname = 'servers_provider_check'
   AND c.contype = 'c'
   AND c.convalidated;

-- check: the worker still registers servers; serve does not
SELECT has_table_privilege('exdb_worker', 'registry.servers', 'INSERT')
   AND NOT has_table_privilege('exdb_serve', 'registry.servers', 'INSERT') AS ok;
