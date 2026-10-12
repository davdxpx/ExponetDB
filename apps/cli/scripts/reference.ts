import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { referenceMarkdown } from '../src/cli/reference.ts'
import { COMMANDS } from '../src/commands/index.ts'

/** Writes exponetdb-docs/15-cli/reference.md from the command registry (`bun run reference`). */
const target = fileURLToPath(
  new URL('../../../exponetdb-docs/15-cli/reference.md', import.meta.url),
)
await writeFile(target, referenceMarkdown(COMMANDS))
console.log(`wrote ${target}`)
