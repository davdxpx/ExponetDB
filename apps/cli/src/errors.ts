/**
 * A refusal of the CLI: a stable code and a message written here. Messages
 * never contain a token, a code, a verifier or a server response body.
 */
export class CliError extends Error {
  override readonly name = 'CliError'
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
