import { runCommand } from './commands/index.ts'

/**
 * Entry point of the `exponetdb` program (Node.js 24). The command line
 * selects the role or the one-shot command; see `commands/index.ts`.
 */
const code = await runCommand(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
})
process.exitCode = code
// Long-running roles have closed their listeners and pools; a one-shot command
// may leave idle sockets (OTLP exporter, pool) for a moment. Exit explicitly.
setTimeout(() => process.exit(code), 100).unref()
