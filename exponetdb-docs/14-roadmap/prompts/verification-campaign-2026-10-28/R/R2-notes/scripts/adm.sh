. /srv/work/r2/ftlib.sh
for side in new old; do
  cp /srv/work/r2/probes/r2-admission.test.ts /srv/work/r2/$side/packages/postgres/test/
  echo "=== $side"
  (cd /srv/work/r2/$side/packages/postgres && bunx vitest run test/r2-admission.test.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "^R2-ADM|Test Files|Tests  |Error" | head -20)
  rm -f /srv/work/r2/$side/packages/postgres/test/r2-admission.test.ts
done
