import { defineConfig } from 'vitest/config'
import { targetIntegrationConfig } from '../../vitest.shared.ts'

// Tests that need the disposable PostgreSQL servers (EXDB_TEST_TARGETS) and, for the engine
// suites, the Control Store (EXDB_TEST_PG_URL). One file at a time: they hold sessions and locks.
export default defineConfig({
  ...targetIntegrationConfig,
  test: {
    ...targetIntegrationConfig.test,
    include: ['I*.int.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
})
