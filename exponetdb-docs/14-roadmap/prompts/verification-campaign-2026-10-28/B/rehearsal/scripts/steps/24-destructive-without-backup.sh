source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
VERIFY_SQL="SELECT to_regclass('public.docs_tags') IS NULL AS ok;" mkb $PROJ drop-docs-tags --depends-on baseline:rehearsal-2024 > $L/d1.id <<'SQL'
DROP TABLE public.docs_tags;
SQL
D1=$(cat $L/d1.id)
python3 - $PROJ/migrations/${D1}_drop-docs-tags/migration.yaml <<'PY'
import sys
f=sys.argv[1]; s=open(f).read().replace("compatibility:\n  declared: additive\n","compatibility:\n  declared: destructive\n  notes: |\n    Drops public.docs_tags, which nothing reads.\n"); open(f,"w").write(s)
PY
TAIL=4 tm d1-plan-staging exdb migration plan $D1 --target lab/platform/rhstg
PL=$(grep -o "pln_[A-Z0-9]*" $L/d1-plan-staging.log | head -1); TAIL=3 tm d1-apply-staging exdb plan apply $PL --wait
echo "=== D1 (destructive, verified on staging) planned for production"
TAIL=22 tm d1-plan-prod exdb migration plan $D1 --target lab/platform/rhprod
echo "=== the same with --break-glass (no grant exists)"
TAIL=6 tm d1-plan-prod-bg exdb migration plan $D1 --target lab/platform/rhprod --break-glass bgl_01M64R0000000000000000000
