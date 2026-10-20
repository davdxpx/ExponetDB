// The design system's component tests render whole demo pages (lazy grids,
// MDX, axe sweeps) in jsdom. Testing Library waits 1 s by default; on the CI
// runner (two cores, every package in parallel) an axe sweep of the result grid
// outlasted it and "a grid loads when it is shown" failed on `main` as on pull
// requests. The waits get the budget the runner needs, as in the Web App; an
// element that never appears, or a violation that stays, still fails the test.
import { configure } from '@testing-library/react'

configure({ asyncUtilTimeout: 10_000 })
