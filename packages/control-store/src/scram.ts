/**
 * SCRAM-SHA-256 verifiers live in `@exponetdb/kernel/hash` since Wave 4 (the
 * Control Store roles and the managed-target roles use the same function);
 * re-exported here for the Control Store's bootstrap code.
 */
export {
  generatePassword,
  SCRAM_ITERATIONS,
  SCRAM_VERIFIER,
  scramSha256Verifier,
} from '@exponetdb/kernel/hash'
