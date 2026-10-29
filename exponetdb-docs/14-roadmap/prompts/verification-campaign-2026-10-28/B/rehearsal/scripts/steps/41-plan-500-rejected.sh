source /srv/work/s5/rehearsal/rh-lib.sh
read -r SP_ WP_ GP_ <<<"$(cp_pids | tr '\n' ' ')"
D=$(new_project scale-chain); python3 $RH/gen_bundles.py $D chain 500 >/dev/null
for kind in chain diamond fanout; do
  cd $EXSTACK_PROJECTS/scale-$kind
  /usr/bin/time -f "local lint $kind (nonprod, 500): %e s, max RSS %M KB" /tmp/exdb-bin migration lint --tier nonprod 2>&1 | tail -1
  memwatch $L/mem-plan500-$kind.log $SP_ $WP_
  TAIL=1 tm plan500-$kind exdb migration plan --target lab/platform/rhrep --yes 2>&1 | tail -3 | cut -c1-200
  memstop
  for i in 2 3; do awk -v c=$i '{split($c,a,"="); if (a[2]>m) m=a[2]} END{printf "  peak RSS col %s: %s MB", c, m}' $L/mem-plan500-$kind.log; done; echo
  grep -m3 "Content:\|Decision:\|Error" $L/plan500-$kind.log | cut -c1-160
done
