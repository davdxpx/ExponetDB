import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { bundledPackages, NOTICE_FILE, renderNotices } from './notices.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The repository notices appended to the generated file (ADR-0030): what the register points to. */
export const REPOSITORY_NOTICES = [
  {
    title:
      'Files derived from Supabase and shadcn/ui, glyphs from Simple Icons (THIRD_PARTY_NOTICES.md)',
    file: 'THIRD_PARTY_NOTICES.md',
  },
  { title: 'Apache License 2.0 (Supabase)', file: 'LICENSES/Apache-2.0.txt' },
  { title: 'MIT License (Supabase packages)', file: 'LICENSES/MIT-supabase.txt' },
  { title: 'MIT License (shadcn/ui)', file: 'LICENSES/MIT-shadcn.txt' },
  { title: 'CC0 1.0 Universal (Simple Icons)', file: 'LICENSES/CC0-1.0-simple-icons.txt' },
  { title: 'SIL Open Font License 1.1 (Inter)', file: 'LICENSES/OFL-1.1-inter.txt' },
  {
    title: 'SIL Open Font License 1.1 (Source Code Pro)',
    file: 'LICENSES/OFL-1.1-source-code-pro.txt',
  },
] as const

/**
 * Emits `assets/third-party-licenses.txt` from the modules the build actually bundled (the
 * JavaScript chunks' modules, plus the CSS and font modules they import). A bundled package with
 * neither a license file nor a declared license fails the build.
 */
export function thirdPartyNotices(): Plugin {
  return {
    name: 'exponetdb-third-party-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const ids = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          for (const id of Object.keys(output.modules)) ids.add(id)
        } else {
          for (const id of output.originalFileNames) ids.add(id)
        }
      }
      // CSS and font modules are not chunk modules; the module graph still names them.
      for (const id of this.getModuleIds()) {
        if (/\.(?:css|woff2?)(?:\?|$)/.test(id)) ids.add(id)
      }
      const { packages, problems } = bundledPackages(ids)
      if (problems.length > 0) {
        this.error(`third-party license notices:\n${problems.join('\n')}`)
      }
      const text = renderNotices(
        packages,
        REPOSITORY_NOTICES.map((n) => ({
          title: n.title,
          text: readFileSync(join(root, n.file), 'utf8'),
        })),
      )
      this.emitFile({ type: 'asset', fileName: NOTICE_FILE, source: text })
    },
  }
}
