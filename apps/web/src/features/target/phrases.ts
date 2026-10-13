import { type MessageKey, t } from '../../lib/i18n/i18n.ts'

/**
 * A catalog message that a pattern composes into its own sentence after a
 * verb: "Could not read target", "Loading target health", "You do not have
 * access to this page". The catalog keeps every message in sentence case, so
 * the phrase is lower-cased where it is used. Only for plain nouns; a name
 * such as ExponetDB never goes through here.
 */
export function nounPhrase(key: MessageKey): string {
  return t(key).toLowerCase()
}
