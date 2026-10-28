-- 80/20 read/write mix on public.orders (plus one cheap read of the order_totals matview).
-- Variables: rows (set with -D rows=N), pgbench built-ins client_id and random().
-- Reads: 60% point read by primary key, 10% customer range read, 10% matview read.
-- Writes: 15% update of one order, 5% insert of a new order (refs come from bench_seq, unique).
\set id random(1, :rows)
\set cid random(1, 1000)
\set r random(1, 100)
\if :r <= 60
SELECT id, customer_id, ref, status, amount FROM public.orders WHERE id = :id;
\elif :r <= 70
SELECT count(*) FROM public.orders WHERE customer_id = :cid AND created_at >= timestamp '2026-01-01' AND created_at < timestamp '2026-01-02';
\elif :r <= 80
SELECT n FROM public.order_totals WHERE customer_id = :cid;
\elif :r <= 95
UPDATE public.orders SET amount = amount + 1, note = 'u' || :id WHERE id = :id;
\else
INSERT INTO public.orders (customer_id, ref, amount, note) VALUES (:cid, 'B-' || nextval('public.bench_seq'), 100, 'ins');
\endif
