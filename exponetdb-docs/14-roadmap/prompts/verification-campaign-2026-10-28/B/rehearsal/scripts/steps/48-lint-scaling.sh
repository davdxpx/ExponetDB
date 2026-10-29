source /srv/work/s5/rehearsal/rh-lib.sh
for spec in "diamond 250" "diamond 1000" "chain 250"; do
  set -- $spec; kind=$1; n=$2
  D=$(new_project scale-$kind-$n); python3 $RH/gen_bundles.py $D $kind $n >/dev/null; cd $D
  /usr/bin/time -f "local lint $kind $n (nonprod): %e s, max RSS %M KB" /tmp/exdb-bin migration lint --tier nonprod 2>&1 | tail -1
done
