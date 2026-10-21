import { Server } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import type { HeadingLevel } from '@exponetdb/ui-patterns'
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useId,
  useMemo,
} from 'react'

/**
 * The page frame of a plan (design-system.md §4: production is marked once,
 * clearly; information-architecture.md §5). `PlanFrame` draws the reserved
 * `production` frame around the whole review and one short sentence at its
 * head. The page header carries the one production chip; the blocks inside
 * the frame repeat nothing (**[DECIDED]** by the owner on 2026-10-21: a chip
 * beside every block heading made a production page a wall of equally loud
 * blocks). The typed confirmations keep their own production frame.
 */

interface PlanFrameState {
  readonly production: boolean
}

const PlanFrameContext = createContext<PlanFrameState | null>(null)

/** Whether the nearest `PlanFrame` is a production frame (false outside a frame). */
export function usePlanFrameProduction(): boolean {
  return useContext(PlanFrameContext)?.production === true
}

export interface PlanFrameProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * The plan changes production. The page passes `plan.subject.tier !== 'nonprod'`
   * (`PlanView.subject.tier`), which fails closed like the confirmation dialogs:
   * a tier that is missing or not known gets the production frame.
   */
  readonly production: boolean
  /**
   * The one sentence at the head of a production frame, in the page's words
   * ("This plan changes production.", or why a plan without a tier is treated
   * as production). Default: "This plan changes production."
   */
  readonly notice?: ReactNode
  readonly children?: ReactNode
}

/**
 * The frame of a plan's review page. With `production` it adds the reserved
 * `production` frame and one sentence at its head (no chip: the page
 * header's tier chip is the one chip of the page); without it, it adds
 * neither. Blocks inside can ask `usePlanFrameProduction()`.
 */
export function PlanFrame({
  production,
  notice,
  children,
  className,
  ...rest
}: PlanFrameProps): ReactNode {
  const value = useMemo(() => ({ production }), [production])
  return (
    <PlanFrameContext.Provider value={value}>
      <div
        data-plan-frame=""
        data-tier={production ? 'production' : 'nonprod'}
        className={cn(
          'flex min-w-0 flex-col gap-4',
          production && 'rounded-lg p-3 ring-2 ring-production ring-inset sm:p-4',
          className,
        )}
        {...rest}
      >
        {production ? (
          <p
            data-production-notice=""
            className="m-0 flex items-start gap-2 rounded-md border border-production bg-production-muted px-3 py-2 text-sm text-foreground"
          >
            <Server aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-production" />
            <span className="min-w-0">{notice ?? 'This plan changes production.'}</span>
          </p>
        ) : null}
        {children}
      </div>
    </PlanFrameContext.Provider>
  )
}

export interface PlanBlockProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Plain text. */
  readonly title: string
  /** The level of the block's heading in the page outline. Default 2. */
  readonly headingLevel?: HeadingLevel
  /** A short line under the heading. */
  readonly description?: ReactNode
  readonly children?: ReactNode
}

/**
 * One block of the plan review: a `section` named by its heading, in the
 * default border. It carries no production cue of its own: the frame and the
 * page header say it once.
 */
export function PlanBlock({
  title,
  headingLevel = 2,
  description,
  children,
  className,
  ...rest
}: PlanBlockProps): ReactNode {
  const headingId = useId()
  const Heading = `h${headingLevel}` as const
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-lg border border-default bg-surface-100 p-4',
        className,
      )}
      {...rest}
    >
      <Heading id={headingId} className="text-base font-medium text-foreground">
        {title}
      </Heading>
      {description === undefined ? null : (
        <div className="text-sm text-foreground-light">{description}</div>
      )}
      {children}
    </section>
  )
}

export interface ComputedFactsSectionProps extends HTMLAttributes<HTMLElement> {
  /** The level of the section's heading. Default 2; put the blocks inside one level below. */
  readonly headingLevel?: HeadingLevel
  readonly children?: ReactNode
}

/**
 * "What ExponetDB computed": the group of the server's facts that comes
 * before the raw text of the plan (ADR-0029 §3; Wave 7 order §24). The
 * blocks inside it take `headingLevel` one below this section's.
 */
export function ComputedFactsSection({
  headingLevel = 2,
  children,
  className,
  ...rest
}: ComputedFactsSectionProps): ReactNode {
  const headingId = useId()
  const Heading = `h${headingLevel}` as const
  return (
    <section
      aria-labelledby={headingId}
      data-review-part="computed"
      className={cn('computed flex min-w-0 flex-col gap-4', className)}
      {...rest}
    >
      <div className="flex flex-col gap-1">
        <Heading id={headingId} className="text-lg font-medium text-foreground">
          What ExponetDB computed
        </Heading>
        <p className="text-sm text-foreground-light">
          Facts ExponetDB computed from the stored plan. The raw text of the plan follows as data.
        </p>
      </div>
      {children}
    </section>
  )
}
