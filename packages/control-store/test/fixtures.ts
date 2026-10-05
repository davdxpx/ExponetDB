import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHIPPED_BUNDLES_DIR } from '../src/index.ts'

/** A temporary copy of the shipped bundle directory that a test can extend or edit. */
export interface BundleDir {
  readonly path: string
  add(directory: string, files: Record<string, string>): Promise<void>
  write(directory: string, file: string, content: string): Promise<void>
  /** Keeps only the shipped bundles whose directory starts with one of `prefixes`. */
  keepOnly(prefixes: readonly string[]): Promise<void>
  remove(): Promise<void>
}

export async function bundleDir(): Promise<BundleDir> {
  const path = await mkdtemp(join(tmpdir(), 'exdb-bundles-'))
  await cp(fileURLToPath(SHIPPED_BUNDLES_DIR), path, { recursive: true })
  return {
    path,
    async add(directory, files) {
      const dir = join(path, directory)
      await mkdir(dir, { recursive: true })
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, name), content)
      }
    },
    async write(directory, file, content) {
      await writeFile(join(path, directory, file), content)
    },
    async keepOnly(prefixes) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory() && !prefixes.some((p) => entry.name.startsWith(p))) {
          await rm(join(path, entry.name), { recursive: true })
        }
      }
    },
    remove: () => rm(path, { recursive: true, force: true }),
  }
}

export const FOUNDATION_ID = '01M46KHY80CWGMHV633DGSP8S8'

/** A probe bundle that depends on the foundation and counts its executions. */
export function probeBundle(
  id: string,
  options: { up?: string; verify?: string } = {},
): Record<string, string> {
  return {
    'migration.yaml': [
      'schema: exponetdb.migration/v1',
      `id: ${id}`,
      'name: probe',
      'description: Test probe bundle.',
      'dependsOn:',
      `  - ${FOUNDATION_ID}`,
      'execution:',
      '  transactional: true',
      'compatibility:',
      '  declared: additive',
      'verification:',
      '  expectations: auto',
      '  runtimeChecks: verify.sql',
      '',
    ].join('\n'),
    'up.sql':
      options.up ??
      'CREATE TABLE control.probe_runs (n integer NOT NULL);\nINSERT INTO control.probe_runs (n) VALUES (1);\n',
    'verify.sql':
      options.verify ??
      "-- check: probe table exists\nSELECT to_regclass('control.probe_runs') IS NOT NULL AS ok;\n",
  }
}
