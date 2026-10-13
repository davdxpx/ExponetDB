import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const srcDir = join(packageRoot, 'src')

/** The CSS files of the package, in the order tokens.css imports them. */
export const partNames = [
  'fonts',
  'inputs',
  'semantic',
  'theme',
  'animations',
  'utilities',
  'base',
] as const

export function readPart(name: (typeof partNames)[number] | 'tokens'): string {
  return readFileSync(join(srcDir, `${name}.css`), 'utf8')
}

/** Every token CSS file with comments removed, so a test sees declarations and not prose. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

export const entryImport = `@import 'tailwindcss';\n@import '${join(srcDir, 'tokens.css')}';\n`

export interface TokenCompiler {
  build(candidates: string[]): string
}

/** The Tailwind v4 compiler for an app stylesheet that imports the tokens entry. */
export async function tokenCompiler(extraCss = ''): Promise<TokenCompiler> {
  return compile(`${entryImport}${extraCss}`, {
    base: packageRoot,
    onDependency: () => {},
    shouldRewriteUrls: true,
  })
}

/**
 * Compiles the entry exactly like an app does (`@import 'tailwindcss'` plus the tokens entry)
 * with the given utility candidates, through the Tailwind v4 compile API.
 */
export async function compileTokens(candidates: readonly string[]): Promise<string> {
  const compiler = await tokenCompiler()
  return compiler.build([...candidates])
}
