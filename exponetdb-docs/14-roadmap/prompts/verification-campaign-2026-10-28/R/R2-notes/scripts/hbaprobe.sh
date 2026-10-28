. /srv/work/r2/ftlib.sh
cp /srv/work/r2/probes/r2-hba.test.ts /srv/work/r2/new/packages/nodes/test/
(cd /srv/work/r2/new/packages/nodes && bunx vitest run test/r2-hba.test.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "R2-HBA|Test Files|Tests  |Error" | head)
rm -f /srv/work/r2/new/packages/nodes/test/r2-hba.test.ts
