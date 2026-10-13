import { createFileRoute } from '@tanstack/react-router'
import { StepUpPage } from '../../features/step-up/step-up-page.tsx'

/** `/step-up#id=stu_…`: confirming a command the person started in the CLI (ADR-0026). */
export const Route = createFileRoute('/_session/step-up')({
  staticData: { title: 'stepUp.title' },
  component: StepUpPage,
})
