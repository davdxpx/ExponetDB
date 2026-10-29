\set org random(1, 2000)
\set eid random(1, 5000000)
\set iid random(1, 1000000)
BEGIN;
UPDATE public.crm_items SET priority = priority + 1 WHERE id = :iid;
UPDATE public.billing_items SET amount = amount + 0.01 WHERE id = :iid;
INSERT INTO public.events_log (org_id, user_id, kind, payload) VALUES (md5(:org::text)::uuid, md5('u' || :org)::uuid, 'click', jsonb_build_object('n', :eid));
END;
