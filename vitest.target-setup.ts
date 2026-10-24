import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { verifierLoginTurn } from './packages/testkit/src/verifier-password.ts'

// A vitest setup file of the suites against the target servers
// (`targetIntegrationConfig`): a file holds the verifier password's shared
// lock from before its own beforeAll (its worlds log in as the verifier
// there) until its first test ended, then each test does, so a rotation in
// another suite never runs while one logs in.
const turn = verifierLoginTurn()

beforeAll(() => turn.enter())
beforeEach(() => turn.enter())
afterEach(() => turn.leave())
afterAll(() => turn.close())
