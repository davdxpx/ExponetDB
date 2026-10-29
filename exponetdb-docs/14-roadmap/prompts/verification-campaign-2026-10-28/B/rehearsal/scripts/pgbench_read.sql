\set org random(1, 2000)
\set eid random(1, 5000000)
\set iid random(1, 1000000)
\set acc random(1, 2000)
BEGIN;
SELECT id, kind FROM public.events_log WHERE id = :eid;
SELECT count(*) FROM public.crm_items WHERE account_id = :acc;
SELECT id, amount FROM public.billing_items WHERE id = :iid;
SELECT count(*) FROM public.events_log WHERE org_id = md5(:org::text)::uuid AND created_at > now() - interval '10 minutes';
END;
