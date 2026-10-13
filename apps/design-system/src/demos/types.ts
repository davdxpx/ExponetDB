import type { ReactNode } from 'react'

/**
 * A live demo with mock data (design-system only; the product never ships
 * mocks). Demos are declared in `src/demos/<area>/<name>.demos.tsx` files that
 * export `demos: readonly DemoDefinition[]`; MDX pages show one with
 * `<Demo id="…" />`, the visual-regression host renders each in light and
 * dark, and the accessibility test checks each.
 */
export interface DemoDefinition {
  /** `<area>/<component>/<state>`, lowercase, e.g. `ui/button/variants`. */
  readonly id: string
  readonly title: string
  readonly render: () => ReactNode
  /**
   * False for a demo that cannot be captured as a still image (it only shows
   * something after an interaction) or that is not deterministic; the
   * visual-regression host skips it. True by default.
   */
  readonly visual?: boolean
}

export interface DemoModule {
  readonly demos: readonly DemoDefinition[]
}
