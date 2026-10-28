. /srv/work/r2/ftlib.sh
for side in new old; do
  cp /srv/work/r2/probes/r2-cli-e4.test.ts /srv/work/r2/$side/apps/cli/test/
  echo "=== $side"
  (cd /srv/work/r2/$side/apps/cli && bunx vitest run test/r2-cli-e4.test.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE -A2 "^R2-E4|Test Files|Tests  |Error" | head -40)
  rm -f /srv/work/r2/$side/apps/cli/test/r2-cli-e4.test.ts
done
