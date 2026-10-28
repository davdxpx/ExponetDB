ALTER TABLE public.order_items ADD CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES public.orders (id) NOT VALID;
