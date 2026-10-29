source /srv/work/s5/rehearsal/rh-lib.sh
read -r SP_ WP_ GP_ <<<"$(cp_pids | tr '\n' ' ')"
for kind in chain diamond fanout; do
  cd $EXSTACK_PROJECTS/scale-$kind
  IDS=$(ls migrations | cut -c1-26 | head -50 | tr '\n' ' ')
  memwatch $L/mem-plan50-$kind.log $SP_ $WP_
  TAIL=1 tm plan50-$kind exdb migration plan $IDS --target lab/platform/rhrep --yes 2>&1 | tail -2 | cut -c1-160
  memstop
  grep -m2 "Content:\|Error\|Decision:" $L/plan50-$kind.log | cut -c1-120
  for i in 2 3; do awk -v c=$i '{split($c,a,"="); if (a[2]>m) m=a[2]} END{printf "  peak RSS col %s: %s MB", c, m}' $L/mem-plan50-$kind.log; done; echo
done
