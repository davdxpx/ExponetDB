set -euo pipefail
source /srv/work/s5kit/stack-env.sh
# kit patch: the evidence environment of a production target is a parameter (default staging)
cd /srv/work/s5kit/kit
grep -q EXSTACK_EVIDENCE_FROM seed.ts || sed -i "s|\.\.\.(tier === 'prod' ? { evidenceFrom: 'staging' } : {})|...(tier === 'prod' ? { evidenceFrom: process.env['EXSTACK_EVIDENCE_FROM'] ?? 'staging' } : {})|" seed.ts
grep -n "EXSTACK_EVIDENCE_FROM" seed.ts
# cluster 17: archiving, logical wal level, pg_stat_statements, bigger WAL window
PGDATABASE=postgres psql_target pg17 -v ON_ERROR_STOP=1 <<'SQL'
ALTER SYSTEM SET wal_level = 'logical';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = 'test ! -f /srv/work/s5/walarchive/%f && cp %p /srv/work/s5/walarchive/%f';
ALTER SYSTEM SET archive_timeout = '60s';
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
ALTER SYSTEM SET max_wal_size = '8GB';
ALTER SYSTEM SET max_wal_senders = '10';
ALTER SYSTEM SET max_replication_slots = '10';
ALTER SYSTEM SET shared_buffers = '1GB';
ALTER SYSTEM SET track_io_timing = 'on';
ALTER SYSTEM SET log_min_duration_statement = '2000';
SQL
pg_restart pg17 fast
sleep 3
PGDATABASE=postgres psql_target pg17 -Atc "select current_setting('archive_mode'), current_setting('wal_level'), current_setting('shared_preload_libraries')"
psql_target pg17 -X -f /srv/work/s5/rehearsal/legacy/prereq_cluster.sql
psql_target pg17 -c "drop database if exists gen_test"
