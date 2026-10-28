. /srv/work/r2/ftlib.sh
echo "########## NEW (acceptance)"
vt new packages/contracts test/errors.test.ts
vt new packages/nodes test/capability.test.ts
vt new packages/policy test/node-rules.test.ts
vt new packages/postgres test/migration-analysis.test.ts test/admission.test.ts
vt new packages/migrations-engine test/legacy-files.test.ts
vt new packages/backups test/selection.test.ts
vt new apps/cli test/backups.test.ts test/foundation.test.ts
vt new packages/ui test/sidebar.test.tsx
vt new apps/web test/global-findings/findings-page.test.tsx test/target-pages/findings.test.tsx test/infrastructure/nodes.test.tsx test/plans/plan-page.test.tsx
vt new packages/application test/views.test.ts
echo "########## OLD (tests copied)"
ft_reset
ft_copy packages/contracts/test/errors.test.ts
vt old packages/contracts test/errors.test.ts
ft_reset
ft_copy packages/nodes/test/capability.test.ts
vt old packages/nodes test/capability.test.ts
ft_reset
ft_copy packages/policy/test/node-rules.test.ts
vt old packages/policy test/node-rules.test.ts
ft_reset
ft_copy packages/postgres/test/migration-analysis.test.ts packages/postgres/test/admission.test.ts
vt old packages/postgres test/migration-analysis.test.ts test/admission.test.ts
ft_reset
ft_copy packages/migrations-engine/test/legacy-files.test.ts
vt old packages/migrations-engine test/legacy-files.test.ts
ft_reset
ft_copy packages/backups/test/selection.test.ts
vt old packages/backups test/selection.test.ts
ft_reset
ft_copy apps/cli/test/backups.test.ts apps/cli/test/foundation.test.ts
LINES_MAX=60 vt old apps/cli test/backups.test.ts test/foundation.test.ts
ft_reset
ft_copy packages/ui/test/sidebar.test.tsx
vt old packages/ui test/sidebar.test.tsx
ft_reset
ft_copy apps/web/test/global-findings/findings-page.test.tsx apps/web/test/target-pages/findings.test.tsx apps/web/test/infrastructure/nodes.test.tsx
LINES_MAX=30 vt old apps/web test/global-findings/findings-page.test.tsx test/target-pages/findings.test.tsx test/infrastructure/nodes.test.tsx
ft_reset
echo B1-DONE
