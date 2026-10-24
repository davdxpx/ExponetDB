import mdx from '@mdx-js/rollup'
import remarkGfm from 'remark-gfm'
import { mergeConfig } from 'vitest/config'
import { componentConfig } from '../../vitest.shared.ts'

// The component tests render MDX pages too: compile them like the build does.
export default mergeConfig(componentConfig, {
  plugins: [{ enforce: 'pre', ...mdx({ providerImportSource: null, remarkPlugins: [remarkGfm] }) }],
  test: {
    setupFiles: [new URL('./test/setup.ts', import.meta.url).pathname],
  },
})
