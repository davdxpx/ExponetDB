import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { CliError } from '../errors.ts'
import { type Docker, dockerFailure } from './docker.ts'
import type { LabPaths, LabRecord } from './state.ts'

/**
 * The image a lab runs ([`15-cli/lab.md`](../../../../exponetdb-docs/15-cli/lab.md)):
 * built from an ExponetDB source checkout at its current commit (the
 * repository's own Dockerfile, the commit as the build argument), or an
 * image the person names with `--image`. The lab records the commit it was
 * built from and `dev up`/`dev status` compare it with the checkout, so an
 * old image is never reused unnoticed.
 */
export type ImageChoice =
  | { readonly kind: 'source'; readonly dir: string }
  | { readonly kind: 'image'; readonly ref: string }

export interface BuiltImage {
  readonly image: LabRecord['image']
  readonly source: LabRecord['source']
}

const run = promisify(execFile)

/** The checkout's commit, `-dirty` when it has changes; null when it is not a git checkout. */
export async function sourceCommit(dir: string): Promise<string | null> {
  try {
    const head = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(head)) return null
    const status = (await run('git', ['-C', dir, 'status', '--porcelain'])).stdout
    return status.trim() === '' ? head : `${head}-dirty`
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/** The ExponetDB source checkout at or above `from` (its Dockerfile and both apps), if any. */
export async function findSource(from: string): Promise<string | undefined> {
  let dir = resolve(from)
  for (;;) {
    if (
      (await exists(join(dir, 'Dockerfile'))) &&
      (await exists(join(dir, 'apps', 'server', 'package.json'))) &&
      (await exists(join(dir, 'apps', 'cli', 'package.json')))
    ) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

interface ImageFacts {
  readonly Id: string
  readonly Config: { readonly Labels: Record<string, string> | null }
}

async function inspectImage(docker: Docker, ref: string): Promise<ImageFacts | undefined> {
  const r = await docker.run(['image', 'inspect', ref])
  if (r.code !== 0) {
    if (/No such image/i.test(r.stderr)) return undefined
    throw dockerFailure('docker image inspect', r)
  }
  return (JSON.parse(r.stdout) as ImageFacts[])[0]
}

function described(ref: string, facts: ImageFacts): LabRecord['image'] {
  const labels = facts.Config.Labels ?? {}
  if (labels['org.opencontainers.image.title'] !== 'exponetdb') {
    throw new CliError(
      'usage',
      `${ref} is not an ExponetDB image (its title label is not exponetdb).`,
    )
  }
  const revision = labels['org.opencontainers.image.revision']
  return {
    ref,
    id: facts.Id,
    revision: revision === undefined || revision === 'unknown' ? null : revision,
  }
}

export async function ensureImage(
  docker: Docker,
  choice: ImageChoice,
  paths: LabPaths,
  progress: (line: string) => void,
): Promise<BuiltImage> {
  if (choice.kind === 'image') {
    let facts = await inspectImage(docker, choice.ref)
    if (facts === undefined) {
      progress(`pulling ${choice.ref}`)
      const pulled = await docker.run(['pull', choice.ref])
      if (pulled.code !== 0) throw dockerFailure(`docker pull ${choice.ref}`, pulled)
      facts = await inspectImage(docker, choice.ref)
    }
    if (facts === undefined) throw new CliError('lab_failed', `${choice.ref} is not available.`)
    return { image: described(choice.ref, facts), source: null }
  }
  const commit = await sourceCommit(choice.dir)
  if (commit === null) {
    throw new CliError('usage', `${choice.dir} is not a git checkout; name an image with --image.`)
  }
  const head = commit.replace(/-dirty$/, '')
  const tag = `exponetdb-lab:${head.slice(0, 12)}${commit.endsWith('-dirty') ? '-dirty' : ''}`
  const existing = commit.endsWith('-dirty') ? undefined : await inspectImage(docker, tag)
  if (
    existing !== undefined &&
    existing.Config.Labels?.['org.opencontainers.image.revision'] === head
  ) {
    progress(`image ${tag} (built earlier from ${head})`)
    return { image: described(tag, existing), source: { dir: choice.dir, commit } }
  }
  const log = join(paths.work, 'build.log')
  progress(`building ${tag} from ${choice.dir} at ${commit} (log: ${log})`)
  const handle = await open(log, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600)
  let last = 0
  try {
    const r = await docker.run(
      ['build', '--build-arg', `EXPONETDB_BUILD_COMMIT=${head}`, '--tag', tag, choice.dir],
      {
        onLine: (line) => {
          void handle.write(`${line}\n`)
          const step = /^#(\d+) \[[^\]]+\] (.*)$/.exec(line)
          if (step !== null && Number(step[1]) > last) {
            last = Number(step[1])
            progress(`build: ${step[2]?.slice(0, 100) ?? ''}`)
          }
        },
      },
    )
    if (r.code !== 0) {
      throw new CliError('lab_failed', `The image build failed; its log is ${log}.`)
    }
  } finally {
    await handle.close()
  }
  const built = await inspectImage(docker, tag)
  if (built === undefined) throw new CliError('lab_failed', `The build did not produce ${tag}.`)
  return { image: described(tag, built), source: { dir: choice.dir, commit } }
}
