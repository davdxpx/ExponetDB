SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=$$public$$ AND table_name=$$calendar_items$$ AND column_name=$$flag$$) AS ok;
