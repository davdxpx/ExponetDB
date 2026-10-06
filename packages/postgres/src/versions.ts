import { TargetError } from './errors.ts'
import { isSupportedMajor, type SupportedMajor } from './parser/majors.ts'

export { isSupportedMajor, SUPPORTED_MAJORS, type SupportedMajor } from './parser/majors.ts'

/** The major of a `server_version_num` (e.g. 170011 → 17); refuses unsupported servers. */
export function majorOf(serverVersionNum: number): SupportedMajor {
  const major = Math.floor(serverVersionNum / 10_000)
  if (!Number.isInteger(serverVersionNum) || !isSupportedMajor(major)) {
    throw new TargetError('CAPABILITY_UNAVAILABLE', 'unsupported_version')
  }
  return major
}
