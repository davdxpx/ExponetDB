import { defineConfig } from 'vitest/config'
import { integrationConfig } from '../../vitest.shared.ts'

// The engine's suites hold target sessions on purpose (locks, a waiting
// backend, a lost COMMIT reply): one file at a time, so one never takes the
// sessions another one waits for.
export default defineConfig({
  ...integrationConfig,
  test: { ...integrationConfig.test, fileParallelism: false },
})
