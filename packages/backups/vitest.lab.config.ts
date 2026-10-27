import { defineConfig } from 'vitest/config'
import { sharedConfig } from '../../vitest.shared.ts'

// Lab tests (`*.lab.test.ts`): real engines on this machine, as root, with disposable
// clusters and repositories in a temporary directory. Never against a real host or bucket.
export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['test/**/*.lab.test.ts'],
    exclude: [],
    testTimeout: 600_000,
  },
})
