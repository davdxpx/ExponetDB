// Types for pg-cursor 2.22.1 (the package ships none): only what the session uses.
declare module 'pg-cursor' {
  import type { Submittable } from 'pg'

  // biome-ignore lint/style/noDefaultExport: the module's own shape (pg-cursor exports a default class)
  export default class Cursor implements Submittable {
    constructor(
      text: string,
      values?: readonly unknown[],
      config?: Readonly<Record<string, unknown>>,
    )
    submit(connection: unknown): void
    read(rows: number): Promise<unknown[]>
    close(): Promise<void>
  }
}
