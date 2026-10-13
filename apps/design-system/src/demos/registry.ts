import type { DemoDefinition, DemoModule } from './types.ts'

const ID = /^[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*){2,}$/

/** Every demo by id; a malformed or repeated id fails at load (the build and the tests). */
export function buildDemos(
  modules: Readonly<Record<string, DemoModule>>,
): ReadonlyMap<string, DemoDefinition> {
  const byId = new Map<string, DemoDefinition>()
  for (const [file, module] of Object.entries(modules)) {
    for (const demo of module.demos) {
      if (!ID.test(demo.id))
        throw new Error(`${file}: demo id "${demo.id}" is not <area>/<name>/<state>`)
      if (byId.has(demo.id)) throw new Error(`${file}: demo id "${demo.id}" is used twice`)
      byId.set(demo.id, demo)
    }
  }
  return byId
}

export const DEMOS: ReadonlyMap<string, DemoDefinition> = buildDemos(
  import.meta.glob<DemoModule>('./**/*.demos.tsx', { eager: true }),
)
