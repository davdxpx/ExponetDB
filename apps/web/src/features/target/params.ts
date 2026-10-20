import { SCHEMA_KINDS } from '../../lib/navigation/links.ts'

/**
 * What the page trusts in `/t/<product>/<project>/<environment>`. The three
 * segments are input (C-26): each must match the slug grammar of the registry
 * (`SlugSchema`: a lower-case letter, then up to 38 lower-case letters, digits
 * or hyphens) exactly, or the page is "not found" and nothing is requested.
 * A segment that failed the grammar is never rendered, never put in a link
 * and never sent to the server.
 */
const SLUG_BODY = '[a-z][a-z0-9-]{0,38}'
export const SLUG_PATTERN = new RegExp(`^${SLUG_BODY}$`)

export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value)
}

/** `<product>/<project>/<environment>` as the API names a target (`getTarget`'s `{target}`). */
export const TARGET_PATH_PATTERN = new RegExp(`^${SLUG_BODY}/${SLUG_BODY}/${SLUG_BODY}$`)

export function isTargetPath(value: unknown): value is string {
  return typeof value === 'string' && TARGET_PATH_PATTERN.test(value)
}

/** A target as the route names it: three validated slugs and their path. */
export interface TargetRoute {
  readonly product: string
  readonly project: string
  readonly environment: string
  /** `<product>/<project>/<environment>`. */
  readonly path: string
}

/** The route parameters of the target layout, as the router hands them over (untrusted strings). */
export interface TargetParams {
  readonly product: string
  readonly project: string
  readonly environment: string
}

/** The validated target of the route parameters, or `undefined` when any segment fails the grammar. */
export function parseTargetParams(params: Partial<TargetParams>): TargetRoute | undefined {
  const { product, project, environment } = params
  if (!isSlug(product) || !isSlug(project) || !isSlug(environment)) return undefined
  return { product, project, environment, path: `${product}/${project}/${environment}` }
}

const TARGET_PREFIX = /^\/t\/([^/]+)\/([^/]+)\/([^/]+)/

/** The target a page address (`/t/<product>/<project>/<environment>…`) names, if it is a valid one. */
export function targetOfPathname(pathname: string): TargetRoute | undefined {
  const m = TARGET_PREFIX.exec(pathname)
  if (m === null) return undefined
  const [, product, project, environment] = m
  return parseTargetParams({ product, project, environment })
}

/** The target a registry path names, or `undefined` when it is not three slugs. */
export function splitTargetPath(path: string): TargetRoute | undefined {
  if (!isTargetPath(path)) return undefined
  const [product, project, environment] = path.split('/')
  return parseTargetParams({ product, project, environment })
}

export type SchemaKind = (typeof SCHEMA_KINDS)[number]

/** Whether `/schema/<kind>` names a kind of schema object (never an object's own name). */
export function isSchemaKind(value: unknown): value is SchemaKind {
  return typeof value === 'string' && (SCHEMA_KINDS as readonly string[]).includes(value)
}
