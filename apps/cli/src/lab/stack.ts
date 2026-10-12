import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { CliError } from '../errors.ts'
import { createNewPrivateFile, ensurePrivateDir, writePrivateJson } from '../files.ts'
import type { Major } from '../local/grammar.ts'
import { type Docker, dockerFailure, must } from './docker.ts'
import { type BuiltImage, ensureImage, type ImageChoice, sourceCommit } from './image.ts'
import {
  activeRun,
  containerName,
  DATABASE_ROLES,
  type DatabaseRole,
  FIXTURE_VERSION,
  finishRun,
  IMAGES,
  LAB_SCHEMA,
  LABEL,
  type LabPaths,
  type LabRecord,
  labelArgs,
  listRuns,
  networkName,
  ownerTag,
  PROCESS_ROLES,
  type ProcessRole,
  prepareDirs,
  ROLES,
  type Role,
  type RunRecord,
  readLab,
  targetHost,
  volumeName,
  writeLab,
} from './state.ts'

/**
 * The lab's stack ([`15-cli/lab.md`](../../../../exponetdb-docs/15-cli/lab.md)):
 * a private Docker network with the Control Store (PostgreSQL 17), two
 * managed targets (`staging`, `production`; PostgreSQL 16, 17 or 18 with
 * TLS from a CA each target generates for itself) and the three process
 * roles of one ExponetDB image (`serve` on a loopback port, `worker`,
 * `gateway`). It is set up the way an operator sets up an installation:
 * the image's own bootstrap SQL, `control-store migrate` with the migration
 * login, a generated keyring, each role with its own login. Nothing else on
 * the machine is touched: only objects created here, recorded by ID and
 * carrying this lab's labels.
 */
export interface LabEnv {
  readonly docker: Docker
  readonly paths: LabPaths
  readonly labId: string
  readonly progress: (line: string) => void
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly fetch: typeof fetch
}

const DATA = '/var/lib/postgresql/data'
const TLS_DIR = `${DATA}/tls`

// ----- inspection and ownership -----

interface Inspected {
  readonly Id: string
  readonly Name: string
  readonly State: {
    readonly Status: string
    readonly Running: boolean
    readonly Health?: { readonly Status: string }
  }
  readonly Config: { readonly Labels: Record<string, string> | null; readonly Image: string }
  readonly Image: string
  readonly Created: string
  readonly RestartCount: number
  readonly Mounts: readonly {
    readonly Type: string
    readonly Name?: string
    readonly Destination: string
  }[]
  readonly HostConfig: { readonly Privileged: boolean }
}

async function inspectContainer(docker: Docker, ref: string): Promise<Inspected | undefined> {
  const r = await docker.run(['container', 'inspect', ref])
  if (r.code !== 0) {
    if (/No such (object|container)/i.test(r.stderr)) return undefined
    throw dockerFailure('docker inspect', r)
  }
  return (JSON.parse(r.stdout) as Inspected[])[0]
}

/**
 * Refuses a container that is not this lab's: its labels, its name, its
 * mounts (only its own named volume, never a bind mount such as the Docker
 * socket or a host directory) and no privileged mode.
 */
function checkOwned(env: LabEnv, c: Inspected, role: Role): void {
  const labels = c.Config.Labels ?? {}
  const owner = ownerTag(env.paths)
  const expectedVolume = (DATABASE_ROLES as readonly string[]).includes(role)
    ? volumeName(env.labId, role as DatabaseRole)
    : undefined
  const problems = [
    labels[LABEL.id] !== env.labId ? 'lab label' : undefined,
    labels[LABEL.role] !== role ? 'role label' : undefined,
    labels[LABEL.owner] !== owner ? 'owner label' : undefined,
    labels[LABEL.fixture] !== String(FIXTURE_VERSION) ? 'fixture label' : undefined,
    c.Name !== `/${containerName(env.labId, role)}` ? 'name' : undefined,
    c.HostConfig.Privileged ? 'privileged' : undefined,
    c.Mounts.some((m) => m.Type !== 'volume' || m.Name !== expectedVolume) ? 'mounts' : undefined,
  ].filter((p): p is string => p !== undefined)
  if (problems.length > 0) {
    throw new CliError(
      'lab_foreign',
      `Container ${c.Id.slice(0, 12)} does not belong to lab ${env.labId} (${problems.join(', ')}); nothing was changed.`,
    )
  }
}

