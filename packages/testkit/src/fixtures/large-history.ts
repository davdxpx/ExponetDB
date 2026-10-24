import type { LegacyFile } from './legacy-history.ts'

/**
 * A large synthetic legacy history in the shape of a Supabase-origin
 * product (follow-up 2, F4: the first real import had 556 files and about
 * 2.7 MB of SQL): tables with row security and policies calling the
 * identity service, PL/pgSQL functions and triggers, indexes, grants,
 * guarded role grants in `DO` blocks, comment-only files and a few large
 * function libraries. Only shapes: no consumer name, no data.
 *
 * Deterministic: the same arguments give the same files.
 */
export interface LargeHistoryOptions {
  /** The number of files (default 600). */
  readonly files?: number
  /** About this many bytes of SQL in all (default 3 000 000). */
  readonly bytes?: number
}

function table(n: number): string {
  const cols = Array.from({ length: 18 }, (_, i) => {
    const types = ['text', 'integer', 'boolean', 'timestamptz', 'jsonb', 'numeric(12,2)']
    return `  c${i} ${types[i % types.length]}${i % 4 === 0 ? ' NOT NULL' : ''}`
  }).join(',\n')
  return `-- Records of kind ${n}.
CREATE TABLE IF NOT EXISTS public.acme_t${n} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
${cols}
);
ALTER TABLE public.acme_t${n} ENABLE ROW LEVEL SECURITY;
CREATE POLICY acme_t${n}_select ON public.acme_t${n} FOR SELECT
  USING (tenant_id IN (SELECT m.tenant_id FROM public.acme_members m WHERE m.user_id = (SELECT auth.uid())));
CREATE POLICY acme_t${n}_insert ON public.acme_t${n} FOR INSERT
  WITH CHECK (tenant_id IN (SELECT m.tenant_id FROM public.acme_members m WHERE m.user_id = (SELECT auth.uid())));
CREATE POLICY acme_t${n}_update ON public.acme_t${n} FOR UPDATE
  USING (tenant_id IN (SELECT m.tenant_id FROM public.acme_members m WHERE m.user_id = (SELECT auth.uid())));
CREATE INDEX IF NOT EXISTS acme_t${n}_tenant ON public.acme_t${n} (tenant_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.acme_t${n} TO authenticated;
COMMENT ON TABLE public.acme_t${n} IS 'records of kind ${n}';
`
}

function fn(n: number, lines: number, trigger = true): string {
  const body = Array.from(
    { length: lines },
    (_, i) => `    IF NEW.c${i % 18} IS DISTINCT FROM OLD.c${i % 18} THEN
      INSERT INTO public.acme_audit (tenant_id, kind, detail)
      VALUES (NEW.tenant_id, 'acme_t${n}.c${i % 18}', jsonb_build_object('step', ${i}));
    END IF;`,
  ).join('\n')
  return `CREATE OR REPLACE FUNCTION public.acme_t${n}_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Keeps the audit trail of kind ${n}.
${body}
  RETURN NEW;
END;
$$;
${
  trigger
    ? `DROP TRIGGER IF EXISTS acme_t${n}_changed ON public.acme_t${n};
CREATE TRIGGER acme_t${n}_changed AFTER UPDATE ON public.acme_t${n}
  FOR EACH ROW EXECUTE FUNCTION public.acme_t${n}_changed();
`
    : ''
}`
}

function guarded(n: number): string {
  return `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acme_consent_writer') THEN
    GRANT acme_reader_${n % 7} TO acme_consent_writer;
  END IF;
END $$;
`
}

export function largeLegacyHistory(options: LargeHistoryOptions = {}): LegacyFile[] {
  const count = options.files ?? 600
  const budget = options.bytes ?? 3_000_000
  const files: LegacyFile[] = [
    {
      name: '0000_base.sql',
      text: `CREATE TABLE IF NOT EXISTS public.acme_members (tenant_id uuid NOT NULL, user_id uuid NOT NULL);
CREATE TABLE IF NOT EXISTS public.acme_audit (id bigserial PRIMARY KEY, tenant_id uuid, kind text, detail jsonb);
`,
    },
  ]
  // Every tenth file a function with its trigger, every 25th a guarded grant, every 40th
  // comments only; the rest tables. Three function libraries take the bytes left over.
  for (let i = 1; files.length < count - 3; i++) {
    // A function file follows a table file and keeps that table's audit trail.
    const n = i - 1
    const name = `${String(i).padStart(4, '0')}_step_${i}.sql`
    if (i % 40 === 0) files.push({ name, text: `-- Step ${i} was folded into an earlier one.\n` })
    else if (i % 25 === 0) files.push({ name, text: guarded(i) })
    else if (i % 10 === 0) files.push({ name, text: fn(n, 12) })
    else files.push({ name, text: table(i) })
  }
  const used = files.reduce((sum, f) => sum + f.text.length, 0)
  const left = Math.max(0, budget - used)
  for (let k = 0; k < 3; k++) {
    const parts: string[] = []
    let size = 0
    for (let j = 0; size < left / 3; j++) {
      const text = fn(1000 + k * 1000 + j, 40, false).replaceAll('acme_t', `acme_lib${k}_t`)
      parts.push(text)
      size += text.length
    }
    files.push({ name: `${9000 + k}_library_${k}.sql`, text: parts.join('\n') })
  }
  return files
}
