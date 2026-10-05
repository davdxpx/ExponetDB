import { defaultClientConditions, defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

// Workspace packages resolve to their TypeScript sources through the
// `@exponetdb/source` export condition, so tests never run against stale builds.
// Dependencies resolve like Node.js resolves them at run time: the bundler-only
// `module` condition is left out, because some packages (OpenTelemetry) point
// it at ESM builds that Node.js itself cannot load.
const sourceCondition = '@exponetdb/source'
const nodeConditions = defaultServerConditions.filter((c) => c !== 'module')

export const sharedConfig = defineConfig({
  resolve: { conditions: [sourceCondition, ...defaultClientConditions] },
  ssr: {
    resolve: {
      conditions: [sourceCondition, ...nodeConditions],
      externalConditions: nodeConditions,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.int.test.ts', '**/node_modules/**'],
    environment: 'node',
    reporters: ['default'],
  },
})

// Integration tests (`*.int.test.ts`) run against a real PostgreSQL 17 server
// named by EXDB_TEST_PG_URL (a superuser URL of a disposable server). They are
// never skipped: without the variable the suite fails with an explanation.
export const integrationConfig = defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['test/**/*.int.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
