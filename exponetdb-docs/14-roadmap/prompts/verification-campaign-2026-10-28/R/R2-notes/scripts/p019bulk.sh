. /srv/work/r2/ftlib.sh
cp /srv/work/r2/probes/r2-nul-bulk-http-nodes.int.test.ts /srv/work/r2/new/apps/server/test/r2-nul-bulk-http-nodes.int.test.ts
(cd /srv/work/r2/new/apps/server && bunx vitest run --config vitest.integration.config.ts test/r2-nul-bulk-http-nodes.int.test.ts 2>&1 | grep -aE "R2-PROBE|Test Files|Tests  |FAIL|AssertionError|Error|expected" | sed -e 's/\x1b\[[0-9;]*m//g' | head -20)
rm -f /srv/work/r2/new/apps/server/test/r2-nul-bulk-http-nodes.int.test.ts
