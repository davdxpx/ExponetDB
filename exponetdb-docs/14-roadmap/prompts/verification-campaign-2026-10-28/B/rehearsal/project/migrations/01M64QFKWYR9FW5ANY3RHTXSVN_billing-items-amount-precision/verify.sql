SELECT (SELECT numeric_scale FROM information_schema.columns WHERE table_schema=$$public$$ AND table_name=$$billing_items$$ AND column_name=$$amount$$) = 4 AS ok;
