import type { Io } from '../src/cli/run.ts'

/**
 * A process seam for tests: output collected per stream (and in one list
 * of lines), no terminal unless asked, no browser, no real sleeping.
 */
export interface TestIoOptions {
  readonly lines?: string[]
  readonly stdout?: string[]
  readonly stderr?: string[]
  readonly env?: NodeJS.ProcessEnv
  readonly configDir: string
  readonly cwd?: string
  readonly fetch?: typeof fetch
  readonly openBrowser?: (url: string) => void
  readonly tty?: boolean
  readonly columns?: number
  readonly stdin?: string
  readonly secret?: string
  readonly confirm?: boolean
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly sleeps?: number[]
}

export function testIo(o: TestIoOptions): Io {
  const split = (text: string, into: string[] | undefined) => {
    const parts = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
    o.lines?.push(...parts)
    into?.push(text)
  }
  return {
    stdout: (text) => split(text, o.stdout),
    stderr: (text) => split(text, o.stderr),
    readStdin: async () => o.stdin ?? '',
    tty: { stdout: o.tty === true, stderr: o.tty === true, stdin: o.tty === true },
    columns: o.columns,
    env: o.env ?? {},
    cwd: o.cwd ?? o.configDir,
    fetch: o.fetch ?? globalThis.fetch,
    configDir: o.configDir,
    platform: process.platform,
    openBrowser: o.openBrowser ?? (() => undefined),
    readSecret: async () => o.secret ?? '',
    confirm: async () => o.confirm ?? false,
    signal: o.signal ?? new AbortController().signal,
    now: o.now ?? Date.now,
    sleep: async (ms) => {
      o.sleeps?.push(ms)
    },
  }
}
