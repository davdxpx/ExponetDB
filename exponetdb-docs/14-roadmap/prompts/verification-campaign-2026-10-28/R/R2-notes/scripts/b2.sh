. /srv/work/r2/ftlib.sh
IC="--config vitest.integration.config.ts"
echo "########## NEW (acceptance, integration)"
LINES_MAX=20 vt new packages/nodes $IC test/nodes.int.test.ts
LINES_MAX=20 vt new packages/diagnostics $IC test/performance.int.test.ts
LINES_MAX=20 vt new packages/migrations-engine $IC test/recovery.int.test.ts
LINES_MAX=20 vt new packages/migrations-engine $IC test/ledger-guard.int.test.ts
LINES_MAX=20 vt new apps/server $IC test/http-nodes.int.test.ts test/node-operations.int.test.ts
echo "########## OLD (tests copied)"
ft_reset; ft_copy packages/nodes/test/nodes.int.test.ts
LINES_MAX=20 vt old packages/nodes $IC test/nodes.int.test.ts -t "TC-016"
ft_reset; ft_copy packages/diagnostics/test/performance.int.test.ts
LINES_MAX=20 vt old packages/diagnostics $IC test/performance.int.test.ts -t "without pg_stat_statements"
ft_reset; ft_copy packages/migrations-engine/test/recovery.int.test.ts packages/migrations-engine/test/world.ts
LINES_MAX=30 vt old packages/migrations-engine $IC test/recovery.int.test.ts -t "unknown dependency"
ft_reset; ft_copy packages/migrations-engine/test/ledger-guard.int.test.ts
LINES_MAX=20 vt old packages/migrations-engine $IC test/ledger-guard.int.test.ts
ft_reset; ft_copy apps/server/test/http-nodes.int.test.ts apps/server/test/node-operations.int.test.ts
LINES_MAX=30 vt old apps/server $IC test/http-nodes.int.test.ts test/node-operations.int.test.ts
ft_reset
echo B2-DONE
