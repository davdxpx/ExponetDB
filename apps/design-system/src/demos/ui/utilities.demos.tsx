import {
  Button,
  cn,
  controlRadiusBySize,
  copyToClipboard,
  getExplicitTabIndex,
  PAGE_SIZE_CLASSES,
  SIZE,
  useIsMobile,
} from '@exponetdb/ui'
import { type ReactNode, useState } from 'react'
import type { DemoDefinition } from '../types.ts'
import { Row, Stack } from './support.tsx'

function Line({ input, output }: { readonly input: string; readonly output: string }): ReactNode {
  return (
    <li className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <code className="font-mono text-xs text-foreground-light">{input}</code>
      <span aria-hidden className="hidden text-foreground-lighter sm:inline">
        gives
      </span>
      <code className="font-mono text-xs text-foreground">{output || '(nothing)'}</code>
    </li>
  )
}

function ClassNames(): ReactNode {
  const hidden = false as boolean
  return (
    <ul aria-label="Results of cn" className="flex flex-col gap-2">
      <Line input="cn('px-2 py-1', 'px-4')" output={cn('px-2 py-1', 'px-4')} />
      <Line
        input="cn('text-foreground', 'text-foreground-light')"
        output={cn('text-foreground', 'text-foreground-light')}
      />
      <Line input="cn('rounded-md', 'rounded-panel')" output={cn('rounded-md', 'rounded-panel')} />
      <Line input="cn('p-4', 'p-card')" output={cn('p-4', 'p-card')} />
      <Line input="cn('focus-ring', 'hit-area-1')" output={cn('focus-ring', 'hit-area-1')} />
      <Line
        input="cn('flex', hidden && 'hidden', ['gap-2', { 'gap-4': hidden }])"
        output={cn('flex', hidden && 'hidden', ['gap-2', { 'gap-4': hidden }])}
      />
    </ul>
  )
}

function TabIndexes(): ReactNode {
  return (
    <ul aria-label="Results of getExplicitTabIndex" className="flex flex-col gap-2">
      <Line
        input="getExplicitTabIndex(undefined)"
        output={String(getExplicitTabIndex(undefined))}
      />
      <Line
        input="getExplicitTabIndex(undefined, true)"
        output={String(getExplicitTabIndex(undefined, true))}
      />
      <Line
        input="getExplicitTabIndex(-1, false)"
        output={String(getExplicitTabIndex(-1, false))}
      />
    </ul>
  )
}

function Sizes(): ReactNode {
  return (
    <ul aria-label="Shared control sizes" className="flex flex-col gap-2">
      {(['tiny', 'small', 'medium', 'large'] as const).map((size) => (
        <Line
          key={size}
          input={`SIZE.height.${size}`}
          output={`${SIZE.height[size]} ${SIZE.text[size]} ${SIZE.padding[size]}`}
        />
      ))}
      <Line input="controlRadiusBySize.tiny" output={controlRadiusBySize.tiny} />
      <Line input="PAGE_SIZE_CLASSES.small" output={PAGE_SIZE_CLASSES.small} />
      <Line input="PAGE_SIZE_CLASSES.large" output={PAGE_SIZE_CLASSES.large} />
    </ul>
  )
}

function Breakpoint(): ReactNode {
  const mobile = useIsMobile()
  return (
    <p role="status" className="text-sm text-foreground-light">
      The window is {mobile ? 'narrower' : 'at least as wide'} as 768 px, so layouts that follow{' '}
      <code className="text-code-inline">useIsMobile</code> are in their{' '}
      {mobile ? 'small-screen' : 'wide-screen'} form.
    </p>
  )
}

function Clipboard(): ReactNode {
  const [result, setResult] = useState<string | null>(null)
  return (
    <Stack>
      <Row>
        <Button
          variant="default"
          onClick={async () => {
            const copied = await copyToClipboard('shop/platform/staging')
            setResult(copied ? 'Copied the path.' : 'Could not copy. Copy the path by hand.')
          }}
        >
          Copy path
        </Button>
        <p role="status" className="text-sm text-foreground-light">
          {result ?? 'Nothing copied yet.'}
        </p>
      </Row>
    </Stack>
  )
}

export const demos: readonly DemoDefinition[] = [
  {
    id: 'ui/utilities/class-names',
    title: 'cn merges classes, and knows the tokens of the system',
    render: () => <ClassNames />,
  },
  {
    id: 'ui/utilities/tab-index',
    title: 'getExplicitTabIndex',
    render: () => <TabIndexes />,
  },
  {
    id: 'ui/utilities/sizes',
    title: 'The shared size constants',
    render: () => <Sizes />,
  },
  {
    id: 'ui/utilities/breakpoint',
    title: 'useIsMobile follows the 768 px breakpoint',
    render: () => <Breakpoint />,
    visual: false,
  },
  {
    id: 'ui/utilities/clipboard',
    title: 'copyToClipboard resolves to whether it worked and shows nothing itself',
    render: () => <Clipboard />,
    visual: false,
  },
]
