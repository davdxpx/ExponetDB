#!/usr/bin/env bash
# Applies the legacy history the way the old tool did: file by file as the owner role, then the ledger rows.
# usage: apply_legacy.sh DATABASE [PORT] [GEN_DIR]   (run as root on the server; superuser via the postgres peer user, SET ROLE lab_owner)
set -euo pipefail
DB="${1:?database}"; PORT="${2:-55417}"; GEN="${3:-/srv/work/s5/rehearsal/legacy}"
P=(runuser -u postgres -- env PGOPTIONS='-c role=lab_owner' psql -X -q -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1)
n=0; start=$(date +%s)
while IFS=$'\t' read -r f mode; do
  if [ "$mode" = notx ]; then "${P[@]}" -f "$GEN/as_applied/$f" >/dev/null; else "${P[@]}" -1 -f "$GEN/as_applied/$f" >/dev/null; fi
  n=$((n+1))
done < "$GEN/apply_order.txt"
echo "applied $n files in $(( $(date +%s) - start )) s"
runuser -u postgres -- psql -X -q -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1 -f "$GEN/ledger.sql" >/dev/null
echo "ledger rows: $(runuser -u postgres -- psql -X -Atq -p "$PORT" -d "$DB" -c 'select count(*) from supabase_migrations.schema_migrations')"
