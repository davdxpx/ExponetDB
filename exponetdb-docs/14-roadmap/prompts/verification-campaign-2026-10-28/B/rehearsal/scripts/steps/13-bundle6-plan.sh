source /srv/work/s5/rehearsal/rh-lib.sh
cd $PROJ
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_archivecleanup /srv/work/s5/walarchive 000000010000000200000051 && echo "archive pruned: $(ls /srv/work/s5/walarchive | wc -l) files, $(du -sh /srv/work/s5/walarchive | cut -f1)"
# B6 only (B7 is written later)
sed -n '/^second)/,/^esac/p' $RH/author_bundles.sh > /dev/null
B3=$(grep ^B3 $L/bundle-ids-first.env | cut -d= -f2)
LAST=$(cut -d' ' -f1 <<<"$(ls -d migrations/* | sed 's|migrations/||' | cut -c1-26 | tr '\n' ' ')")
HEAD=$(cat $L/bl2.id)
VERIFY_SQL="SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications' AND column_name='channel') AND to_regclass('public.rh_marker') IS NOT NULL AS ok;" \
mkb $PROJ notifications-channel-and-marker --depends-on $HEAD > $L/b6.id <<'SQL'
-- additive: a column with a constant default (no rewrite since PostgreSQL 11) and a small marker table
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'app';
CREATE TABLE public.rh_marker (id bigint PRIMARY KEY, ts timestamptz NOT NULL DEFAULT clock_timestamp());
GRANT ALL ON public.rh_marker TO service_role;
SQL
echo B6=$(cat $L/b6.id)
TAIL=14 tm plan-b6 exdb migration plan --target lab/platform/rhstg
