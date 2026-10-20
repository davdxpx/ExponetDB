// Component tests of the Web App mount the whole app (session guard, shell,
// lazy route chunks) in jsdom. Testing Library waits 1 s for an element by
// default; on a loaded machine the first render of a page can take longer, and
// the test then failed before the page existed (the activity page's stale-read
// test, under parallel load). The waits get the budget the CI runner needs, as
// the test timeout did; an element that never appears still fails the test.
import { configure } from '@testing-library/react'

configure({ asyncUtilTimeout: 10_000 })
