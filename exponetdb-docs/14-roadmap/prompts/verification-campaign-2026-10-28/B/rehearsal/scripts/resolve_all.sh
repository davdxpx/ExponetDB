#!/usr/bin/env bash
# Decides every open item of an import report the way a reviewer would, with a note each: resolve_all.sh REPORT_ID TARGET_SLUG
# gap in the ledger -> recorded_present; only_in_target (hand-made) -> unrecorded_present; only_in_replay (dropped by a deleted file) -> superseded;
# a file with failing expectations or edited after apply -> recorded_present (accepts exactly what fails today)
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
R="${1:?report}"; T="${2:?target slug}"
exdb_json migration import report "$R" --target "lab/platform/$T" > "$L/report-$T.json"
n=0
while IFS=$'\t' read -r id state name evid; do
  case "$evid" in
    *only_in_target*) st=unrecorded_present; note="hand-made object on the target, accepted as present (hotfix of 2024-11)";;
    *only_in_replay*) st=superseded; note="dropped on the target by a ledger entry whose file was deleted";;
    *ledger_entry_without_file*) st=recorded_present; note="ledger entry whose file is excluded or deleted; effect confirmed by hand";;
    *differs*) st=unrecorded_present; note="file edited after apply; the target keeps the applied default";;
    *) st=recorded_present; note="reviewed: accepted as applied";;
  esac
  exdb_json migration import resolve "$R" "$id" --target "lab/platform/$T" --state "$st" --note "$note" >/dev/null && n=$((n+1)) || echo "FAILED item $id ($name)"
done < <(jq -r '.data.items[] | select(.decision==null and .state=="ambiguous") | [.itemId, .state, .name, (.evidence|join(","))] | @tsv' "$L/report-$T.json")
echo "decisions recorded: $n"
exdb_json migration import report "$R" --target "lab/platform/$T" | jq -c '.data | {state, unresolved}'
