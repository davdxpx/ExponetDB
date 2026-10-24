import type pg from 'pg'
import { superuserClient, TEST_TARGETS_ENV, type TestServer, testTargets } from './servers.ts'

/**
 * The verifier's password on the shared PostgreSQL 17 test server, between
 * the one suite that rotates it (`node-credential-rotation.int`, through
 * the product's `credential.rotate`) and every suite that logs in as the
 * verifier (each verification with a `verify.sql`). A rotation sets another
 * password for the whole file and puts the test kit's back after it; a
 * verifier login meanwhile failed (`password authentication failed`), so a
 * verification read as `error` in another package running at the same time.
 *
 * The suites against the target servers hold a shared advisory lock for
 * each test (`vitest.target-setup.ts`); the rotation holds it exclusively
 * for its file, so it starts once the running tests ended and the tests that
 * start meanwhile wait for it. The rotation takes this lock before the role
 * lock and a test takes it before any role lock it takes, so the two locks
 * are always taken in the same order. Logins in a `beforeAll` are not
 * covered; a session opened before the rotation lives on.
 */
const VERIFIER_PASSWORD_LOCK = 0x45584442_0006 // 'EXDB', the verifier's test password

/** The test server whose verifier password a suite rotates. */
export const VERIFIER_ROTATION_MAJOR = 17

// On the global object, not in this module: the setup file and the test file
// may hold this module twice; both run in the same worker.
const ROTATING = Symbol.for('exponetdb.testkit.verifierRotating')
const flags = globalThis as { [ROTATING]?: boolean }

/** Runs `fn` while no test of another suite logs in as the verifier on `s`. */
export async function withVerifierPasswordHeld<T>(s: TestServer, fn: () => Promise<T>): Promise<T> {
  if (s.major !== VERIFIER_ROTATION_MAJOR) {
    throw new Error(
      `only the PostgreSQL ${VERIFIER_ROTATION_MAJOR} test server rotates the verifier`,
    )
  }
  const c = await superuserClient(s, 'postgres')
  try {
    await c.query('SELECT pg_advisory_lock($1::bigint)', [VERIFIER_PASSWORD_LOCK])
    flags[ROTATING] = true
    try {
      return await fn()
    } finally {
      flags[ROTATING] = false
      await c.query('SELECT pg_advisory_unlock($1::bigint)', [VERIFIER_PASSWORD_LOCK])
    }
  } finally {
    await c.end()
  }
}

/** One file's turn on the verifier password: shared, per test. */
export interface VerifierLoginTurn {
  enter(): Promise<void>
  leave(): Promise<void>
  close(): Promise<void>
}

/**
 * The shared side for one test file. Without the target servers described
 * it does nothing (the suites fail on their own with the explanation); in
 * the rotating file itself it does nothing (it holds the lock).
 */
export function verifierLoginTurn(): VerifierLoginTurn {
  let client: Promise<pg.Client | null> | null = null
  let held = false
  const session = () => {
    client ??= (async () => {
      if (process.env[TEST_TARGETS_ENV] === undefined) return null
      const s = testTargets().servers.find((x) => x.major === VERIFIER_ROTATION_MAJOR)
      return s === undefined ? null : await superuserClient(s, 'postgres')
    })()
    return client
  }
  return {
    async enter() {
      if (flags[ROTATING] === true || held) return
      const lock = async () => {
        const c = await session()
        if (c === null) return false
        await c.query('SELECT pg_advisory_lock_shared($1::bigint)', [VERIFIER_PASSWORD_LOCK])
        return true
      }
      held = await lock().catch(() => {
        client = null
        return lock()
      })
    },
    async leave() {
      if (!held) return
      held = false
      const c = await session()
      // A session a test ended released its lock with it: the next test opens another.
      await c
        ?.query('SELECT pg_advisory_unlock_shared($1::bigint)', [VERIFIER_PASSWORD_LOCK])
        .catch(() => {
          client = null
        })
    },
    async close() {
      const c = client === null ? null : await client.catch(() => null)
      client = null
      held = false
      await c?.end().catch(() => undefined)
    },
  }
}
