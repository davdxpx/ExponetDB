import {
  type BundleSet,
  beat,
  type ControlStore,
  ControlStoreError,
  compareSchema,
  expectedMigrations,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_SECONDS,
  liveProcesses,
  loadBundleSet,
  markStopped,
  PROCESS_ROLE_LOGIN,
  readInstallationId,
  readLedger,
  registerProcess,
} from '@exponetdb/control-store'
import { newId, type ProcessInstanceId } from '@exponetdb/kernel'
import { fail, type HealthCheck, pass, Readiness, SafeError, warn } from '@exponetdb/observability'
import { type Keyring, keyringStatus, loadKeyring } from '@exponetdb/secrets'
import { BUILD } from '../config/build-info.ts'
import type { RoleConfig } from '../config/env.ts'
import { openStore, type Runtime } from './runtime.ts'

/**
 * What every process role is built from: its own Control Store login, the
 * keyring, the shipped bundle set (the schema this build expects), a
 * heartbeat, and readiness checks
 * ([health.md §8](../../../../exponetdb-docs/10-observability/health.md#8-control-plane-health)).
 *
 * Startup refuses (exit, not "not ready") when running would be unsafe: a
 * login that is not the role's own or is privileged, a Control Store of
 * another installation, a schema newer than this build, a checksum mismatch,
 * an invalid keyring. A Control Store that is unreachable, not yet migrated
 * or not yet verified leaves the process running and not ready.
 */
export class StartupRefused extends SafeError {
  override readonly name = 'StartupRefused'
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, 'The process refused to start.', options)
  }
}

export interface RoleServices {
  readonly processId: ProcessInstanceId
  readonly store: ControlStore
  readonly keyring: Keyring
  readonly bundles: BundleSet
  readonly readiness: Readiness
  /** Milliseconds since the last successful heartbeat, or `undefined` before the first. */
  heartbeatAge(): number | undefined
  /** Startup gate, heartbeat and readiness loops. */
  start(): Promise<void>
  /** Stops the loops, marks the heartbeat stopped, closes the pool, wipes the keyring. */
  stop(): Promise<void>
}

export interface ComposeOptions {
  readonly extraChecks?: (services: Omit<RoleServices, 'start' | 'stop'>) => readonly HealthCheck[]
  readonly readinessIntervalMs?: number
}

