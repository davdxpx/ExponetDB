// MDX pages compile to a React component plus their ESM exports; `meta` is
// checked at run time by the page registry (src/content/registry.ts).
declare module '*.mdx' {
  import type { ComponentType } from 'react'

  export const meta: unknown
  const Content: ComponentType<{ readonly components?: Readonly<Record<string, unknown>> }>
  // biome-ignore lint/style/noDefaultExport: an MDX module's page is its default export (the compiler's output, not ours)
  export default Content
}
