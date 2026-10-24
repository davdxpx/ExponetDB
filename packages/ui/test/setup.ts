// Testing Library unmounts what a test rendered only when it finds a global
// `afterEach`, and these tests import theirs from vitest (no globals): every
// tree stayed mounted after its test, and the shared setup only empties the
// document. A component's timers then outlived it: the navigation menu's 300 ms
// skip delay, started by Escape in the file's last test but one, fired after the
// file's jsdom was gone and failed the run on CI ("window is not defined").
// Unmounting after each test runs the components' own cleanup, which clears them.
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
