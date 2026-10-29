-- high risk, measured: rewrite of 1.5M rows that pgbench updates, with the dependent views dropped and recreated
DROP VIEW public.billing_overview;
DROP VIEW public.v_billing_totals;
ALTER TABLE public.billing_items ALTER COLUMN amount TYPE numeric(16,4);
CREATE VIEW public.billing_overview WITH (security_invoker = true) AS
  SELECT a.id, a.org_id, a.name, a.status, count(i.id) AS items, coalesce(sum(i.amount), 0) AS amount
  FROM public.billing_accounts a LEFT JOIN public.billing_items i ON i.account_id = a.id GROUP BY a.id;
GRANT SELECT ON public.billing_overview TO authenticated, service_role;
CREATE VIEW public.v_billing_totals AS SELECT org_id, count(*) AS n, coalesce(sum(amount), 0) AS total FROM public.billing_items GROUP BY org_id;
GRANT SELECT ON public.v_billing_totals TO authenticated, service_role;
