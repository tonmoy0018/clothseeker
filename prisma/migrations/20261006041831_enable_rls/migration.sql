-- Lock down every table in the public schema.
--
-- Supabase exposes the public schema through its REST/GraphQL API to anyone holding the
-- publishable key. ClothSeeker never uses that API for data: all reads and writes go through
-- server-side Prisma, which connects as the table owner and is not subject to RLS.
-- Enabling RLS with NO policies therefore denies the anon/authenticated API roles entirely.
--
-- Every future migration that creates a table must also enable RLS on it.
-- `pnpm db:check` and tests/integration/rls.test.ts fail if any public table lacks RLS.

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END
$$;
