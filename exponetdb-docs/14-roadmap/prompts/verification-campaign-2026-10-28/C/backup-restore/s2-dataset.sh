# runs INSIDE s2-host as root: builds the >= 5 GB dataset in database app of cluster 17/exdbnode (archiving still off)
set -euo pipefail
SCALE=${SCALE:-400}; PORT=${PORT:-55417}; DB=${DB:-app}
P="runuser -u postgres -- psql -X -q -p $PORT -d $DB -v ON_ERROR_STOP=1"
t0=$(date +%s)
step() { echo "[$(date -u +%T)] $* (+$(( $(date +%s) - t0 ))s)"; }
step "pgbench -i -s $SCALE"
runuser -u postgres -- nice pgbench -i -s $SCALE -p $PORT $DB 2>&1 | tail -3
step "blobs (random bytea, incompressible)"
$P <<'SQL'
CREATE TABLE public.blobs (id int PRIMARY KEY, payload bytea NOT NULL);
INSERT INTO public.blobs
SELECT i, (SELECT decode(string_agg(md5(random()::text || g::text || i::text), ''), 'hex') FROM generate_series(1, 32768) g)
FROM generate_series(1, 1000) i;
SQL
step "docs (text)"
$P <<'SQL'
CREATE TABLE public.docs (id bigint PRIMARY KEY, body text NOT NULL);
INSERT INTO public.docs
SELECT i, (SELECT string_agg(md5(i::text || j::text), ' ') FROM generate_series(1, 64) j)
FROM generate_series(1, 250000) i;
CREATE INDEX docs_prefix_idx ON public.docs (substr(body, 1, 12));
SQL
step "marker + roles"
$P <<'SQL'
CREATE TABLE public.marker (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT clock_timestamp(), note text);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='s2_reader') THEN CREATE ROLE s2_reader LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='s2_owner') THEN CREATE ROLE s2_owner NOLOGIN; END IF;
END $$;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO s2_reader;
ALTER TABLE public.marker OWNER TO s2_owner;
ANALYZE;
CHECKPOINT;
SQL
step "sizes"
$P -A -t <<'SQL'
SELECT 'database', pg_size_pretty(pg_database_size('app')), pg_database_size('app');
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY pg_total_relation_size(oid) DESC LIMIT 8;
SQL
step "cluster size"
du -sh /var/lib/postgresql/17/exdbnode | cat
step "DONE"
