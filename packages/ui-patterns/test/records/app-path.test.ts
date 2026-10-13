import { describe, expect, it } from 'vitest'

import { isAppPath } from '../../src/records/app-path.ts'

describe('isAppPath', () => {
  it.each(['/', '/changes/plans/pln_01H', '/t/acme/platform/staging/schema?tab=indexes#top'])(
    'accepts %s',
    (href) => {
      expect(isAppPath(href)).toBe(true)
    },
  )

  it.each([
    '',
    'changes/plans',
    '//evil.example/x',
    '/\\evil.example',
    'https://evil.example',
    'javascript:alert(1)',
    'data:text/html,x',
    ' /spaced',
    '/with space',
    '/tab\there',
    '/new\nline',
    '/nul\u0000',
    '/del\u007f',
  ])('refuses %j', (href) => {
    expect(isAppPath(href)).toBe(false)
  })
})
