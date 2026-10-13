import { t } from '../../lib/i18n/i18n.ts'
import type { BreakGlassGrant } from './keys.ts'

/**
 * The post-incident review of a break-glass grant (resources.md,
 * `POST /break-glass-grants/{id}/review`): the note's rules as the contract
 * states them (1 to 2,000 characters, not blank, no control character but the
 * line feed, no bidirectional override or isolate), checked here so a person
 * learns a mistake before the request; the server checks again and records
 * the note once, permanently.
 */
export const REVIEW_NOTE_MAX = 2000

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
const FORBIDDEN = /[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/

export type NoteProblem = 'blank' | 'long' | 'characters'

export function noteProblem(note: string): NoteProblem | undefined {
  if (note.trim().length === 0) return 'blank'
  if (note.length > REVIEW_NOTE_MAX) return 'long'
  if (FORBIDDEN.test(note)) return 'characters'
  return undefined
}

export function noteProblemText(problem: NoteProblem): string {
  switch (problem) {
    case 'blank':
      return t('settings.breakGlass.note.blank')
    case 'long':
      return t('settings.breakGlass.note.long', { max: REVIEW_NOTE_MAX })
    case 'characters':
      return t('settings.breakGlass.note.characters')
  }
}

export function grantStateLabel(state: BreakGlassGrant['state']): string {
  switch (state) {
    case 'active':
      return t('settings.breakGlass.state.active')
    case 'expired':
      return t('settings.breakGlass.state.expired')
    case 'revoked':
      return t('settings.breakGlass.state.revoked')
    case 'used_up':
      return t('settings.breakGlass.state.used_up')
  }
}

/** "3 of 5 uses" or "3 uses, no limit". */
export function usesText(grant: BreakGlassGrant): string {
  return grant.maxUses === null
    ? t('settings.breakGlass.uses.unlimited', { uses: grant.uses })
    : t('settings.breakGlass.uses', { uses: grant.uses, max: grant.maxUses })
}
