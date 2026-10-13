// Derived from supabase/supabase packages/ui-patterns/src/form/KeyValueFieldArray/validation.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
type KeyValueFieldName = string

export type KeyValueFieldArrayValidationIssue<TFieldName extends KeyValueFieldName> = {
  path: [number, TFieldName]
  message: string
}

type GetKeyValueFieldArrayValidationIssuesParams<
  TRow extends Record<string, unknown>,
  TKeyFieldName extends Extract<keyof TRow, string>,
  TValueFieldName extends Extract<keyof TRow, string>,
> = {
  rows: TRow[]
  keyFieldName: TKeyFieldName
  valueFieldName: TValueFieldName
  keyRequiredMessage: string
  valueRequiredMessage: string
  duplicateKeyMessage?: string
  allowEmptyRows?: boolean
  normalizeKey?: (key: string) => string
}

const getTrimmedString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export type StripEmptyKeyValueFieldArrayRowsParams<
  TRow extends Record<string, unknown>,
  TKeyFieldName extends Extract<keyof TRow, string>,
  TValueFieldName extends Extract<keyof TRow, string>,
> = {
  rows: TRow[]
  keyFieldName: TKeyFieldName
  valueFieldName: TValueFieldName
}

/**
 * Removes fully empty draft rows before persisting field-array values.
 */
export const stripEmptyKeyValueFieldArrayRows = <
  TRow extends Record<string, unknown>,
  TKeyFieldName extends Extract<keyof TRow, string>,
  TValueFieldName extends Extract<keyof TRow, string>,
>({
  rows,
  keyFieldName,
  valueFieldName,
}: StripEmptyKeyValueFieldArrayRowsParams<TRow, TKeyFieldName, TValueFieldName>) =>
  rows.filter((row) => {
    const key = getTrimmedString(row[keyFieldName])
    const value = getTrimmedString(row[valueFieldName])

    return key.length > 0 || value.length > 0
  })

/**
 * Returns per-cell validation issues for draft-friendly key/value rows.
 *
 * Consumers should feed these issues into their resolver schema, typically via
 * `zod.superRefine(...)`, so validation stays declarative and local to the form.
 */
export const getKeyValueFieldArrayValidationIssues = <
  TRow extends Record<string, unknown>,
  TKeyFieldName extends Extract<keyof TRow, string>,
  TValueFieldName extends Extract<keyof TRow, string>,
>({
  rows,
  keyFieldName,
  valueFieldName,
  keyRequiredMessage,
  valueRequiredMessage,
  duplicateKeyMessage,
  allowEmptyRows = true,
  normalizeKey = (key) => key,
}: GetKeyValueFieldArrayValidationIssuesParams<TRow, TKeyFieldName, TValueFieldName>) => {
  const issues: KeyValueFieldArrayValidationIssue<TKeyFieldName | TValueFieldName>[] = []
  const rowIndexesByKey = duplicateKeyMessage ? new Map<string, number[]>() : null

  rows.forEach((row, index) => {
    const key = getTrimmedString(row[keyFieldName])
    const value = getTrimmedString(row[valueFieldName])

    if (!key && !value) {
      if (!allowEmptyRows) {
        issues.push({ path: [index, keyFieldName], message: keyRequiredMessage })
        issues.push({ path: [index, valueFieldName], message: valueRequiredMessage })
      }
      return
    }

    if (!key) {
      issues.push({ path: [index, keyFieldName], message: keyRequiredMessage })
      return
    }

    if (!value) {
      issues.push({ path: [index, valueFieldName], message: valueRequiredMessage })
      return
    }

    if (!rowIndexesByKey) return

    const normalizedKey = normalizeKey(key)
    if (!normalizedKey) return

    rowIndexesByKey.set(normalizedKey, [...(rowIndexesByKey.get(normalizedKey) ?? []), index])
  })

  if (!rowIndexesByKey || !duplicateKeyMessage) return issues

  rowIndexesByKey.forEach((indexes) => {
    if (indexes.length < 2) return

    indexes.forEach((index) => {
      issues.push({
        path: [index, keyFieldName],
        message: duplicateKeyMessage,
      })
    })
  })

  return issues
}
