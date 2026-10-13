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
    exclude: [
      'test/**/*.int.test.ts',
      'test/**/*.e2e.test.ts',
      'test/**/*.host.test.ts',
      'test/**/*.install.test.ts',
      'test/**/*.lab.test.ts',
      'test/**/*.conformance.test.ts',
      'test/**/*.model.test.ts',
      '**/node_modules/**',
    ],
    environment: 'node',
    reporters: ['default'],
  },
})

// Component tests of the browser packages (Wave 8: `packages/ui*`, `packages/icons`,
// `packages/tokens`, `apps/web`, `apps/design-system`): `.test.ts` and
// `.test.tsx` files in a jsdom document with the shims of vitest.dom-setup.ts.
// Each package declares jsdom and the Testing Library packages it uses.
export const componentConfig = defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: [new URL('./vitest.dom-setup.ts', import.meta.url).pathname],
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

// Browser end-to-end tests (`*.e2e.test.ts`): a real Chromium with a virtual
// WebAuthn authenticator against the real program and PostgreSQL 17. Never
// skipped: without the browser, the built Web App or the database they fail.
export const e2eConfig = defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['test/**/*.e2e.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})

// Host tests (`*.host.test.ts`): the real Go agent and root helper against
// disposable PostgreSQL clusters on this host (tooling/dev/node-clusters.sh),
// as root, with EXDB_TEST_PG_URL for the Control Store. Never skipped: without
// root, EXDB_NODE_CLUSTERS or EXDB_NODE_E2E_AGENT_USER they fail. Only run
// where such a host is provided (the CI job node-pg, local-development.md §5b).
export const hostConfig = defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['test/**/*.host.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 900_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})

// Install tests (`*.install.test.ts`): a packed artifact installed outside the
// monorepo and run as a process (apps/cli). Never skipped: without Node 24
// (EXDB_CLI_NODE), npm or Bun they fail.
export const installConfig = defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['test/**/*.install.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})

// Lab tests (`*.lab.test.ts`): the local test lab on the real Docker daemon
// (apps/cli), from the ExponetDB image EXDB_LAB_IMAGE names. Never skipped:
// without Docker or the image they fail.
export const labConfig = defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['test/**/*.lab.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})

// Conformance tests (`*.conformance.test.ts`, apps/server): the pinned MCP
// conformance suite against the test composition of `/mcp` on a local port.
// Never skipped: without the package registry (to fetch the pinned suite)
// they fail.
export const conformanceConfig = defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['test/**/*.conformance.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})

// Model evals (`*.model.test.ts`, apps/server; Wave 7 order §29 layers B and
// C): a model works on the eval tasks through `/mcp` of the test composition
// with the owner's own key (`EXDB_EVAL_ANTHROPIC_API_KEY`). Never part of
// `verify` or CI; without the key every task fails as NOT RUN, never green.
export const modelEvalsConfig = defineConfig({
  ...sharedConfig,
  test: {
    ...sharedConfig.test,
    include: ['test/**/*.model.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})
