-- high risk: a column type change that rewrites 1M rows under an ACCESS EXCLUSIVE lock.
-- The first draft was only the ALTER; the apply failed with 0A000 because crm_overview and mv_crm_pipeline read the column
-- (the plan had not warned). The final form drops and recreates the dependents in the same transaction.
DROP MATERIALIZED VIEW public.mv_crm_pipeline;
DROP VIEW public.crm_overview;
ALTER TABLE public.crm_items ALTER COLUMN amount TYPE numeric(16,4);
CREATE VIEW public.crm_overview WITH (security_invoker = true) AS
  SELECT a.id, a.org_id, a.name, a.status, count(i.id) AS items, coalesce(sum(i.amount), 0) AS amount
  FROM public.crm_accounts a LEFT JOIN public.crm_items i ON i.account_id = a.id GROUP BY a.id;
GRANT SELECT ON public.crm_overview TO authenticated, service_role;
CREATE MATERIALIZED VIEW public.mv_crm_pipeline AS
  SELECT org_id, status, count(*) AS n, sum(amount) AS amount FROM public.crm_items GROUP BY 1, 2;
CREATE UNIQUE INDEX mv_crm_pipeline_key ON public.mv_crm_pipeline (org_id, status);
GRANT SELECT ON public.mv_crm_pipeline TO authenticated, service_role;
