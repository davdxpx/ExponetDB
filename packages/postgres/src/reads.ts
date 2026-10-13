import { type AdmittedRead, registerAdmittedRead } from './admitted-read.ts'
import { type Admission, admitRead, checkRelationKinds, checkUserCode } from './parser/admission.ts'
import { resolveRelationKinds, resolveUserCode } from './relations.ts'
import type { TargetSession } from './session.ts'

type Refusal = Extract<Admission, { ok: false }>

/**
 * Admits one statement for a read on this session's target: the parser
 * first (nothing is sent to the server before it passes), then the
 * relation kinds and the user code read from this target's catalog.
 */
export async function admitReadOn(
  session: TargetSession,
  text: string,
): Promise<{ readonly ok: true; readonly read: AdmittedRead } | Refusal> {
  const admission = await admitRead(session.facts.major, text)
  if (!admission.ok) return admission
  const kinds = await resolveRelationKinds(session, admission.relations)
  const relationRefusal = checkRelationKinds(admission.relations, kinds)
  if (relationRefusal !== undefined) return relationRefusal
  const codeRefusal = checkUserCode(await resolveUserCode(session))
  if (codeRefusal !== undefined) return codeRefusal
  return {
    ok: true,
    read: registerAdmittedRead({
      text,
      statementClass: admission.statementClass,
      analyze: admission.analyze,
      relations: admission.relations,
    }),
  }
}
