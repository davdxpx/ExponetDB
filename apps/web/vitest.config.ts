import { mergeConfig } from 'vitest/config'
import { componentConfig } from '../../vitest.shared.ts'

export default mergeConfig(componentConfig, {
  test: {
    setupFiles: [new URL('./test/setup.ts', import.meta.url).pathname],
  },
})
