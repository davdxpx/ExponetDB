source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
T=$(target_id lab/platform/rhrep)
for i in $(seq 1 45); do
  s=$(date +%s.%N)
  exdb_json drift check lab/platform/rhrep > $L/drift-rep-$i.json
  n=$(ctl_sql "select count(*) from observation.findings f join observation.subject_findings s using (finding_id) where s.target_id='$T' and f.resolved_at is null" 2>/dev/null)
  printf 'check %s: %s s, status=%s counts=%s open=%s\n' $i "$(echo "$(date +%s.%N) - $s" | bc | cut -c1-5)" "$(jq -r .data.status $L/drift-rep-$i.json)" "$(jq -c .data.counts $L/drift-rep-$i.json)" "$n" | cut -c1-200
  [ "${n:-0}" -ge 10000 ] && break
done
