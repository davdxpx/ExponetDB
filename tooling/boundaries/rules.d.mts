import type { ICruiseOptions, IForbiddenRuleType } from 'dependency-cruiser'

export interface Component {
  readonly path: string
  readonly allowed: readonly string[]
}
export interface BoundaryGraph {
  readonly foundations: readonly string[]
  readonly components: Readonly<Record<string, Component>>
  readonly noFoundations: readonly string[]
  readonly runtimeDependencies: {
    readonly allowedIn: Readonly<Record<string, readonly string[]>>
    readonly forbidden: readonly string[]
  }
}
export const graph: BoundaryGraph
export function allowedComponents(name: string): string[]
export function moduleNameOf(name: string): string | undefined
export function boundaryRules(): IForbiddenRuleType[]
export const forbidden: IForbiddenRuleType[]
export const options: ICruiseOptions & {
  readonly enhancedResolveOptions: {
    conditionNames: string[]
    exportsFields: string[]
    extensions: string[]
  }
}
