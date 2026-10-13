import type { ComponentType } from 'react'
import { AREAS, type Area, locate, type PageMeta, parseMeta } from './meta.ts'

/**
 * Every page of the design-system app, found at build time: each
 * `src/content/<area>/<slug>.mdx` is one page at `/<area>/<slug>`. The
 * navigation, the home page and the agent-readable index are built from
 * this one list.
 */
interface MdxModule {
  readonly default: ComponentType<{ readonly components?: Readonly<Record<string, unknown>> }>
  readonly meta: unknown
}

export interface Page extends PageMeta {
  readonly area: Area
  readonly slug: string
  /** `/<area>/<slug>`. */
  readonly path: string
  readonly Content: MdxModule['default']
}

export function buildPages(modules: Readonly<Record<string, MdxModule>>): readonly Page[] {
  const pages = Object.entries(modules).map(([file, module]): Page => {
    const { area, slug } = locate(file)
    return {
      ...parseMeta(module.meta, file),
      area,
      slug,
      path: `/${area}/${slug}`,
      Content: module.default,
    }
  })
  return pages.sort(
    (a, b) =>
      AREAS.indexOf(a.area) - AREAS.indexOf(b.area) ||
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      a.title.localeCompare(b.title, 'en-US'),
  )
}

export const PAGES: readonly Page[] = buildPages(
  import.meta.glob<MdxModule>('./*/*.mdx', { eager: true }),
)

export function pageAt(path: string): Page | undefined {
  return PAGES.find((page) => page.path === path)
}
