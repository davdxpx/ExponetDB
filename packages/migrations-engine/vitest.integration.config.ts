import { defineConfig } from 'vitest/config'
import { targetIntegrationConfig } from '../../vitest.shared.ts'

// The engine's suites hold target sessions on purpose (locks, a waiting
// backend, a lost COMMIT reply): one file at a time, so one never takes the
// sessions another one waits for.
export default defineConfig({
  ...targetIntegrationConfig,
  test: { ...targetIntegrationConfig.test, fileParallelism: false },
})
