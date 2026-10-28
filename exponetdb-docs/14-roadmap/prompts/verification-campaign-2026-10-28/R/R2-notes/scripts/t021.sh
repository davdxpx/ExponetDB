. /srv/work/r2/ftlib.sh
cp /srv/work/r2/probes/r2-tc021-timing.test.ts /srv/work/r2/new/packages/postgres/test/
(cd /srv/work/r2/new/packages/postgres && bunx vitest run test/r2-tc021-timing.test.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "^R2-TC021|Test Files|Tests  |Error" | head)
rm -f /srv/work/r2/new/packages/postgres/test/r2-tc021-timing.test.ts
# old at the 1,000-file size only (the 5,000 case took 196 s in the first campaign)
cp /srv/work/r2/probes/r2-tc021-timing.test.ts /srv/work/r2/old/packages/postgres/test/
(cd /srv/work/r2/old/packages/postgres && timeout 300 bunx vitest run test/r2-tc021-timing.test.ts -t "100 files|1000 files|5000 files" 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "^R2-TC021|Test Files|Tests  |Error" | head)
rm -f /srv/work/r2/old/packages/postgres/test/r2-tc021-timing.test.ts
