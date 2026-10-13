import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

/** One titled block of a target page: a heading (level 2), one sentence, then the content. */
export function Section({
  id,
  title,
  description,
  children,
}: {
  readonly id?: string
  readonly title: string
  readonly description?: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <PageSection id={id}>
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>{title}</PageSectionTitle>
          {description === undefined ? null : (
            <PageSectionDescription>{description}</PageSectionDescription>
          )}
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent className="flex min-w-0 flex-col gap-3">{children}</PageSectionContent>
    </PageSection>
  )
}
