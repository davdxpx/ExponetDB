import { config } from 'zod/v4/core'

/**
 * zod compiles object parsers with `new Function` unless it runs jitless. To
 * decide, it probes once with `new Function("")` inside a `try`: under the
 * page's CSP (`script-src 'self'`, no `unsafe-eval`) the probe throws and is
 * swallowed, but Chromium still reports a `securitypolicyviolation` (an
 * `eval` violation the browser suites count). Jitless parsing never probes
 * and never evaluates text. Imported first by `main.tsx`, before any schema
 * is built (the form demos build theirs at load). The Web App does the same
 * (`apps/web/src/app/zod-jitless.ts`).
 */
config({ jitless: true })
