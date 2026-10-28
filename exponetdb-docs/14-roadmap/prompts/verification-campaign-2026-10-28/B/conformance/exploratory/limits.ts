// Exploratory (NOT a verdict): the plan request limit (50 bundles) against the CLI default
// (every local bundle is submitted, apps/cli/src/commands/migration.ts:487-508).
// Run from the repository root of the tree under test: bun --conditions=@exponetdb/source limits.ts
import { MigrationPlanRequestSchema, MIGRATION_REQUEST_LIMITS } from './packages/contracts/src/rest/migrations.ts'
const mk = (i: number) => ({
  directory: `01JB2Z6G8M4Q7R9T1V3W5X${String(i).padStart(4, '0').replace(/[IOLU]/g,'0')}_b${i}`,
  files: { 'migration.yaml': 'x', 'up.sql': 'SELECT 1;' },
})
for (const n of [50, 51, 500]) {
  const r = MigrationPlanRequestSchema.safeParse({ bundles: Array.from({ length: n }, (_, i) => mk(i)) })
  console.log(n, 'bundles ->', r.success ? 'OK' : r.error.issues.filter(i => i.code === 'too_big').map(i => `${i.path.join('.')}: ${i.message}`).join('; ') || 'other issues: ' + r.error.issues.slice(0,2).map(i=>i.path.join('.')+':'+i.message))
}
console.log(MIGRATION_REQUEST_LIMITS)
