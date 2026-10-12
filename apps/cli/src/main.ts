#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { dispatch } from './cli/dispatch.ts'
import type { Io } from './cli/run.ts'
import { COMMANDS } from './commands/index.ts'
import { CliError } from './errors.ts'
import { defaultConfigDir } from './store.ts'

/**
 * `exponetdb`: the command-line client ([`15-cli/README.md`](../../../exponetdb-docs/15-cli/README.md)).
 * This file only wires the process (streams, terminal, signals) to the
 * dispatcher; every command lives in the registry (`commands/`).
 */
export type { Io }

/** Opens a URL with the platform's opener, without a shell; failures are ignored (the URL is printed anyway). */
export function systemBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? undefined : 'xdg-open'
  if (opener !== undefined && /^https?:\/\//.test(url)) {
    execFile(opener, [url], { timeout: 5000 }, () => undefined)
  }
}

/** Runs one invocation with the given process seam; returns the exit code. */
export function run(argv: readonly string[], io: Io): Promise<number> {
  return dispatch(argv, io, COMMANDS)
}

async function readStdin(maxBytes: number): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > maxBytes)
      throw new CliError('usage', `The input on stdin is larger than ${maxBytes} bytes.`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

let rawMode = false

function restoreTerminal(): void {
  if (rawMode && process.stdin.isTTY) {
    process.stdin.setRawMode(false)
    rawMode = false
  }
}

/** A line typed without echo; Ctrl-C aborts. Never stored, never logged. */
function readSecret(prompt: string, controller: AbortController): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new CliError('usage', 'A secret is read from a terminal only.'))
  }
  process.stderr.write(prompt)
  return new Promise((resolve, reject) => {
    let value = ''
    process.stdin.setRawMode(true)
    rawMode = true
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const done = (error?: Error) => {
      process.stdin.off('data', onData)
      restoreTerminal()
      process.stdin.pause()
      process.stderr.write('\n')
      if (error === undefined) resolve(value)
      else reject(error)
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done()
        if (ch === '\u0003') {
          controller.abort()
          return done(new CliError('interrupted', 'Interrupted.'))
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
      }
    }
    process.stdin.on('data', onData)
  })
}

function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false)
  process.stderr.write(`${question} [y/N] `)
  return new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', (answer: string) => {
      process.stdin.pause()
      resolve(/^y(es)?$/i.test(answer.trim()))
    })
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CliError('interrupted', 'Interrupted.'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CliError('interrupted', 'Interrupted.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function processIo(): Io {
  const controller = new AbortController()
  process.on('SIGINT', () => {
    restoreTerminal()
    // A second Ctrl-C ends at once.
    if (controller.signal.aborted) process.exit(130)
    controller.abort()
  })
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin,
    tty: {
      stdout: process.stdout.isTTY === true,
      stderr: process.stderr.isTTY === true,
      stdin: process.stdin.isTTY === true,
    },
    columns: process.stdout.columns,
    env: process.env,
    cwd: process.cwd(),
    fetch: globalThis.fetch,
    configDir: defaultConfigDir(process.env),
    platform: process.platform,
    openBrowser: systemBrowser,
    readSecret: (prompt) => readSecret(prompt, controller),
    confirm,
    signal: controller.signal,
    now: Date.now,
    sleep,
  }
}

/**
 * Whether this module is the program Node started. An installed CLI starts
 * through the package manager's `bin` link, so the script path is compared
 * after resolving links (Node resolves them for the main module).
 */
function invokedDirectly(): boolean {
  const script = process.argv[1]
  if (script === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  run(process.argv.slice(2), processIo()).then(
    (code) => {
      process.exitCode = code
    },
    () => {
      restoreTerminal()
      process.stderr.write('The CLI failed unexpectedly.\n')
      process.exitCode = 1
    },
  )
}
