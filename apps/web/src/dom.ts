/**
 * A tiny element builder. Text always goes through `textContent` (never
 * `innerHTML`): names, labels and device strings come from people and are
 * untrusted. No inline styles or handlers in markup (the CSP forbids them);
 * listeners are attached in code.
 */
export type Child = Node | string | false | null | undefined

type Listener = (event: Event) => void
export type Props = Readonly<Record<string, string | number | boolean | Listener | undefined>>

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) {
      continue
    }
    if (typeof value === 'function') {
      el.addEventListener(key.replace(/^on/, ''), value)
    } else if (value === true) {
      el.setAttribute(key, '')
    } else {
      el.setAttribute(key, String(value))
    }
  }
  append(el, children)
  return el
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) {
      continue
    }
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren()
  append(parent, children)
}

/** Reads a named field of a submitted form as text. */
export function field(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name)
  return typeof value === 'string' ? value : ''
}

const SVG = 'http://www.w3.org/2000/svg'

/** A QR code drawn locally as SVG path data (no image service, no inline style). */
export function qrImage(pathData: string, size: number, label: string): SVGSVGElement {
  const quiet = 4
  const svg = document.createElementNS(SVG, 'svg')
  const extent = size + quiet * 2
  svg.setAttribute('viewBox', `0 0 ${extent} ${extent}`)
  svg.setAttribute('class', 'qr')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  svg.setAttribute('shape-rendering', 'crispEdges')
  const background = document.createElementNS(SVG, 'rect')
  background.setAttribute('width', String(extent))
  background.setAttribute('height', String(extent))
  background.setAttribute('fill', '#ffffff')
  const modules = document.createElementNS(SVG, 'path')
  modules.setAttribute('d', pathData)
  modules.setAttribute('fill', '#000000')
  svg.append(background, modules)
  return svg
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}
