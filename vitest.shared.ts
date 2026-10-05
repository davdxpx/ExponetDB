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
    environment: 'node',
    reporters: ['default'],
  },
})
