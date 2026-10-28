import { defineConfig } from 'vitest/config'
import { sharedConfig } from '../../vitest.shared.ts'

// Tests that need no database (formats, graph, lint, parser, loader).
// TZ is NOT forced here: the runtime-matrix test spawns its own child processes with their own TZ.
export default defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['I*-pure.test.ts', 'I*.pure.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
