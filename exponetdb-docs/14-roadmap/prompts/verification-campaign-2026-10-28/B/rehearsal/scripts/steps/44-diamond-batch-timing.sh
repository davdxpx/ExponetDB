source /srv/work/s5/rehearsal/rh-lib.sh
cd $EXSTACK_PROJECTS/scale-diamond
for b in 9 0; do
  IDS=$(ls migrations | cut -c1-26 | sed -n "$((b*50+1)),$((b*50+50))p" | tr '\n' ' ')
  s=$(date +%s.%N); out=$(exdb migration plan $IDS --target lab/platform/rhrep --yes 2>&1 | grep -m1 "Error\|Decision" | cut -c1-200); echo "diamond batch $b: $(echo "$(date +%s.%N) - $s" | bc | cut -c1-6) s  $out"
done
exdb migration plan $(ls migrations | cut -c1-26 | head -50 | tr '\n' ' ') --target lab/platform/rhrep --yes 2>&1 | grep -c Error
# the same 50 as a plain list with the whole project loaded (500 local bundles): lint cost on the client is separate
