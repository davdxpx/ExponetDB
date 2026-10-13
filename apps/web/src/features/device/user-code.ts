/**
 * The user code of a device sign-in (RFC 8628; oauth.md §5, threat model
 * "device-code phishing"): eight letters the CLI shows as `BCDF-GHJK`. The
 * person types it; the page never takes it from a link or a query. Case,
 * dashes and spaces do not matter, so the field keeps the letters only and
 * the request sends them in the device's own shape. The server checks the
 * alphabet and counts every try against the person.
 */
export const USER_CODE_LENGTH = 8

/** The letters of what was typed or pasted, upper case, at most eight. */
export function codeLetters(input: string): string {
  return input
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, USER_CODE_LENGTH)
}

export function isCompleteCode(letters: string): boolean {
  return new RegExp(`^[A-Z]{${USER_CODE_LENGTH}}$`).test(letters)
}

/** The code as the device shows it and the server accepts it: `BCDF-GHJK`. */
export function formatUserCode(letters: string): string {
  const half = USER_CODE_LENGTH / 2
  return letters.length <= half ? letters : `${letters.slice(0, half)}-${letters.slice(half)}`
}
