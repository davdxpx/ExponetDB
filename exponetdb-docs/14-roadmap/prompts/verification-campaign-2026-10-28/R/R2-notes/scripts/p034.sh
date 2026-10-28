. /srv/work/r2/ftlib.sh
cp /srv/work/r2/probes/r2-tc034-http-drift-accept.int.test.ts /srv/work/r2/new/apps/server/test/
(cd /srv/work/r2/new/apps/server && bunx vitest run --config vitest.integration.config.ts test/r2-tc034-http-drift-accept.int.test.ts 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "R2-TC034|Test Files|Tests  |FAIL|AssertionError|Error:" | head -20)
rm -f /srv/work/r2/new/apps/server/test/r2-tc034-http-drift-accept.int.test.ts
