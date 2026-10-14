import { targetHref } from '../../shell/navigation.ts'
import { useTargetScope } from '../target/scope.tsx'

/**
 * The address of a page of the current target, built from the route's
 * validated slugs (never from a path the server sent): `href('/drift')`.
 */
export function useTargetHref(): (suffix?: string) => string {
  const { target } = useTargetScope()
  return (suffix = '') => targetHref(target, suffix)
}

/** The validated path of the current target (`<product>/<project>/<environment>`). */
export function useTargetPath(): string {
  return useTargetScope().target.path
}
