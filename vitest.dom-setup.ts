// Setup of the component tests (`componentConfig` in vitest.shared.ts): a DOM
// (jsdom) with the browser APIs the UI libraries expect and jsdom lacks, and
// a clean document after every test. No network, no timers faked here.
import { afterEach } from 'vitest'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof window !== 'undefined') {
  if (window.matchMedia === undefined) {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
  if (globalThis.ResizeObserver === undefined) {
    globalThis.ResizeObserver = ResizeObserverStub
  }
  if (Element.prototype.scrollIntoView === undefined) {
    Element.prototype.scrollIntoView = () => {}
  }
  if (Element.prototype.hasPointerCapture === undefined) {
    Element.prototype.hasPointerCapture = () => false
    Element.prototype.releasePointerCapture = () => {}
    Element.prototype.setPointerCapture = () => {}
  }
}

afterEach(() => {
  // Only a real DOM is reset; a test may stand in its own minimal `document`.
  if (typeof HTMLElement !== 'undefined' && document.body instanceof HTMLElement) {
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-theme')
  }
})
