/**
 * A scan of the rendered document for a reveal-once secret (C-20): where does it appear besides
 * the one element that is meant to show it? Any attribute (`title`, `data-*`, `aria-*`, `href`,
 * `value`, `alt`, ...), any comment node, any text node outside `allowed`, the document title and
 * the browser storages count as an exposure. Returns the places found (empty when none).
 */
export function secretExposure(root: ParentNode, secret: string, allowed: string): string[] {
  const found: string[] = []
  const permitted = root.querySelector(allowed)
  const elements = [...root.querySelectorAll('*')]
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      if (attribute.value.includes(secret) || attribute.name.includes(secret)) {
        found.push(`<${element.tagName.toLowerCase()} ${attribute.name}>`)
      }
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.value.includes(secret)) found.push(`<${element.tagName.toLowerCase()}>.value`)
    }
  }
  const walker = document.createTreeWalker(
    root as Node,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT,
  )
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node.nodeValue ?? '').includes(secret)) continue
    const inside = permitted?.contains(node) === true
    if (node.nodeType === Node.COMMENT_NODE) found.push('comment node')
    else if (!inside) found.push(`text outside ${allowed}`)
  }
  if (document.title.includes(secret)) found.push('document.title')
  if (window.location.href.includes(secret)) found.push('location')
  if (JSON.stringify(window.history.state ?? null).includes(secret)) found.push('history.state')
  for (const [name, store] of [
    ['localStorage', window.localStorage],
    ['sessionStorage', window.sessionStorage],
  ] as const) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i) ?? ''
      if (key.includes(secret) || (store.getItem(key) ?? '').includes(secret)) found.push(name)
    }
  }
  if (document.cookie.includes(secret)) found.push('document.cookie')
  return found
}
