import axe from 'axe-core'

/**
 * Accessibility check of a rendered subtree with axe-core (WCAG 2.2 A/AA
 * rules). jsdom has no layout, so the rules that need rendering (color
 * contrast, which the token tests prove in Chromium instead) are off.
 * Returns readable violations; a test asserts the list is empty.
 */
export async function axeViolations(root: Element = document.body): Promise<string[]> {
  const result = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: { 'color-contrast': { enabled: false } },
  })
  return result.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
  )
}
