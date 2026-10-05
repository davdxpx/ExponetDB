import { defaultClientConditions, defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

// Workspace packages resolve to their TypeScript sources through the
// `@exponetdb/source` export condition, so tests never run against stale builds.
const sourceCondition = '@exponetdb/source'

export const sharedConfig = defineConfig({
  resolve: { conditions: [sourceCondition, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [sourceCondition, ...defaultServerConditions] } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
})
