/**
 * Supported server majors ([postgres-adapter.md §2](../../../../exponetdb-docs/03-database-model/postgres-adapter.md#2-supported-server-versions)),
 * defined in the parser component because each major has its own grammar;
 * the adapter re-exports them. Versions are compared as integers, never as
 * text.
 */
export const SUPPORTED_MAJORS = [16, 17, 18] as const
export type SupportedMajor = (typeof SUPPORTED_MAJORS)[number]

export function isSupportedMajor(value: number): value is SupportedMajor {
  return (SUPPORTED_MAJORS as readonly number[]).includes(value)
}