/** The recorded container of a role, checked; undefined when it is gone. */
async function owned(env: LabEnv, lab: LabRecord, role: Role): Promise<Inspected | undefined> {
  const id = lab.containers[role]
  if (id === undefined) return undefined
  const c = await inspectContainer(env.docker, id)
  if (c === undefined) return undefined
  checkOwned(env, c, role)
  return c
}

/** Refuses to create over an object of the same name that this lab did not record. */
async function refuseForeign(env: LabEnv): Promise<void> {
  for (const role of ROLES) {
    const c = await inspectContainer(env.docker, containerName(env.labId, role))
    if (c !== undefined) {
      throw new CliError(
        'lab_foreign',
        `A container named ${containerName(env.labId, role)} exists but is not recorded by this lab; it is not adopted. Remove it yourself or choose another --lab.`,
      )
    }
  }
  const net = await env.docker.run(['network', 'inspect', networkName(env.labId)])
  if (net.code === 0) {
    throw new CliError(
      'lab_foreign',
      `A network named ${networkName(env.labId)} exists but is not recorded by this lab; it is not adopted.`,
    )
  }
  for (const role of DATABASE_ROLES) {
    const vol = await env.docker.run(['volume', 'inspect', volumeName(env.labId, role)])
    if (vol.code === 0) {
      throw new CliError(
        'lab_foreign',
        `A volume named ${volumeName(env.labId, role)} exists but is not recorded by this lab; it is not adopted.`,
      )
    }
  }
}

export async function checkDocker(docker: Docker): Promise<string> {
  const r = await docker.run(['version', '--format', '{{.Server.Version}}'])
  if (r.code !== 0) throw dockerFailure('docker version', r)
  return r.stdout.trim()
}

// ----- secrets -----

const secret = () => randomBytes(24).toString('base64url')

async function writeSecret(paths: LabPaths, name: string, content: string): Promise<string> {
  const path = join(paths.secrets, name)
  await rm(path, { force: true })
  await createNewPrivateFile(path, content)
  return path
}

async function readSecret(paths: LabPaths, name: string): Promise<string> {
  return readFile(join(paths.secrets, name), 'utf8')
}

function credential(credentials: string, login: string): string {
  const line = credentials.split('\n').find((l) => l.startsWith(`${login}=`))
  if (line === undefined)
    throw new CliError('lab_failed', `The bootstrap credentials have no ${login}.`)
  return line.slice(login.length + 1).trim()
}

function storeUrl(labId: string, login: string, password: string): string {
  return `postgres://${login}:${encodeURIComponent(password)}@${containerName(labId, 'control')}:5432/exponetdb_control`
}

// ----- readiness -----

async function waitFor(
  env: LabEnv,
  what: string,
  seconds: number,
  check: () => Promise<boolean>,
): Promise<void> {
  const until = env.now() + seconds * 1000
  for (;;) {
    if (await check()) return
    if (env.now() >= until)
      throw new CliError('lab_failed', `${what} did not become ready in ${seconds} s.`)
    await env.sleep(1000)
  }
}

