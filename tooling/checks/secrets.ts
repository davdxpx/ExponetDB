import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Secret scan over every tracked file (G0 check F, now in CI). Fixtures and
 * vectors are synthetic; a hit is either a real leak or a fixture that must be
 * changed. The scanner proves itself on canaries assembled at run time, so
 * this file never contains a real-looking secret.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const PATTERNS: readonly [string, RegExp][] = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['OpenAI or Anthropic key', /\bsk-(ant-)?[A-Za-z0-9_-]{32,}/],
  ['Stripe live key', /\b[rs]k_live_[A-Za-z0-9]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['URL with credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{3,}@[^\s'"]+/i],
  ['ExponetDB token', /\bex(at|rt|ak)_[A-Za-z0-9]{24,}/],
  [
    'secret assignment',
    /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
  ],
]

export function scan(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name)
}

function selfTest(): void {
  const canaries = [
    ['-----BEGIN ', 'RSA PRIVATE KEY-----'],
    ['AKIA', 'ABCDEFGHIJKLMNOP'],
    ['ghp_', 'a'.repeat(36)],
    ['sk-ant-', 'b'.repeat(40)],
    ['postgres://admin:', 'hunter22@db.internal/prod'],
    ['exat_', 'c'.repeat(30)],
  ].map((parts) => parts.join(''))
  for (const canary of canaries) {
    if (scan(canary).length === 0) {
      console.error(`secret scanner misses its canary: ${canary.slice(0, 6)}…`)
      process.exit(2)
    }
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  selfTest()
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f.length > 0)
  const hits: string[] = []
  for (const file of tracked) {
    if (/\.(png|jpg|ico|woff2?)$/.test(file) || file === 'bun.lock') {
      continue
    }
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      for (const name of scan(line)) {
        hits.push(`${file}:${i + 1}: ${name}`)
      }
    }
  }
  if (hits.length > 0) {
    console.error(hits.join('\n'))
    process.exit(1)
  }
  console.log(
    `no secrets in ${tracked.length} tracked files (scanner checked against ${PATTERNS.length} patterns and canaries)`,
  )
}
