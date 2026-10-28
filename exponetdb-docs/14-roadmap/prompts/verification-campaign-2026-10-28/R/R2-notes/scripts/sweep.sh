. /srv/work/r2/ftlib.sh
for side in new old; do
  cp /srv/work/r2/probes/r2-cli-sweep.test.ts /srv/work/r2/$side/apps/cli/test/r2-cli-sweep.test.ts
  echo "=== $side"
  (cd /srv/work/r2/$side/apps/cli && bunx vitest run test/r2-cli-sweep.test.ts 2>&1 | sed -n '/R2-SWEEP-BEGIN/,/R2-SWEEP-END/p' | grep -a -v '^ok ' | head -150) 
  (cd /srv/work/r2/$side/apps/cli && bunx vitest run test/r2-cli-sweep.test.ts 2>&1 | grep -a -c '^ok ')
  rm -f /srv/work/r2/$side/apps/cli/test/r2-cli-sweep.test.ts
done
