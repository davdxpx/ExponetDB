source /srv/work/s5/rehearsal/rh-lib.sh
t0=$(date +%s)
for i in $(seq -w 1 100); do
  s=$(date +%s.%N)
  out=$(add_target sc$i pg16 nonprod 2>&1 | tail -1 | cut -c1-120)
  printf 'sc%s\t%.1f\t%s\n' $i "$(echo "$(date +%s.%N) - $s" | bc)" "$out" >> $L/scale100-targets.tsv
done
echo "100 targets in $(( $(date +%s) - t0 )) s" >> $L/scale100-targets.tsv
