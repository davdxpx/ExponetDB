import { afterAll, afterEach, beforeEach } from 'vitest'
import { verifierLoginTurn } from './packages/testkit/src/verifier-password.ts'

// A vitest setup file of the suites against the target servers
// (`targetIntegrationConfig`): each test holds the verifier password's
// shared lock, so a rotation in another suite never runs during it.
const turn = verifierLoginTurn()

beforeEach(() => turn.enter())
afterEach(() => turn.leave())
afterAll(() => turn.close())
