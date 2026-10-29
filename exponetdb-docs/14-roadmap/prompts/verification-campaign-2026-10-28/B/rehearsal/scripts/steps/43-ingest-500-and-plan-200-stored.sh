source /srv/work/s5/rehearsal/rh-lib.sh
for kind in diamond fanout; do
  cd $EXSTACK_PROJECTS/scale-$kind
  ALL=$(ls migrations | cut -c1-26 | tr '\n' ' ')
  # ingest all 500 in batches of 50 (each batch is a plan; nothing is applied)
  t0=$(date +%s.%N)
  for b in 0 1 2 3 4 5 6 7 8 9; do
    IDS=$(ls migrations | cut -c1-26 | sed -n "$((b*50+1)),$((b*50+50))p" | tr '\n' ' ')
    exdb migration plan $IDS --target lab/platform/rhrep --yes >/dev/null 2>&1 || echo "batch $b: $(exdb migration plan $IDS --target lab/platform/rhrep --yes 2>&1 | grep -m1 Error | cut -c1-200)"
  done
  echo "$kind: 10 batches of 50 planned in $(echo "$(date +%s.%N) - $t0" | bc | cut -c1-6) s"
  IDS200=$(ls migrations | cut -c1-26 | head -200 | tr '\n' ' ')
  TAIL=1 tm plan200stored-$kind exdb migration plan $IDS200 --stored --target lab/platform/rhrep --yes 2>&1 | tail -1 | cut -c1-160
  grep -m3 "Content:\|Decision:\|Error" $L/plan200stored-$kind.log | cut -c1-140
done
