import { defineConfig } from 'vitest/config'
import { targetIntegrationConfig } from '../../vitest.shared.ts'

// Everything: pure files (I*.pure.test.ts) and database files (I*.int.test.ts).
export default defineConfig({
  ...targetIntegrationConfig,
  test: {
    ...targetIntegrationConfig.test,
    include: ['I*.pure.test.ts', 'I*.int.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
})