export async function composeRole(
  config: RoleConfig,
  runtime: Runtime,
  options: ComposeOptions = {},
): Promise<RoleServices> {
  let keyring: Keyring
  try {
    keyring = await loadKeyring(config.keyringEnv)
  } catch (error) {
    throw new StartupRefused('keyring_invalid', { cause: error })
  }
  const bundles = await loadBundleSet()
  const store = openStore(runtime, config.controlStoreUrl, PROCESS_ROLE_LOGIN[config.role])
  const processId = newId('prc', runtime.clock.nowMs())
  const readiness = new Readiness(runtime.clock)
  const expected = expectedMigrations(bundles)
  let lastBeat: number | undefined
  let registered = false
  let timers: NodeJS.Timeout[] = []

  const checks: HealthCheck[] = [
    {
      name: 'control_store',
      severity: 'critical',
      timeoutMs: 3000,
      run: async () => {
        await store.query('readiness.ping', 'SELECT 1 AS one')
        return pass()
      },
    },
    {
      name: 'role_credential',
      severity: 'critical',
      run: async () => {
        try {
          await store.verifyLogin()
          return pass()
        } catch (error) {
          return fail(
            error instanceof ControlStoreError && error.code === 'control_store_wrong_role'
              ? 'wrong_login'
              : 'login_unverified',
          )
        }
      },
    },
    {
      name: 'installation',
      severity: 'critical',
      run: async () => {
        const id = await readInstallationId(store)
        return id === undefined
          ? fail('installation_missing')
          : id === config.installationId
            ? pass()
            : fail('installation_mismatch')
      },
    },
    {
      name: 'schema',
      severity: 'critical',
      run: async () => {
        const state = compareSchema(expected, await readLedger(store))
        switch (state.status) {
          case 'current':
            return pass()
          case 'uninitialized':
          case 'pending':
            return fail('schema_pending')
          case 'unverified':
            return fail('schema_unverified')
          case 'newer':
            return fail('schema_newer')
          default:
            return fail('schema_mismatch')
        }
      },
    },
    {
      name: 'keyring',
      severity: 'critical',
      run: async () => {
        const status = await keyringStatus(store, keyring)
        if (status.mismatched.length > 0) {
          return fail('keyring_mismatch')
        }
        return status.missing.length > 0 ? fail('keyring_missing_key') : pass()
      },
    },
    {
      name: 'heartbeat',
      severity: 'critical',
      run: async () => {
        if (lastBeat === undefined) {
          return fail('heartbeat_pending')
        }
        return runtime.clock.nowMs() - lastBeat < HEARTBEAT_STALE_SECONDS * 1000
          ? pass()
          : fail('heartbeat_stale')
      },
    },
  ]
  const base = {
    processId,
    store,
    keyring,
    bundles,
    readiness,
    heartbeatAge: () => (lastBeat === undefined ? undefined : runtime.clock.nowMs() - lastBeat),
  }
  for (const check of [...checks, ...(options.extraChecks?.(base) ?? [])]) {
    readiness.register(check)
  }

  async function heartbeat(): Promise<void> {
    try {
      if (!registered) {
        await registerProcess(store, {
          processId,
          role: config.role,
          buildVersion: BUILD.version,
          buildCommit: BUILD.commit,
        })
        registered = true
      } else if (!(await beat(store, processId))) {
        registered = false
        return
      }
      lastBeat = runtime.clock.nowMs()
    } catch (error) {
      runtime.logger.warn('heartbeat.failed', {
        processId,
        code: error instanceof ControlStoreError ? error.code : 'heartbeat_failed',
      })
    }
  }

  async function gate(): Promise<void> {
    try {
      await store.query('startup.ping', 'SELECT 1 AS one')
    } catch {
      runtime.logger.warn('startup.control_store_unreachable', { component: 'control_store' })
      return
    }
    try {
      await store.verifyLogin()
    } catch (error) {
      throw new StartupRefused('wrong_or_privileged_login', { cause: error })
    }
    // A Control Store that is not migrated yet cannot be read: not ready, not refused.
    const facts = await Promise.all([
      readInstallationId(store),
      readLedger(store),
      keyringStatus(store, keyring),
    ]).catch((error: unknown) => {
      runtime.logger.warn('startup.control_store_unreadable', {
        code: error instanceof ControlStoreError ? error.code : 'unreadable',
      })
      return undefined
    })
    if (facts === undefined) {
      return
    }
    const [installation, ledger, keys] = facts
    if (installation !== undefined && installation !== config.installationId) {
      throw new StartupRefused('installation_mismatch')
    }
    const state = compareSchema(expected, ledger)
    if (state.status === 'newer') {
      throw new StartupRefused('schema_newer')
    }
    if (state.status === 'mismatch') {
      throw new StartupRefused('schema_mismatch')
    }
    if (keys.mismatched.length > 0) {
      throw new StartupRefused('keyring_mismatch')
    }
  }

  return {
    ...base,
    async start() {
      await gate()
      await heartbeat()
      await readiness.evaluate()
      timers = [
        setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS),
        setInterval(() => void readiness.evaluate(), options.readinessIntervalMs ?? 5000),
      ]
    },
    async stop() {
      readiness.markStopping()
      for (const t of timers) {
        clearInterval(t)
      }
      timers = []
      if (registered) {
        await markStopped(store, processId).catch(() => undefined)
      }
      await store.close()
      keyring.destroy()
    },
  }
}

/** serve: is any worker alive? (degrading: serve stays ready, operations would not progress). */
export function liveWorkerCheck(store: ControlStore): HealthCheck {
  return {
    name: 'workers',
    severity: 'degrading',
    run: async () =>
      (await liveProcesses(store)).some((p) => p.role === 'worker')
        ? pass()
        : warn('no_live_worker'),
  }
}
