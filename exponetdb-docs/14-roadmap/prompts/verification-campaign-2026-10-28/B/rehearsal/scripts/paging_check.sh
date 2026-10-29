#!/usr/bin/env bash
# Pagination correctness and list time: pages through a list with several page sizes and compares the id set with the Control Store.
# usage: paging_check.sh finding|target  [target path for findings]
source /srv/work/s5/rehearsal/rh-lib.sh
KIND="${1:?finding|target}"; TP="${2:-lab/platform/rhrep}"; cd "$PROJ"
if [ "$KIND" = finding ]; then
  T=$(target_id "$TP")
  TRUTH=$(ctl_sql "select count(*) from observation.findings where target_id='$T' and state='open'")
  BASE=(finding list --target "$TP")
else
  TRUTH=$(ctl_sql "select count(*) from registry.targets" 2>/dev/null || echo "?")
  BASE=(target list)
fi
echo "Control Store count: $TRUTH"
page_through() { # limit
  local limit="$1" cursor="" ids="$L/page-$KIND-$limit.ids" pages=0; : > "$ids"; local s; s=$(date +%s.%N)
  while :; do
    local j; j=$(exdb_json "${BASE[@]}" --limit "$limit" ${cursor:+--cursor "$cursor"})
    jq -r '.data.items[].id' <<<"$j" >> "$ids"; pages=$((pages+1))
    cursor=$(jq -r '[.next[]? | select(test("--cursor "))][0] // empty | split("--cursor ")[1] // empty' <<<"$j")  # the cursor is only in the "next" hint
    [ -z "$cursor" ] && break; [ $pages -gt 3000 ] && { echo "stopped after 3000 pages"; break; }
  done
  echo "limit $limit: $pages pages, $(wc -l < "$ids") ids, $(sort -u "$ids" | wc -l) distinct, $(echo "$(date +%s.%N) - $s" | bc | cut -c1-6) s"
}
for lim in ${LIMITS:-1000 100 50}; do page_through "$lim"; done
s=$(date +%s.%N); n=$(exdb_json "${BASE[@]}" --all | jq '.data.items | length'); echo "--all: $n items in $(echo "$(date +%s.%N) - $s" | bc | cut -c1-6) s"
for lim in ${LIMITS:-1000 100 50}; do
  a=$(sort -u "$L/page-$KIND-$lim.ids" | md5sum | cut -c1-12); echo "id-set digest limit $lim: $a"
done
