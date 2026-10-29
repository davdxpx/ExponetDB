source /srv/work/s5/rehearsal/rh-lib.sh
cat > /tmp/exdb-bin <<'X'
#!/bin/bash
source /srv/work/s5/rehearsal/rh-lib.sh
exdb "$@"
X
chmod +x /tmp/exdb-bin
for kind in diamond fanout; do
  cd $EXSTACK_PROJECTS/scale-$kind
  /usr/bin/time -f "graph $kind: %e s" /tmp/exdb-bin migration graph 2>&1 | tail -2 | cut -c1-150
  /usr/bin/time -f "lint $kind (nonprod): %e s" /tmp/exdb-bin migration lint --tier nonprod 2>&1 | tail -3 | cut -c1-150
done
