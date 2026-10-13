import { useRef } from 'react'

function depsEqual(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
}

/**
 * A number that grows each time `deps` changes (compared one by one with
 * `Object.is`, like React compares an effect's dependencies). It lets a hook
 * take a dependency list of any length and still give React a fixed one.
 * Without `deps` the number never changes.
 */
export function useDepsVersion(deps: readonly unknown[] | undefined): number {
  const previous = useRef(deps)
  const version = useRef(0)
  if (!depsEqual(previous.current, deps)) {
    previous.current = deps
    version.current += 1
  }
  return version.current
}
