import { spawn } from 'node:child_process'
import { CliError } from '../errors.ts'

/**
 * The lab's only way to Docker ([`15-cli/lab.md`](../../../../exponetdb-docs/15-cli/lab.md)):
 * the `docker` program on PATH, bound to the local daemon socket. A Docker
 * context, `DOCKER_HOST` or a buildx builder chosen elsewhere is never used:
 * the lab creates and removes containers and must not do that on a remote
 * daemon by accident. Arguments are passed as an array (no shell).
 */
export const LOCAL_SOCKET = 'unix:///var/run/docker.sock'

/** Variables that would point the docker program somewhere else. */
const REMOTE_VARIABLES = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'BUILDX_BUILDER',
] as const

export interface DockerResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface DockerOptions {
  /** Bytes for the program's stdin. */
  readonly input?: string | Buffer
  /** Each line of the program's output, as it comes (build progress). */
  readonly onLine?: (line: string) => void
  readonly signal?: AbortSignal
}

export interface Docker {
  /** Runs `docker <args>` and collects its output. */
  run(args: readonly string[], options?: DockerOptions): Promise<DockerResult>
  /** Runs `docker <args>` on this terminal (shell, psql, logs --follow); the exit code. */
  attach(args: readonly string[]): Promise<number>
}

/**
 * The docker program with the local socket. `EXPONETDB_LAB_DOCKER_SOCKET`
 * may name another local socket (a rootless daemon), never a TCP address.
 */
export function localDocker(env: NodeJS.ProcessEnv): Docker {
  const socket = env['EXPONETDB_LAB_DOCKER_SOCKET'] ?? LOCAL_SOCKET
  if (!/^unix:\/\/\/[^\s]+$/.test(socket)) {
    throw new CliError('usage', 'EXPONETDB_LAB_DOCKER_SOCKET must be a local unix:// socket.')
  }
  const childEnv: NodeJS.ProcessEnv = { ...env }
  for (const name of REMOTE_VARIABLES) delete childEnv[name]
  // The builder of the default (local) context, not one selected elsewhere.
  childEnv['BUILDX_BUILDER'] = 'default'
  const argv = (args: readonly string[]) => ['--host', socket, ...args]
  return {
    run(args, options = {}) {
      return new Promise((resolve) => {
        const child = spawn('docker', argv(args), {
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
        const out: Buffer[] = []
        const err: Buffer[] = []
        let partial = ''
        const line = (chunk: Buffer) => {
          if (options.onLine === undefined) return
          partial += chunk.toString('utf8')
          const lines = partial.split('\n')
          partial = lines.pop() ?? ''
          for (const l of lines) options.onLine(l)
        }
        child.stdout.on('data', (c: Buffer) => {
          out.push(c)
          line(c)
        })
        child.stderr.on('data', (c: Buffer) => {
          err.push(c)
          line(c)
        })
        child.on('error', (error: NodeJS.ErrnoException) => {
          resolve({
            code: error.code === 'ENOENT' ? 127 : -1,
            stdout: '',
            stderr: error.code === 'ENOENT' ? 'docker: not found' : String(error.message),
          })
        })
        child.on('close', (code) => {
          if (partial !== '' && options.onLine !== undefined) options.onLine(partial)
          resolve({
            code: code ?? -1,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
          })
        })
        child.stdin.on('error', () => undefined)
        child.stdin.end(options.input ?? '')
      })
    },
    attach(args) {
      return new Promise((resolve) => {
        const child = spawn('docker', argv(args), { env: childEnv, stdio: 'inherit' })
        child.on('error', () => resolve(127))
        child.on('close', (code) => resolve(code ?? 1))
      })
    },
  }
}

/** A failed docker call as the CLI's error (the daemon's message, first line only). */
export function dockerFailure(what: string, r: DockerResult): CliError {
  const first = r.stderr.trim().split('\n')[0] ?? ''
  if (r.code === 127) {
    return new CliError(
      'lab_unavailable',
      'Docker is not installed (the docker program is not on PATH).',
    )
  }
  // The daemon's wording differs between Docker versions.
  if (
    /Cannot connect to the Docker daemon|failed to connect to the docker API|Is the docker daemon running|permission denied.*docker\.sock/i.test(
      r.stderr,
    )
  ) {
    return new CliError(
      'lab_unavailable',
      `The local Docker daemon is not reachable (${first}). Start Docker, or check that you may use its socket.`,
    )
  }
  return new CliError('lab_failed', `${what} failed: ${first}`)
}

/** Runs a docker call that must succeed. */
export async function must(
  docker: Docker,
  what: string,
  args: readonly string[],
  options?: DockerOptions,
): Promise<string> {
  const r = await docker.run(args, options)
  if (r.code !== 0) throw dockerFailure(what, r)
  return r.stdout
}
