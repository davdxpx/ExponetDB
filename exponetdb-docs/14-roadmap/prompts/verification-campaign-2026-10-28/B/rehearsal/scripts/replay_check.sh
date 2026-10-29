#!/usr/bin/env bash
# I10: replay the repository's legacy files and then every bundle's up.sql in applied order into an EMPTY database, then compare fp1 with the live target.
# usage: replay_check.sh LIVE_SLUG REPLAY_SLUG
source /srv/work/s5/rehearsal/rh-lib.sh
LIVE="${1:?live slug}"; REP="${2:?replay slug}"; cd "$PROJ"
DB="lab_${REP}"; PSQL=(runuser -u postgres -- env PGOPTIONS='-c role=lab_owner' psql -X -q -p 55417 -d "$DB" -v ON_ERROR_STOP=1)
t0=$(date +%s.%N)
runuser -u postgres -- psql -X -q -p 55417 -d "$DB" -f "$RH/legacy/prereq_db.sql" >/dev/null
n=0
for f in legacy/*.sql; do
  if grep -qi 'concurrently' "$f"; then "${PSQL[@]}" -f "$f" >/dev/null; else "${PSQL[@]}" -1 -f "$f" >/dev/null; fi
  n=$((n+1))
done
echo "legacy files replayed from the repository (notApplicable file included): $n"
# bundles in the order the live target applied them (its ledger), not the file order
mapfile -t IDS < <(psql_target pg17 -d "lab_${LIVE}" -Atc "select migration_id from exponetdb.schema_migrations where origin not in ('legacy_import','baseline') order by applied_seq")
for id in "${IDS[@]}"; do
  d=$(ls -d migrations/${id}_* 2>/dev/null) || { echo "bundle $id has no directory (dependsOn only)"; continue; }
  "${PSQL[@]}" -1 -f "$d/up.sql" >/dev/null && echo "  replayed $id $(basename "$d" | cut -c28-)"
done
echo "replay wall: $(echo "$(date +%s.%N) - $t0" | bc) s"
exdb schema fingerprint "lab/platform/$LIVE" 2>&1 | grep -i "fp1" | head -2
exdb schema fingerprint "lab/platform/$REP" 2>&1 | grep -i "fp1" | head -2
exdb_json schema diff "lab/platform/$REP" "lab/platform/$LIVE" > "$L/replay-diff.json"
jq -c '.data | {equal, counts: (.counts // .summary)}' "$L/replay-diff.json" | cut -c1-400
jq -r '(.data.changes // .data.items // .data.entries // [])[] | [.change // .kind // .type, .severity // "", (.object // .key // .summary // "")] | @tsv' "$L/replay-diff.json" | cut -c1-200
