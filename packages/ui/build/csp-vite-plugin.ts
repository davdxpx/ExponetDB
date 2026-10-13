/**
 * Build-time fixes that keep third-party primitives inside the Web App's CSP
 * (`script-src 'self'; style-src 'self'`, order D9) without relaxing it. Each
 * fix names the module it changes and the exact construct it removes; when a
 * module is part of the build but the construct is no longer found (a new
 * library version), the build fails instead of shipping a violation.
 *
 * 1. `react-style-singleton` (used by the scroll lock of every modal Radix
 *    primitive): its `singleton.js` is replaced by `src/csp/style-singleton.ts`,
 *    which uses constructable stylesheets instead of a `<style>` element.
 * 2. `@radix-ui/react-scroll-area` and `@radix-ui/react-select` render a
 *    `<style dangerouslySetInnerHTML>` in their viewports; the element is
 *    removed and `src/csp.css` carries the same rules.
 * 3. `input-otp` creates `<style id="input-otp-style">` unless an element with
 *    that id exists: the page gets an inert `<meta id="input-otp-style">`, and
 *    `src/csp.css` carries the rules.
 *
 * Evidence: the Wave 8 CSP spike in Chromium (G8 record §5.1) and the
 * permanent browser test `csp-ui-surface`.
 */
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const SINGLETON = fileURLToPath(new URL('../src/csp/style-singleton.ts', import.meta.url))
const RADIX_STYLE =
  /\/\* @__PURE__ \*\/ jsx\(\s*"style",\s*\{\s*dangerouslySetInnerHTML:\s*\{\s*__html:\s*`[^`]*`\s*\},\s*nonce\s*\}\s*\)/g

const normalize = (id: string): string => (id.split('?')[0] ?? id).replace(/\\/g, '/')

export function cspPrimitives(): Plugin {
  const seen = new Set<string>()
  const fixed = new Set<string>()
  return {
    name: 'exponetdb-csp-primitives',
    enforce: 'pre',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            id: 'input-otp-style',
            name: 'exponetdb-csp',
            content: 'input-otp-styles-are-static',
          },
          injectTo: 'head',
        },
      ]
    },
    transform(code, rawId) {
      const id = normalize(rawId)
      if (/\/react-style-singleton\/dist\/es2015\/singleton\.js$/.test(id)) {
        seen.add('react-style-singleton')
        fixed.add('react-style-singleton')
        return {
          code: `export { stylesheetSingleton } from ${JSON.stringify(SINGLETON)};\n`,
          map: null,
        }
      }
      const radix = /\/@radix-ui\/react-(scroll-area|select)\/dist\/index\.mjs$/.exec(id)
      if (radix !== null) {
        const name = `@radix-ui/react-${radix[1] ?? ''}`
        seen.add(name)
        let count = 0
        const out = code.replace(RADIX_STYLE, () => {
          count++
          return 'null'
        })
        if (count === 0) {
          this.error(`${name}: the injected <style> element was not found; review the CSP fix`)
        }
        fixed.add(name)
        return { code: out, map: null }
      }
      return null
    },
    buildEnd() {
      const missing = [...seen].filter((name) => !fixed.has(name))
      if (missing.length > 0) {
        this.error(`CSP fixes not applied to: ${missing.join(', ')}`)
      }
    },
  }
}
