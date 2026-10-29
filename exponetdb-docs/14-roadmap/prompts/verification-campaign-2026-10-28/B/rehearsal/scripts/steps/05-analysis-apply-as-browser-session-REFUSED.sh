source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
PLAN=$(jq -r '.data.id' $L/import-analyze-plan.log)
read -r SP_ WP_ GP_ <<<"$(cp_pids | tr '\n' ' ')"
memwatch $L/import-analyze-mem.log $SP_ $WP_ $GP_
t0=$(date +%s.%N)
happly $PLAN
echo "HOP=$HOP"
wait_op $HOP 1800
t1=$(date +%s.%N)
memstop
printf 'import-analyze-apply\t%s\t%s\t%.1f\t0\n' "$(date -u +%FT%TZ)" "$(date -u +%FT%TZ)" "$(echo "$t1 - $t0" | bc)" >> $TIMINGS
echo "analysis wall: $(echo "$t1 - $t0" | bc) s; RSS MB serve=$SP_ worker=$WP_ gateway=$GP_ (max per process):"
for i in 2 3 4; do awk -v c=$i '{split($c,a,"="); if (a[2]>m) m=a[2]} END{print "  col " c ": max " m " MB"}' $L/import-analyze-mem.log; done
head -1 $L/import-analyze-mem.log
