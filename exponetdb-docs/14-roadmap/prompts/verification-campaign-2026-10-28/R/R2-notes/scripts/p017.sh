. /srv/work/r2/ftlib.sh
cp /srv/work/r2/probes/r2-tc017-diagnostics.int.test.ts /srv/work/r2/new/packages/diagnostics/test/
(cd /srv/work/r2/new/packages/diagnostics && bunx vitest run --config vitest.integration.config.ts test/r2-tc017-diagnostics.int.test.ts -t "R2 PROBE" 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "R2-TC017|Test Files|Tests  |FAIL|Error" | head -12)
rm -f /srv/work/r2/new/packages/diagnostics/test/r2-tc017-diagnostics.int.test.ts
