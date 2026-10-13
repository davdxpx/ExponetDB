import type { ReactNode } from 'react'
import { useLocation } from '../router.tsx'
import { CaseFrame } from './case-frame.tsx'
import { CSP_CASES, findCase } from './cases.tsx'

/**
 * `/csp-surface`: the list of cases, or one case with `?case=<id>`. Served by the real
 * `mountWeb` in the browser test, so every case runs under the production policy.
 */
export function CspSurfacePage(): ReactNode {
  const { search } = useLocation()
  const id = new URLSearchParams(search).get('case')
  if (id === null) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <h1 className="mb-4 text-2xl font-semibold">CSP surface</h1>
        <p className="mb-4 text-foreground-light">
          Every primitive that could inject a style, evaluate code or load a resource, in its
          interactive state. The browser test opens each case under the production policy.
        </p>
        <ul className="flex flex-col gap-1">
          {CSP_CASES.map((c) => (
            <li key={c.id}>
              <a href={`/csp-surface?case=${c.id}`} data-csp-case={c.id}>
                {c.title}
              </a>
            </li>
          ))}
        </ul>
      </main>
    )
  }
  const found = findCase(id)
  if (found === undefined) {
    return (
      <main className="p-6">
        <h1 className="text-2xl font-semibold">Unknown case</h1>
        <p>There is no case with this name.</p>
      </main>
    )
  }
  return (
    <main>
      <h1 className="sr-only">{found.title}</h1>
      <CaseFrame name={found.title} act={found.act}>
        {found.render()}
      </CaseFrame>
    </main>
  )
}
