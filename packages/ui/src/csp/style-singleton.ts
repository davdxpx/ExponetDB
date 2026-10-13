/**
 * A drop-in for `react-style-singleton` (MIT) that never creates a
 * `<style>` element. The modal Radix primitives lock page scrolling through
 * `react-remove-scroll-bar`, which adds its rules (`body[data-scroll-locked]`
 * with the measured scrollbar gap) through this module. Under the Web App's
 * CSP (`style-src 'self'`) a created `<style>` element is blocked and the
 * lock silently fails (the page behind a dialog scrolls). Constructable
 * stylesheets (`new CSSStyleSheet()` + `document.adoptedStyleSheets`) are
 * CSSOM and allowed, so the same rules apply without relaxing the policy.
 * The build aliases the library's `singleton.js` to this module
 * (`build/csp-vite-plugin.ts`); the API is the library's.
 */
export interface StyleSingleton {
  add(css: string): void
  remove(): void
}

export function stylesheetSingleton(): StyleSingleton {
  let counter = 0
  let sheet: CSSStyleSheet | undefined
  return {
    add(css: string): void {
      if (
        counter === 0 &&
        typeof document !== 'undefined' &&
        typeof CSSStyleSheet !== 'undefined'
      ) {
        sheet = new CSSStyleSheet()
        sheet.replaceSync(css)
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      }
      counter++
    },
    remove(): void {
      counter--
      if (counter === 0 && sheet !== undefined && typeof document !== 'undefined') {
        const done = sheet
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== done)
        sheet = undefined
      }
    },
  }
}
