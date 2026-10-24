import { type MessageKey, t } from '../../lib/i18n/i18n.ts'

/**
 * A catalog message that a component composes into its own sentence ("You do
 * not have access to lifecycle changes"). The catalog keeps every message in
 * sentence case, starting with a capital, so only its first letter is lowered
 * where the phrase is used. Unlike a whole-string lower-casing this keeps an
 * acronym ("SQL", "URI") as it is. Only for plain phrases; a name such as
 * ExponetDB never goes through here.
 */
export function phrase(key: MessageKey): string {
  const text = t(key)
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`
}
