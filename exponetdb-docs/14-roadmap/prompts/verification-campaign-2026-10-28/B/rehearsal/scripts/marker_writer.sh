#!/usr/bin/env bash
# One committed row per second into public.events_log (kind rh-marker); the client logs "id commit-time" after each commit.
# usage: marker_writer.sh PORT DATABASE LOGFILE      (stop with: pkill -f '[m]arker_writer')
PORT="${1:-55417}"; DB="${2:-lab_rhstg}"; OUT="${3:-/srv/work/logs-s5/marker.log}"
exec runuser -u postgres -- psql -X -At -F' ' -p "$PORT" -d "$DB" -o "$OUT" <<'SQL'
\set QUIET on
insert into public.events_log (org_id, kind, payload) values (md5('1')::uuid, 'rh-marker', jsonb_build_object('t', clock_timestamp())) returning id, to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
\watch 1
SQL
