import { describe, expect, it } from 'vitest'

import { isAppPath } from '../../../src/command-menu/api/utils.ts'

describe('isAppPath', () => {
  it('accepts a path inside the app', () => {
    expect(isAppPath('/')).toBe(true)
    expect(isAppPath('/changes/plans')).toBe(true)
    expect(isAppPath('/t/acme/platform/production/schema?tab=indexes#top')).toBe(true)
  })

  it.each([
    ['a full URL', 'https://evil.example/plans'],
    ['a protocol-relative URL', '//evil.example/plans'],
    ['a backslash path', '/\\evil.example'],
    ['a script URL', 'javascript:alert(1)'],
    ['a relative path', 'changes/plans'],
    ['an empty string', ''],
    ['a path with a space', '/changes /plans'],
    ['a path with a line break', '/changes\n/plans'],
    ['a path with a tab', '/changes\t'],
    ['a path with a control character', '/changes\u0000'],
    ['a path with a delete character', '/changes\u007f'],
  ])('refuses %s', (_name, value) => {
    expect(isAppPath(value)).toBe(false)
  })
})
