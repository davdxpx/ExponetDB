import { EditorView } from '@codemirror/view'

/**
 * Helpers of the editor tests. jsdom has no layout, so these tests prove the
 * structure and the behavior of the editors (what is in the shadow root, what
 * a key or an edit does, what a screen reader is told) and not their
 * appearance: the real-browser CSP and rendering checks cover that.
 */

const emptyRect: DOMRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({}),
}

/** CodeMirror measures text through `Range`; answer "nothing is laid out". */
export function installLayoutStubs(): void {
  Range.prototype.getBoundingClientRect = () => emptyRect
  Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null })
  if (typeof document.elementFromPoint !== 'function') {
    document.elementFromPoint = () => null
  }
  // jsdom reports Apple's vendor string, so CodeMirror takes its Safari path, which asks for this.
  if (typeof document.execCommand !== 'function') {
    document.execCommand = () => false
  }
}

/** The open shadow root of the editor host inside `container`. */
export function shadowOf(container: HTMLElement): ShadowRoot {
  const host = container.querySelector('[data-exdb-editor]')
  const root = host instanceof HTMLElement ? host.shadowRoot : null
  if (root === null) throw new Error('no shadow root: the editor is not mounted')
  return root
}

/** Every CodeMirror view inside a shadow root (one for the SQL editor, two for the diff). */
export function viewsOf(root: ShadowRoot): EditorView[] {
  const views: EditorView[] = []
  for (const dom of root.querySelectorAll('.cm-editor')) {
    const view = dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null
    if (view !== null) views.push(view)
  }
  return views
}

export function viewOf(root: ShadowRoot): EditorView {
  const [view] = viewsOf(root)
  if (view === undefined) throw new Error('no editor view in the shadow root')
  return view
}

class FakeSheet {
  readonly rules: string[] = []
  insertRule(rule: string, index = 0): number {
    this.rules.splice(index, 0, rule)
    return index
  }
}

/**
 * Stands in for constructable stylesheets, which jsdom lacks, the way Chromium
 * has them: a shadow root with `adoptedStyleSheets` and a `CSSStyleSheet` that
 * takes rules. With them CodeMirror's style module adopts one sheet per
 * document instead of adding a `<style>` element. Returns a restore function.
 */
export function installAdoptedSheets(): { sheets: FakeSheet[]; restore: () => void } {
  const sheets: FakeSheet[] = []
  const original = window.CSSStyleSheet
  class TrackedSheet extends FakeSheet {
    constructor() {
      super()
      sheets.push(this)
    }
  }
  Object.defineProperty(window, 'CSSStyleSheet', { configurable: true, value: TrackedSheet })
  const stores = new WeakMap<object, unknown[]>()
  Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
    configurable: true,
    get() {
      return stores.get(this) ?? []
    },
    set(value: unknown[]) {
      stores.set(this, value)
    },
  })
  return {
    sheets,
    restore: () => {
      Object.defineProperty(window, 'CSSStyleSheet', { configurable: true, value: original })
      Reflect.deleteProperty(ShadowRoot.prototype, 'adoptedStyleSheets')
    },
  }
}