/** A database role answers on TCP (the final server, not the init server on the socket). */
async function databaseReady(env: LabEnv, id: string): Promise<boolean> {
  const r = await env.docker.run(['exec', id, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', '5432'])
  return r.code === 0
}

async function health(env: LabEnv, id: string): Promise<string> {
  const c = await inspectContainer(env.docker, id)
  return (
    c?.State.Health?.Status ??
    (c?.State.Running === true ? 'running' : (c?.State.Status ?? 'missing'))
  )
}

async function serveReady(env: LabEnv, port: number): Promise<boolean> {
  try {
    const r = await env.fetch(`http://127.0.0.1:${port}/healthz/ready`, {
      signal: AbortSignal.timeout(3000),
    })
    return r.status === 200
  } catch {
    return false
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

// ----- creating the stack -----

/**
 * The shell a target runs before PostgreSQL: on the first start it creates
 * a CA and a server certificate for the target's container name in its own
 * volume, and a pg_hba that refuses plaintext over TCP. A fixed script of
 * this fixture, never text from elsewhere.
 */
function targetScript(name: string, alias: string): string {
  return [
    'set -eu',
    `d=${TLS_DIR}`,
    'if [ ! -f "$d/server.key" ]; then',
    '  mkdir -p "$d"',
    '  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=exponetdb lab CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout "$d/ca.key" -out "$d/ca.crt" 2>/dev/null',
    `  printf 'subjectAltName=DNS:${alias},DNS:${name},DNS:localhost\\nextendedKeyUsage=serverAuth\\n' > "$d/ext.cnf"`,
    `  openssl req -newkey rsa:2048 -nodes -subj "/CN=${alias}" -keyout "$d/server.key" -out "$d/server.csr" 2>/dev/null`,
    '  openssl x509 -req -in "$d/server.csr" -CA "$d/ca.crt" -CAkey "$d/ca.key" -CAcreateserial -days 825 -extfile "$d/ext.cnf" -out "$d/server.crt" 2>/dev/null',
    '  printf \'local all all trust\\nhostssl all all all scram-sha-256\\nhostnossl all all all reject\\n\' > "$d/pg_hba.conf"',
    '  rm -f "$d/ca.key" "$d/server.csr" "$d/ext.cnf"',
    'fi',
    'chown -R postgres:postgres "$d"',
    'chmod 0700 "$d"',
    'chmod 0600 "$d/server.key"',
    `exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=$d/server.crt -c ssl_key_file=$d/server.key -c hba_file=$d/pg_hba.conf`,
  ].join('\n')
}

async function startDatabase(
  env: LabEnv,
  lab: LabRecord,
  role: DatabaseRole,
  major: Major,
): Promise<string> {
  const name = containerName(env.labId, role)
  const owner = ownerTag(env.paths)
  const envFile = join(env.paths.secrets, `${role}.env`)
  const image = role === 'control' ? IMAGES.control : IMAGES.target[major]
  const args = [
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    lab.network.name,
    '--restart',
    'no',
    ...labelArgs(env.labId, role, owner),
    '--env-file',
    envFile,
    '--env',
    `PGDATA=${DATA}/pgdata`,
    '--mount',
    `type=volume,source=${volumeName(env.labId, role)},target=${DATA}`,
    ...(role === 'control'
      ? [image]
      : [
          '--network-alias',
          targetHost(env.labId, role),
          '--entrypoint',
          'sh',
          image,
          '-c',
          targetScript(name, targetHost(env.labId, role)),
        ]),
  ]
  return (await must(env.docker, `starting ${name}`, args)).trim()
}

async function startProcess(env: LabEnv, lab: LabRecord, role: ProcessRole): Promise<string> {
  const name = containerName(env.labId, role)
  const args = [
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    lab.network.name,
    '--restart',
    'no',
    ...labelArgs(env.labId, role, ownerTag(env.paths)),
    '--env-file',
    join(env.paths.secrets, `${role}.env`),
    ...(role === 'serve' ? ['--publish', `127.0.0.1:${lab.port}:8080`] : []),
    lab.image.id,
    role,
  ]
  return (await must(env.docker, `starting ${name}`, args)).trim()
}

/** Runs one of the image's operator commands in a one-off container; its standard output. */
async function imageCommand(
  env: LabEnv,
  lab: LabRecord,
  what: string,
  script: string,
  options: { network?: boolean; envFile?: string } = {},
): Promise<string> {
  return must(env.docker, what, [
    'run',
    '--rm',
    ...(options.network === true ? ['--network', lab.network.name] : []),
    ...(options.envFile === undefined ? [] : ['--env-file', options.envFile]),
    '--entrypoint',
    'sh',
    lab.image.id,
    '-c',
    script,
  ])
}

async function migrateStore(env: LabEnv, lab: LabRecord): Promise<string> {
  env.progress('Control Store: control-store migrate (login exdb_migrate)')
  const out = await imageCommand(
    env,
    lab,
    'control-store migrate',
    'exec node /app/bin/exponetdb.mjs control-store migrate',
    {
      network: true,
      envFile: join(env.paths.secrets, 'migrate.env'),
    },
  )
  const installation = /"installationId":\s*"(ins_[0-9A-Z]{26})"/.exec(out)?.[1]
  if (installation === undefined || !/"status":\s*"current"/.test(out)) {
    throw new CliError(
      'lab_failed',
      'control-store migrate did not report a current schema and an installation.',
    )
  }
  return installation
}

async function writeProcessEnv(env: LabEnv, lab: LabRecord, installationId: string): Promise<void> {
  const credentials = await readSecret(env.paths, 'credentials')
  const keyring = JSON.stringify(JSON.parse(await readSecret(env.paths, 'keyring.json')))
  const common = (login: string) => [
    `EXPONETDB_CONTROL_STORE_URL=${storeUrl(env.labId, login, credential(credentials, login))}`,
    `EXPONETDB_INSTALLATION_ID=${installationId}`,
    `EXPONETDB_KEYRING=${keyring}`,
    'EXPONETDB_LOG_LEVEL=info',
  ]
  await writeSecret(
    env.paths,
    'serve.env',
    [...common('exdb_serve'), `EXPONETDB_PUBLIC_URL=http://localhost:${lab.port}`, ''].join('\n'),
  )
  await writeSecret(env.paths, 'worker.env', [...common('exdb_worker'), ''].join('\n'))
  await writeSecret(env.paths, 'gateway.env', [...common('exdb_gateway'), ''].join('\n'))
  await writeSecret(
    env.paths,
    'operator.env',
    [
      `EXPONETDB_CONTROL_STORE_URL=${storeUrl(env.labId, 'exdb_serve', credential(credentials, 'exdb_serve'))}`,
      `EXPONETDB_PUBLIC_URL=http://localhost:${lab.port}`,
      'EXPONETDB_LOG_LEVEL=warn',
      '',
    ].join('\n'),
  )
}

async function startProcesses(env: LabEnv, lab: LabRecord): Promise<LabRecord> {
  let current = lab
  for (const role of PROCESS_ROLES) {
    env.progress(`${role}: starting from ${lab.image.revision ?? lab.image.id.slice(7, 19)}`)
    const id = await startProcess(env, current, role)
    current = { ...current, containers: { ...current.containers, [role]: id } }
    await writeLab(env.paths, current)
  }
  await waitProcesses(env, current)
  return current
}

async function waitProcesses(env: LabEnv, lab: LabRecord): Promise<void> {
  for (const role of PROCESS_ROLES) {
    const id = lab.containers[role]
    if (id === undefined) continue
    await waitFor(env, role, 120, async () => {
      const h = await health(env, id)
      if (h === 'exited' || h === 'dead' || h === 'unhealthy') {
        throw new CliError(
          'lab_failed',
          `${role} is ${h}; see: exponetdb dev logs ${role} --lab ${env.labId}`,
        )
      }
      return h === 'healthy'
    })
  }
  await waitFor(env, 'serve readiness', 60, () => serveReady(env, lab.port))
}

async function copyCertificates(env: LabEnv, lab: LabRecord): Promise<void> {
  for (const role of ['staging', 'production'] as const) {
    const id = lab.containers[role]
    if (id === undefined) continue
    await waitFor(env, `${role} certificate`, 60, async () => {
      const r = await env.docker.run(['exec', id, 'cat', `${TLS_DIR}/ca.crt`])
      if (r.code !== 0 || !r.stdout.includes('BEGIN CERTIFICATE')) return false
      await writeFile(join(env.paths.tls, `${role}-ca.crt`), r.stdout, { mode: 0o644 })
      return true
    })
  }
}

export interface CreateOptions {
  readonly image: ImageChoice
  readonly postgres: Major
  readonly port: number
}

/** Creates a new lab from nothing; the record is written after each step, so a failed start can be destroyed. */
export async function createLab(env: LabEnv, options: CreateOptions): Promise<LabRecord> {
  await refuseForeign(env)
  if (!(await portFree(options.port))) {
    throw new CliError(
      'usage',
      `Port ${options.port} on 127.0.0.1 is in use; choose another with --port.`,
    )
  }
  await prepareDirs(env.paths)
  const built: BuiltImage = await ensureImage(env.docker, options.image, env.paths, env.progress)
  const owner = ownerTag(env.paths)
  env.progress(`network ${networkName(env.labId)}`)
  const networkId = (
    await must(env.docker, 'creating the network', [
      'network',
      'create',
      ...labelArgs(env.labId, 'network', owner),
      networkName(env.labId),
    ])
  ).trim()
  let lab: LabRecord = {
    schema: LAB_SCHEMA,
    labId: env.labId,
    fixture: FIXTURE_VERSION,
    createdAt: new Date(env.now()).toISOString(),
    postgres: options.postgres,
    port: options.port,
    source: built.source,
    image: built.image,
    network: { name: networkName(env.labId), id: networkId },
    containers: {},
    volumes: {},
    installationId: null,
  }
  await writeLab(env.paths, lab)
  for (const role of DATABASE_ROLES) {
    await must(env.docker, `creating the ${role} volume`, [
      'volume',
      'create',
      ...labelArgs(env.labId, role, owner),
      volumeName(env.labId, role),
    ])
    lab = { ...lab, volumes: { ...lab.volumes, [role]: volumeName(env.labId, role) } }
    await writeLab(env.paths, lab)
    await writeSecret(env.paths, `${role}.env`, `POSTGRES_PASSWORD=${secret()}\n`)
    env.progress(
      `${role}: PostgreSQL ${role === 'control' ? '17 (Control Store)' : `${options.postgres} with TLS (managed target)`}`,
    )
    const id = await startDatabase(env, lab, role, options.postgres)
    lab = { ...lab, containers: { ...lab.containers, [role]: id } }
    await writeLab(env.paths, lab)
  }
  for (const role of DATABASE_ROLES) {
    const id = lab.containers[role] ?? ''
    await waitFor(env, role, 120, () => databaseReady(env, id))
  }
  await copyCertificates(env, lab)

  env.progress(
    'Control Store: the image’s bootstrap SQL (SCRAM verifiers only), applied as the superuser',
  )
  const split = '--EXDB-LAB-SPLIT--'
  const both = await imageCommand(
    env,
    lab,
    'control-store bootstrap-sql',
    `set -e; node /app/bin/exponetdb.mjs control-store bootstrap-sql --credentials-file /tmp/credentials --output /tmp/bootstrap.sql >/dev/null; cat /tmp/credentials; echo '${split}'; cat /tmp/bootstrap.sql`,
  )
  const at = both.indexOf(`${split}\n`)
  if (at < 0) throw new CliError('lab_failed', 'control-store bootstrap-sql printed no result.')
  await writeSecret(env.paths, 'credentials', both.slice(0, at))
  const sql = both.slice(at + split.length + 1)
  await must(
    env.docker,
    'applying the bootstrap SQL',
    [
      'exec',
      '--interactive',
      '--user',
      'postgres',
      lab.containers.control ?? '',
      'psql',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-d',
      'postgres',
    ],
    { input: sql },
  )
  const credentials = await readSecret(env.paths, 'credentials')
  await writeSecret(
    env.paths,
    'migrate.env',
    `EXPONETDB_CONTROL_STORE_URL=${storeUrl(env.labId, 'exdb_migrate', credential(credentials, 'exdb_migrate'))}\nEXPONETDB_LOG_LEVEL=warn\n`,
  )
  const installationId = await migrateStore(env, lab)
  lab = { ...lab, installationId }
  await writeLab(env.paths, lab)
  env.progress('keyring: generated for this lab')
  const keyring = await imageCommand(
    env,
    lab,
    'keyring generate',
    'set -e; node /app/bin/exponetdb.mjs keyring generate --key-id lab1 --output /tmp/keyring.json >/dev/null; cat /tmp/keyring.json',
  )
  await writeSecret(env.paths, 'keyring.json', keyring)
  await writeProcessEnv(env, lab, installationId)
  return startProcesses(env, lab)
}

// ----- an existing lab -----

export interface Freshness {
  /** The commit the lab's image was built from (its revision label). */
  readonly running: string | null
  /** The source checkout's commit now, when the lab was built from one. */
  readonly source: string | null
  readonly current: boolean
}

export async function freshness(lab: LabRecord): Promise<Freshness> {
  if (lab.source === null) return { running: lab.image.revision, source: null, current: true }
  const now = await sourceCommit(lab.source.dir).catch(() => null)
  return {
    running: lab.source.commit,
    source: now,
    current: now !== null && now === lab.source.commit && !now.endsWith('-dirty'),
  }
}

export interface ResumeOptions {
  readonly rebuild: boolean
  readonly keepImage: boolean
}

/** Starts a stopped lab (and, with --rebuild, moves its roles to an image of the current source). */
export async function resumeLab(
  env: LabEnv,
  lab: LabRecord,
  options: ResumeOptions,
): Promise<{ lab: LabRecord; stale: Freshness | null }> {
  for (const role of ROLES) {
    if ((await owned(env, lab, role)) === undefined) {
      throw new CliError(
        'lab_failed',
        `The ${role} container of lab ${env.labId} is gone; run: exponetdb dev reset --lab ${env.labId}`,
      )
    }
  }
  const fresh = await freshness(lab)
  let current = lab
  if (!fresh.current && !options.keepImage && !options.rebuild) {
    throw new CliError(
      'lab_stale',
      `Lab ${env.labId} runs ${fresh.running ?? 'an unknown commit'} but the source is at ${fresh.source ?? 'an unreadable commit'}; run with --rebuild to use the current source, or --keep-image to keep the running image.`,
    )
  }
  for (const role of DATABASE_ROLES) {
    const id = lab.containers[role] ?? ''
    await must(env.docker, `starting ${role}`, ['start', id])
  }
  for (const role of DATABASE_ROLES) {
    const id = lab.containers[role] ?? ''
    await waitFor(env, role, 120, () => databaseReady(env, id))
  }
  if (options.rebuild && lab.source !== null) {
    const built = await ensureImage(
      env.docker,
      { kind: 'source', dir: lab.source.dir },
      env.paths,
      env.progress,
    )
    for (const role of PROCESS_ROLES) {
      await must(env.docker, `removing ${role}`, ['rm', '--force', lab.containers[role] ?? ''])
    }
    current = {
      ...lab,
      image: built.image,
      source: built.source,
      containers: Object.fromEntries(DATABASE_ROLES.map((r) => [r, lab.containers[r] ?? ''])),
    }
    await writeLab(env.paths, current)
    const installationId = await migrateStore(env, current)
    if (installationId !== lab.installationId) {
      throw new CliError(
        'lab_failed',
        'control-store migrate reported another installation; the lab is left stopped.',
      )
    }
    return { lab: await startProcesses(env, current), stale: null }
  }
  for (const role of PROCESS_ROLES) {
    await must(env.docker, `starting ${role}`, ['start', lab.containers[role] ?? ''])
  }
  await waitProcesses(env, current)
  return { lab: current, stale: fresh.current ? null : fresh }
}

// ----- status -----

export interface RoleStatus {
  readonly role: Role
  readonly container: string | null
  readonly state: string
  readonly ready: boolean
  readonly detail: string
}

export interface LabStatus {
  readonly labId: string
  readonly exists: boolean
  readonly ready: boolean
  readonly server: string | null
  readonly installationId: string | null
  readonly postgres: Major | null
  readonly image: LabRecord['image'] | null
  readonly freshness: Freshness | null
  readonly roles: readonly RoleStatus[]
  readonly targets: readonly {
    readonly role: 'staging' | 'production'
    readonly host: string
    readonly port: 5432
    readonly caFile: string
  }[]
  readonly activeRun: RunRecord | null
  readonly lastRun: RunRecord | null
}

export async function labStatus(env: LabEnv): Promise<LabStatus> {
  const lab = await readLab(env.paths)
  const runs = await listRuns(env.paths)
  const active = await activeRun(env.paths, env.now())
  if (lab === undefined) {
    return {
      labId: env.labId,
      exists: false,
      ready: false,
      server: null,
      installationId: null,
      postgres: null,
      image: null,
      freshness: null,
      roles: [],
      targets: [],
      activeRun: active ?? null,
      lastRun: runs.find((r) => r.state !== 'running') ?? null,
    }
  }
  const roles: RoleStatus[] = []
  for (const role of ROLES) {
    const c = await owned(env, lab, role)
    if (c === undefined) {
      roles.push({
        role,
        container: null,
        state: 'missing',
        ready: false,
        detail: 'the container is gone',
      })
      continue
    }
    // A stopped container keeps its last health; only a running one has a current health.
    const state = c.State.Running ? (c.State.Health?.Status ?? c.State.Status) : c.State.Status
    let ready = false
    let detail = c.State.Status
    if (c.State.Running && (DATABASE_ROLES as readonly string[]).includes(role)) {
      ready = await databaseReady(env, c.Id)
      detail = ready ? 'accepting connections over TCP' : 'not accepting connections'
    } else if (c.State.Running && role === 'serve') {
      ready = c.State.Health?.Status === 'healthy' && (await serveReady(env, lab.port))
      detail = ready ? `ready on http://localhost:${lab.port}` : `health ${state}`
    } else if (c.State.Running) {
      ready = c.State.Health?.Status === 'healthy'
      detail = `health ${state}`
    }
    roles.push({ role, container: c.Id.slice(0, 12), state, ready, detail })
  }
  return {
    labId: env.labId,
    exists: true,
    ready: roles.every((r) => r.ready),
    server: `http://localhost:${lab.port}`,
    installationId: lab.installationId,
    postgres: lab.postgres,
    image: lab.image,
    freshness: await freshness(lab),
    roles,
    targets: (['staging', 'production'] as const).map((role) => ({
      role,
      host: targetHost(env.labId, role),
      port: 5432,
      caFile: join(env.paths.tls, `${role}-ca.crt`),
    })),
    activeRun: active ?? null,
    lastRun: runs.find((r) => r.state !== 'running') ?? null,
  }
}

// ----- stop, export, remove -----

/** Refuses while a run holds the lab; with `interrupt`, ends that run first and records it as interrupted. */
export async function quiesce(env: LabEnv, interrupt: boolean): Promise<RunRecord | null> {
  const run = await activeRun(env.paths, env.now())
  if (run === undefined) return null
  if (!interrupt) {
    throw new CliError(
      'lab_busy',
      `Run ${run.runId} (${run.suite}) is using lab ${env.labId}; wait for it or pass --interrupt to stop it.`,
    )
  }
  for (const pid of [run.childPid, run.pid]) {
    if (pid === null) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  await env.sleep(2000)
  return finishRun(
    env.paths,
    run,
    { state: 'interrupted', exitCode: null, reason: 'interrupted by dev stop/reset/destroy' },
    env.now(),
  )
}

/** Every recorded container of the lab, each checked before any is touched. */
async function ownedAll(env: LabEnv, lab: LabRecord): Promise<Map<Role, Inspected>> {
  const all = new Map<Role, Inspected>()
  for (const role of ROLES) {
    const c = await owned(env, lab, role)
    if (c !== undefined) all.set(role, c)
  }
  return all
}

export async function stopLab(env: LabEnv, lab: LabRecord): Promise<void> {
  const all = await ownedAll(env, lab)
  for (const role of [...PROCESS_ROLES, ...DATABASE_ROLES]) {
    const c = all.get(role)
    if (c?.State.Running === true) {
      env.progress(`${role}: stopping`)
      await must(env.docker, `stopping ${role}`, ['stop', '--time', '30', c.Id])
    }
  }
}

/** Writes logs, sanitized container facts and the run records into a new directory; returns it. */
export async function exportLab(
  env: LabEnv,
  lab: LabRecord | undefined,
  target?: string,
): Promise<string> {
  const stamp = new Date(env.now()).toISOString().replace(/[:.]/g, '-')
  const dir = target ?? join(env.paths.exports, `${env.labId}-${stamp}`)
  await ensurePrivateDir(env.paths.exports)
  await mkdir(dir, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST')
      throw new CliError('file_refused', `${dir} already exists; nothing was overwritten.`)
    throw error
  })
  await mkdir(join(dir, 'logs'), { mode: 0o700 })
  const facts: unknown[] = []
  if (lab !== undefined) {
    await writePrivateJson(join(dir, 'lab.json'), lab)
    for (const role of ROLES) {
      const c = await owned(env, lab, role).catch(() => undefined)
      if (c === undefined) continue
      // Never the environment or the command line: they carry secrets.
      facts.push({
        role,
        id: c.Id,
        name: c.Name.slice(1),
        image: c.Image,
        created: c.Created,
        state: c.State.Status,
        health: c.State.Health?.Status ?? null,
        restarts: c.RestartCount,
        labels: c.Config.Labels,
      })
      const logs = await env.docker.run(['logs', '--timestamps', c.Id])
      const handle = await open(
        join(dir, 'logs', `${role}.log`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      )
      try {
        await handle.writeFile(`${logs.stdout}${logs.stderr}`)
      } finally {
        await handle.close()
      }
    }
  }
  await writePrivateJson(join(dir, 'containers.json'), facts)
  const runs = await stat(env.paths.runs).catch(() => undefined)
  if (runs !== undefined) await cp(env.paths.runs, join(dir, 'runs'), { recursive: true })
  return dir
}

/** Removes every Docker object of the lab (checked) and, unless kept, its state directory. */
export async function removeLab(env: LabEnv, lab: LabRecord, keepState: boolean): Promise<void> {
  const all = await ownedAll(env, lab)
  for (const role of [...PROCESS_ROLES, ...DATABASE_ROLES]) {
    const c = all.get(role)
    if (c !== undefined) {
      env.progress(`${role}: removing`)
      await must(env.docker, `removing ${role}`, ['rm', '--force', c.Id])
    }
  }
  for (const role of DATABASE_ROLES) {
    const name = lab.volumes[role]
    if (name === undefined) continue
    const v = await env.docker.run([
      'volume',
      'inspect',
      '--format',
      `{{index .Labels "${LABEL.owner}"}}`,
      name,
    ])
    if (v.code !== 0) continue
    if (v.stdout.trim() !== ownerTag(env.paths)) {
      throw new CliError(
        'lab_foreign',
        `Volume ${name} does not belong to lab ${env.labId}; it is kept.`,
      )
    }
    await must(env.docker, `removing the ${role} volume`, ['volume', 'rm', name])
  }
  const n = await env.docker.run([
    'network',
    'inspect',
    '--format',
    `{{index .Labels "${LABEL.owner}"}}`,
    lab.network.id,
  ])
  if (n.code === 0) {
    if (n.stdout.trim() !== ownerTag(env.paths)) {
      throw new CliError(
        'lab_foreign',
        `Network ${lab.network.name} does not belong to lab ${env.labId}; it is kept.`,
      )
    }
    await must(env.docker, 'removing the network', ['network', 'rm', lab.network.id])
  }
  if (keepState) {
    await rm(env.paths.secrets, { recursive: true, force: true })
    await rm(env.paths.tls, { recursive: true, force: true })
    await rm(env.paths.record, { force: true })
  } else {
    await rm(env.paths.root, { recursive: true, force: true })
  }
}

/** The container ID of a role, checked to be this lab's and running. */
export async function runningContainer(env: LabEnv, role: Role): Promise<string> {
  const lab = await readLab(env.paths)
  if (lab === undefined)
    throw new CliError(
      'lab_not_found',
      `There is no lab ${env.labId}; run: exponetdb dev up --lab ${env.labId}`,
    )
  const c = await owned(env, lab, role)
  if (c === undefined || !c.State.Running) {
    throw new CliError(
      'lab_failed',
      `The ${role} container of lab ${env.labId} is not running; run: exponetdb dev up --lab ${env.labId}`,
    )
  }
  return c.Id
}

export {
  databaseReady,
  inspectContainer,
  owned as ownedContainer,
  readSecret as readLabSecret,
  serveReady,
}
