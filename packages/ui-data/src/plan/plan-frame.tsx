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
 * The page frame of a plan (design-system.md §4: production cues on every
 * surface that can lead to a production change; information-architecture.md
 * §5). `PlanFrame` draws the reserved `production` frame around the whole
 * review and a "Production" cue at its head; every block inside repeats the
 * cue beside its heading, so a person who scrolled to the raw statements
 * still sees that the plan changes production.
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
   * a tier that is missing or not known gets the production cue.
   */
  readonly production: boolean
  readonly children?: ReactNode
}

/** The chip every production cue of the plan page uses: the reserved color and the word. */
export function ProductionCue({ className }: { readonly className?: string }): ReactNode {
  return (
    <span
      data-production-cue=""
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-production bg-production px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap text-production-foreground',
        className,
      )}
    >
      <Server aria-hidden="true" className="size-3" />
      Production
    </span>
  )
}

/**
 * The frame of a plan's review page. With `production` it adds the reserved
 * `production` frame and a "Production" cue at its head, and the blocks
 * inside show the cue beside their headings; without it, it adds neither.
 */
export function PlanFrame({ production, children, className, ...rest }: PlanFrameProps): ReactNode {
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
          <p className="flex flex-wrap items-center gap-2 rounded-md border border-production bg-production-muted px-3 py-2 text-sm text-foreground">
            <ProductionCue />
            <span>
              This plan changes a production target. Check the target path and the plan hash before
              you decide.
            </span>
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
 * One block of the plan review: a `section` named by its heading, with the
 * production cue beside the heading inside a production `PlanFrame`.
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
  const production = usePlanFrameProduction()
  const Heading = `h${headingLevel}` as const
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-lg border border-default bg-surface-100 p-4',
        production && 'border-production',
        className,
      )}
      {...rest}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Heading id={headingId} className="text-base font-medium text-foreground">
          {title}
        </Heading>
        {production ? <ProductionCue /> : null}
      </div>
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
