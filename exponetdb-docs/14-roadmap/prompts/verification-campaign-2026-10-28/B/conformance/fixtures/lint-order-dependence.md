Two independent bundles that both touch `public.t` (`ALTER TABLE public.t ADD COLUMN a/b/c ...`), linted in two
orders (`lintBundles([A,B,C,D])` against `lintBundles([D,C,B,A])`): the reports differ in the ORDER and in the
named partner of every `parallel_object_overlap` finding ("... also touches table public.t" names whichever
other migration the loop meets first). Everything else in the report (digests, graph, blocking flag) is equal.
Reproduce: `bunx vitest run --config vitest.pure.config.ts I1` (test "FINDING: the lint report does not depend on the order ...").
