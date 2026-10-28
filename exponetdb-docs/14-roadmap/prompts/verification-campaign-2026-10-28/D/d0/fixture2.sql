-- D0 exploratory fixture, part 2: two clusters and a repository each (superuser, replica mode, FK-free fixture only).
\connect - postgres
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO registry.clusters (cluster_id, server_id, management_mode, display_name, state, ca_bundle, created_at, created_by_operation_id)
SELECT c.id, NULL, 'external', c.nm, 'pending', '-----BEGIN CERTIFICATE-----', now(), 'op_01M61C90YHV706H2B8EW39TBA0'
  FROM (VALUES ('cls_01M61C90YHV706H2B8EW39TBK1', 'd0-cluster-one'), ('cls_01M61C90YHV706H2B8EW39TBK2', 'd0-cluster-two')) c(id, nm);
INSERT INTO backups.repositories (repository_id, cluster_id, layer, engine, provider, prefix, priority, purpose, ownership, secret_source,
  lock_mode, lock_capability, cipher, state, revision, created_by_operation_id)
SELECT r.id, r.cl, 'l2_logical', 'pg_dump', 'posix', r.pfx, 1, 'primary', 'external', 'host_config', 'none', 'unknown', 'none', 'registered', 1,
       'op_01M61C90YHV706H2B8EW39TBA0'
  FROM (VALUES ('bkr_01M61C90YHV706H2B8EW39TBR1', 'cls_01M61C90YHV706H2B8EW39TBK1', 'one'),
               ('bkr_01M61C90YHV706H2B8EW39TBR2', 'cls_01M61C90YHV706H2B8EW39TBK2', 'two')) r(id, cl, pfx);
COMMIT;
SELECT 'fixture2 ready: ' || (SELECT count(*) FROM backups.repositories) || ' repositories';
