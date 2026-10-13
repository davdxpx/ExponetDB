/**
 * What every page of the design-system app declares about itself: an MDX page
 * exports `meta` (`export const meta = { … }`), checked here when the page
 * registry loads, so a page without a title or area fails the build and the
 * tests instead of rendering a blank entry.
 */
export const AREAS = ['guidance', 'tokens', 'ui', 'ui-patterns', 'ui-data'] as const
export type Area = (typeof AREAS)[number]

export const AREA_LABELS: Readonly<Record<Area, string>> = {
  guidance: 'Guidance',
  tokens: 'Tokens',
  ui: 'Components',
  'ui-patterns': 'Patterns',
  'ui-data': 'Data components',
}

export interface PageMeta {
  /** The page's `h1` and its name in the navigation. */
  readonly title: string
  /** One sentence: what the page covers (the index and the navigation show it). */
  readonly description: string
  /** Pages of an area are ordered by `order`, then by title. */
  readonly order?: number
}

export function parseMeta(value: unknown, where: string): PageMeta {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${where}: export const meta = { title, description } is missing`)
  }
  const record = value as Record<string, unknown>
  const { title, description, order } = record
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error(`${where}: meta.title must be a non-empty string`)
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error(`${where}: meta.description must be a non-empty string`)
  }
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
    throw new Error(`${where}: meta.order must be a number`)
  }
  return order === undefined ? { title, description } : { title, description, order }
}

/** `guidance/forms.mdx` → `{ area: 'guidance', slug: 'forms' }`; anything else is refused. */
export function locate(path: string): { readonly area: Area; readonly slug: string } {
  const m = /^(?:\.\/)?([a-z-]+)\/([a-z0-9][a-z0-9-]*)\.mdx$/.exec(path)
  const area = AREAS.find((a) => a === m?.[1])
  if (m === null || area === undefined || m[2] === undefined) {
    throw new Error(`${path}: pages live at <area>/<slug>.mdx with area one of ${AREAS.join(', ')}`)
  }
  return { area, slug: m[2] }
}
